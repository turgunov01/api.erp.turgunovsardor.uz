// Production (Stage 6): bills of materials (BOM) + production orders. A production
// order snapshots the materials required to build a finished product; issuing it
// consumes materials (stock OUT) and completing it receives finished goods (stock IN)
// — always via the shared warehouse contract (src/lib/stock.ts). This closes the
// factory loop: procurement → warehouse → production → sales.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { requirePermission } from '../../plugins/rbac.js';
import { blockIfInactiveWrite } from '../../plugins/subscription.js';
import { applyStockDelta } from '../../lib/stock.js';
import { emitEvent } from '../../lib/events.js';
import { audit } from '../../lib/audit.js';
import { BadRequest, NotFound } from '../../lib/errors.js';
import { pageQuery, skipTake, pageMeta } from '../../lib/pagination.js';
import { quantityPositive } from '../../lib/validators.js';

const D = (v: number | string | Prisma.Decimal) => new Prisma.Decimal(v);

async function nextNumber(prefix: string, count: () => Promise<number>): Promise<string> {
  const n = await count();
  return `${prefix}-${new Date().getFullYear()}-${String(n + 1).padStart(4, '0')}`;
}

// Denormalize product name/sku for production rows (no cross-module FK).
async function productMap(tenantId: string, ids: string[]) {
  const products = await prisma.product.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, name: true, sku: true, type: true } });
  return new Map(products.map((p) => [p.id, p]));
}

