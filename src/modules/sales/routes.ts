// Sales (Stage 5): customers + contacts, price lists, quotations (commercial
// offers), sales orders, stock reservation (available-to-promise), shipments
// (stock OUT via warehouse contract) and returns (stock IN).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { requirePermission } from '../../plugins/rbac.js';
import { blockIfInactiveWrite } from '../../plugins/subscription.js';
import { applyStockDelta } from '../../lib/stock.js';
import { emitEvent } from '../../lib/events.js';
import { adjustReserved } from '../../lib/reservation.js';
import { audit } from '../../lib/audit.js';
import { BadRequest, NotFound } from '../../lib/errors.js';
import { pageQuery, skipTake, pageMeta } from '../../lib/pagination.js';
import { moneyMinor, quantityPositive } from '../../lib/validators.js';

const D = (v: number | string | Prisma.Decimal) => new Prisma.Decimal(v);
const dec = (v: Prisma.Decimal | number | string) => new Prisma.Decimal(v);

async function nextNumber(prefix: string, count: () => Promise<number>): Promise<string> {
  const n = await count();
  return `${prefix}-${new Date().getFullYear()}-${String(n + 1).padStart(4, '0')}`;
}

// Denormalize product name/sku for sales items (no cross-module FK).
async function productMap(tenantId: string, ids: string[]) {
  const products = await prisma.product.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, name: true, sku: true, type: true } });
  return new Map(products.map((p) => [p.id, p]));
}

// Net price of a line after its discount, in minor units, rounded.
const lineNet = (priceMinor: number, discountPct: number) => Math.round(priceMinor * (1 - (discountPct || 0) / 100));
// Line total after discount * quantity.
const lineTotal = (priceMinor: number, discountPct: number, qty: Prisma.Decimal | number) => lineNet(priceMinor, discountPct) * Number(qty);

