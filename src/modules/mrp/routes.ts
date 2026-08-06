// MRP — планирование потребности в материалах (Stage 19, ТЗ 6.6). Nets production
// demand + min-stock top-up against available stock and open purchase orders, producing
// a shortage list that can be turned into a single purchase request (Stage 4). Ties
// production + inventory + procurement. Gated by procurement permissions.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { requirePermission } from '../../plugins/rbac.js';
import { blockIfInactiveWrite } from '../../plugins/subscription.js';
import { audit } from '../../lib/audit.js';
import { BadRequest, NotFound } from '../../lib/errors.js';
import { nextDocNumber } from '../../lib/ledger.js';

const D = (v: number | string | Prisma.Decimal) => new Prisma.Decimal(v);
const DMax = (a: Prisma.Decimal, b: Prisma.Decimal) => (a.greaterThan(b) ? a : b);

interface MrpLineCalc {
  productId: string; productName: string; productSku: string | null;
  demandQty: Prisma.Decimal; minTopUpQty: Prisma.Decimal; onHandQty: Prisma.Decimal;
  onOrderQty: Prisma.Decimal; netQty: Prisma.Decimal; suggestedQty: Prisma.Decimal;
}

// Compute net material requirements for a tenant.
async function computeMrp(tenantId: string, includeMinStock: boolean): Promise<MrpLineCalc[]> {
  // 1) Demand: remaining materials of production orders not yet finished/cancelled.
  const orders = await prisma.productionOrder.findMany({
    where: { tenantId, status: { in: ['draft', 'confirmed', 'in_progress'] } },
    include: { items: true },
  });
  const demand = new Map<string, Prisma.Decimal>();
  for (const o of orders) {
    for (const it of o.items) {
      const remaining = D(it.requiredQty).minus(it.consumedQty);
      if (remaining.greaterThan(0)) demand.set(it.productId, (demand.get(it.productId) ?? D(0)).plus(remaining));
    }
  }

  // 2) Stock aggregated per product (across warehouses).
  const stockItems = await prisma.stockItem.findMany({ where: { tenantId } });
  const onHand = new Map<string, Prisma.Decimal>();
  const reserved = new Map<string, Prisma.Decimal>();
  const minQ = new Map<string, Prisma.Decimal>();
  const reorderQ = new Map<string, Prisma.Decimal>();
  for (const si of stockItems) {
    onHand.set(si.productId, (onHand.get(si.productId) ?? D(0)).plus(si.quantity));
    reserved.set(si.productId, (reserved.get(si.productId) ?? D(0)).plus(si.reserved));
    minQ.set(si.productId, DMax(minQ.get(si.productId) ?? D(0), D(si.minQty)));
    reorderQ.set(si.productId, DMax(reorderQ.get(si.productId) ?? D(0), D(si.reorderQty)));
  }

  // 3) Candidates: everything with demand, plus (optionally) anything with a min level.
  const candidates = new Set<string>(demand.keys());
  if (includeMinStock) for (const [pid, mq] of minQ) if (mq.greaterThan(0)) candidates.add(pid);

  // 4) On-order: undelivered quantity on open purchase orders.
  const poItems = await prisma.purchaseOrderItem.findMany({ where: { po: { tenantId, status: { in: ['sent', 'partially_received'] } } } });
  const onOrder = new Map<string, Prisma.Decimal>();
  for (const it of poItems) onOrder.set(it.productId, (onOrder.get(it.productId) ?? D(0)).plus(D(it.quantity).minus(it.receivedQty)));

  // 5) Product names.
  const products = await prisma.product.findMany({ where: { tenantId, id: { in: [...candidates] } }, select: { id: true, name: true, sku: true } });
  const pById = new Map(products.map((p) => [p.id, p]));

  const lines: MrpLineCalc[] = [];
  for (const pid of candidates) {
    const p = pById.get(pid);
    if (!p) continue;
    const dem = demand.get(pid) ?? D(0);
    const oh = onHand.get(pid) ?? D(0);
    const available = oh.minus(reserved.get(pid) ?? D(0));
    const oo = onOrder.get(pid) ?? D(0);
    let minTop = D(0);
    if (includeMinStock) {
      const mq = minQ.get(pid) ?? D(0);
      if (mq.greaterThan(0) && available.lessThan(mq)) minTop = DMax(mq.minus(available), reorderQ.get(pid) ?? D(0));
    }
    const net = dem.plus(minTop).minus(available).minus(oo);
    const suggested = net.greaterThan(0) ? net : D(0);
    if (dem.greaterThan(0) || minTop.greaterThan(0)) {
      lines.push({ productId: pid, productName: p.name, productSku: p.sku, demandQty: dem, minTopUpQty: minTop, onHandQty: oh, onOrderQty: oo, netQty: net, suggestedQty: suggested });
    }
  }
  lines.sort((a, b) => b.suggestedQty.comparedTo(a.suggestedQty));
  return lines;
}

