// POS / Касса (Stage 15). Retail point-of-sale behind /api/v1/pos:
//   - registers (till terminals bound to a warehouse)
//   - cashier shifts: open with a cash float → sell/refund → close with counted cash (X/Z)
//   - receipts: a sale draws stock OUT (COGS captured) and books revenue via events;
//     a refund returns stock IN and reverses the revenue
// Money is integer minor units (BigInt — a single receipt total can exceed the Int ceiling).
// VAT is added on top of the net line value, consistent with sales shipments.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { requirePermission } from '../../plugins/rbac.js';
import { blockIfInactiveWrite } from '../../plugins/subscription.js';
import { audit } from '../../lib/audit.js';
import { BadRequest, NotFound } from '../../lib/errors.js';
import { nextDocNumber } from '../../lib/ledger.js';
import { emitEvent } from '../../lib/events.js';
import { applyStockDelta } from '../../lib/stock.js';
import { getVatSettings, vatOnNet } from '../../lib/vat.js';

type Tx = Prisma.TransactionClient;
const D = (v: number | string | Prisma.Decimal) => new Prisma.Decimal(v);

// Find the single open shift for a register (POS operations attach to it).
async function openShiftFor(tx: Tx, tenantId: string, registerId: string) {
  return tx.posShift.findFirst({ where: { tenantId, registerId, status: 'open' } });
}

