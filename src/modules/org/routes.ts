// Organization module: companies, branches, departments, positions. Tenant-scoped.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { requirePermission } from '../../plugins/rbac.js';
import { blockIfInactiveWrite } from '../../plugins/subscription.js';
import { audit } from '../../lib/audit.js';
import { NotFound } from '../../lib/errors.js';

const companySchema = z.object({
  name: z.string().min(1),
  code: z.string().min(1),
  legalName: z.string().optional(),
  taxId: z.string().optional(),
  currency: z.string().default('UZS'),
});

const branchSchema = z.object({
  companyId: z.string().min(1),
  name: z.string().min(1),
  code: z.string().min(1),
  address: z.string().optional(),
});

export default async function orgRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', blockIfInactiveWrite);

  // ---- Companies ----
  app.get('/companies', { preHandler: [requirePermission('org.read')] }, async (req) => {
    const companies = await prisma.company.findMany({
      where: { tenantId: req.auth.tid },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { branches: true, warehouses: true } } },
    });
    return { companies };
  });

  app.post('/companies', { preHandler: [requirePermission('org.manage')] }, async (req, reply) => {
    const body = companySchema.parse(req.body);
    const company = await prisma.company.create({
      data: { ...body, tenantId: req.auth.tid },
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'org.company.create', entity: 'Company', entityId: company.id, meta: body, ip: req.ip });
    return reply.code(201).send({ company });
  });

  // ---- Branches ----
  app.get('/branches', { preHandler: [requirePermission('org.read')] }, async (req) => {
    const branches = await prisma.branch.findMany({
      where: { tenantId: req.auth.tid },
      orderBy: { createdAt: 'asc' },
    });
    return { branches };
  });

  app.post('/branches', { preHandler: [requirePermission('org.manage')] }, async (req, reply) => {
    const body = branchSchema.parse(req.body);
    const company = await prisma.company.findFirst({ where: { id: body.companyId, tenantId: req.auth.tid } });
    if (!company) throw NotFound('Company not found');
    const branch = await prisma.branch.create({ data: { ...body, tenantId: req.auth.tid } });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'org.branch.create', entity: 'Branch', entityId: branch.id, meta: body, ip: req.ip });
    return reply.code(201).send({ branch });
  });
}
