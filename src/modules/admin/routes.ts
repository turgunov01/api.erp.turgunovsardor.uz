// Admin module: users, roles, audit log. Tenant-scoped.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { requirePermission } from '../../plugins/rbac.js';
import { hashPassword } from '../../lib/password.js';
import { blockIfInactiveWrite } from '../../plugins/subscription.js';
import { assertWithinLimit } from '../../lib/limits.js';
import { audit } from '../../lib/audit.js';
import { BadRequest, Conflict, NotFound } from '../../lib/errors.js';
import { pageQuery, skipTake, pageMeta } from '../../lib/pagination.js';
import { createInvite } from '../../lib/invites.js';
import { PERMISSIONS, ALL_PERMISSION_CODES } from '../../lib/permissions.js';
import { config } from '../../config.js';

const createUserSchema = z.object({
  email: z.string().email(),
  fullName: z.string().min(1),
  password: z.string().min(6),
  roleCodes: z.array(z.string()).default([]),
});

export default async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', blockIfInactiveWrite);

  app.get('/roles', { preHandler: [requirePermission('admin.roles')] }, async (req) => {
    const roles = await prisma.role.findMany({
      where: { tenantId: req.auth.tid },
      include: { permissions: { include: { permission: true } }, _count: { select: { users: true } } },
      orderBy: { name: 'asc' },
    });
    return {
      roles: roles.map((r) => ({
        id: r.id, code: r.code, name: r.name, description: r.description,
        users: r._count.users, permissions: r.permissions.map((p) => p.permission.code),
      })),
    };
  });

  app.get('/users', { preHandler: [requirePermission('admin.users')] }, async (req) => {
    const q = pageQuery.parse(req.query);
    const where = {
      tenantId: req.auth.tid,
      ...(q.search ? { OR: [
        { fullName: { contains: q.search, mode: 'insensitive' as const } },
        { email: { contains: q.search, mode: 'insensitive' as const } },
      ] } : {}),
    };
    const [users, total] = await prisma.$transaction([
      prisma.user.findMany({
        where,
        include: { roles: { include: { role: true } } },
        orderBy: { createdAt: 'asc' },
        ...skipTake(q),
      }),
      prisma.user.count({ where }),
    ]);
    return {
      meta: pageMeta(q, total),
      users: users.map((u) => ({
        id: u.id, email: u.email, fullName: u.fullName, status: u.status,
        lastLoginAt: u.lastLoginAt, roles: u.roles.map((r) => r.role.code),
      })),
    };
  });

  app.post('/users', { preHandler: [requirePermission('admin.users')] }, async (req, reply) => {
    const body = createUserSchema.parse(req.body);
    const tenantId = req.auth.tid;
    await assertWithinLimit(tenantId, 'users');
    const exists = await prisma.user.findUnique({ where: { tenantId_email: { tenantId, email: body.email } } });
    if (exists) throw Conflict('User with this email already exists in the tenant', 'EMAIL_EXISTS');

    const roles = await prisma.role.findMany({ where: { tenantId, code: { in: body.roleCodes } } });
    if (roles.length !== body.roleCodes.length) throw NotFound('One or more roles not found');

    const user = await prisma.user.create({
      data: {
        tenantId,
        email: body.email,
        fullName: body.fullName,
        passwordHash: await hashPassword(body.password),
        roles: { create: roles.map((r) => ({ roleId: r.id })) },
      },
    });
    await audit({ tenantId, userId: req.auth.sub, action: 'admin.user.create', entity: 'User', entityId: user.id, meta: { email: body.email, roles: body.roleCodes }, ip: req.ip });
    return reply.code(201).send({ user: { id: user.id, email: user.email, fullName: user.fullName } });
  });

  app.get('/audit', { preHandler: [requirePermission('audit.read')] }, async (req) => {
    const { action } = req.query as { action?: string };
    const q = pageQuery.parse(req.query);
    const where = { tenantId: req.auth.tid, ...(action ? { action: { contains: action } } : {}) };
    const [logs, total] = await prisma.$transaction([
      prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(q) }),
      prisma.auditLog.count({ where }),
    ]);
    return { meta: pageMeta(q, total), logs };
  });

  // ===================== INVITATIONS (3.1) =====================
  const inviteSchema = z.object({ email: z.string().email(), roleCodes: z.array(z.string()).min(1) });
  app.post('/invitations', { preHandler: [requirePermission('admin.users')] }, async (req, reply) => {
    const body = inviteSchema.parse(req.body);
    const roles = await prisma.role.findMany({ where: { tenantId: req.auth.tid, code: { in: body.roleCodes } } });
    if (roles.length !== body.roleCodes.length) throw NotFound('One or more roles not found');
    const existing = await prisma.user.findUnique({ where: { tenantId_email: { tenantId: req.auth.tid, email: body.email } } });
    if (existing) throw Conflict('Пользователь уже существует', 'EMAIL_EXISTS');

    const { id, token } = await createInvite(req.auth.tid, body.email, body.roleCodes, req.auth.sub);
    const link = `${config.APP_URL}/app.html?invite=${token}#accept-invite`;
    req.log.info({ inviteLink: link }, 'Invitation created');
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'admin.invite.create', entity: 'Invitation', entityId: id, meta: { email: body.email }, ip: req.ip });
    // Dev convenience: return the link/token until email is wired (Stage 9).
    return reply.code(201).send({ id, ...(config.NODE_ENV !== 'production' ? { devInviteLink: link, devToken: token } : {}) });
  });

  app.get('/invitations', { preHandler: [requirePermission('admin.users')] }, async (req) => {
    const invitations = await prisma.invitation.findMany({
      where: { tenantId: req.auth.tid, status: 'pending' }, orderBy: { createdAt: 'desc' },
      select: { id: true, email: true, roleCodes: true, expiresAt: true, createdAt: true },
    });
    return { invitations };
  });

  app.post('/invitations/:id/revoke', { preHandler: [requirePermission('admin.users')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await prisma.invitation.updateMany({ where: { id, tenantId: req.auth.tid, status: 'pending' }, data: { status: 'revoked' } });
    return reply.send({ ok: true });
  });

  // ===================== PERMISSIONS + CUSTOM ROLES (3.2) =====================
  app.get('/permissions', { preHandler: [requirePermission('admin.roles')] }, async () => ({ permissions: PERMISSIONS }));

  const roleSchema = z.object({
    name: z.string().min(2), code: z.string().regex(/^[a-z0-9_]+$/, 'code: a-z, 0-9, _'),
    description: z.string().optional(), permissions: z.array(z.enum(ALL_PERMISSION_CODES as [string, ...string[]])).default([]),
  });
  app.post('/roles', { preHandler: [requirePermission('admin.roles')] }, async (req, reply) => {
    const body = roleSchema.parse(req.body);
    const exists = await prisma.role.findUnique({ where: { tenantId_code: { tenantId: req.auth.tid, code: body.code } } });
    if (exists) throw Conflict('Роль с таким кодом уже есть', 'ROLE_EXISTS');
    const permIds = await prisma.permission.findMany({ where: { code: { in: body.permissions } }, select: { id: true } });
    const role = await prisma.role.create({
      data: {
        tenantId: req.auth.tid, name: body.name, code: body.code, description: body.description ?? null, isSystem: false,
        permissions: { create: permIds.map((p) => ({ permissionId: p.id })) },
      },
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'admin.role.create', entity: 'Role', entityId: role.id, meta: { code: body.code } });
    return reply.code(201).send({ role: { id: role.id, code: role.code } });
  });

  const rolePatchSchema = z.object({ name: z.string().min(2).optional(), description: z.string().optional(), permissions: z.array(z.enum(ALL_PERMISSION_CODES as [string, ...string[]])).optional() });
  app.patch('/roles/:id', { preHandler: [requirePermission('admin.roles')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = rolePatchSchema.parse(req.body);
    const role = await prisma.role.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!role) throw NotFound('Роль не найдена');
    if (role.isSystem) throw BadRequest('Системную роль нельзя менять', 'SYSTEM_ROLE');
    if (body.permissions) {
      const permIds = await prisma.permission.findMany({ where: { code: { in: body.permissions } }, select: { id: true } });
      await prisma.rolePermission.deleteMany({ where: { roleId: id } });
      await prisma.rolePermission.createMany({ data: permIds.map((p) => ({ roleId: id, permissionId: p.id })) });
    }
    await prisma.role.update({ where: { id }, data: { name: body.name ?? role.name, description: body.description ?? role.description } });
    return reply.send({ ok: true });
  });

  app.delete('/roles/:id', { preHandler: [requirePermission('admin.roles')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const role = await prisma.role.findFirst({ where: { id, tenantId: req.auth.tid }, include: { _count: { select: { users: true } } } });
    if (!role) throw NotFound('Роль не найдена');
    if (role.isSystem) throw BadRequest('Системную роль нельзя удалить', 'SYSTEM_ROLE');
    if (role._count.users > 0) throw BadRequest('Роль назначена пользователям', 'ROLE_IN_USE');
    await prisma.role.delete({ where: { id } });
    return reply.send({ ok: true });
  });

  // ===================== RECORD-LEVEL WAREHOUSE SCOPE (3.5) =====================
  app.get('/users/:id/warehouses', { preHandler: [requirePermission('admin.users')] }, async (req) => {
    const { id } = req.params as { id: string };
    const scope = await prisma.userWarehouse.findMany({ where: { userId: id }, select: { warehouseId: true } });
    return { warehouseIds: scope.map((s) => s.warehouseId) };
  });
  app.put('/users/:id/warehouses', { preHandler: [requirePermission('admin.users')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { warehouseIds } = z.object({ warehouseIds: z.array(z.string()) }).parse(req.body);
    const user = await prisma.user.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!user) throw NotFound('Пользователь не найден');
    // Only warehouses belonging to this tenant.
    const valid = await prisma.warehouse.findMany({ where: { id: { in: warehouseIds }, tenantId: req.auth.tid }, select: { id: true } });
    await prisma.$transaction([
      prisma.userWarehouse.deleteMany({ where: { userId: id } }),
      prisma.userWarehouse.createMany({ data: valid.map((w) => ({ userId: id, warehouseId: w.id })) }),
    ]);
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'admin.user.scope', entity: 'User', entityId: id, meta: { warehouseIds: valid.map((w) => w.id) } });
    return reply.send({ ok: true, warehouseIds: valid.map((w) => w.id) });
  });
}
