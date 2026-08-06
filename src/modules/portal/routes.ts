// Клиентский портал (Stage 21, ТЗ 5.7). A SEPARATE auth realm for external customers:
// they log in with their own CustomerUser account and see ONLY their own sales orders,
// quotations and statuses. Every query is scoped to (tenantId + customerId) from the
// token — a customer can never read another customer's or another tenant's data.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { requirePermission } from '../../plugins/rbac.js';
import { audit } from '../../lib/audit.js';
import { Unauthorized, BadRequest, NotFound } from '../../lib/errors.js';

const D = (v: Prisma.Decimal | number | string) => new Prisma.Decimal(v);

interface PortalClaims { sub: string; tid: string; cid: string; email: string; kind: string }

// Verify a portal token and require the customer realm. Populates req.portal.
async function portalAuth(req: FastifyRequest): Promise<PortalClaims> {
  let p: PortalClaims;
  try { p = await req.jwtVerify<PortalClaims>(); } catch { throw Unauthorized('Недействительный или просроченный токен'); }
  if (p.kind !== 'customer' || !p.cid || !p.tid) throw Unauthorized('Требуется вход в клиентский портал');
  (req as unknown as { portal: PortalClaims }).portal = p;
  return p;
}
const portalOf = (req: FastifyRequest) => (req as unknown as { portal: PortalClaims }).portal;

function orderTotal(items: { quantity: Prisma.Decimal; priceMinor: number }[]): number {
  return items.reduce((s, it) => s + Math.round(Number(it.quantity) * it.priceMinor), 0);
}