export default async function productionRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', blockIfInactiveWrite);

  // ============ BOM (6.1) — bill of materials ============
  const bomItemSchema = z.object({ productId: z.string(), quantity: quantityPositive });
  const bomSchema = z.object({
    productId: z.string(),
    name: z.string().min(1),
    outputQty: quantityPositive.default(1),
    notes: z.string().optional(),
    items: z.array(bomItemSchema).min(1),
  });

  app.get('/boms', { preHandler: [requirePermission('production.read')] }, async (req) => {
    const q = pageQuery.parse(req.query);
    // status filter: 'active' (default) | 'archived' | 'all'
    const st = (req.query as { status?: string }).status;
    const statusFilter = st === 'archived' ? { status: 'archived' } : st === 'all' ? {} : { status: 'active' };
    const where = { tenantId: req.auth.tid, ...statusFilter, ...(q.search ? { OR: [{ name: { contains: q.search, mode: 'insensitive' as const } }, { productName: { contains: q.search, mode: 'insensitive' as const } }, { productSku: { contains: q.search, mode: 'insensitive' as const } }] } : {}) };
    const [boms, total] = await prisma.$transaction([
      prisma.bom.findMany({ where, orderBy: { updatedAt: 'desc' }, include: { items: true, _count: { select: { orders: true } } }, ...skipTake(q) }),
      prisma.bom.count({ where }),
    ]);
    return { boms, meta: pageMeta(q, total) };
  });

  app.get('/boms/:id', { preHandler: [requirePermission('production.read')] }, async (req) => {
    const { id } = req.params as { id: string };
    const bom = await prisma.bom.findFirst({ where: { id, tenantId: req.auth.tid }, include: { items: true } });
    if (!bom) throw NotFound('Спецификация не найдена');
    return { bom };
  });

  app.post('/boms', { preHandler: [requirePermission('production.write')] }, async (req, reply) => {
    const body = bomSchema.parse(req.body);
    const allIds = [body.productId, ...body.items.map((i) => i.productId)];
    const pm = await productMap(req.auth.tid, allIds);
    if (!pm.get(body.productId)) throw NotFound('Готовый продукт не найден');
    if (body.items.some((i) => !pm.get(i.productId))) throw BadRequest('Некоторые материалы не найдены');
    if (body.items.some((i) => i.productId === body.productId)) throw BadRequest('Материал не может совпадать с готовым продуктом', 'SELF_COMPONENT');
    const fin = pm.get(body.productId)!;
    const bom = await prisma.bom.create({
      data: {
        tenantId: req.auth.tid, productId: body.productId, productName: fin.name, productSku: fin.sku,
        name: body.name, outputQty: D(body.outputQty), notes: body.notes ?? null,
        items: { create: body.items.map((i) => ({ productId: i.productId, productName: pm.get(i.productId)!.name, productSku: pm.get(i.productId)!.sku, quantity: D(i.quantity) })) },
      },
      include: { items: true },
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'production.bom.create', entity: 'Bom', entityId: bom.id, meta: { name: body.name }, ip: req.ip });
    return reply.code(201).send({ bom });
  });

  app.patch('/boms/:id', { preHandler: [requirePermission('production.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ name: z.string().min(1).optional(), outputQty: quantityPositive.optional(), notes: z.string().optional(), status: z.enum(['active', 'archived']).optional() }).parse(req.body);
    const bom = await prisma.bom.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!bom) throw NotFound('Спецификация не найдена');
    const updated = await prisma.bom.update({ where: { id }, data: { ...body, outputQty: body.outputQty !== undefined ? D(body.outputQty) : undefined } });
    return reply.send({ bom: updated });
  });

  app.post('/boms/:id/items', { preHandler: [requirePermission('production.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = bomItemSchema.parse(req.body);
    const bom = await prisma.bom.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!bom) throw NotFound('Спецификация не найдена');
    if (body.productId === bom.productId) throw BadRequest('Материал не может совпадать с готовым продуктом', 'SELF_COMPONENT');
    const product = await prisma.product.findFirst({ where: { id: body.productId, tenantId: req.auth.tid } });
    if (!product) throw NotFound('Материал не найден');
    const item = await prisma.bomItem.create({ data: { bomId: id, productId: body.productId, productName: product.name, productSku: product.sku, quantity: D(body.quantity) } });
    return reply.code(201).send({ item });
  });

  app.delete('/boms/:id/items/:itemId', { preHandler: [requirePermission('production.write')] }, async (req, reply) => {
    const { id, itemId } = req.params as { id: string; itemId: string };
    const bom = await prisma.bom.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!bom) throw NotFound('Спецификация не найдена');
    await prisma.bomItem.deleteMany({ where: { id: itemId, bomId: id } });
    return reply.send({ ok: true });
  });

  // ============ PRODUCTION ORDERS (6.2) ============
  function orderView(o: { id: string; number: string; productName: string; productId: string; quantity: Prisma.Decimal; producedQty: Prisma.Decimal; status: string; warehouseId: string | null; plannedAt: Date | null; createdAt: Date; items?: { requiredQty: Prisma.Decimal; consumedQty: Prisma.Decimal }[] }) {
    return {
      id: o.id, number: o.number, product: o.productName, productId: o.productId,
      quantity: o.quantity, producedQty: o.producedQty, status: o.status, warehouseId: o.warehouseId,
      plannedAt: o.plannedAt, createdAt: o.createdAt, materialCount: o.items?.length ?? 0,
    };
  }

  app.get('/orders', { preHandler: [requirePermission('production.read')] }, async (req) => {
    const { status } = req.query as { status?: string };
    const q = pageQuery.parse(req.query);
    const where = { tenantId: req.auth.tid, ...(status ? { status } : {}) };
    const [orders, total] = await prisma.$transaction([
      prisma.productionOrder.findMany({ where, orderBy: { createdAt: 'desc' }, include: { items: true }, ...skipTake(q) }),
      prisma.productionOrder.count({ where }),
    ]);
    return { orders: orders.map(orderView), meta: pageMeta(q, total) };
  });

  app.get('/orders/:id', { preHandler: [requirePermission('production.read')] }, async (req) => {
    const { id } = req.params as { id: string };
    const o = await prisma.productionOrder.findFirst({ where: { id, tenantId: req.auth.tid }, include: { items: true, bom: { select: { name: true, outputQty: true } } } });
    if (!o) throw NotFound('Производственный заказ не найден');
    return { order: o };
  });

  // Create a production order. From a BOM (materials snapshotted & scaled to the
  // ordered quantity) or with an explicit finished product + manual materials.
  app.post('/orders', { preHandler: [requirePermission('production.write')] }, async (req, reply) => {
    const body = z.object({
      bomId: z.string().optional(),
      productId: z.string().optional(),
      quantity: quantityPositive,
      warehouseId: z.string().optional(),
      plannedAt: z.string().optional(),
      note: z.string().optional(),
      items: z.array(z.object({ productId: z.string(), requiredQty: quantityPositive })).optional(),
    }).parse(req.body);

    let productId: string;
    let materials: { productId: string; requiredQty: Prisma.Decimal }[];

    if (body.bomId) {
      const bom = await prisma.bom.findFirst({ where: { id: body.bomId, tenantId: req.auth.tid }, include: { items: true } });
      if (!bom) throw NotFound('Спецификация не найдена');
      if (bom.status !== 'active') throw BadRequest('Спецификация архивирована', 'BOM_ARCHIVED');
      productId = bom.productId;
      // Scale each component: required = component.qty * (orderQty / bom.outputQty).
      const factor = D(body.quantity).div(bom.outputQty);
      materials = bom.items.map((it) => ({ productId: it.productId, requiredQty: D(it.quantity).mul(factor) }));
    } else {
      if (!body.productId) throw BadRequest('Укажите готовый продукт или спецификацию', 'PRODUCT_OR_BOM_REQUIRED');
      if (!body.items || body.items.length === 0) throw BadRequest('Укажите материалы для заказа', 'ITEMS_REQUIRED');
      productId = body.productId;
      materials = body.items.map((i) => ({ productId: i.productId, requiredQty: D(i.requiredQty) }));
    }

    const pm = await productMap(req.auth.tid, [productId, ...materials.map((m) => m.productId)]);
    if (!pm.get(productId)) throw NotFound('Готовый продукт не найден');
    if (materials.some((m) => !pm.get(m.productId))) throw BadRequest('Некоторые материалы не найдены');
    const fin = pm.get(productId)!;
    const number = await nextNumber('PRD', () => prisma.productionOrder.count());
    const order = await prisma.productionOrder.create({
      data: {
        tenantId: req.auth.tid, number, bomId: body.bomId ?? null, productId, productName: fin.name, productSku: fin.sku,
        quantity: D(body.quantity), warehouseId: body.warehouseId ?? null, status: 'draft', createdBy: req.auth.sub,
        plannedAt: body.plannedAt ? new Date(body.plannedAt) : null, note: body.note ?? null,
        items: { create: materials.map((m) => ({ productId: m.productId, productName: pm.get(m.productId)!.name, productSku: pm.get(m.productId)!.sku, requiredQty: m.requiredQty })) },
      },
      include: { items: true },
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'production.order.create', entity: 'ProductionOrder', entityId: order.id, meta: { number }, ip: req.ip });
    return reply.code(201).send({ order });
  });

  app.post('/orders/:id/confirm', { preHandler: [requirePermission('production.confirm')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const o = await prisma.productionOrder.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!o) throw NotFound('Производственный заказ не найден');
    if (o.status !== 'draft') throw BadRequest('Заказ уже подтверждён/обработан', 'BAD_TRANSITION');
    await prisma.productionOrder.update({ where: { id }, data: { status: 'confirmed' } });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'production.order.confirm', entity: 'ProductionOrder', entityId: id, ip: req.ip });
    return reply.send({ ok: true });
  });

  // Check material availability at a warehouse — a shortfall preview (6.3 support).
  app.get('/orders/:id/availability', { preHandler: [requirePermission('production.read')] }, async (req) => {
    const { id } = req.params as { id: string };
    const { warehouseId: wq } = req.query as { warehouseId?: string };
    const o = await prisma.productionOrder.findFirst({ where: { id, tenantId: req.auth.tid }, include: { items: true } });
    if (!o) throw NotFound('Производственный заказ не найден');
    const warehouseId = wq ?? o.warehouseId;
    if (!warehouseId) throw BadRequest('Укажите склад', 'WAREHOUSE_REQUIRED');
    const stock = await prisma.stockItem.findMany({ where: { warehouseId, productId: { in: o.items.map((it) => it.productId) } } });
    const onHand = new Map(stock.map((s) => [s.productId, D(s.quantity)]));
    const lines = o.items.map((it) => {
      const need = D(it.requiredQty).minus(it.consumedQty);
      const have = onHand.get(it.productId) ?? D(0);
      return { productId: it.productId, productName: it.productName, need: need.toString(), onHand: have.toString(), short: need.greaterThan(have) ? need.minus(have).toString() : '0' };
    });
    return { warehouseId, ok: lines.every((l) => l.short === '0'), lines };
  });

  // ============ ISSUE MATERIALS (6.3) — stock OUT for each component ============
  app.post('/orders/:id/issue', { preHandler: [requirePermission('production.execute')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ warehouseId: z.string().optional() }).parse(req.body ?? {});
    const o = await prisma.productionOrder.findFirst({ where: { id, tenantId: req.auth.tid }, include: { items: true } });
    if (!o) throw NotFound('Производственный заказ не найден');
    if (o.status === 'cancelled') throw BadRequest('Заказ отменён');
    if (o.status === 'done') throw BadRequest('Заказ уже завершён');
    if (o.status === 'draft') throw BadRequest('Сначала подтвердите заказ', 'NOT_CONFIRMED');
    const warehouseId = body.warehouseId ?? o.warehouseId;
    if (!warehouseId) throw BadRequest('Укажите склад для списания', 'WAREHOUSE_REQUIRED');
    const wh = await prisma.warehouse.findFirst({ where: { id: warehouseId, tenantId: req.auth.tid } });
    if (!wh) throw NotFound('Склад не найден');

    // Everything still owed across the order's materials.
    const toConsume = o.items.map((it) => ({ it, need: D(it.requiredQty).minus(it.consumedQty) })).filter((x) => x.need.greaterThan(0));
    if (toConsume.length === 0) throw BadRequest('Все материалы уже списаны', 'NOTHING_TO_ISSUE');

    // Pre-check on-hand for every material so we never partially consume then fail.
    const stock = await prisma.stockItem.findMany({ where: { warehouseId, productId: { in: toConsume.map((x) => x.it.productId) } } });
    const onHand = new Map(stock.map((s) => [s.productId, D(s.quantity)]));
    for (const { it, need } of toConsume) {
      const have = onHand.get(it.productId) ?? D(0);
      if (need.greaterThan(have)) throw BadRequest(`Недостаточно материала «${it.productName}» (нужно ${need.toString()}, на складе ${have.toString()})`, 'INSUFFICIENT_STOCK');
    }

    await prisma.$transaction(async (tx) => {
      let issuedCostMinor = 0n;
      for (const { it, need } of toConsume) {
        const res = await applyStockDelta(tx, { tenantId: req.auth.tid, warehouseId, productId: it.productId, type: 'OUT', delta: need.negated(), reason: `Списание в производство ${o.number}`, refType: 'ProductionOrder', refId: o.id, userId: req.auth.sub });
        issuedCostMinor += res.costMinor;
        await tx.productionOrderItem.update({ where: { id: it.id }, data: { consumedQty: D(it.consumedQty).plus(need) } });
      }
      await tx.productionOrder.update({ where: { id: o.id }, data: { status: 'in_progress', warehouseId, materialCostMinor: BigInt(o.materialCostMinor) + issuedCostMinor } });
      // Auto-posting (Stage 8.4): Dr WIP / Cr Inventory for issued materials.
      await emitEvent('production.issued', { refId: o.id, number: o.number, costMinor: issuedCostMinor }, { tx, tenantId: req.auth.tid, userId: req.auth.sub });
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'production.order.issue', entity: 'ProductionOrder', entityId: id, meta: { warehouseId }, ip: req.ip });
    return reply.send({ ok: true });
  });

  // ============ RECEIVE FINISHED GOODS (6.3) — stock IN of the product ============
  app.post('/orders/:id/complete', { preHandler: [requirePermission('production.execute')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ warehouseId: z.string().optional(), quantity: quantityPositive.optional() }).parse(req.body ?? {});
    const o = await prisma.productionOrder.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!o) throw NotFound('Производственный заказ не найден');
    if (o.status === 'cancelled') throw BadRequest('Заказ отменён');
    if (o.status === 'done') throw BadRequest('Заказ уже завершён', 'ALREADY_DONE');
    if (o.status !== 'in_progress') throw BadRequest('Сначала спишите материалы в производство', 'NOT_ISSUED');
    const warehouseId = body.warehouseId ?? o.warehouseId;
    if (!warehouseId) throw BadRequest('Укажите склад для оприходования', 'WAREHOUSE_REQUIRED');
    const wh = await prisma.warehouse.findFirst({ where: { id: warehouseId, tenantId: req.auth.tid } });
    if (!wh) throw NotFound('Склад не найден');

    const remaining = D(o.quantity).minus(o.producedQty);
    const produce = body.quantity !== undefined ? D(body.quantity) : remaining;
    if (produce.lessThanOrEqualTo(0)) throw BadRequest('Нечего оприходовать', 'NOTHING_TO_PRODUCE');
    if (produce.greaterThan(remaining)) throw BadRequest(`Оприходование превышает план (осталось ${remaining.toString()})`, 'OVER_PRODUCE');

    // Finished-goods unit cost = accumulated material (WIP) cost spread over planned output.
    const unitCostMinor = D(o.quantity).greaterThan(0)
      ? BigInt(D(o.materialCostMinor.toString()).div(o.quantity).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0))
      : 0n;
    const producedCostMinor = BigInt(produce.mul(unitCostMinor.toString()).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0));
    await prisma.$transaction(async (tx) => {
      await applyStockDelta(tx, { tenantId: req.auth.tid, warehouseId, productId: o.productId, type: 'IN', delta: produce, reason: `Приход из производства ${o.number}`, refType: 'ProductionOrder', refId: o.id, userId: req.auth.sub, unitCostMinor });
      const newProduced = D(o.producedQty).plus(produce);
      await tx.productionOrder.update({ where: { id: o.id }, data: { producedQty: newProduced, status: newProduced.greaterThanOrEqualTo(o.quantity) ? 'done' : 'in_progress', warehouseId } });
      // Auto-posting (Stage 8.4): Dr Inventory (finished goods) / Cr WIP.
      await emitEvent('production.completed', { refId: o.id, number: o.number, costMinor: producedCostMinor }, { tx, tenantId: req.auth.tid, userId: req.auth.sub });
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'production.order.complete', entity: 'ProductionOrder', entityId: id, meta: { produced: produce.toString() }, ip: req.ip });
    return reply.send({ ok: true });
  });

  app.post('/orders/:id/cancel', { preHandler: [requirePermission('production.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const o = await prisma.productionOrder.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!o) throw NotFound('Производственный заказ не найден');
    if (o.status === 'done') throw BadRequest('Завершённый заказ нельзя отменить');
    if (o.status === 'in_progress') throw BadRequest('Нельзя отменить заказ с уже списанными материалами', 'ALREADY_ISSUED');
    await prisma.productionOrder.update({ where: { id }, data: { status: 'cancelled' } });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'production.order.cancel', entity: 'ProductionOrder', entityId: id, ip: req.ip });
    return reply.send({ ok: true });
  });

  // ============ WORK CENTERS (6.4) ============
  app.get('/work-centers', { preHandler: [requirePermission('production.read')] }, async (req) => {
    const workCenters = await prisma.workCenter.findMany({ where: { tenantId: req.auth.tid }, orderBy: { code: 'asc' } });
    return { workCenters };
  });

  const wcBody = z.object({
    code: z.string().min(1).max(40).regex(/^[a-z0-9_-]+$/i, 'Латиница/цифры/дефис'),
    name: z.string().min(1).max(120),
    type: z.enum(['machining', 'assembly', 'welding', 'painting', 'qc', 'other']).default('other'),
    hourlyCostMinor: z.number().int().min(0).default(0),
    status: z.enum(['active', 'inactive']).optional(),
    note: z.string().max(300).nullish(),
  });

  app.post('/work-centers', { preHandler: [requirePermission('production.write')] }, async (req, reply) => {
    const body = wcBody.parse(req.body);
    if (await prisma.workCenter.findUnique({ where: { tenantId_code: { tenantId: req.auth.tid, code: body.code } } })) throw BadRequest('Рабочий центр с таким кодом уже есть', 'CODE_EXISTS');
    const workCenter = await prisma.workCenter.create({ data: { tenantId: req.auth.tid, code: body.code, name: body.name, type: body.type, hourlyCostMinor: BigInt(body.hourlyCostMinor), status: body.status ?? 'active', note: body.note || null } });
    return reply.code(201).send({ workCenter });
  });

  app.patch('/work-centers/:id', { preHandler: [requirePermission('production.write')] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = wcBody.partial().parse(req.body);
    const existing = await prisma.workCenter.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!existing) throw NotFound('Рабочий центр не найден');
    const data: Prisma.WorkCenterUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.type !== undefined) data.type = body.type;
    if (body.hourlyCostMinor !== undefined) data.hourlyCostMinor = BigInt(body.hourlyCostMinor);
    if (body.status !== undefined) data.status = body.status;
    if (body.note !== undefined) data.note = body.note || null;
    const workCenter = await prisma.workCenter.update({ where: { id }, data });
    return { workCenter };
  });

  app.delete('/work-centers/:id', { preHandler: [requirePermission('production.write')] }, async (req) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.workCenter.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!existing) throw NotFound('Рабочий центр не найден');
    const used = await prisma.productionOperation.count({ where: { tenantId: req.auth.tid, workCenterId: id, status: { in: ['pending', 'in_progress'] } } });
    if (used > 0) throw BadRequest('Центр используется в активных операциях', 'WORK_CENTER_BUSY');
    await prisma.workCenter.delete({ where: { id } });
    return { ok: true };
  });

  // ============ ROUTING OPERATIONS (6.4) ============
  // Full routing + QC view for one order.
  app.get('/orders/:id/routing', { preHandler: [requirePermission('production.read')] }, async (req) => {
    const { id } = req.params as { id: string };
    const order = await prisma.productionOrder.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!order) throw NotFound('Производственный заказ не найден');
    const [operations, quality] = await Promise.all([
      prisma.productionOperation.findMany({ where: { orderId: id }, orderBy: { sequence: 'asc' } }),
      prisma.qualityCheck.findMany({ where: { orderId: id }, orderBy: { createdAt: 'desc' } }),
    ]);
    const laborCostMinor = operations.reduce((a, o) => a + o.costMinor, 0n);
    return { order, operations, quality, summary: { laborCostMinor, scrapQty: order.scrapQty } };
  });

  app.post('/orders/:id/operations', { preHandler: [requirePermission('production.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ name: z.string().min(1).max(160), workCenterId: z.string().nullish(), plannedMinutes: z.number().int().min(0).default(0) }).parse(req.body);
    const order = await prisma.productionOrder.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!order) throw NotFound('Производственный заказ не найден');
    let workCenterName: string | null = null;
    let costMinor = 0n;
    if (body.workCenterId) {
      const wc = await prisma.workCenter.findFirst({ where: { id: body.workCenterId, tenantId: req.auth.tid } });
      if (!wc) throw NotFound('Рабочий центр не найден');
      workCenterName = wc.name;
      costMinor = (wc.hourlyCostMinor * BigInt(body.plannedMinutes)) / 60n;
    }
    const count = await prisma.productionOperation.count({ where: { orderId: id } });
    const operation = await prisma.productionOperation.create({ data: { tenantId: req.auth.tid, orderId: id, workCenterId: body.workCenterId || null, workCenterName, sequence: count, name: body.name, plannedMinutes: body.plannedMinutes, costMinor } });
    return reply.code(201).send({ operation });
  });

  app.post('/operations/:opId/start', { preHandler: [requirePermission('production.execute')] }, async (req) => {
    const { opId } = req.params as { opId: string };
    const op = await prisma.productionOperation.findFirst({ where: { id: opId, tenantId: req.auth.tid } });
    if (!op) throw NotFound('Операция не найдена');
    if (op.status !== 'pending') throw BadRequest('Операцию можно начать только из статуса «ожидает»', 'BAD_STATE');
    const operation = await prisma.productionOperation.update({ where: { id: opId }, data: { status: 'in_progress', startedAt: new Date() } });
    return { operation };
  });

  app.post('/operations/:opId/complete', { preHandler: [requirePermission('production.execute')] }, async (req) => {
    const { opId } = req.params as { opId: string };
    const body = z.object({ actualMinutes: z.number().int().min(0).nullish() }).parse(req.body ?? {});
    const op = await prisma.productionOperation.findFirst({ where: { id: opId, tenantId: req.auth.tid }, include: { workCenter: true } });
    if (!op) throw NotFound('Операция не найдена');
    if (op.status === 'done') throw BadRequest('Операция уже завершена', 'BAD_STATE');
    const actual = body.actualMinutes ?? op.plannedMinutes;
    // Recompute cost from actual time if a work center rate is available.
    const costMinor = op.workCenter ? (op.workCenter.hourlyCostMinor * BigInt(actual)) / 60n : op.costMinor;
    const operation = await prisma.productionOperation.update({ where: { id: opId }, data: { status: 'done', actualMinutes: actual, costMinor, finishedAt: new Date() } });
    return { operation };
  });

  app.delete('/operations/:opId', { preHandler: [requirePermission('production.write')] }, async (req) => {
    const { opId } = req.params as { opId: string };
    const op = await prisma.productionOperation.findFirst({ where: { id: opId, tenantId: req.auth.tid } });
    if (!op) throw NotFound('Операция не найдена');
    await prisma.productionOperation.delete({ where: { id: opId } });
    return { ok: true };
  });

  // ============ QUALITY CONTROL + SCRAP (6.5) ============
  app.post('/orders/:id/quality', { preHandler: [requirePermission('production.execute')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ checkedQty: quantityPositive, defectQty: z.coerce.number().min(0).default(0), inspector: z.string().max(120).nullish(), note: z.string().max(300).nullish() }).parse(req.body);
    const order = await prisma.productionOrder.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!order) throw NotFound('Производственный заказ не найден');
    const checked = D(body.checkedQty);
    const defect = D(body.defectQty);
    if (defect.greaterThan(checked)) throw BadRequest('Брак не может превышать проверенное количество', 'DEFECT_TOO_LARGE');
    const passed = checked.minus(defect);
    const result = defect.isZero() ? 'pass' : (passed.isZero() ? 'fail' : 'partial');
    const check = await prisma.$transaction(async (tx) => {
      const c = await tx.qualityCheck.create({ data: { tenantId: req.auth.tid, orderId: id, checkedQty: checked, passedQty: passed, defectQty: defect, result, inspector: body.inspector || null, note: body.note || null, createdBy: req.auth.sub } });
      if (defect.greaterThan(0)) await tx.productionOrder.update({ where: { id }, data: { scrapQty: D(order.scrapQty).plus(defect) } });
      return c;
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'production.quality', entity: 'ProductionOrder', entityId: id, meta: { defect: defect.toString(), result }, ip: req.ip });
    return reply.code(201).send({ check });
  });
}
