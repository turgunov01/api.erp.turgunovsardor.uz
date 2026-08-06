// Advanced warehouse (Stage 7): bin locations (7.1), inventory counts (7.2),
// batches/serials/expiry (7.3) and min-stock reorder → auto purchase requests (7.4).
// The aggregate StockItem stays the source of truth; bins and batches are opt-in
// refinements. Counts reconcile through the warehouse contract (ADJUST via
// src/lib/stock.ts). Product refs are denormalized String ids (module convention).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { requirePermission } from '../../plugins/rbac.js';
import { blockIfInactiveWrite } from '../../plugins/subscription.js';
import { applyStockDelta } from '../../lib/stock.js';
import { audit } from '../../lib/audit.js';
import { notifyOwners } from '../../lib/notify.js';
import { BadRequest, NotFound } from '../../lib/errors.js';
import { quantityPositive } from '../../lib/validators.js';
import { buildXlsx } from '../../lib/xlsx.js';

const D = (v: number | string | Prisma.Decimal) => new Prisma.Decimal(v);

async function nextNumber(prefix: string, count: () => Promise<number>): Promise<string> {
  const n = await count();
  return `${prefix}-${new Date().getFullYear()}-${String(n + 1).padStart(4, '0')}`;
}
async function productMap(tenantId: string, ids: string[]) {
  const products = await prisma.product.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, name: true, sku: true, tracking: true } });
  return new Map(products.map((p) => [p.id, p]));
}
async function warehouseOr404(tenantId: string, warehouseId: string) {
  const wh = await prisma.warehouse.findFirst({ where: { id: warehouseId, tenantId } });
  if (!wh) throw NotFound('Склад не найден');
  return wh;
}

