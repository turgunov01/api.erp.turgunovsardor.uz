// Warehouse module: warehouses, on-hand stock, and the append-only movement ledger.
// Only this module mutates stock — the single source of truth for inventory.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { requirePermission } from '../../plugins/rbac.js';
import { blockIfInactiveWrite } from '../../plugins/subscription.js';
import { assertWithinLimit } from '../../lib/limits.js';
import { audit } from '../../lib/audit.js';
import { BadRequest, NotFound, Conflict } from '../../lib/errors.js';
import { pageQuery, skipTake, safeOrderBy, pageMeta } from '../../lib/pagination.js';
import { quantityPositive, quantityNonNegative } from '../../lib/validators.js';
import { allowedWarehouses, assertWarehouseAllowed } from '../../lib/scope.js';

const D = (v: number | string) => new Prisma.Decimal(v);

const warehouseSchema = z.object({
  name: z.string().min(1),
  code: z.string().min(1),
  companyId: z.string().optional(),
  address: z.string().optional(),
});

// IN/OUT use a positive quantity; ADJUST sets the absolute on-hand (stock count correction).
// Base allows >= 0 (ADJUST target 0 is valid); per-type positivity is enforced in the handler.
const moveSchema = z.object({
  warehouseId: z.string().min(1),
  productId: z.string().min(1),
  type: z.enum(['IN', 'OUT', 'ADJUST']),
  quantity: quantityNonNegative,
  reason: z.string().max(500).optional(),
});

const transferSchema = z.object({
  fromWarehouseId: z.string().min(1),
  toWarehouseId: z.string().min(1),
  productId: z.string().min(1),
  quantity: quantityPositive,
  reason: z.string().max(500).optional(),
});

async function currentQty(tenantId: string, warehouseId: string, productId: string): Promise<Prisma.Decimal> {
  // Scope by tenantId too (defence-in-depth) so a cross-tenant (warehouse,product) pair can never leak.
  const item = await prisma.stockItem.findFirst({ where: { tenantId, warehouseId, productId } });
  return item ? new Prisma.Decimal(item.quantity) : D(0);
}