export default async function salesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', blockIfInactiveWrite);

  // ============ CUSTOMERS (5.1) ============
  const customerSchema = z.object({
    code: z.string().min(1), name: z.string().min(1),
    legalName: z.string().optional(), inn: z.string().optional(), phone: z.string().optional(), email: z.string().optional(),
    address: z.string().optional(), bank: z.string().optional(), account: z.string().optional(), mfo: z.string().optional(),
    creditLimitMinor: moneyMinor.optional(), rating: z.number().int().min(0).max(5).optional(), notes: z.string().optional(),
  });

  app.get('/customers', { preHandler: [requirePermission('sales.read')] }, async (req) => {
    const q = pageQuery.parse(req.query);
    const where = { tenantId: req.auth.tid, status: 'active', ...(q.search ? { OR: [{ name: { contains: q.search, mode: 'insensitive' as const } }, { code: { contains: q.search, mode: 'insensitive' as const } }, { inn: { contains: q.search } }] } : {}) };
    const [customers, total] = await prisma.$transaction([
      prisma.customer.findMany({ where, orderBy: { name: 'asc' }, include: { contacts: true }, ...skipTake(q) }),
      prisma.customer.count({ where }),
    ]);
    return { customers, meta: pageMeta(q, total) };
  });

  app.post('/customers', { preHandler: [requirePermission('sales.write')] }, async (req, reply) => {
    const body = customerSchema.parse(req.body);
    const exists = await prisma.customer.findFirst({ where: { tenantId: req.auth.tid, code: body.code } });
    if (exists) throw BadRequest(`Клиент с кодом "${body.code}" уже есть`, 'CODE_EXISTS');
    const customer = await prisma.customer.create({ data: { ...body, tenantId: req.auth.tid } });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'sales.customer.create', entity: 'Customer', entityId: customer.id, meta: { code: body.code }, ip: req.ip });
    return reply.code(201).send({ customer });
  });

  app.patch('/customers/:id', { preHandler: [requirePermission('sales.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = customerSchema.partial().parse(req.body);
    const c = await prisma.customer.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!c) throw NotFound('Клиент не найден');
    const customer = await prisma.customer.update({ where: { id }, data: body });
    return reply.send({ customer });
  });

  // Contacts (5.1)
  app.post('/customers/:id/contacts', { preHandler: [requirePermission('sales.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ name: z.string().min(1), role: z.string().optional(), phone: z.string().optional(), email: z.string().optional(), isPrimary: z.boolean().optional() }).parse(req.body);
    const c = await prisma.customer.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!c) throw NotFound('Клиент не найден');
    const contact = await prisma.customerContact.create({ data: { customerId: id, ...body } });
    return reply.code(201).send({ contact });
  });

  app.delete('/customers/:id/contacts/:cid', { preHandler: [requirePermission('sales.write')] }, async (req, reply) => {
    const { id, cid } = req.params as { id: string; cid: string };
    const c = await prisma.customer.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!c) throw NotFound('Клиент не найден');
    await prisma.customerContact.deleteMany({ where: { id: cid, customerId: id } });
    return reply.send({ ok: true });
  });

  // ============ PRICE LISTS (5.5) ============
  app.get('/price-lists', { preHandler: [requirePermission('sales.read')] }, async (req) => {
    const lists = await prisma.priceList.findMany({ where: { tenantId: req.auth.tid, status: 'active' }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }], include: { items: true } });
    return { priceLists: lists };
  });

  app.post('/price-lists', { preHandler: [requirePermission('sales.write')] }, async (req, reply) => {
    const body = z.object({ name: z.string().min(1), currency: z.string().default('UZS'), isDefault: z.boolean().optional() }).parse(req.body);
    const list = await prisma.$transaction(async (tx) => {
      if (body.isDefault) await tx.priceList.updateMany({ where: { tenantId: req.auth.tid }, data: { isDefault: false } });
      return tx.priceList.create({ data: { tenantId: req.auth.tid, name: body.name, currency: body.currency, isDefault: body.isDefault ?? false } });
    });
    return reply.code(201).send({ priceList: list });
  });

  // Upsert a price line into a list.
  app.post('/price-lists/:id/items', { preHandler: [requirePermission('sales.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ productId: z.string(), priceMinor: moneyMinor }).parse(req.body);
    const list = await prisma.priceList.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!list) throw NotFound('Прайс-лист не найден');
    const product = await prisma.product.findFirst({ where: { id: body.productId, tenantId: req.auth.tid } });
    if (!product) throw NotFound('Товар не найден');
    const item = await prisma.priceListItem.upsert({
      where: { priceListId_productId: { priceListId: id, productId: body.productId } },
      create: { priceListId: id, productId: body.productId, productSku: product.sku, priceMinor: body.priceMinor },
      update: { priceMinor: body.priceMinor },
    });
    return reply.code(201).send({ item });
  });

  app.delete('/price-lists/:id/items/:itemId', { preHandler: [requirePermission('sales.write')] }, async (req, reply) => {
    const { id, itemId } = req.params as { id: string; itemId: string };
    const list = await prisma.priceList.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!list) throw NotFound('Прайс-лист не найден');
    await prisma.priceListItem.deleteMany({ where: { id: itemId, priceListId: id } });
    return reply.send({ ok: true });
  });

  // ============ QUOTATIONS (5.2) — commercial offers ============
  const quoteItemSchema = z.object({ productId: z.string(), quantity: quantityPositive, priceMinor: moneyMinor, discountPct: z.number().int().min(0).max(100).default(0) });

  app.get('/quotations', { preHandler: [requirePermission('sales.read')] }, async (req) => {
    const q = pageQuery.parse(req.query);
    const where = { tenantId: req.auth.tid };
    const [quotations, total] = await prisma.$transaction([
      prisma.quotation.findMany({ where, orderBy: { createdAt: 'desc' }, include: { items: true, customer: { select: { name: true } } }, ...skipTake(q) }),
      prisma.quotation.count({ where }),
    ]);
    return {
      quotations: quotations.map((qo) => ({
        id: qo.id, number: qo.number, customer: qo.customer.name, customerId: qo.customerId, status: qo.status,
        validUntil: qo.validUntil, createdAt: qo.createdAt, items: qo.items,
        totalMinor: qo.items.reduce((s, it) => s + lineTotal(it.priceMinor, it.discountPct, it.quantity), 0),
      })),
      meta: pageMeta(q, total),
    };
  });

  app.post('/quotations', { preHandler: [requirePermission('sales.write')] }, async (req, reply) => {
    const body = z.object({ customerId: z.string(), note: z.string().optional(), validUntil: z.string().optional(), items: z.array(quoteItemSchema).min(1) }).parse(req.body);
    const customer = await prisma.customer.findFirst({ where: { id: body.customerId, tenantId: req.auth.tid } });
    if (!customer) throw NotFound('Клиент не найден');
    const pm = await productMap(req.auth.tid, body.items.map((i) => i.productId));
    if (pm.size !== new Set(body.items.map((i) => i.productId)).size) throw BadRequest('Некоторые товары не найдены');
    const number = await nextNumber('QUO', () => prisma.quotation.count());
    const quotation = await prisma.quotation.create({
      data: {
        tenantId: req.auth.tid, number, customerId: body.customerId, status: 'draft', createdBy: req.auth.sub,
        note: body.note ?? null, validUntil: body.validUntil ? new Date(body.validUntil) : null,
        items: { create: body.items.map((i) => ({ productId: i.productId, productName: pm.get(i.productId)!.name, productSku: pm.get(i.productId)!.sku, quantity: D(i.quantity), priceMinor: i.priceMinor, discountPct: i.discountPct })) },
      },
      include: { items: true },
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'sales.quotation.create', entity: 'Quotation', entityId: quotation.id, meta: { number }, ip: req.ip });
    return reply.code(201).send({ quotation });
  });

  // Simple status transitions: send / accept / reject.
  for (const [action, from, to] of [['send', 'draft', 'sent'], ['accept', 'sent', 'accepted'], ['reject', 'sent', 'rejected']] as const) {
    app.post(`/quotations/:id/${action}`, { preHandler: [requirePermission('sales.write')] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const qo = await prisma.quotation.findFirst({ where: { id, tenantId: req.auth.tid } });
      if (!qo) throw NotFound('Предложение не найдено');
      if (qo.status !== from) throw BadRequest(`Недопустимый переход из статуса "${qo.status}"`, 'BAD_TRANSITION');
      await prisma.quotation.update({ where: { id }, data: { status: to, decidedAt: action === 'accept' || action === 'reject' ? new Date() : undefined } });
      return reply.send({ ok: true });
    });
  }

  // Convert an accepted quotation into a sales order.
  app.post('/quotations/:id/convert', { preHandler: [requirePermission('sales.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ warehouseId: z.string().optional(), expectedAt: z.string().optional() }).parse(req.body);
    const qo = await prisma.quotation.findFirst({ where: { id, tenantId: req.auth.tid }, include: { items: true } });
    if (!qo) throw NotFound('Предложение не найдено');
    if (qo.status !== 'accepted') throw BadRequest('Сначала клиент должен принять предложение', 'NOT_ACCEPTED');
    const number = await nextNumber('SO', () => prisma.salesOrder.count());
    const so = await prisma.$transaction(async (tx) => {
      const order = await tx.salesOrder.create({
        data: {
          tenantId: req.auth.tid, number, customerId: qo.customerId, warehouseId: body.warehouseId ?? null, status: 'draft', quotationId: id, createdBy: req.auth.sub,
          expectedAt: body.expectedAt ? new Date(body.expectedAt) : null,
          items: { create: qo.items.map((it) => ({ productId: it.productId, productName: it.productName, productSku: it.productSku, quantity: it.quantity, priceMinor: it.priceMinor, discountPct: it.discountPct })) },
        },
      });
      await tx.quotation.update({ where: { id }, data: { status: 'ordered' } });
      return order;
    });
    return reply.code(201).send({ salesOrder: so });
  });

  // ============ SALES ORDERS (5.2) ============
  const soItemSchema = z.object({ productId: z.string(), quantity: quantityPositive, priceMinor: moneyMinor, discountPct: z.number().int().min(0).max(100).default(0) });

  function orderTotals(o: { discountPct: number; items: { priceMinor: number; discountPct: number; quantity: Prisma.Decimal }[] }) {
    const subtotal = o.items.reduce((s, it) => s + lineTotal(it.priceMinor, it.discountPct, it.quantity), 0);
    const total = Math.round(subtotal * (1 - (o.discountPct || 0) / 100));
    return { subtotalMinor: subtotal, totalMinor: total };
  }

  app.get('/orders', { preHandler: [requirePermission('sales.read')] }, async (req) => {
    const { status } = req.query as { status?: string };
    const q = pageQuery.parse(req.query);
    const where = { tenantId: req.auth.tid, ...(status ? { status } : {}) };
    const [orders, total] = await prisma.$transaction([
      prisma.salesOrder.findMany({ where, orderBy: { createdAt: 'desc' }, include: { customer: { select: { name: true } }, items: true }, ...skipTake(q) }),
      prisma.salesOrder.count({ where }),
    ]);
    return {
      orders: orders.map((o) => ({
        id: o.id, number: o.number, customer: o.customer.name, customerId: o.customerId, status: o.status,
        expectedAt: o.expectedAt, warehouseId: o.warehouseId, createdAt: o.createdAt, discountPct: o.discountPct,
        ...orderTotals(o), itemCount: o.items.length,
      })),
      meta: pageMeta(q, total),
    };
  });

  app.get('/orders/:id', { preHandler: [requirePermission('sales.read')] }, async (req) => {
    const { id } = req.params as { id: string };
    const o = await prisma.salesOrder.findFirst({ where: { id, tenantId: req.auth.tid }, include: { customer: true, items: true, shipments: { include: { items: true } }, returns: { include: { items: true } } } });
    if (!o) throw NotFound('Заказ не найден');
    return { order: { ...o, ...orderTotals(o) } };
  });

  app.post('/orders', { preHandler: [requirePermission('sales.write')] }, async (req, reply) => {
    const body = z.object({ customerId: z.string(), warehouseId: z.string().optional(), expectedAt: z.string().optional(), note: z.string().optional(), discountPct: z.number().int().min(0).max(100).default(0), items: z.array(soItemSchema).min(1) }).parse(req.body);
    const customer = await prisma.customer.findFirst({ where: { id: body.customerId, tenantId: req.auth.tid } });
    if (!customer) throw NotFound('Клиент не найден');
    const pm = await productMap(req.auth.tid, body.items.map((i) => i.productId));
    if (pm.size !== new Set(body.items.map((i) => i.productId)).size) throw BadRequest('Некоторые товары не найдены');
    const number = await nextNumber('SO', () => prisma.salesOrder.count());
    const order = await prisma.salesOrder.create({
      data: {
        tenantId: req.auth.tid, number, customerId: body.customerId, warehouseId: body.warehouseId ?? null, status: 'draft', createdBy: req.auth.sub,
        expectedAt: body.expectedAt ? new Date(body.expectedAt) : null, note: body.note ?? null, discountPct: body.discountPct,
        items: { create: body.items.map((i) => ({ productId: i.productId, productName: pm.get(i.productId)!.name, productSku: pm.get(i.productId)!.sku, quantity: D(i.quantity), priceMinor: i.priceMinor, discountPct: i.discountPct })) },
      },
      include: { items: true },
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'sales.order.create', entity: 'SalesOrder', entityId: order.id, meta: { number }, ip: req.ip });
    return reply.code(201).send({ order });
  });

  app.post('/orders/:id/confirm', { preHandler: [requirePermission('sales.confirm')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const o = await prisma.salesOrder.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!o) throw NotFound('Заказ не найден');
    if (o.status !== 'draft') throw BadRequest('Заказ уже подтверждён/обработан', 'BAD_TRANSITION');
    await prisma.salesOrder.update({ where: { id }, data: { status: 'confirmed' } });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'sales.order.confirm', entity: 'SalesOrder', entityId: id, ip: req.ip });
    return reply.send({ ok: true });
  });

  // Reserve remaining unreserved/unshipped quantity against available stock (5.3).
  app.post('/orders/:id/reserve', { preHandler: [requirePermission('sales.confirm')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ warehouseId: z.string().optional() }).parse(req.body ?? {});
    const o = await prisma.salesOrder.findFirst({ where: { id, tenantId: req.auth.tid }, include: { items: true } });
    if (!o) throw NotFound('Заказ не найден');
    if (o.status === 'cancelled') throw BadRequest('Заказ отменён');
    const warehouseId = body.warehouseId ?? o.warehouseId;
    if (!warehouseId) throw BadRequest('Укажите склад для резервирования', 'WAREHOUSE_REQUIRED');
    const wh = await prisma.warehouse.findFirst({ where: { id: warehouseId, tenantId: req.auth.tid } });
    if (!wh) throw NotFound('Склад не найден');

    try {
      await prisma.$transaction(async (tx) => {
        for (const it of o.items) {
          const need = dec(it.quantity).minus(it.reservedQty).minus(0); // reserve up to ordered qty
          const toReserve = need.greaterThan(0) ? need : dec(0);
          if (toReserve.lessThanOrEqualTo(0)) continue;
          await adjustReserved(tx, { tenantId: req.auth.tid, warehouseId, productId: it.productId, delta: toReserve, guardAvailable: true });
          await tx.salesOrderItem.update({ where: { id: it.id }, data: { reservedQty: dec(it.reservedQty).plus(toReserve) } });
        }
        if (!o.warehouseId) await tx.salesOrder.update({ where: { id }, data: { warehouseId } });
      });
    } catch (e: any) {
      if (e?.__insufficient) throw BadRequest(e.message, 'INSUFFICIENT_STOCK');
      throw e;
    }
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'sales.order.reserve', entity: 'SalesOrder', entityId: id, meta: { warehouseId }, ip: req.ip });
    return reply.send({ ok: true });
  });

  // Release all reservations held by an order (e.g. before cancelling).
  async function releaseReservations(tx: Prisma.TransactionClient, tenantId: string, warehouseId: string | null, items: { id: string; productId: string; reservedQty: Prisma.Decimal }[]) {
    if (!warehouseId) return;
    for (const it of items) {
      const held = dec(it.reservedQty);
      if (held.greaterThan(0)) {
        await adjustReserved(tx, { tenantId, warehouseId, productId: it.productId, delta: held.negated() });
        await tx.salesOrderItem.update({ where: { id: it.id }, data: { reservedQty: dec(0) } });
      }
    }
  }

  app.post('/orders/:id/release', { preHandler: [requirePermission('sales.confirm')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const o = await prisma.salesOrder.findFirst({ where: { id, tenantId: req.auth.tid }, include: { items: true } });
    if (!o) throw NotFound('Заказ не найден');
    await prisma.$transaction((tx) => releaseReservations(tx, req.auth.tid, o.warehouseId, o.items));
    return reply.send({ ok: true });
  });

  app.post('/orders/:id/cancel', { preHandler: [requirePermission('sales.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const o = await prisma.salesOrder.findFirst({ where: { id, tenantId: req.auth.tid }, include: { items: true } });
    if (!o) throw NotFound('Заказ не найден');
    if (o.status === 'shipped') throw BadRequest('Отгруженный заказ нельзя отменить');
    await prisma.$transaction(async (tx) => {
      await releaseReservations(tx, req.auth.tid, o.warehouseId, o.items);
      await tx.salesOrder.update({ where: { id }, data: { status: 'cancelled' } });
    });
    return reply.send({ ok: true });
  });

  // ============ SHIPMENT (5.4) — ship against a SO, applies stock OUT ============
  app.post('/orders/:id/ship', { preHandler: [requirePermission('sales.ship')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ warehouseId: z.string().optional(), note: z.string().optional(), items: z.array(z.object({ productId: z.string(), quantity: quantityPositive })).min(1) }).parse(req.body);
    const o = await prisma.salesOrder.findFirst({ where: { id, tenantId: req.auth.tid }, include: { items: true } });
    if (!o) throw NotFound('Заказ не найден');
    if (o.status === 'cancelled') throw BadRequest('Заказ отменён');
    if (o.status === 'draft') throw BadRequest('Сначала подтвердите заказ', 'NOT_CONFIRMED');
    const warehouseId = body.warehouseId ?? o.warehouseId;
    if (!warehouseId) throw BadRequest('Укажите склад для отгрузки', 'WAREHOUSE_REQUIRED');
    const wh = await prisma.warehouse.findFirst({ where: { id: warehouseId, tenantId: req.auth.tid } });
    if (!wh) throw NotFound('Склад не найден');

    // Validate against remaining ordered quantities (no over-shipment).
    const byProduct = new Map(o.items.map((it) => [it.productId, it]));
    for (const line of body.items) {
      const it = byProduct.get(line.productId);
      if (!it) throw BadRequest(`Товар вне заказа: ${line.productId}`, 'NOT_IN_SO');
      const remaining = dec(it.quantity).minus(it.shippedQty);
      if (D(line.quantity).greaterThan(remaining)) throw BadRequest(`Отгрузка превышает остаток по заказу (осталось ${remaining.toString()})`, 'OVER_SHIP');
    }

    const customer = await prisma.customer.findFirst({ where: { id: o.customerId, tenantId: req.auth.tid }, select: { name: true } });
    const number = await nextNumber('SH', () => prisma.shipment.count());
    try {
      const shipment = await prisma.$transaction(async (tx) => {
        const sh = await tx.shipment.create({
          data: {
            tenantId: req.auth.tid, number, soId: o.id, customerId: o.customerId, warehouseId, note: body.note ?? null, shippedBy: req.auth.sub,
            items: { create: body.items.map((l) => ({ productId: l.productId, productName: byProduct.get(l.productId)!.productName, quantity: D(l.quantity) })) },
          },
        });
        let cogsMinor = 0n;
        let saleValueMinor = 0n;
        for (const l of body.items) {
          const it = byProduct.get(l.productId)!;
          const ship = D(l.quantity);
          // Release the portion that was reserved for this line before consuming on-hand.
          const releaseQty = Prisma.Decimal.min(dec(it.reservedQty), ship);
          if (releaseQty.greaterThan(0)) await adjustReserved(tx, { tenantId: req.auth.tid, warehouseId, productId: l.productId, delta: releaseQty.negated() });
          // Consume on-hand via the shared warehouse contract (stock OUT, negative delta).
          const res = await applyStockDelta(tx, { tenantId: req.auth.tid, warehouseId, productId: l.productId, type: 'OUT', delta: ship.negated(), reason: `Отгрузка по заказу ${o.number}`, refType: 'Shipment', refId: sh.id, userId: req.auth.sub });
          cogsMinor += res.costMinor;
          // Sale value of this line = qty * price, net of line and order discounts.
          const lineValue = ship.mul(it.priceMinor).mul(100 - (it.discountPct ?? 0)).div(100).mul(100 - (o.discountPct ?? 0)).div(100);
          saleValueMinor += BigInt(lineValue.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0));
          await tx.salesOrderItem.update({ where: { id: it.id }, data: { shippedQty: dec(it.shippedQty).plus(ship), reservedQty: Prisma.Decimal.max(dec(0), dec(it.reservedQty).minus(releaseQty)) } });
        }
        // Recompute SO status.
        const items = await tx.salesOrderItem.findMany({ where: { soId: o.id } });
        const allShipped = items.every((it) => dec(it.shippedQty).greaterThanOrEqualTo(it.quantity));
        const anyShipped = items.some((it) => dec(it.shippedQty).greaterThan(0));
        await tx.salesOrder.update({ where: { id: o.id }, data: { status: allShipped ? 'shipped' : anyShipped ? 'partially_shipped' : o.status } });
        // Auto-posting (Stage 8.4): recognise revenue (Dr AR/Cr Revenue) and COGS.
        await emitEvent('sales.shipped', { refId: sh.id, number, saleValueMinor, cogsMinor, customerName: customer?.name ?? null }, { tx, tenantId: req.auth.tid, userId: req.auth.sub });
        return sh;
      });
      await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'sales.ship', entity: 'Shipment', entityId: shipment.id, meta: { so: o.number, number }, ip: req.ip });
      return reply.code(201).send({ shipment: { id: shipment.id, number: shipment.number } });
    } catch (e: any) {
      if (e?.__insufficient) throw BadRequest(e.message, 'INSUFFICIENT_STOCK');
      throw e;
    }
  });

  app.get('/shipments', { preHandler: [requirePermission('sales.read')] }, async (req) => {
    const q = pageQuery.parse(req.query);
    const where = { tenantId: req.auth.tid };
    const [shipments, total] = await prisma.$transaction([
      prisma.shipment.findMany({ where, orderBy: { createdAt: 'desc' }, include: { items: true, so: { select: { number: true } } }, ...skipTake(q) }),
      prisma.shipment.count({ where }),
    ]);
    return { shipments, meta: pageMeta(q, total) };
  });

  // ============ RETURNS (5.4) — customer return, applies stock IN ============
  app.post('/returns', { preHandler: [requirePermission('sales.ship')] }, async (req, reply) => {
    const body = z.object({ soId: z.string().optional(), warehouseId: z.string(), reason: z.string().optional(), note: z.string().optional(), items: z.array(z.object({ productId: z.string(), quantity: quantityPositive })).min(1) }).parse(req.body);
    const wh = await prisma.warehouse.findFirst({ where: { id: body.warehouseId, tenantId: req.auth.tid } });
    if (!wh) throw NotFound('Склад не найден');
    const so = body.soId ? await prisma.salesOrder.findFirst({ where: { id: body.soId, tenantId: req.auth.tid }, include: { items: true } }) : null;
    if (body.soId && !so) throw NotFound('Заказ не найден');
    const pm = await productMap(req.auth.tid, body.items.map((i) => i.productId));

    // If tied to an SO, disallow returning more than was shipped.
    if (so) {
      const shippedByProduct = new Map(so.items.map((it) => [it.productId, dec(it.shippedQty)]));
      for (const l of body.items) {
        const shipped = shippedByProduct.get(l.productId) ?? dec(0);
        if (D(l.quantity).greaterThan(shipped)) throw BadRequest(`Возврат превышает отгруженное по заказу (отгружено ${shipped.toString()})`, 'OVER_RETURN');
      }
    }

    const customer = so?.customerId ? await prisma.customer.findFirst({ where: { id: so.customerId, tenantId: req.auth.tid }, select: { name: true } }) : null;
    const number = await nextNumber('RET', () => prisma.salesReturn.count());
    const ret = await prisma.$transaction(async (tx) => {
      const r = await tx.salesReturn.create({
        data: {
          tenantId: req.auth.tid, number, soId: so?.id ?? null, customerId: so?.customerId ?? null, warehouseId: body.warehouseId, reason: body.reason ?? null, note: body.note ?? null, createdBy: req.auth.sub,
          items: { create: body.items.map((l) => ({ productId: l.productId, productName: pm.get(l.productId)?.name ?? l.productId, quantity: D(l.quantity) })) },
        },
      });
      let cogsMinor = 0n;
      let saleValueMinor = 0n;
      for (const l of body.items) {
        const res = await applyStockDelta(tx, { tenantId: req.auth.tid, warehouseId: body.warehouseId, productId: l.productId, type: 'IN', delta: D(l.quantity), reason: `Возврат ${number}${so ? ' по заказу ' + so.number : ''}`, refType: 'SalesReturn', refId: r.id, userId: req.auth.sub });
        cogsMinor += res.costMinor;
        // Reduce shippedQty so the order reflects the net shipped amount.
        if (so) {
          const it = so.items.find((x) => x.productId === l.productId);
          if (it) {
            const lineValue = D(l.quantity).mul(it.priceMinor).mul(100 - (it.discountPct ?? 0)).div(100).mul(100 - (so.discountPct ?? 0)).div(100);
            saleValueMinor += BigInt(lineValue.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0));
            await tx.salesOrderItem.update({ where: { id: it.id }, data: { shippedQty: Prisma.Decimal.max(dec(0), dec(it.shippedQty).minus(l.quantity)) } });
          }
        }
      }
      // Auto-posting (Stage 8.4): reverse revenue and COGS for the returned goods.
      await emitEvent('sales.returned', { refId: r.id, number, saleValueMinor, cogsMinor, customerName: customer?.name ?? null }, { tx, tenantId: req.auth.tid, userId: req.auth.sub });
      return r;
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'sales.return', entity: 'SalesReturn', entityId: ret.id, meta: { number }, ip: req.ip });
    return reply.code(201).send({ salesReturn: { id: ret.id, number: ret.number } });
  });

  app.get('/returns', { preHandler: [requirePermission('sales.read')] }, async (req) => {
    const q = pageQuery.parse(req.query);
    const where = { tenantId: req.auth.tid };
    const [returns, total] = await prisma.$transaction([
      prisma.salesReturn.findMany({ where, orderBy: { createdAt: 'desc' }, include: { items: true, so: { select: { number: true } } }, ...skipTake(q) }),
      prisma.salesReturn.count({ where }),
    ]);
    return { returns, meta: pageMeta(q, total) };
  });
}
