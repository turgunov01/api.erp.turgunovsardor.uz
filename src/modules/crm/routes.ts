// CRM (Stage 5): deals + sales funnel (kanban). A deal moves through stages
// lead → qualified → proposal → won | lost, with an amount, probability and
// (on loss) a reason. Grouped view feeds the kanban board.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { requirePermission } from '../../plugins/rbac.js';
import { blockIfInactiveWrite } from '../../plugins/subscription.js';
import { audit } from '../../lib/audit.js';
import { BadRequest, NotFound } from '../../lib/errors.js';
import { moneyMinor } from '../../lib/validators.js';

export const DEAL_STAGES = ['lead', 'qualified', 'proposal', 'won', 'lost'] as const;
const stageEnum = z.enum(DEAL_STAGES);

export default async function crmRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', blockIfInactiveWrite);

  const dealSchema = z.object({
    title: z.string().min(1),
    customerId: z.string().optional(),
    stage: stageEnum.optional(),
    amountMinor: moneyMinor.optional(),
    probability: z.number().int().min(0).max(100).optional(),
    note: z.string().optional(),
    expectedCloseAt: z.string().optional(),
  });

  // Flat list (optionally filtered by stage).
  app.get('/deals', { preHandler: [requirePermission('crm.read')] }, async (req) => {
    const { stage } = req.query as { stage?: string };
    const where = { tenantId: req.auth.tid, ...(stage ? { stage } : {}) };
    const deals = await prisma.deal.findMany({ where, orderBy: { updatedAt: 'desc' }, include: { customer: { select: { name: true } } }, take: 500 });
    return { deals: deals.map((d) => ({ ...d, customer: d.customer?.name ?? null })) };
  });

  // Kanban: deals grouped by stage + per-stage totals.
  app.get('/funnel', { preHandler: [requirePermission('crm.read')] }, async (req) => {
    const deals = await prisma.deal.findMany({ where: { tenantId: req.auth.tid }, orderBy: { updatedAt: 'desc' }, include: { customer: { select: { name: true } } }, take: 500 });
    const columns = DEAL_STAGES.map((stage) => {
      const items = deals.filter((d) => d.stage === stage).map((d) => ({ id: d.id, title: d.title, customer: d.customer?.name ?? null, amountMinor: d.amountMinor, probability: d.probability, expectedCloseAt: d.expectedCloseAt, lostReason: d.lostReason }));
      return { stage, count: items.length, totalMinor: items.reduce((s, d) => s + Number(d.amountMinor), 0), items };
    });
    return { columns };
  });

  app.post('/deals', { preHandler: [requirePermission('crm.write')] }, async (req, reply) => {
    const body = dealSchema.parse(req.body);
    if (body.customerId) {
      const c = await prisma.customer.findFirst({ where: { id: body.customerId, tenantId: req.auth.tid } });
      if (!c) throw NotFound('Клиент не найден');
    }
    const deal = await prisma.deal.create({
      data: {
        tenantId: req.auth.tid, title: body.title, customerId: body.customerId ?? null, stage: body.stage ?? 'lead',
        amountMinor: body.amountMinor ?? 0, probability: body.probability ?? 0, note: body.note ?? null,
        ownerId: req.auth.sub, expectedCloseAt: body.expectedCloseAt ? new Date(body.expectedCloseAt) : null,
      },
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'crm.deal.create', entity: 'Deal', entityId: deal.id, meta: { title: body.title }, ip: req.ip });
    return reply.code(201).send({ deal });
  });

  app.patch('/deals/:id', { preHandler: [requirePermission('crm.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = dealSchema.partial().parse(req.body);
    const d = await prisma.deal.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!d) throw NotFound('Сделка не найдена');
    const deal = await prisma.deal.update({ where: { id }, data: { ...body, expectedCloseAt: body.expectedCloseAt ? new Date(body.expectedCloseAt) : undefined } });
    return reply.send({ deal });
  });

  // Move a deal to another stage (kanban drag). Losing requires a reason.
  app.post('/deals/:id/move', { preHandler: [requirePermission('crm.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ stage: stageEnum, lostReason: z.string().optional() }).parse(req.body);
    const d = await prisma.deal.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!d) throw NotFound('Сделка не найдена');
    if (body.stage === 'lost' && !body.lostReason) throw BadRequest('Укажите причину отказа', 'LOST_REASON_REQUIRED');
    const probability = body.stage === 'won' ? 100 : body.stage === 'lost' ? 0 : d.probability;
    await prisma.deal.update({ where: { id }, data: { stage: body.stage, lostReason: body.stage === 'lost' ? body.lostReason ?? null : null, probability } });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'crm.deal.move', entity: 'Deal', entityId: id, meta: { stage: body.stage }, ip: req.ip });
    return reply.send({ ok: true });
  });

  app.delete('/deals/:id', { preHandler: [requirePermission('crm.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const d = await prisma.deal.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!d) throw NotFound('Сделка не найдена');
    await prisma.deal.delete({ where: { id } });
    return reply.send({ ok: true });
  });
}