export default async function warehouseRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', blockIfInactiveWrite);

  // ---- Warehouses (record-level scoped) ----
  app.get('/warehouses', { preHandler: [requirePermission('warehouse.read')] }, async (req) => {
    const allowed = await allowedWarehouses(req.auth.sub);
    return { warehouses: await prisma.warehouse.findMany({
      where: { tenantId: req.auth.tid, ...(allowed ? { id: { in: allowed } } : {}) }, orderBy: { code: 'asc' },
    }) };
  });

  app.post('/warehouses', { preHandler: [requirePermission('warehouse.manage')] }, async (req, reply) => {
    const body = warehouseSchema.parse(req.body);
    await assertWithinLimit(req.auth.tid, 'warehouses');
    const wh = await prisma.warehouse.create({ data: { ...body, tenantId: req.auth.tid } });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'warehouse.create', entity: 'Warehouse', entityId: wh.id, meta: body, ip: req.ip });
    return reply.code(201).send({ warehouse: wh });
  });

  app.patch('/warehouses/:id', { preHandler: [requirePermission('warehouse.manage')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = warehouseSchema.partial().parse(req.body);
    const wh = await prisma.warehouse.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!wh) throw NotFound('Склад не найден');
    if (body.code && body.code !== wh.code) {
      const clash = await prisma.warehouse.findFirst({ where: { tenantId: req.auth.tid, code: body.code, NOT: { id } } });
      if (clash) throw Conflict(`Склад с кодом «${body.code}» уже существует`, 'WAREHOUSE_CODE_EXISTS');
    }
    const updated = await prisma.warehouse.update({ where: { id }, data: body });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'warehouse.update', entity: 'Warehouse', entityId: id, meta: body, ip: req.ip });
    return reply.send({ warehouse: updated });
  });

  app.delete('/warehouses/:id', { preHandler: [requirePermission('warehouse.manage')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const wh = await prisma.warehouse.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!wh) throw NotFound('Склад не найден');
    // Never destroy audit-grade history or live stock: block, don't silently discard.
    const moves = await prisma.stockMovement.count({ where: { tenantId: req.auth.tid, warehouseId: id } });
    if (moves > 0) throw Conflict(`Нельзя удалить: по складу есть движения (${moves}). История неизменяема.`, 'WAREHOUSE_HAS_HISTORY');
    const withStock = await prisma.stockItem.count({ where: { tenantId: req.auth.tid, warehouseId: id, quantity: { gt: 0 } } });
    if (withStock > 0) throw Conflict(`Нельзя удалить: на складе есть остатки (${withStock} позиц.).`, 'WAREHOUSE_HAS_STOCK');
    // Safe to remove: no history, no stock. Clean up empty refinement rows + zero StockItems.
    await prisma.$transaction([
      prisma.binStock.deleteMany({ where: { tenantId: req.auth.tid, warehouseId: id } }),
      prisma.warehouseLocation.deleteMany({ where: { tenantId: req.auth.tid, warehouseId: id } }),
      prisma.stockItem.deleteMany({ where: { tenantId: req.auth.tid, warehouseId: id } }),
      prisma.warehouse.delete({ where: { id } }),
    ]);
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'warehouse.delete', entity: 'Warehouse', entityId: id, meta: { code: wh.code }, ip: req.ip });
    return reply.send({ ok: true });
  });

  // ---- Stock levels (on-hand) ----
  app.get('/stock', { preHandler: [requirePermission('warehouse.read')] }, async (req) => {
    const { warehouseId, lowOnly } = req.query as { warehouseId?: string; lowOnly?: string };
    const q = pageQuery.parse(req.query);
    const allowed = await allowedWarehouses(req.auth.sub);
    const where = { tenantId: req.auth.tid, ...(warehouseId ? { warehouseId } : allowed ? { warehouseId: { in: allowed } } : {}) };
    const [items, total] = await prisma.$transaction([
      prisma.stockItem.findMany({
        where,
        include: { product: { include: { unit: true } }, warehouse: true },
        orderBy: { updatedAt: 'desc' },
        ...skipTake(q),
      }),
      prisma.stockItem.count({ where }),
    ]);
    const rows = items.map((i) => ({
      warehouseId: i.warehouseId,
      warehouse: i.warehouse.name,
      productId: i.productId,
      sku: i.product.sku,
      product: i.product.name,
      unit: i.product.unit?.code ?? '',
      quantity: i.quantity.toString(),
      reserved: i.reserved.toString(),
      available: new Prisma.Decimal(i.quantity).minus(i.reserved).toString(),
    }));
    return { stock: lowOnly === '1' ? rows.filter((r) => Number(r.available) <= 0) : rows, meta: pageMeta(q, total) };
  });

  // ---- Movement ledger (paginated + filterable by warehouse/product/type) ----
  app.get('/movements', { preHandler: [requirePermission('warehouse.read')] }, async (req) => {
    const { warehouseId, productId, type } = req.query as { warehouseId?: string; productId?: string; type?: string };
    const q = pageQuery.parse(req.query);
    const allowed = await allowedWarehouses(req.auth.sub);
    const where = {
      tenantId: req.auth.tid,
      ...(warehouseId ? { warehouseId } : allowed ? { warehouseId: { in: allowed } } : {}),
      ...(productId ? { productId } : {}),
      ...(type ? { type } : {}),
    };
    const [movements, total] = await prisma.$transaction([
      prisma.stockMovement.findMany({
        where,
        include: { product: true, warehouse: true },
        orderBy: { createdAt: 'desc' },
        ...skipTake(q),
      }),
      prisma.stockMovement.count({ where }),
    ]);
    return {
      meta: pageMeta(q, total),
      movements: movements.map((m) => ({
        id: m.id,
        type: m.type,
        product: m.product.name,
        sku: m.product.sku,
        warehouse: m.warehouse.name,
        quantity: m.quantity.toString(),
        balanceAfter: m.balanceAfter.toString(),
        reason: m.reason,
        createdAt: m.createdAt,
      })),
    };
  });

  // ---- Perform a stock movement (receive / issue / adjust) ----
  app.post('/movements', { preHandler: [requirePermission('warehouse.move')] }, async (req, reply) => {
    const body = moveSchema.parse(req.body);
    const tenantId = req.auth.tid;

    const [wh, product] = await Promise.all([
      prisma.warehouse.findFirst({ where: { id: body.warehouseId, tenantId } }),
      prisma.product.findFirst({ where: { id: body.productId, tenantId } }),
    ]);
    if (!wh) throw NotFound('Warehouse not found');
    if (!product) throw NotFound('Product not found');
    if (product.type !== 'stockable') throw BadRequest('Product is not stockable', 'NOT_STOCKABLE');
    assertWarehouseAllowed(await allowedWarehouses(req.auth.sub), body.warehouseId);

    const current = await currentQty(tenantId, body.warehouseId, body.productId);
    let delta: Prisma.Decimal;
    let newBalance: Prisma.Decimal;

    if (body.type === 'IN') {
      if (body.quantity <= 0) throw BadRequest('IN quantity must be positive');
      delta = D(body.quantity);
      newBalance = current.plus(delta);
    } else if (body.type === 'OUT') {
      if (body.quantity <= 0) throw BadRequest('OUT quantity must be positive');
      delta = D(body.quantity).negated();
      newBalance = current.plus(delta);
      if (newBalance.lessThan(0)) throw BadRequest(`Insufficient stock: on-hand ${current.toString()}, requested ${body.quantity}`, 'INSUFFICIENT_STOCK');
    } else {
      // ADJUST: quantity is the target absolute on-hand
      if (body.quantity < 0) throw BadRequest('ADJUST target cannot be negative');
      newBalance = D(body.quantity);
      delta = newBalance.minus(current);
    }

    const movement = await prisma.$transaction(async (tx) => {
      await tx.stockItem.upsert({
        where: { warehouseId_productId: { warehouseId: body.warehouseId, productId: body.productId } },
        create: { tenantId, warehouseId: body.warehouseId, productId: body.productId, quantity: newBalance },
        update: { quantity: newBalance },
      });
      return tx.stockMovement.create({
        data: {
          tenantId,
          warehouseId: body.warehouseId,
          productId: body.productId,
          type: body.type,
          quantity: delta,
          balanceAfter: newBalance,
          reason: body.reason ?? null,
          userId: req.auth.sub,
        },
      });
    });

    await audit({ tenantId, userId: req.auth.sub, action: 'stock.move', entity: 'StockMovement', entityId: movement.id, meta: { type: body.type, delta: delta.toString(), balanceAfter: newBalance.toString(), product: product.sku }, ip: req.ip });
    return reply.code(201).send({ movement: { id: movement.id, type: movement.type, balanceAfter: newBalance.toString() } });
  });

  // ---- Transfer between warehouses (atomic OUT + IN) ----
  app.post('/transfer', { preHandler: [requirePermission('warehouse.move')] }, async (req, reply) => {
    const body = transferSchema.parse(req.body);
    const tenantId = req.auth.tid;
    if (body.fromWarehouseId === body.toWarehouseId) throw BadRequest('Source and destination must differ');
    const allowedW = await allowedWarehouses(req.auth.sub);
    assertWarehouseAllowed(allowedW, body.fromWarehouseId);
    assertWarehouseAllowed(allowedW, body.toWarehouseId);

    const fromQty = await currentQty(tenantId, body.fromWarehouseId, body.productId);
    if (fromQty.lessThan(body.quantity)) throw BadRequest('Insufficient stock in source warehouse', 'INSUFFICIENT_STOCK');
    const toQty = await currentQty(tenantId, body.toWarehouseId, body.productId);
    const fromNew = fromQty.minus(body.quantity);
    const toNew = toQty.plus(body.quantity);

    await prisma.$transaction(async (tx) => {
      await tx.stockItem.upsert({
        where: { warehouseId_productId: { warehouseId: body.fromWarehouseId, productId: body.productId } },
        create: { tenantId, warehouseId: body.fromWarehouseId, productId: body.productId, quantity: fromNew },
        update: { quantity: fromNew },
      });
      await tx.stockItem.upsert({
        where: { warehouseId_productId: { warehouseId: body.toWarehouseId, productId: body.productId } },
        create: { tenantId, warehouseId: body.toWarehouseId, productId: body.productId, quantity: toNew },
        update: { quantity: toNew },
      });
      await tx.stockMovement.createMany({
        data: [
          { tenantId, warehouseId: body.fromWarehouseId, productId: body.productId, type: 'TRANSFER_OUT', quantity: D(body.quantity).negated(), balanceAfter: fromNew, reason: body.reason ?? 'transfer', userId: req.auth.sub },
          { tenantId, warehouseId: body.toWarehouseId, productId: body.productId, type: 'TRANSFER_IN', quantity: D(body.quantity), balanceAfter: toNew, reason: body.reason ?? 'transfer', userId: req.auth.sub },
        ],
      });
    });

    await audit({ tenantId, userId: req.auth.sub, action: 'stock.transfer', entity: 'StockMovement', meta: { ...body }, ip: req.ip });
    return reply.code(201).send({ ok: true });
  });
}