export default async function inventoryRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', blockIfInactiveWrite);

  // ================= 7.1 BIN LOCATIONS (zone→rack→shelf→bin tree) =================
  // Hierarchy levels: a child must sit exactly one level below its parent.
  const LOC_LEVEL: Record<string, number> = { zone: 0, rack: 1, shelf: 2, bin: 3 };
  const LOC_LABEL: Record<string, string> = { zone: 'зона', rack: 'стеллаж', shelf: 'полка', bin: 'ячейка' };

  app.get('/locations', { preHandler: [requirePermission('warehouse.read')] }, async (req) => {
    const { warehouseId, parentId, stats } = req.query as { warehouseId?: string; parentId?: string; stats?: string };
    const where: Record<string, unknown> = { tenantId: req.auth.tid, status: 'active', ...(warehouseId ? { warehouseId } : {}) };
    // When parentId is supplied, return only that node's direct children.
    // parentId='' or 'root' means the top level (zones with no parent). Absent = whole flat list.
    if (parentId !== undefined) where.parentId = parentId && parentId !== 'root' ? parentId : null;
    const rows = await prisma.warehouseLocation.findMany({
      where, orderBy: { code: 'asc' }, include: { _count: { select: { children: true } } },
    });
    let locations = rows.map(({ _count, ...l }) => ({ ...l, childCount: _count.children }));

    // stats=1 → attach positionCount: number of stock LINE-ITEMS (distinct product-in-bin
    // entries, qty>0) within each node's whole subtree — NOT the summed unit quantity.
    if (stats === '1' && warehouseId) {
      const [allLocs, bins] = await Promise.all([
        prisma.warehouseLocation.findMany({ where: { tenantId: req.auth.tid, warehouseId }, select: { id: true, parentId: true } }),
        prisma.binStock.findMany({ where: { tenantId: req.auth.tid, warehouseId, quantity: { gt: 0 } }, select: { locationId: true } }),
      ]);
      const posByLoc = new Map<string, number>();
      for (const b of bins) posByLoc.set(b.locationId, (posByLoc.get(b.locationId) ?? 0) + 1);
      const childrenOf = new Map<string, string[]>();
      for (const l of allLocs) if (l.parentId) childrenOf.set(l.parentId, [...(childrenOf.get(l.parentId) ?? []), l.id]);
      const memo = new Map<string, number>();
      const subtreePos = (id: string): number => {
        if (memo.has(id)) return memo.get(id)!;
        let total = posByLoc.get(id) ?? 0;
        for (const ch of childrenOf.get(id) ?? []) total += subtreePos(ch);
        memo.set(id, total);
        return total;
      };
      locations = locations.map((l) => ({ ...l, positionCount: subtreePos(l.id) }));
    }
    return { locations };
  });

  app.post('/locations', { preHandler: [requirePermission('warehouse.locations')] }, async (req, reply) => {
    const body = z.object({
      warehouseId: z.string(),
      code: z.string().min(1),
      name: z.string().min(1),
      kind: z.enum(['zone', 'rack', 'shelf', 'bin']).default('bin'),
      parentId: z.string().optional(),
    }).parse(req.body);
    await warehouseOr404(req.auth.tid, body.warehouseId);
    // Validate the tree: a top-level node must be a zone; a child must be exactly one level below its parent.
    if (!body.parentId) {
      if (LOC_LEVEL[body.kind] !== 0) throw BadRequest(`Верхний уровень — только зона (${LOC_LABEL[body.kind]} должна быть внутри родителя)`, 'PARENT_REQUIRED');
    } else {
      const parent = await prisma.warehouseLocation.findFirst({ where: { id: body.parentId, tenantId: req.auth.tid, warehouseId: body.warehouseId } });
      if (!parent) throw NotFound('Родительская позиция не найдена');
      if (LOC_LEVEL[body.kind] !== LOC_LEVEL[parent.kind] + 1) {
        throw BadRequest(`Внутри «${LOC_LABEL[parent.kind]}» можно создать только «${LOC_LABEL[Object.keys(LOC_LEVEL).find((k) => LOC_LEVEL[k] === LOC_LEVEL[parent.kind] + 1) || 'bin']}»`, 'BAD_HIERARCHY');
      }
    }
    // Uniqueness is per-parent (siblings), not per-warehouse: the same code may repeat
    // under different parents (R-01 in every zone, S-01 in every rack, etc.).
    const clash = await prisma.warehouseLocation.findFirst({ where: { tenantId: req.auth.tid, warehouseId: body.warehouseId, parentId: body.parentId || null, code: body.code } });
    if (clash) throw BadRequest(`«${body.code}» уже есть на этом уровне (внутри одного родителя)`, 'CODE_EXISTS');
    const location = await prisma.warehouseLocation.create({ data: { ...body, parentId: body.parentId || null, tenantId: req.auth.tid } });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'warehouse.location.create', entity: 'WarehouseLocation', entityId: location.id, meta: { code: body.code, kind: body.kind }, ip: req.ip });
    return reply.code(201).send({ location });
  });

  app.patch('/locations/:id', { preHandler: [requirePermission('warehouse.locations')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ name: z.string().min(1).optional(), kind: z.enum(['zone', 'rack', 'shelf', 'bin']).optional(), status: z.enum(['active', 'archived']).optional() }).parse(req.body);
    const loc = await prisma.warehouseLocation.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!loc) throw NotFound('Ячейка не найдена');
    return reply.send({ location: await prisma.warehouseLocation.update({ where: { id }, data: body }) });
  });

  app.delete('/locations/:id', { preHandler: [requirePermission('warehouse.locations')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const loc = await prisma.warehouseLocation.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!loc) throw NotFound('Позиция не найдена');
    const children = await prisma.warehouseLocation.count({ where: { tenantId: req.auth.tid, parentId: id } });
    if (children > 0) throw BadRequest(`Нельзя удалить: внутри есть вложенные позиции (${children}). Сначала удалите их.`, 'HAS_CHILDREN');
    const inUse = await prisma.binStock.count({ where: { tenantId: req.auth.tid, locationId: id, quantity: { gt: 0 } } });
    if (inUse > 0) throw BadRequest(`Нельзя удалить: в ячейке есть товары (${inUse} позиц.).`, 'LOCATION_IN_USE');
    await prisma.$transaction([
      prisma.binStock.deleteMany({ where: { tenantId: req.auth.tid, locationId: id } }),
      prisma.warehouseLocation.delete({ where: { id } }),
    ]);
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'warehouse.location.delete', entity: 'WarehouseLocation', entityId: id, meta: { code: loc.code }, ip: req.ip });
    return reply.send({ ok: true });
  });

  // Bin-level stock map (where within the warehouse a product sits).
  app.get('/bin-stock', { preHandler: [requirePermission('warehouse.read')] }, async (req) => {
    const { warehouseId, productId, locationId } = req.query as { warehouseId?: string; productId?: string; locationId?: string };
    const where = { tenantId: req.auth.tid, ...(warehouseId ? { warehouseId } : {}), ...(productId ? { productId } : {}), ...(locationId ? { locationId } : {}) };
    const [rows, locations] = await Promise.all([
      prisma.binStock.findMany({ where, orderBy: { updatedAt: 'desc' } }),
      prisma.warehouseLocation.findMany({ where: { tenantId: req.auth.tid, ...(warehouseId ? { warehouseId } : {}) } }),
    ]);
    const locName = new Map(locations.map((l) => [l.id, l.code]));
    return { binStock: rows.map((r) => ({ ...r, locationCode: locName.get(r.locationId) ?? '—' })) };
  });

  // Total already binned for a product across the warehouse (≤ warehouse on-hand).
  async function binnedTotal(tx: Prisma.TransactionClient, warehouseId: string, productId: string, exceptLocationId?: string) {
    const rows = await tx.binStock.findMany({ where: { warehouseId, productId, ...(exceptLocationId ? { NOT: { locationId: exceptLocationId } } : {}) } });
    return rows.reduce((s, r) => s.plus(r.quantity), D(0));
  }

  // Place (assign) part of the warehouse on-hand into a bin. Guarded so the total
  // binned for the product never exceeds actual on-hand.
  app.post('/bin-stock/place', { preHandler: [requirePermission('warehouse.move')] }, async (req, reply) => {
    const body = z.object({ warehouseId: z.string(), locationId: z.string(), productId: z.string(), quantity: quantityPositive }).parse(req.body);
    await warehouseOr404(req.auth.tid, body.warehouseId);
    const loc = await prisma.warehouseLocation.findFirst({ where: { id: body.locationId, tenantId: req.auth.tid, warehouseId: body.warehouseId } });
    if (!loc) throw NotFound('Ячейка не найдена на этом складе');
    await prisma.$transaction(async (tx) => {
      const stock = await tx.stockItem.findUnique({ where: { warehouseId_productId: { warehouseId: body.warehouseId, productId: body.productId } } });
      const onHand = stock ? D(stock.quantity) : D(0);
      const othersBinned = await binnedTotal(tx, body.warehouseId, body.productId, body.locationId);
      const existing = await tx.binStock.findUnique({ where: { locationId_productId: { locationId: body.locationId, productId: body.productId } } });
      const newQty = (existing ? D(existing.quantity) : D(0)).plus(body.quantity);
      if (othersBinned.plus(newQty).greaterThan(onHand)) throw BadRequest(`Нельзя разместить больше, чем на складе (свободно ${onHand.minus(othersBinned.plus(existing ? existing.quantity : 0)).toString()})`, 'EXCEEDS_ONHAND');
      await tx.binStock.upsert({
        where: { locationId_productId: { locationId: body.locationId, productId: body.productId } },
        create: { tenantId: req.auth.tid, warehouseId: body.warehouseId, locationId: body.locationId, productId: body.productId, quantity: D(body.quantity) },
        update: { quantity: newQty },
      });
    });
    return reply.send({ ok: true });
  });

  // Move quantity between two bins of the same warehouse (aggregate unchanged).
  app.post('/bin-stock/transfer', { preHandler: [requirePermission('warehouse.move')] }, async (req, reply) => {
    const body = z.object({ warehouseId: z.string(), fromLocationId: z.string(), toLocationId: z.string(), productId: z.string(), quantity: quantityPositive }).parse(req.body);
    if (body.fromLocationId === body.toLocationId) throw BadRequest('Ячейки совпадают');
    await warehouseOr404(req.auth.tid, body.warehouseId);
    await prisma.$transaction(async (tx) => {
      const from = await tx.binStock.findUnique({ where: { locationId_productId: { locationId: body.fromLocationId, productId: body.productId } } });
      if (!from || D(from.quantity).lessThan(body.quantity)) throw BadRequest('Недостаточно в исходной ячейке', 'INSUFFICIENT_BIN');
      await tx.binStock.update({ where: { locationId_productId: { locationId: body.fromLocationId, productId: body.productId } }, data: { quantity: D(from.quantity).minus(body.quantity) } });
      const to = await tx.binStock.findUnique({ where: { locationId_productId: { locationId: body.toLocationId, productId: body.productId } } });
      await tx.binStock.upsert({
        where: { locationId_productId: { locationId: body.toLocationId, productId: body.productId } },
        create: { tenantId: req.auth.tid, warehouseId: body.warehouseId, locationId: body.toLocationId, productId: body.productId, quantity: D(body.quantity) },
        update: { quantity: (to ? D(to.quantity) : D(0)).plus(body.quantity) },
      });
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'warehouse.bin.transfer', entity: 'BinStock', entityId: body.productId, meta: { from: body.fromLocationId, to: body.toLocationId }, ip: req.ip });
    return reply.send({ ok: true });
  });

  // ================= 7.2 INVENTORY COUNTS =================
  app.get('/counts', { preHandler: [requirePermission('warehouse.read')] }, async (req) => {
    const counts = await prisma.stockCount.findMany({ where: { tenantId: req.auth.tid }, orderBy: { createdAt: 'desc' }, include: { _count: { select: { items: true } } }, take: 100 });
    return { counts };
  });

  app.get('/counts/:id', { preHandler: [requirePermission('warehouse.read')] }, async (req) => {
    const { id } = req.params as { id: string };
    const count = await prisma.stockCount.findFirst({ where: { id, tenantId: req.auth.tid }, include: { items: { orderBy: { productName: 'asc' } } } });
    if (!count) throw NotFound('Инвентаризация не найдена');
    const items = count.items.map((it) => ({ ...it, variance: it.countedQty == null ? null : D(it.countedQty).minus(it.systemQty).toString() }));
    return { count: { ...count, items } };
  });

  // Export the count results as a .xlsx file (SKU / product / system / counted / variance).
  app.get('/counts/:id/export', { preHandler: [requirePermission('warehouse.read')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const count = await prisma.stockCount.findFirst({ where: { id, tenantId: req.auth.tid }, include: { items: { orderBy: { productName: 'asc' } } } });
    if (!count) throw NotFound('Инвентаризация не найдена');
    const columns = [
      { key: 'sku', label: 'SKU' },
      { key: 'name', label: 'Товар' },
      { key: 'system', label: 'Система (учёт)' },
      { key: 'counted', label: 'Факт' },
      { key: 'variance', label: 'Отклонение' },
    ];
    const rows = count.items.map((it) => {
      const system = Number(it.systemQty);
      const counted = it.countedQty == null ? null : Number(it.countedQty);
      return {
        sku: it.productSku ?? '',
        name: it.productName,
        system,
        counted: counted == null ? '' : counted,
        variance: counted == null ? '' : counted - system,
      };
    });
    const buf = buildXlsx({ name: (count.number || 'Инвентаризация').slice(0, 31), columns, rows });
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('Content-Disposition', `attachment; filename="${count.number}.xlsx"`);
    return reply.send(buf);
  });

  // Open a count: snapshot on-hand for the warehouse's stocked products.
  app.post('/counts', { preHandler: [requirePermission('warehouse.count')] }, async (req, reply) => {
    const body = z.object({ warehouseId: z.string(), note: z.string().optional() }).parse(req.body);
    await warehouseOr404(req.auth.tid, body.warehouseId);
    const stock = await prisma.stockItem.findMany({ where: { tenantId: req.auth.tid, warehouseId: body.warehouseId } });
    if (stock.length === 0) throw BadRequest('На складе нет позиций для пересчёта', 'EMPTY_WAREHOUSE');
    const pm = await productMap(req.auth.tid, stock.map((s) => s.productId));
    const number = await nextNumber('SC', () => prisma.stockCount.count());
    const count = await prisma.stockCount.create({
      data: {
        tenantId: req.auth.tid, warehouseId: body.warehouseId, number, status: 'counting', note: body.note ?? null, createdBy: req.auth.sub,
        items: { create: stock.map((s) => ({ productId: s.productId, productName: pm.get(s.productId)?.name ?? s.productId, productSku: pm.get(s.productId)?.sku ?? null, systemQty: D(s.quantity) })) },
      },
      include: { items: true },
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'warehouse.count.open', entity: 'StockCount', entityId: count.id, meta: { number }, ip: req.ip });
    return reply.code(201).send({ count });
  });

  // Enter counted quantities for one or more lines.
  app.patch('/counts/:id/items', { preHandler: [requirePermission('warehouse.count')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ items: z.array(z.object({ productId: z.string(), countedQty: z.number().min(0) })).min(1) }).parse(req.body);
    const count = await prisma.stockCount.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!count) throw NotFound('Инвентаризация не найдена');
    if (count.status !== 'counting') throw BadRequest('Инвентаризация уже закрыта', 'NOT_OPEN');
    await prisma.$transaction(body.items.map((it) => prisma.stockCountItem.updateMany({ where: { countId: id, productId: it.productId }, data: { countedQty: D(it.countedQty) } })));
    return reply.send({ ok: true });
  });

  // Post the count: reconcile every variance via a stock ADJUST (warehouse contract).
  app.post('/counts/:id/complete', { preHandler: [requirePermission('warehouse.count')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const count = await prisma.stockCount.findFirst({ where: { id, tenantId: req.auth.tid }, include: { items: true } });
    if (!count) throw NotFound('Инвентаризация не найдена');
    if (count.status !== 'counting') throw BadRequest('Инвентаризация уже закрыта', 'NOT_OPEN');
    let adjusted = 0;
    await prisma.$transaction(async (tx) => {
      for (const it of count.items) {
        if (it.countedQty == null) continue; // uncounted lines are left as-is
        const current = await tx.stockItem.findUnique({ where: { warehouseId_productId: { warehouseId: count.warehouseId, productId: it.productId } } });
        const onHand = current ? D(current.quantity) : D(0);
        const delta = D(it.countedQty).minus(onHand);
        if (delta.isZero()) continue;
        await applyStockDelta(tx, { tenantId: req.auth.tid, warehouseId: count.warehouseId, productId: it.productId, type: 'ADJUST', delta, reason: `Инвентаризация ${count.number}`, refType: 'StockCount', refId: count.id, userId: req.auth.sub });
        adjusted++;
      }
      await tx.stockCount.update({ where: { id }, data: { status: 'completed', countedAt: new Date() } });
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'warehouse.count.complete', entity: 'StockCount', entityId: id, meta: { adjusted }, ip: req.ip });
    return reply.send({ ok: true, adjusted });
  });

  app.post('/counts/:id/cancel', { preHandler: [requirePermission('warehouse.count')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const count = await prisma.stockCount.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!count) throw NotFound('Инвентаризация не найдена');
    if (count.status !== 'counting') throw BadRequest('Инвентаризация уже закрыта', 'NOT_OPEN');
    await prisma.stockCount.update({ where: { id }, data: { status: 'cancelled' } });
    return reply.send({ ok: true });
  });

  // ================= 7.3 BATCHES / SERIALS / EXPIRY =================
  app.get('/batches', { preHandler: [requirePermission('warehouse.read')] }, async (req) => {
    const { warehouseId, productId } = req.query as { warehouseId?: string; productId?: string };
    const where = { tenantId: req.auth.tid, ...(warehouseId ? { warehouseId } : {}), ...(productId ? { productId } : {}) };
    return { batches: await prisma.stockBatch.findMany({ where, orderBy: [{ expiryDate: 'asc' }, { batchNo: 'asc' }] }) };
  });

  // Batches expiring within N days (or already expired). Requires a wall-clock "now".
  app.get('/batches/expiring', { preHandler: [requirePermission('warehouse.read')] }, async (req) => {
    const { days } = req.query as { days?: string };
    const horizon = new Date(Date.now() + (Number(days) || 30) * 86_400_000);
    const batches = await prisma.stockBatch.findMany({
      where: { tenantId: req.auth.tid, status: 'active', quantity: { gt: 0 }, expiryDate: { not: null, lte: horizon } },
      orderBy: { expiryDate: 'asc' },
    });
    const now = Date.now();
    return { batches: batches.map((b) => ({ ...b, expired: b.expiryDate ? b.expiryDate.getTime() < now : false })) };
  });

  // Receive a batch: creates/increments the lot AND bumps aggregate on-hand (stock IN).
  app.post('/batches/receive', { preHandler: [requirePermission('warehouse.move')] }, async (req, reply) => {
    const body = z.object({ warehouseId: z.string(), productId: z.string(), batchNo: z.string().min(1), expiryDate: z.string().optional(), quantity: quantityPositive }).parse(req.body);
    await warehouseOr404(req.auth.tid, body.warehouseId);
    const pm = await productMap(req.auth.tid, [body.productId]);
    const prod = pm.get(body.productId);
    if (!prod) throw NotFound('Товар не найден');
    const batch = await prisma.$transaction(async (tx) => {
      const b = await tx.stockBatch.upsert({
        where: { warehouseId_productId_batchNo: { warehouseId: body.warehouseId, productId: body.productId, batchNo: body.batchNo } },
        create: { tenantId: req.auth.tid, warehouseId: body.warehouseId, productId: body.productId, productName: prod.name, productSku: prod.sku, batchNo: body.batchNo, expiryDate: body.expiryDate ? new Date(body.expiryDate) : null, quantity: D(body.quantity), status: 'active' },
        update: { quantity: { increment: D(body.quantity) }, expiryDate: body.expiryDate ? new Date(body.expiryDate) : undefined, status: 'active' },
      });
      await applyStockDelta(tx, { tenantId: req.auth.tid, warehouseId: body.warehouseId, productId: body.productId, type: 'IN', delta: D(body.quantity), reason: `Приём партии ${body.batchNo}`, refType: 'StockBatch', refId: b.id, userId: req.auth.sub });
      return b;
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'warehouse.batch.receive', entity: 'StockBatch', entityId: batch.id, meta: { batchNo: body.batchNo }, ip: req.ip });
    return reply.code(201).send({ batch });
  });

  // Consume from a specific batch (stock OUT) — e.g. picking the earliest-expiry lot.
  app.post('/batches/:id/consume', { preHandler: [requirePermission('warehouse.move')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ quantity: quantityPositive, reason: z.string().optional() }).parse(req.body);
    const batch = await prisma.stockBatch.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!batch) throw NotFound('Партия не найдена');
    if (D(batch.quantity).lessThan(body.quantity)) throw BadRequest(`В партии только ${batch.quantity.toString()}`, 'INSUFFICIENT_BATCH');
    await prisma.$transaction(async (tx) => {
      const remaining = D(batch.quantity).minus(body.quantity);
      await tx.stockBatch.update({ where: { id }, data: { quantity: remaining, status: remaining.isZero() ? 'depleted' : 'active' } });
      await applyStockDelta(tx, { tenantId: req.auth.tid, warehouseId: batch.warehouseId, productId: batch.productId, type: 'OUT', delta: D(body.quantity).negated(), reason: body.reason ?? `Списание партии ${batch.batchNo}`, refType: 'StockBatch', refId: batch.id, userId: req.auth.sub });
    });
    return reply.send({ ok: true });
  });

  // Serial numbers registry.
  app.get('/serials', { preHandler: [requirePermission('warehouse.read')] }, async (req) => {
    const { productId, status } = req.query as { productId?: string; status?: string };
    const where = { tenantId: req.auth.tid, ...(productId ? { productId } : {}), ...(status ? { status } : {}) };
    return { serials: await prisma.serialNumber.findMany({ where, orderBy: { createdAt: 'desc' }, take: 500 }) };
  });

  app.post('/serials', { preHandler: [requirePermission('warehouse.locations')] }, async (req, reply) => {
    const body = z.object({ productId: z.string(), serial: z.string().min(1), warehouseId: z.string().optional(), batchId: z.string().optional() }).parse(req.body);
    const pm = await productMap(req.auth.tid, [body.productId]);
    const prod = pm.get(body.productId);
    if (!prod) throw NotFound('Товар не найден');
    const clash = await prisma.serialNumber.findFirst({ where: { tenantId: req.auth.tid, productId: body.productId, serial: body.serial } });
    if (clash) throw BadRequest(`Серийный номер «${body.serial}» уже зарегистрирован`, 'SERIAL_EXISTS');
    const serial = await prisma.serialNumber.create({ data: { tenantId: req.auth.tid, productId: body.productId, productName: prod.name, serial: body.serial, warehouseId: body.warehouseId ?? null, batchId: body.batchId ?? null, status: 'in_stock' } });
    return reply.code(201).send({ serial });
  });

  app.patch('/serials/:id', { preHandler: [requirePermission('warehouse.locations')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ status: z.enum(['in_stock', 'shipped', 'returned', 'scrapped']), refType: z.string().optional(), refId: z.string().optional() }).parse(req.body);
    const s = await prisma.serialNumber.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!s) throw NotFound('Серийный номер не найден');
    return reply.send({ serial: await prisma.serialNumber.update({ where: { id }, data: body }) });
  });

  // ================= 7.4 MIN-STOCK / REORDER =================
  // Set reorder levels on a (warehouse, product) stock row.
  app.patch('/stock-levels', { preHandler: [requirePermission('warehouse.locations')] }, async (req, reply) => {
    const body = z.object({ warehouseId: z.string(), productId: z.string(), minQty: z.number().min(0), reorderQty: z.number().min(0) }).parse(req.body);
    await warehouseOr404(req.auth.tid, body.warehouseId);
    const item = await prisma.stockItem.upsert({
      where: { warehouseId_productId: { warehouseId: body.warehouseId, productId: body.productId } },
      create: { tenantId: req.auth.tid, warehouseId: body.warehouseId, productId: body.productId, quantity: D(0), minQty: D(body.minQty), reorderQty: D(body.reorderQty) },
      update: { minQty: D(body.minQty), reorderQty: D(body.reorderQty) },
    });
    return reply.send({ stockItem: item });
  });

  // Low-stock signal: available (on-hand − reserved) below the min level.
  app.get('/low-stock', { preHandler: [requirePermission('warehouse.read')] }, async (req) => {
    const { warehouseId } = req.query as { warehouseId?: string };
    const rows = await prisma.stockItem.findMany({ where: { tenantId: req.auth.tid, ...(warehouseId ? { warehouseId } : {}), minQty: { gt: 0 } } });
    const low = rows.filter((r) => D(r.quantity).minus(r.reserved).lessThan(r.minQty));
    const pm = await productMap(req.auth.tid, low.map((r) => r.productId));
    return {
      lowStock: low.map((r) => {
        const available = D(r.quantity).minus(r.reserved);
        const suggested = D(r.reorderQty).greaterThan(0) ? D(r.reorderQty) : D(r.minQty).minus(available);
        return { warehouseId: r.warehouseId, productId: r.productId, productName: pm.get(r.productId)?.name ?? r.productId, productSku: pm.get(r.productId)?.sku ?? null, available: available.toString(), minQty: r.minQty.toString(), suggestedQty: Prisma.Decimal.max(suggested, D(0)).toString() };
      }),
    };
  });

  // Auto-generate a procurement purchase request covering current low-stock shortfalls.
  app.post('/reorder/auto-request', { preHandler: [requirePermission('procurement.write')] }, async (req, reply) => {
    const body = z.object({ warehouseId: z.string().optional(), note: z.string().optional() }).parse(req.body ?? {});
    const rows = await prisma.stockItem.findMany({ where: { tenantId: req.auth.tid, ...(body.warehouseId ? { warehouseId: body.warehouseId } : {}), minQty: { gt: 0 } } });
    const low = rows.filter((r) => D(r.quantity).minus(r.reserved).lessThan(r.minQty));
    if (low.length === 0) throw BadRequest('Нет позиций ниже минимального остатка', 'NOTHING_TO_REORDER');
    const pm = await productMap(req.auth.tid, low.map((r) => r.productId));
    // Aggregate shortfalls per product (a request may span warehouses).
    const byProduct = new Map<string, Prisma.Decimal>();
    for (const r of low) {
      const available = D(r.quantity).minus(r.reserved);
      const qty = D(r.reorderQty).greaterThan(0) ? D(r.reorderQty) : D(r.minQty).minus(available);
      if (qty.greaterThan(0)) byProduct.set(r.productId, (byProduct.get(r.productId) ?? D(0)).plus(qty));
    }
    const number = await nextNumber('PR', () => prisma.purchaseRequest.count());
    const request = await prisma.purchaseRequest.create({
      data: {
        tenantId: req.auth.tid, number, status: 'pending', requestedBy: req.auth.sub, note: body.note ?? 'Автозаявка по минимальным остаткам',
        items: { create: [...byProduct.entries()].map(([productId, qty]) => ({ productId, productName: pm.get(productId)?.name ?? productId, productSku: pm.get(productId)?.sku ?? null, quantity: qty })) },
      },
      include: { items: true },
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'warehouse.reorder.auto', entity: 'PurchaseRequest', entityId: request.id, meta: { number, lines: request.items.length }, ip: req.ip });
    // Notify owners about the auto-generated reorder (9.2 notifications).
    await notifyOwners(req.auth.tid, { type: 'warning', title: 'Низкий остаток — создана заявка', body: `${number}: ${request.items.length} позиц. ниже минимума`, refType: 'PurchaseRequest', refId: request.id }).catch(() => { /* non-fatal */ });
    return reply.code(201).send({ purchaseRequest: request });
  });
}