export default async function posRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', blockIfInactiveWrite);

  // ==================== REGISTERS ====================
  app.get('/registers', { preHandler: [requirePermission('pos.use')] }, async (req) => {
    const registers = await prisma.posRegister.findMany({ where: { tenantId: req.auth.tid }, orderBy: { name: 'asc' } });
    // Enrich with warehouse name + current open shift (denormalized refs, so look up).
    const whIds = [...new Set(registers.map((r) => r.warehouseId))];
    const warehouses = await prisma.warehouse.findMany({ where: { tenantId: req.auth.tid, id: { in: whIds } }, select: { id: true, name: true } });
    const whName = new Map(warehouses.map((w) => [w.id, w.name]));
    const openShifts = await prisma.posShift.findMany({ where: { tenantId: req.auth.tid, status: 'open' }, select: { id: true, registerId: true, number: true } });
    const openByReg = new Map(openShifts.map((s) => [s.registerId, s]));
    const vat = await getVatSettings(prisma, req.auth.tid);
    return { registers: registers.map((r) => ({ ...r, warehouseName: whName.get(r.warehouseId) ?? null, openShift: openByReg.get(r.id) ?? null })), vat };
  });

  app.post('/registers', { preHandler: [requirePermission('pos.manage')] }, async (req, reply) => {
    const body = z.object({
      name: z.string().min(1).max(120),
      code: z.string().min(1).max(40).regex(/^[a-z0-9_-]+$/i, 'Латиница/цифры/дефис'),
      warehouseId: z.string(),
      priceListId: z.string().nullish(),
    }).parse(req.body);
    const wh = await prisma.warehouse.findFirst({ where: { id: body.warehouseId, tenantId: req.auth.tid } });
    if (!wh) throw NotFound('Склад не найден');
    if (await prisma.posRegister.findUnique({ where: { tenantId_code: { tenantId: req.auth.tid, code: body.code } } })) throw BadRequest('Касса с таким кодом уже есть', 'CODE_EXISTS');
    const register = await prisma.posRegister.create({ data: { tenantId: req.auth.tid, name: body.name, code: body.code, warehouseId: body.warehouseId, priceListId: body.priceListId || null } });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'pos.register.create', entity: 'PosRegister', entityId: register.id, ip: req.ip });
    return reply.code(201).send({ register });
  });

  app.patch('/registers/:id', { preHandler: [requirePermission('pos.manage')] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ name: z.string().min(1).max(120).optional(), active: z.boolean().optional(), priceListId: z.string().nullish(), warehouseId: z.string().optional() }).parse(req.body);
    const existing = await prisma.posRegister.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!existing) throw NotFound('Касса не найдена');
    if (body.warehouseId) {
      const wh = await prisma.warehouse.findFirst({ where: { id: body.warehouseId, tenantId: req.auth.tid } });
      if (!wh) throw NotFound('Склад не найден');
    }
    const data: Prisma.PosRegisterUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.active !== undefined) data.active = body.active;
    if (body.priceListId !== undefined) data.priceListId = body.priceListId || null;
    if (body.warehouseId !== undefined) data.warehouseId = body.warehouseId;
    const register = await prisma.posRegister.update({ where: { id }, data });
    return { register };
  });

  // ==================== SHIFTS ====================
  app.get('/shifts', { preHandler: [requirePermission('pos.use')] }, async (req) => {
    const q = z.object({ registerId: z.string().optional(), status: z.string().optional() }).parse(req.query);
    const where: Prisma.PosShiftWhereInput = { tenantId: req.auth.tid };
    if (q.registerId) where.registerId = q.registerId;
    if (q.status) where.status = q.status;
    const shifts = await prisma.posShift.findMany({ where, include: { register: { select: { name: true } }, _count: { select: { receipts: true } } }, orderBy: { openedAt: 'desc' }, take: 100 });
    return { shifts };
  });

  app.get('/shifts/current', { preHandler: [requirePermission('pos.use')] }, async (req) => {
    const q = z.object({ registerId: z.string() }).parse(req.query);
    const shift = await openShiftFor(prisma, req.auth.tid, q.registerId);
    return { shift };
  });

  app.get('/shifts/:id', { preHandler: [requirePermission('pos.use')] }, async (req) => {
    const { id } = req.params as { id: string };
    const shift = await prisma.posShift.findFirst({ where: { id, tenantId: req.auth.tid }, include: { register: { select: { name: true, code: true } } } });
    if (!shift) throw NotFound('Смена не найдена');
    const receipts = await prisma.posReceipt.findMany({ where: { shiftId: id }, orderBy: { createdAt: 'desc' }, take: 500 });
    // X/Z figures: expected cash = opening float + net cash sales.
    const expectedCashMinor = shift.openingFloatMinor + shift.cashSalesMinor;
    return { shift, receipts, report: { expectedCashMinor } };
  });

  app.post('/shifts/open', { preHandler: [requirePermission('pos.use')] }, async (req, reply) => {
    const body = z.object({ registerId: z.string(), openingFloatMinor: z.number().int().min(0).default(0), note: z.string().max(300).nullish() }).parse(req.body);
    const register = await prisma.posRegister.findFirst({ where: { id: body.registerId, tenantId: req.auth.tid } });
    if (!register) throw NotFound('Касса не найдена');
    if (!register.active) throw BadRequest('Касса неактивна', 'REGISTER_INACTIVE');
    if (await openShiftFor(prisma, req.auth.tid, body.registerId)) throw BadRequest('На этой кассе уже открыта смена', 'SHIFT_ALREADY_OPEN');
    const shift = await prisma.$transaction(async (tx) => {
      const number = await nextDocNumber(tx, req.auth.tid, 'pos_shift', 'SHIFT');
      return tx.posShift.create({ data: { tenantId: req.auth.tid, registerId: body.registerId, number, openingFloatMinor: BigInt(body.openingFloatMinor), openedBy: req.auth.sub, note: body.note || null } });
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'pos.shift.open', entity: 'PosShift', entityId: shift.id, ip: req.ip });
    return reply.code(201).send({ shift });
  });

  app.post('/shifts/:id/close', { preHandler: [requirePermission('pos.use')] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ countedCashMinor: z.number().int().min(0) }).parse(req.body);
    const shift = await prisma.posShift.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!shift) throw NotFound('Смена не найдена');
    if (shift.status !== 'open') throw BadRequest('Смена уже закрыта', 'SHIFT_CLOSED');
    const expected = shift.openingFloatMinor + shift.cashSalesMinor;
    const counted = BigInt(body.countedCashMinor);
    const updated = await prisma.posShift.update({
      where: { id },
      data: { status: 'closed', closedBy: req.auth.sub, closedAt: new Date(), expectedCashMinor: expected, countedCashMinor: counted, cashVarianceMinor: counted - expected },
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'pos.shift.close', entity: 'PosShift', entityId: id, meta: { variance: Number(counted - expected) }, ip: req.ip });
    return { shift: updated };
  });

  // ==================== RECEIPTS ====================
  // Resolve a line's unit price: explicit override → register price list → product price.
  async function priceFor(tx: Tx, tenantId: string, priceListId: string | null, productId: string, fallback: bigint): Promise<bigint> {
    if (priceListId) {
      const pli = await tx.priceListItem.findFirst({ where: { priceListId, productId } });
      if (pli) return BigInt(pli.priceMinor);
    }
    return fallback;
  }

  app.get('/receipts', { preHandler: [requirePermission('pos.use')] }, async (req) => {
    const q = z.object({ shiftId: z.string().optional(), registerId: z.string().optional() }).parse(req.query);
    const where: Prisma.PosReceiptWhereInput = { tenantId: req.auth.tid };
    if (q.shiftId) where.shiftId = q.shiftId;
    if (q.registerId) where.registerId = q.registerId;
    const receipts = await prisma.posReceipt.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
    return { receipts };
  });

  app.get('/receipts/:id', { preHandler: [requirePermission('pos.use')] }, async (req) => {
    const { id } = req.params as { id: string };
    const receipt = await prisma.posReceipt.findFirst({ where: { id, tenantId: req.auth.tid }, include: { items: true } });
    if (!receipt) throw NotFound('Чек не найден');
    return { receipt };
  });

  // Create a sale: draw stock OUT of the register's warehouse, capture COGS, book revenue.
  app.post('/receipts', { preHandler: [requirePermission('pos.use')] }, async (req, reply) => {
    const body = z.object({
      registerId: z.string(),
      lines: z.array(z.object({
        productId: z.string(),
        qty: z.number().positive(),
        unitPriceMinor: z.number().int().min(0).optional(),
      })).min(1, 'Добавьте хотя бы одну позицию'),
      discountMinor: z.number().int().min(0).default(0),
      paymentMethod: z.enum(['cash', 'card', 'mixed']).default('cash'),
      cardMinor: z.number().int().min(0).default(0), // used for mixed / card
      tenderedMinor: z.number().int().min(0).optional(), // cash given (for change)
      customerId: z.string().nullish(),
    }).parse(req.body);

    const register = await prisma.posRegister.findFirst({ where: { id: body.registerId, tenantId: req.auth.tid } });
    if (!register) throw NotFound('Касса не найдена');

    try {
      const result = await prisma.$transaction(async (tx) => {
        const shift = await openShiftFor(tx, req.auth.tid, body.registerId);
        if (!shift) throw BadRequest('Откройте смену на кассе', 'NO_OPEN_SHIFT');

        // Price + stock OUT per line.
        const products = await tx.product.findMany({ where: { tenantId: req.auth.tid, id: { in: body.lines.map((l) => l.productId) } } });
        const prodById = new Map(products.map((p) => [p.id, p]));
        let subtotal = 0n, cogs = 0n;
        const receiptId = (await tx.posReceipt.create({ data: { tenantId: req.auth.tid, shiftId: shift.id, registerId: register.id, number: await nextDocNumber(tx, req.auth.tid, 'pos_receipt', 'R'), type: 'sale', paymentMethod: body.paymentMethod, cashierId: req.auth.sub, customerId: body.customerId || null } })).id;
        for (const l of body.lines) {
          const product = prodById.get(l.productId);
          if (!product) throw BadRequest('Товар не найден', 'PRODUCT_NOT_FOUND');
          const unit = l.unitPriceMinor != null ? BigInt(l.unitPriceMinor) : await priceFor(tx, req.auth.tid, register.priceListId, l.productId, BigInt(product.priceMinor));
          const qty = D(l.qty);
          // Guard against overselling: available = on-hand − reserved must cover the line.
          const si = await tx.stockItem.findUnique({ where: { warehouseId_productId: { warehouseId: register.warehouseId, productId: l.productId } } });
          const available = si ? D(si.quantity).minus(si.reserved) : D(0);
          if (available.lessThan(qty)) throw BadRequest(`Недостаточно товара «${product.name}» на складе (доступно ${available.toFixed(0)})`, 'INSUFFICIENT_STOCK');
          const lineTotal = BigInt(qty.mul(unit.toString()).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0));
          const res = await applyStockDelta(tx, { tenantId: req.auth.tid, warehouseId: register.warehouseId, productId: l.productId, type: 'OUT', delta: qty.negated(), reason: `Продажа (касса ${register.code})`, refType: 'PosReceipt', refId: receiptId, userId: req.auth.sub });
          cogs += res.costMinor;
          subtotal += lineTotal;
          await tx.posReceiptItem.create({ data: { tenantId: req.auth.tid, receiptId, productId: l.productId, productName: product.name, sku: product.sku, qty, unitPriceMinor: unit, lineTotalMinor: lineTotal, costMinor: res.costMinor } });
        }

        const discount = BigInt(body.discountMinor);
        if (discount > subtotal) throw BadRequest('Скидка больше суммы чека', 'DISCOUNT_TOO_LARGE');
        const netSale = subtotal - discount;
        const vat = await getVatSettings(tx, req.auth.tid);
        const vatMinor = vat.enabled ? vatOnNet(netSale, vat.ratePct) : 0n;
        const total = netSale + vatMinor;

        // Split payment.
        let cashMinor = 0n, cardMinor = 0n, tendered = 0n, change = 0n;
        if (body.paymentMethod === 'card') {
          cardMinor = total; tendered = total;
        } else if (body.paymentMethod === 'mixed') {
          cardMinor = BigInt(body.cardMinor);
          if (cardMinor > total) throw BadRequest('Сумма по карте больше итога', 'CARD_TOO_LARGE');
          cashMinor = total - cardMinor;
          tendered = body.tenderedMinor != null ? BigInt(body.tenderedMinor) : cashMinor;
          if (tendered < cashMinor) throw BadRequest('Недостаточно внесено наличными', 'INSUFFICIENT_TENDER');
          change = tendered - cashMinor;
        } else { // cash
          cashMinor = total;
          tendered = body.tenderedMinor != null ? BigInt(body.tenderedMinor) : total;
          if (tendered < total) throw BadRequest('Внесено меньше суммы чека', 'INSUFFICIENT_TENDER');
          change = tendered - total;
        }

        const receipt = await tx.posReceipt.update({
          where: { id: receiptId },
          data: { subtotalMinor: subtotal, discountMinor: discount, vatMinor, totalMinor: total, cogsMinor: cogs, cashMinor, cardMinor, tenderedMinor: tendered, changeMinor: change },
          include: { items: true },
        });
        await tx.posShift.update({ where: { id: shift.id }, data: { cashSalesMinor: shift.cashSalesMinor + cashMinor, cardSalesMinor: shift.cardSalesMinor + cardMinor, totalSalesMinor: shift.totalSalesMinor + total, receiptCount: shift.receiptCount + 1 } });
        await emitEvent('pos.sale', { refId: receipt.id, number: receipt.number, saleValueMinor: netSale, cogsMinor: cogs, cashMinor, cardMinor }, { tx, tenantId: req.auth.tid, userId: req.auth.sub });
        return receipt;
      });
      await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'pos.sale', entity: 'PosReceipt', entityId: result.id, meta: { total: Number(result.totalMinor) }, ip: req.ip });
      return reply.code(201).send({ receipt: result });
    } catch (e: any) {
      if (e?.__insufficient) throw BadRequest(e.message, 'INSUFFICIENT_STOCK');
      throw e;
    }
  });

  // Refund a completed sale: return stock and reverse the revenue. Attaches to the open shift.
  app.post('/receipts/:id/refund', { preHandler: [requirePermission('pos.use')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const original = await prisma.posReceipt.findFirst({ where: { id, tenantId: req.auth.tid }, include: { items: true } });
    if (!original) throw NotFound('Чек не найден');
    if (original.type !== 'sale') throw BadRequest('Возврат возможен только по чеку продажи', 'NOT_A_SALE');
    const already = await prisma.posReceipt.findFirst({ where: { tenantId: req.auth.tid, type: 'refund', refReceiptId: id } });
    if (already) throw BadRequest('По этому чеку уже был возврат', 'ALREADY_REFUNDED');

    const register = await prisma.posRegister.findFirst({ where: { id: original.registerId, tenantId: req.auth.tid } });
    if (!register) throw NotFound('Касса не найдена');
    const refund = await prisma.$transaction(async (tx) => {
      const shift = await openShiftFor(tx, req.auth.tid, original.registerId);
      if (!shift) throw BadRequest('Откройте смену на кассе', 'NO_OPEN_SHIFT');
      const number = await nextDocNumber(tx, req.auth.tid, 'pos_receipt', 'R');
      const r = await tx.posReceipt.create({
        data: {
          tenantId: req.auth.tid, shiftId: shift.id, registerId: original.registerId, number, type: 'refund', refReceiptId: original.id,
          subtotalMinor: original.subtotalMinor, discountMinor: original.discountMinor, vatMinor: original.vatMinor, totalMinor: original.totalMinor, cogsMinor: original.cogsMinor,
          paymentMethod: original.paymentMethod, cashMinor: original.cashMinor, cardMinor: original.cardMinor, cashierId: req.auth.sub, customerId: original.customerId,
        },
      });
      for (const it of original.items) {
        const res = await applyStockDelta(tx, { tenantId: req.auth.tid, warehouseId: register.warehouseId, productId: it.productId, type: 'IN', delta: it.qty, reason: `Возврат по чеку ${original.number}`, refType: 'PosReceipt', refId: r.id, userId: req.auth.sub });
        await tx.posReceiptItem.create({ data: { tenantId: req.auth.tid, receiptId: r.id, productId: it.productId, productName: it.productName, sku: it.sku, qty: it.qty, unitPriceMinor: it.unitPriceMinor, lineTotalMinor: it.lineTotalMinor, costMinor: res.costMinor } });
      }
      const netSale = original.subtotalMinor - original.discountMinor;
      await tx.posShift.update({ where: { id: shift.id }, data: { cashSalesMinor: shift.cashSalesMinor - original.cashMinor, cardSalesMinor: shift.cardSalesMinor - original.cardMinor, totalSalesMinor: shift.totalSalesMinor - original.totalMinor, refundsMinor: shift.refundsMinor + original.totalMinor } });
      await emitEvent('pos.refund', { refId: r.id, number: r.number, saleValueMinor: netSale, cogsMinor: original.cogsMinor, cashMinor: original.cashMinor, cardMinor: original.cardMinor }, { tx, tenantId: req.auth.tid, userId: req.auth.sub });
      return r;
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'pos.refund', entity: 'PosReceipt', entityId: refund.id, ip: req.ip });
    return reply.code(201).send({ receipt: refund });
  });

  // ==================== REPORTS ====================
  app.get('/summary', { preHandler: [requirePermission('pos.use')] }, async (req) => {
    const tid = req.auth.tid;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const [openShifts, todaySales, todayRefunds] = await Promise.all([
      prisma.posShift.count({ where: { tenantId: tid, status: 'open' } }),
      prisma.posReceipt.aggregate({ where: { tenantId: tid, type: 'sale', createdAt: { gte: start } }, _sum: { totalMinor: true }, _count: true }),
      prisma.posReceipt.aggregate({ where: { tenantId: tid, type: 'refund', createdAt: { gte: start } }, _sum: { totalMinor: true }, _count: true }),
    ]);
    return {
      openShifts,
      today: {
        salesMinor: todaySales._sum.totalMinor ?? 0n, salesCount: todaySales._count,
        refundsMinor: todayRefunds._sum.totalMinor ?? 0n, refundsCount: todayRefunds._count,
      },
    };
  });

  app.get('/reports/sales', { preHandler: [requirePermission('pos.manage')] }, async (req) => {
    const q = z.object({ from: z.string().optional(), to: z.string().optional() }).parse(req.query);
    const where: Prisma.PosReceiptWhereInput = { tenantId: req.auth.tid };
    if (q.from || q.to) {
      const to = q.to ? new Date(q.to) : undefined;
      if (to) to.setHours(23, 59, 59, 999);
      where.createdAt = { ...(q.from ? { gte: new Date(q.from) } : {}), ...(to ? { lte: to } : {}) };
    }
    const [sales, refunds] = await Promise.all([
      prisma.posReceipt.aggregate({ where: { ...where, type: 'sale' }, _sum: { totalMinor: true, cashMinor: true, cardMinor: true, cogsMinor: true }, _count: true }),
      prisma.posReceipt.aggregate({ where: { ...where, type: 'refund' }, _sum: { totalMinor: true }, _count: true }),
    ]);
    const salesMinor = sales._sum.totalMinor ?? 0n;
    const cogsMinor = sales._sum.cogsMinor ?? 0n;
    return {
      salesMinor, salesCount: sales._count,
      cashMinor: sales._sum.cashMinor ?? 0n, cardMinor: sales._sum.cardMinor ?? 0n,
      cogsMinor, grossProfitMinor: salesMinor - cogsMinor,
      refundsMinor: refunds._sum.totalMinor ?? 0n, refundsCount: refunds._count,
    };
  });
}