export default async function portalRoutes(app: FastifyInstance) {
  // ---- Public: login ----
  app.post('/auth/login', async (req) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1), tenantSlug: z.string().optional() }).parse(req.body);
    // Resolve the account by email; a tenant slug disambiguates if the same email exists
    // in more than one tenant's portal.
    let candidates = await prisma.customerUser.findMany({ where: { email: body.email.toLowerCase() } });
    if (body.tenantSlug) {
      const tenant = await prisma.tenant.findUnique({ where: { slug: body.tenantSlug } });
      candidates = candidates.filter((c) => c.tenantId === tenant?.id);
    }
    if (candidates.length > 1) throw BadRequest('Укажите организацию (slug)', 'NEED_TENANT');
    const user = candidates[0];
    // Constant-ish: always run a compare to avoid leaking which emails exist.
    const ok = user ? await bcrypt.compare(body.password, user.passwordHash) : await bcrypt.compare(body.password, '$2a$10$0000000000000000000000000000000000000000000000000000');
    if (!user || !ok) throw Unauthorized('Неверный email или пароль');
    if (user.status !== 'active') throw Unauthorized('Учётная запись отключена');

    const customer = await prisma.customer.findFirst({ where: { id: user.customerId, tenantId: user.tenantId } });
    if (!customer) throw Unauthorized('Клиент не найден');
    await prisma.customerUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const token = app.jwt.sign({ sub: user.id, tid: user.tenantId, cid: user.customerId, email: user.email, kind: 'customer' }, { expiresIn: '12h' });
    return { token, user: { email: user.email, fullName: user.fullName }, customer: { name: customer.name, code: customer.code } };
  });

  // ---- Authenticated (customer realm) ----
  app.get('/me', { preHandler: [portalAuth] }, async (req) => {
    const p = portalOf(req);
    const customer = await prisma.customer.findFirst({ where: { id: p.cid, tenantId: p.tid }, select: { name: true, code: true, phone: true, email: true, address: true, creditLimitMinor: true } });
    if (!customer) throw NotFound('Клиент не найден');
    const tenant = await prisma.tenant.findUnique({ where: { id: p.tid }, select: { name: true, brandName: true } });
    return { customer, company: { name: tenant?.brandName || tenant?.name } };
  });

  app.get('/summary', { preHandler: [portalAuth] }, async (req) => {
    const p = portalOf(req);
    const [orders, byStatus, quotations] = await Promise.all([
      prisma.salesOrder.count({ where: { tenantId: p.tid, customerId: p.cid } }),
      prisma.salesOrder.groupBy({ by: ['status'], where: { tenantId: p.tid, customerId: p.cid }, _count: true }),
      prisma.quotation.count({ where: { tenantId: p.tid, customerId: p.cid } }),
    ]);
    return { orders, quotations, ordersByStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count])) };
  });

  app.get('/orders', { preHandler: [portalAuth] }, async (req) => {
    const p = portalOf(req);
    const q = z.object({ status: z.string().optional() }).parse(req.query);
    const orders = await prisma.salesOrder.findMany({
      where: { tenantId: p.tid, customerId: p.cid, ...(q.status ? { status: q.status } : {}) },
      include: { items: true }, orderBy: { createdAt: 'desc' }, take: 200,
    });
    return {
      orders: orders.map((o) => ({
        id: o.id, number: o.number, status: o.status, createdAt: o.createdAt,
        itemCount: o.items.length, totalMinor: orderTotal(o.items),
        shipped: o.items.every((it) => D(it.shippedQty).greaterThanOrEqualTo(it.quantity)),
      })),
    };
  });

  app.get('/orders/:id', { preHandler: [portalAuth] }, async (req) => {
    const p = portalOf(req);
    const { id } = req.params as { id: string };
    // Scope by BOTH id AND (tenant, customer) — a mismatched id yields 404, never another
    // customer's order.
    const order = await prisma.salesOrder.findFirst({ where: { id, tenantId: p.tid, customerId: p.cid }, include: { items: true } });
    if (!order) throw NotFound('Заказ не найден');
    return {
      order: {
        id: order.id, number: order.number, status: order.status, createdAt: order.createdAt, note: order.note,
        totalMinor: orderTotal(order.items),
        items: order.items.map((it) => ({ productName: it.productName, quantity: Number(it.quantity), priceMinor: it.priceMinor, shippedQty: Number(it.shippedQty), lineMinor: Math.round(Number(it.quantity) * it.priceMinor) })),
      },
    };
  });

  app.get('/quotations', { preHandler: [portalAuth] }, async (req) => {
    const p = portalOf(req);
    const quotations = await prisma.quotation.findMany({
      where: { tenantId: p.tid, customerId: p.cid }, include: { items: true }, orderBy: { createdAt: 'desc' }, take: 200,
    });
    return {
      quotations: quotations.map((qt) => ({
        id: qt.id, number: qt.number, status: qt.status, validUntil: qt.validUntil, createdAt: qt.createdAt,
        totalMinor: orderTotal(qt.items as { quantity: Prisma.Decimal; priceMinor: number }[]),
      })),
    };
  });

  // ---- Internal admin: manage a customer's portal login (sales users) ----
  // These use the INTERNAL auth realm (app.authenticate) + sales permissions.
  app.get('/admin/access/:customerId', { preHandler: [app.authenticate, requirePermission('sales.read')] }, async (req) => {
    const { customerId } = req.params as { customerId: string };
    const customer = await prisma.customer.findFirst({ where: { id: customerId, tenantId: req.auth.tid } });
    if (!customer) throw NotFound('Клиент не найден');
    const user = await prisma.customerUser.findFirst({ where: { tenantId: req.auth.tid, customerId }, select: { id: true, email: true, fullName: true, status: true, lastLoginAt: true, createdAt: true } });
    return { user };
  });

  app.post('/admin/access/:customerId', { preHandler: [app.authenticate, requirePermission('sales.write')] }, async (req, reply) => {
    const { customerId } = req.params as { customerId: string };
    const body = z.object({ email: z.string().email(), password: z.string().min(6, 'Минимум 6 символов'), fullName: z.string().max(160).nullish() }).parse(req.body);
    const customer = await prisma.customer.findFirst({ where: { id: customerId, tenantId: req.auth.tid } });
    if (!customer) throw NotFound('Клиент не найден');
    const email = body.email.toLowerCase();
    // Email must be unique within the tenant's portal (and not already tied to another customer).
    const clash = await prisma.customerUser.findFirst({ where: { tenantId: req.auth.tid, email, NOT: { customerId } } });
    if (clash) throw BadRequest('Этот email уже используется другим клиентом', 'EMAIL_TAKEN');
    const passwordHash = await bcrypt.hash(body.password, 12);
    const existing = await prisma.customerUser.findFirst({ where: { tenantId: req.auth.tid, customerId } });
    const user = existing
      ? await prisma.customerUser.update({ where: { id: existing.id }, data: { email, passwordHash, fullName: body.fullName ?? existing.fullName, status: 'active' } })
      : await prisma.customerUser.create({ data: { tenantId: req.auth.tid, customerId, email, passwordHash, fullName: body.fullName ?? customer.name, status: 'active' } });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: existing ? 'portal.reset' : 'portal.create', entity: 'CustomerUser', entityId: user.id, meta: { customerId }, ip: req.ip });
    return reply.code(existing ? 200 : 201).send({ user: { id: user.id, email: user.email, fullName: user.fullName, status: user.status } });
  });

  app.post('/admin/access/:customerId/disable', { preHandler: [app.authenticate, requirePermission('sales.write')] }, async (req) => {
    const { customerId } = req.params as { customerId: string };
    const user = await prisma.customerUser.findFirst({ where: { tenantId: req.auth.tid, customerId } });
    if (!user) throw NotFound('Учётная запись портала не найдена');
    const updated = await prisma.customerUser.update({ where: { id: user.id }, data: { status: user.status === 'active' ? 'disabled' : 'active' } });
    return { status: updated.status };
  });
}
