// Procurement (Stage 4): suppliers, prices+compare, purchase requests (approval),
// purchase orders, goods receipts (stock IN via warehouse contract), 3-way match.
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
import { lookupByInn } from '../../lib/orginfo.js';
import { pageQuery, skipTake, pageMeta } from '../../lib/pagination.js';
import { moneyMinor, quantityPositive } from '../../lib/validators.js';

const D = (v: number | string | Prisma.Decimal) => new Prisma.Decimal(v);

async function nextNumber(tenantId: string, prefix: string, count: () => Promise<number>): Promise<string> {
  const n = await count();
  return `${prefix}-${new Date().getFullYear()}-${String(n + 1).padStart(4, '0')}`;
}

// Denormalize product name/sku for procurement items (no cross-module FK).
async function productMap(tenantId: string, ids: string[]) {
  const products = await prisma.product.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, name: true, sku: true, type: true } });
  return new Map(products.map((p) => [p.id, p]));
}

export default async function procurementRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', blockIfInactiveWrite);

  // ============ SUPPLIERS (4.1) ============
  const supplierSchema = z.object({
    code: z.string().min(1), name: z.string().min(1),
    legalName: z.string().optional(), inn: z.string().optional(), phone: z.string().optional(), email: z.string().optional(),
    address: z.string().optional(), bank: z.string().optional(), account: z.string().optional(), mfo: z.string().optional(),
    rating: z.number().int().min(0).max(5).optional(), notes: z.string().optional(),
  });

  app.get('/suppliers', { preHandler: [requirePermission('procurement.read')] }, async (req) => {
    const q = pageQuery.parse(req.query);
    const where = { tenantId: req.auth.tid, status: 'active', ...(q.search ? { OR: [{ name: { contains: q.search, mode: 'insensitive' as const } }, { code: { contains: q.search, mode: 'insensitive' as const } }, { inn: { contains: q.search } }] } : {}) };
    const [suppliers, total] = await prisma.$transaction([
      prisma.supplier.findMany({ where, orderBy: { name: 'asc' }, ...skipTake(q) }),
      prisma.supplier.count({ where }),
    ]);
    return { suppliers, meta: pageMeta(q, total) };
  });

  // Public-registry auto-fill by INN (orginfo.uz, best-effort; never throws on miss).
  // No specific permission — returns only PUBLIC registry data, reused by sales (customers) too.
  app.get('/suppliers/lookup', async (req) => {
    const { inn } = req.query as { inn?: string };
    if (!inn || inn.replace(/\D/g, '').length !== 9) throw BadRequest('Укажите ИНН из 9 цифр', 'BAD_INN');
    const data = await lookupByInn(inn);
    return { found: !!data, data };
  });

  app.post('/suppliers', { preHandler: [requirePermission('procurement.write')] }, async (req, reply) => {
    const body = supplierSchema.parse(req.body);
    const exists = await prisma.supplier.findFirst({ where: { tenantId: req.auth.tid, code: body.code } });
    if (exists) throw BadRequest(`Поставщик с кодом "${body.code}" уже есть`, 'CODE_EXISTS');
    const supplier = await prisma.supplier.create({ data: { ...body, tenantId: req.auth.tid } });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'procurement.supplier.create', entity: 'Supplier', entityId: supplier.id, meta: { code: body.code }, ip: req.ip });
    return reply.code(201).send({ supplier });
  });

  app.patch('/suppliers/:id', { preHandler: [requirePermission('procurement.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = supplierSchema.partial().parse(req.body);
    const s = await prisma.supplier.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!s) throw NotFound('Поставщик не найден');
    const supplier = await prisma.supplier.update({ where: { id }, data: body });
    return reply.send({ supplier });
  });

  // ============ SUPPLIER PRICES (4.5) + COMPARE (4.7) ============
  app.get('/prices', { preHandler: [requirePermission('procurement.read')] }, async (req) => {
    const { productId } = req.query as { productId?: string };
    const prices = await prisma.supplierPrice.findMany({
      where: { tenantId: req.auth.tid, ...(productId ? { productId } : {}) },
      orderBy: { createdAt: 'desc' }, take: 100,
      include: { supplier: { select: { name: true } } },
    });
    return { prices: prices.map((p) => ({ id: p.id, supplierId: p.supplierId, supplier: p.supplier.name, productId: p.productId, priceMinor: p.priceMinor, currency: p.currency, leadDays: p.leadDays, createdAt: p.createdAt })) };
  });

  app.post('/prices', { preHandler: [requirePermission('procurement.write')] }, async (req, reply) => {
    const body = z.object({ supplierId: z.string(), productId: z.string(), priceMinor: moneyMinor, leadDays: z.number().int().min(0).default(0), currency: z.string().default('UZS') }).parse(req.body);
    const [supplier, product] = await Promise.all([
      prisma.supplier.findFirst({ where: { id: body.supplierId, tenantId: req.auth.tid } }),
      prisma.product.findFirst({ where: { id: body.productId, tenantId: req.auth.tid } }),
    ]);
    if (!supplier) throw NotFound('Поставщик не найден');
    if (!product) throw NotFound('Товар не найден');
    const price = await prisma.supplierPrice.create({ data: { tenantId: req.auth.tid, supplierId: body.supplierId, productId: body.productId, productSku: product.sku, priceMinor: body.priceMinor, leadDays: body.leadDays, currency: body.currency } });
    return reply.code(201).send({ price });
  });

  // Compare suppliers for a product: latest price per supplier, cheapest first.
  app.get('/compare', { preHandler: [requirePermission('procurement.read')] }, async (req) => {
    const { productId } = req.query as { productId?: string };
    if (!productId) throw BadRequest('productId required');
    const rows = await prisma.supplierPrice.findMany({ where: { tenantId: req.auth.tid, productId }, orderBy: { createdAt: 'desc' }, include: { supplier: { select: { name: true, rating: true } } } });
    const bySupplier = new Map<string, any>();
    for (const r of rows) if (!bySupplier.has(r.supplierId)) bySupplier.set(r.supplierId, { supplierId: r.supplierId, supplier: r.supplier.name, rating: r.supplier.rating, priceMinor: r.priceMinor, currency: r.currency, leadDays: r.leadDays, at: r.createdAt });
    const offers = [...bySupplier.values()].sort((a, b) => a.priceMinor - b.priceMinor);
    return { offers, best: offers[0] ?? null };
  });

  // ============ PURCHASE REQUESTS (4.4) ============
  const reqItemSchema = z.object({ productId: z.string(), quantity: quantityPositive });
  app.get('/requests', { preHandler: [requirePermission('procurement.read')] }, async (req) => {
    const q = pageQuery.parse(req.query);
    const where = { tenantId: req.auth.tid };
    const [requests, total] = await prisma.$transaction([
      prisma.purchaseRequest.findMany({ where, orderBy: { createdAt: 'desc' }, include: { items: true }, ...skipTake(q) }),
      prisma.purchaseRequest.count({ where }),
    ]);
    return { requests, meta: pageMeta(q, total) };
  });

  app.post('/requests', { preHandler: [requirePermission('procurement.write')] }, async (req, reply) => {
    const body = z.object({ note: z.string().optional(), items: z.array(reqItemSchema).min(1) }).parse(req.body);
    const pm = await productMap(req.auth.tid, body.items.map((i) => i.productId));
    if (pm.size !== new Set(body.items.map((i) => i.productId)).size) throw BadRequest('Некоторые товары не найдены');
    const number = await nextNumber(req.auth.tid, 'PR', () => prisma.purchaseRequest.count());
    const request = await prisma.purchaseRequest.create({
      data: {
        tenantId: req.auth.tid, number, status: 'pending', requestedBy: req.auth.sub, note: body.note ?? null,
        items: { create: body.items.map((i) => ({ productId: i.productId, productName: pm.get(i.productId)!.name, productSku: pm.get(i.productId)!.sku, quantity: D(i.quantity) })) },
      },
      include: { items: true },
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'procurement.request.create', entity: 'PurchaseRequest', entityId: request.id, meta: { number }, ip: req.ip });
    return reply.code(201).send({ request });
  });

  app.post('/requests/:id/approve', { preHandler: [requirePermission('procurement.approve')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await prisma.purchaseRequest.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!r) throw NotFound('Заявка не найдена');
    if (r.status !== 'pending') throw BadRequest('Заявка уже обработана');
    await prisma.purchaseRequest.update({ where: { id }, data: { status: 'approved', decidedBy: req.auth.sub, decidedAt: new Date() } });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'procurement.request.approve', entity: 'PurchaseRequest', entityId: id, ip: req.ip });
    return reply.send({ ok: true });
  });

  app.post('/requests/:id/reject', { preHandler: [requirePermission('procurement.approve')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await prisma.purchaseRequest.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!r) throw NotFound('Заявка не найдена');
    if (r.status !== 'pending') throw BadRequest('Заявка уже обработана');
    await prisma.purchaseRequest.update({ where: { id }, data: { status: 'rejected', decidedBy: req.auth.sub, decidedAt: new Date() } });
    return reply.send({ ok: true });
  });

  // Convert an approved request into a purchase order.
  app.post('/requests/:id/convert', { preHandler: [requirePermission('procurement.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ supplierId: z.string(), warehouseId: z.string().optional(), prices: z.record(z.string(), moneyMinor).optional() }).parse(req.body);
    const r = await prisma.purchaseRequest.findFirst({ where: { id, tenantId: req.auth.tid }, include: { items: true } });
    if (!r) throw NotFound('Заявка не найдена');
    if (r.status !== 'approved') throw BadRequest('Сначала согласуйте заявку', 'NOT_APPROVED');
    const supplier = await prisma.supplier.findFirst({ where: { id: body.supplierId, tenantId: req.auth.tid } });
    if (!supplier) throw NotFound('Поставщик не найден');
    const number = await nextNumber(req.auth.tid, 'PO', () => prisma.purchaseOrder.count());
    const po = await prisma.$transaction(async (tx) => {
      const order = await tx.purchaseOrder.create({
        data: {
          tenantId: req.auth.tid, number, supplierId: body.supplierId, warehouseId: body.warehouseId ?? null, status: 'draft', requestId: id, createdBy: req.auth.sub,
          items: { create: r.items.map((it) => ({ productId: it.productId, productName: it.productName, productSku: it.productSku, quantity: it.quantity, priceMinor: body.prices?.[it.productId] ?? 0 })) },
        },
      });
      await tx.purchaseRequest.update({ where: { id }, data: { status: 'ordered' } });
      return order;
    });
    return reply.code(201).send({ purchaseOrder: po });
  });

  // ============ PURCHASE ORDERS (4.2) ============
  const poItemSchema = z.object({ productId: z.string(), quantity: quantityPositive, priceMinor: moneyMinor });
  app.get('/orders', { preHandler: [requirePermission('procurement.read')] }, async (req) => {
    const { status } = req.query as { status?: string };
    const q = pageQuery.parse(req.query);
    const where = { tenantId: req.auth.tid, ...(status ? { status } : {}) };
    const [orders, total] = await prisma.$transaction([
      prisma.purchaseOrder.findMany({ where, orderBy: { createdAt: 'desc' }, include: { supplier: { select: { name: true } }, items: true }, ...skipTake(q) }),
      prisma.purchaseOrder.count({ where }),
    ]);
    return {
      orders: orders.map((o) => ({
        id: o.id, number: o.number, supplier: o.supplier.name, supplierId: o.supplierId, status: o.status,
        expectedAt: o.expectedAt, warehouseId: o.warehouseId, createdAt: o.createdAt,
        totalMinor: o.items.reduce((s, it) => s + it.priceMinor * Number(it.quantity), 0),
        itemCount: o.items.length,
      })),
      meta: pageMeta(q, total),
    };
  });

  app.get('/orders/:id', { preHandler: [requirePermission('procurement.read')] }, async (req) => {
    const { id } = req.params as { id: string };
    const o = await prisma.purchaseOrder.findFirst({ where: { id, tenantId: req.auth.tid }, include: { supplier: true, items: true, receipts: { include: { items: true } }, invoices: true } });
    if (!o) throw NotFound('Заказ не найден');
    return { order: o };
  });

  app.post('/orders', { preHandler: [requirePermission('procurement.write')] }, async (req, reply) => {
    const body = z.object({ supplierId: z.string(), warehouseId: z.string().optional(), expectedAt: z.string().optional(), note: z.string().optional(), items: z.array(poItemSchema).min(1) }).parse(req.body);
    const supplier = await prisma.supplier.findFirst({ where: { id: body.supplierId, tenantId: req.auth.tid } });
    if (!supplier) throw NotFound('Поставщик не найден');
    const pm = await productMap(req.auth.tid, body.items.map((i) => i.productId));
    if (pm.size !== new Set(body.items.map((i) => i.productId)).size) throw BadRequest('Некоторые товары не найдены');
    const number = await nextNumber(req.auth.tid, 'PO', () => prisma.purchaseOrder.count());
    const order = await prisma.purchaseOrder.create({
      data: {
        tenantId: req.auth.tid, number, supplierId: body.supplierId, warehouseId: body.warehouseId ?? null, status: 'draft', createdBy: req.auth.sub,
        expectedAt: body.expectedAt ? new Date(body.expectedAt) : null, note: body.note ?? null,
        items: { create: body.items.map((i) => ({ productId: i.productId, productName: pm.get(i.productId)!.name, productSku: pm.get(i.productId)!.sku, quantity: D(i.quantity), priceMinor: i.priceMinor })) },
      },
      include: { items: true },
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'procurement.po.create', entity: 'PurchaseOrder', entityId: order.id, meta: { number }, ip: req.ip });
    return reply.code(201).send({ order });
  });

  app.post('/orders/:id/send', { preHandler: [requirePermission('procurement.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const o = await prisma.purchaseOrder.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!o) throw NotFound('Заказ не найден');
    if (o.status !== 'draft') throw BadRequest('Заказ уже отправлен/обработан');
    await prisma.purchaseOrder.update({ where: { id }, data: { status: 'sent' } });
    return reply.send({ ok: true });
  });

  app.post('/orders/:id/cancel', { preHandler: [requirePermission('procurement.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const o = await prisma.purchaseOrder.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!o) throw NotFound('Заказ не найден');
    if (o.status === 'received') throw BadRequest('Полученный заказ нельзя отменить');
    await prisma.purchaseOrder.update({ where: { id }, data: { status: 'cancelled' } });
    return reply.send({ ok: true });
  });

  // ============ GOODS RECEIPT (4.3) — receive against a PO, applies stock IN ============
  app.post('/orders/:id/receive', { preHandler: [requirePermission('procurement.receive')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ warehouseId: z.string().optional(), note: z.string().optional(), items: z.array(z.object({ productId: z.string(), quantity: quantityPositive })).min(1) }).parse(req.body);
    const o = await prisma.purchaseOrder.findFirst({ where: { id, tenantId: req.auth.tid }, include: { items: true } });
    if (!o) throw NotFound('Заказ не найден');
    if (o.status === 'cancelled') throw BadRequest('Заказ отменён');
    const warehouseId = body.warehouseId ?? o.warehouseId;
    if (!warehouseId) throw BadRequest('Укажите склад для прихода', 'WAREHOUSE_REQUIRED');
    const wh = await prisma.warehouse.findFirst({ where: { id: warehouseId, tenantId: req.auth.tid } });
    if (!wh) throw NotFound('Склад не найден');

    // Validate against remaining ordered quantities (no over-receipt).
    const byProduct = new Map(o.items.map((it) => [it.productId, it]));
    for (const line of body.items) {
      const it = byProduct.get(line.productId);
      if (!it) throw BadRequest(`Товар вне заказа: ${line.productId}`, 'NOT_IN_PO');
      const remaining = new Prisma.Decimal(it.quantity).minus(it.receivedQty);
      if (D(line.quantity).greaterThan(remaining)) throw BadRequest(`Приход превышает остаток по заказу (осталось ${remaining.toString()})`, 'OVER_RECEIPT');
    }

    const supplier = o.supplierId ? await prisma.supplier.findFirst({ where: { id: o.supplierId, tenantId: req.auth.tid }, select: { name: true } }) : null;
    const number = await nextNumber(req.auth.tid, 'GRN', () => prisma.goodsReceipt.count());
    const receipt = await prisma.$transaction(async (tx) => {
      const grn = await tx.goodsReceipt.create({
        data: {
          tenantId: req.auth.tid, number, poId: o.id, supplierId: o.supplierId, warehouseId, note: body.note ?? null, receivedBy: req.auth.sub,
          items: { create: body.items.map((l) => ({ productId: l.productId, productName: byProduct.get(l.productId)!.productName, quantity: D(l.quantity) })) },
        },
      });
      // Apply stock IN via the shared warehouse contract (cost basis = PO unit price)
      // + update PO received quantities; accumulate the received value for accounting.
      let totalCostMinor = 0n;
      for (const l of body.items) {
        const it = byProduct.get(l.productId)!;
        await applyStockDelta(tx, { tenantId: req.auth.tid, warehouseId, productId: l.productId, type: 'RECEIPT', delta: D(l.quantity), reason: `Приход по заказу ${o.number}`, refType: 'GoodsReceipt', refId: grn.id, userId: req.auth.sub, unitCostMinor: BigInt(it.priceMinor) });
        totalCostMinor += BigInt(D(l.quantity).mul(it.priceMinor).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0));
        await tx.purchaseOrderItem.update({ where: { id: it.id }, data: { receivedQty: new Prisma.Decimal(it.receivedQty).plus(l.quantity) } });
      }
      // Recompute PO status.
      const items = await tx.purchaseOrderItem.findMany({ where: { poId: o.id } });
      const allReceived = items.every((it) => new Prisma.Decimal(it.receivedQty).greaterThanOrEqualTo(it.quantity));
      const anyReceived = items.some((it) => new Prisma.Decimal(it.receivedQty).greaterThan(0));
      await tx.purchaseOrder.update({ where: { id: o.id }, data: { status: allReceived ? 'received' : anyReceived ? 'partially_received' : o.status } });
      // Auto-posting (Stage 8.4): Dr Inventory / Cr Accounts Payable at received cost.
      await emitEvent('purchase.received', { refId: grn.id, number, totalCostMinor, supplierName: supplier?.name ?? null }, { tx, tenantId: req.auth.tid, userId: req.auth.sub });
      return grn;
    });

    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'procurement.receive', entity: 'GoodsReceipt', entityId: receipt.id, meta: { po: o.number, number }, ip: req.ip });
    return reply.code(201).send({ receipt: { id: receipt.id, number: receipt.number } });
  });

  app.get('/receipts', { preHandler: [requirePermission('procurement.read')] }, async (req) => {
    const q = pageQuery.parse(req.query);
    const where = { tenantId: req.auth.tid };
    const [receipts, total] = await prisma.$transaction([
      prisma.goodsReceipt.findMany({ where, orderBy: { createdAt: 'desc' }, include: { items: true, po: { select: { number: true } } }, ...skipTake(q) }),
      prisma.goodsReceipt.count({ where }),
    ]);
    return { receipts, meta: pageMeta(q, total) };
  });

  // ============ SUPPLIER INVOICES + 3-WAY MATCH (4.6) ============
  function threeWayMatch(po: { items: { quantity: Prisma.Decimal; receivedQty: Prisma.Decimal; priceMinor: number }[] } | null, invoiceAmount: number) {
    if (!po) return { status: 'open', orderedMinor: 0, receivedMinor: 0, invoiceMinor: invoiceAmount, note: 'Без привязки к заказу' };
    const orderedMinor = po.items.reduce((s, it) => s + it.priceMinor * Number(it.quantity), 0);
    const receivedMinor = po.items.reduce((s, it) => s + it.priceMinor * Number(it.receivedQty), 0);
    const matched = invoiceAmount === receivedMinor;
    const note = matched ? 'Совпадает: счёт = принято' : `Расхождение: счёт ${invoiceAmount}, принято ${receivedMinor}, заказано ${orderedMinor} (minor)`;
    return { status: matched ? 'matched' : 'discrepancy', orderedMinor, receivedMinor, invoiceMinor: invoiceAmount, note };
  }

  app.get('/invoices', { preHandler: [requirePermission('procurement.read')] }, async (req) => {
    const q = pageQuery.parse(req.query);
    const where = { tenantId: req.auth.tid };
    const [invoices, total] = await prisma.$transaction([
      prisma.supplierInvoice.findMany({ where, orderBy: { createdAt: 'desc' }, include: { supplier: { select: { name: true } }, po: { select: { number: true } } }, ...skipTake(q) }),
      prisma.supplierInvoice.count({ where }),
    ]);
    return { invoices, meta: pageMeta(q, total) };
  });

  app.post('/invoices', { preHandler: [requirePermission('procurement.write')] }, async (req, reply) => {
    const body = z.object({ supplierId: z.string(), poId: z.string().optional(), number: z.string().min(1), amountMinor: moneyMinor }).parse(req.body);
    const supplier = await prisma.supplier.findFirst({ where: { id: body.supplierId, tenantId: req.auth.tid } });
    if (!supplier) throw NotFound('Поставщик не найден');
    const po = body.poId ? await prisma.purchaseOrder.findFirst({ where: { id: body.poId, tenantId: req.auth.tid }, include: { items: true } }) : null;
    const match = threeWayMatch(po, body.amountMinor);
    const invoice = await prisma.supplierInvoice.create({ data: { tenantId: req.auth.tid, supplierId: body.supplierId, poId: body.poId ?? null, number: body.number, amountMinor: body.amountMinor, status: match.status, matchNote: match.note } });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'procurement.invoice.create', entity: 'SupplierInvoice', entityId: invoice.id, meta: { number: body.number, match: match.status }, ip: req.ip });
    return reply.code(201).send({ invoice, match });
  });

  // Re-run 3-way match (e.g. after more goods received).
  app.post('/invoices/:id/match', { preHandler: [requirePermission('procurement.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const inv = await prisma.supplierInvoice.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!inv) throw NotFound('Счёт не найден');
    const po = inv.poId ? await prisma.purchaseOrder.findFirst({ where: { id: inv.poId }, include: { items: true } }) : null;
    const match = threeWayMatch(po, inv.amountMinor);
    await prisma.supplierInvoice.update({ where: { id }, data: { status: match.status, matchNote: match.note } });
    return reply.send({ match });
  });

  app.post('/invoices/:id/pay', { preHandler: [requirePermission('procurement.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const inv = await prisma.supplierInvoice.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!inv) throw NotFound('Счёт не найден');
    if (inv.status === 'discrepancy') throw BadRequest('Есть расхождение по 3-way match — сначала устраните', 'MATCH_DISCREPANCY');
    await prisma.supplierInvoice.update({ where: { id }, data: { status: 'paid' } });
    return reply.send({ ok: true });
  });
}