export default async function mrpRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', blockIfInactiveWrite);

  // Preview a plan without persisting (quick "what do we need").
  app.get('/preview', { preHandler: [requirePermission('procurement.read')] }, async (req) => {
    const q = z.object({ includeMinStock: z.coerce.boolean().default(true) }).parse(req.query);
    const lines = await computeMrp(req.auth.tid, q.includeMinStock);
    return { lines, shortageCount: lines.filter((l) => l.suggestedQty.greaterThan(0)).length };
  });

  app.get('/runs', { preHandler: [requirePermission('procurement.read')] }, async (req) => {
    const runs = await prisma.mrpRun.findMany({ where: { tenantId: req.auth.tid }, include: { _count: { select: { lines: true } } }, orderBy: { createdAt: 'desc' }, take: 100 });
    return { runs };
  });

  app.get('/runs/:id', { preHandler: [requirePermission('procurement.read')] }, async (req) => {
    const { id } = req.params as { id: string };
    const run = await prisma.mrpRun.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!run) throw NotFound('Расчёт MRP не найден');
    const lines = await prisma.mrpLine.findMany({ where: { runId: id }, orderBy: { suggestedQty: 'desc' } });
    return { run, lines };
  });

  // Compute + persist a run (snapshot the plan).
  app.post('/runs', { preHandler: [requirePermission('procurement.write')] }, async (req, reply) => {
    const body = z.object({ includeMinStock: z.boolean().default(true), note: z.string().max(300).nullish() }).parse(req.body ?? {});
    const calc = await computeMrp(req.auth.tid, body.includeMinStock);
    const run = await prisma.$transaction(async (tx) => {
      const number = await nextDocNumber(tx, req.auth.tid, 'mrp', 'MRP');
      const r = await tx.mrpRun.create({ data: { tenantId: req.auth.tid, number, includeMinStock: body.includeMinStock, note: body.note || null, createdBy: req.auth.sub } });
      for (const l of calc) {
        await tx.mrpLine.create({ data: { tenantId: req.auth.tid, runId: r.id, productId: l.productId, productName: l.productName, productSku: l.productSku, demandQty: l.demandQty, minTopUpQty: l.minTopUpQty, onHandQty: l.onHandQty, onOrderQty: l.onOrderQty, netQty: l.netQty, suggestedQty: l.suggestedQty } });
      }
      return r;
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'mrp.run', entity: 'MrpRun', entityId: run.id, meta: { lines: calc.length }, ip: req.ip });
    const lines = await prisma.mrpLine.findMany({ where: { runId: run.id }, orderBy: { suggestedQty: 'desc' } });
    return reply.code(201).send({ run, lines });
  });

  // Apply: create ONE purchase request from the shortage lines (suggestedQty > 0).
  app.post('/runs/:id/apply', { preHandler: [requirePermission('procurement.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = await prisma.mrpRun.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!run) throw NotFound('Расчёт MRP не найден');
    if (run.status === 'applied') throw BadRequest('По этому расчёту уже создана заявка', 'ALREADY_APPLIED');
    const lines = await prisma.mrpLine.findMany({ where: { runId: id, suggestedQty: { gt: 0 } } });
    if (lines.length === 0) throw BadRequest('Нет позиций к заказу (дефицита нет)', 'NOTHING_TO_ORDER');

    const result = await prisma.$transaction(async (tx) => {
      // Match the procurement module's PR numbering (global count, PR-YYYY-NNNN) so the
      // generated request slots into the same unique sequence.
      const n = await tx.purchaseRequest.count();
      const number = `PR-${new Date().getFullYear()}-${String(n + 1).padStart(4, '0')}`;
      const request = await tx.purchaseRequest.create({
        data: {
          tenantId: req.auth.tid, number, status: 'pending', requestedBy: req.auth.sub, note: `Автозаявка по расчёту MRP ${run.number}`,
          items: { create: lines.map((l) => ({ productId: l.productId, productName: l.productName, productSku: l.productSku, quantity: l.suggestedQty })) },
        },
      });
      await tx.mrpRun.update({ where: { id }, data: { status: 'applied', requestId: request.id, requestNumber: request.number } });
      return request;
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'mrp.apply', entity: 'MrpRun', entityId: id, meta: { request: result.number, items: lines.length }, ip: req.ip });
    return reply.code(201).send({ requestId: result.id, requestNumber: result.number, itemCount: lines.length });
  });

  app.delete('/runs/:id', { preHandler: [requirePermission('procurement.write')] }, async (req) => {
    const { id } = req.params as { id: string };
    const run = await prisma.mrpRun.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!run) throw NotFound('Расчёт MRP не найден');
    await prisma.mrpRun.delete({ where: { id } });
    return { ok: true };
  });
}
