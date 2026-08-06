// Stage 10.1/10.2 analytics: KPI aggregation, time-series and tabular reports.
// Financial figures come from the posted journal (reliable since Stage 8); operational
// counts/values come straight from the domain tables. Money = integer minor units.
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';

const D = (v: Prisma.Decimal | number | string) => new Prisma.Decimal(v);

export interface Range { from?: Date; to?: Date }

function dateWhere(r: Range) {
  return r.from || r.to ? { date: { ...(r.from ? { gte: r.from } : {}), ...(r.to ? { lte: r.to } : {}) } } : {};
}

// Net movement of a ledger account over a range, in its normal-balance direction.
async function accountNet(tenantId: string, code: string, normal: 'debit' | 'credit', r: Range = {}): Promise<bigint> {
  const lines = await prisma.journalLine.findMany({
    where: { accountCode: code, entry: { tenantId, status: 'posted', ...dateWhere(r) } },
    select: { debitMinor: true, creditMinor: true },
  });
  let net = 0n;
  for (const l of lines) net += normal === 'debit' ? l.debitMinor - l.creditMinor : l.creditMinor - l.debitMinor;
  return net;
}

export async function computeKpis(tenantId: string, r: Range = {}) {
  const [revenue, cogs, ar, ap, accounts, stockItems, lowStock, salesOrders, purchaseOrders, prodDone, openDeals] = await Promise.all([
    accountNet(tenantId, '6010', 'credit', r),
    accountNet(tenantId, '7010', 'debit', r),
    accountNet(tenantId, '1030', 'debit'),      // AR balance (all-time)
    accountNet(tenantId, '5010', 'credit'),     // AP balance (all-time)
    prisma.finAccount.findMany({ where: { tenantId, status: 'active' }, select: { balanceMinor: true } }),
    prisma.stockItem.findMany({ where: { tenantId, quantity: { gt: 0 } }, select: { quantity: true, avgCostMinor: true } }),
    prisma.stockItem.count({ where: { tenantId, minQty: { gt: 0 } } }),
    prisma.salesOrder.count({ where: { tenantId, ...(r.from || r.to ? { createdAt: { ...(r.from ? { gte: r.from } : {}), ...(r.to ? { lte: r.to } : {}) } } : {}) } }),
    prisma.purchaseOrder.count({ where: { tenantId, ...(r.from || r.to ? { createdAt: { ...(r.from ? { gte: r.from } : {}), ...(r.to ? { lte: r.to } : {}) } } : {}) } }),
    prisma.productionOrder.count({ where: { tenantId, status: 'done' } }),
    prisma.deal.aggregate({ where: { tenantId, stage: { notIn: ['won', 'lost'] } }, _count: true, _sum: { amountMinor: true } }),
  ]);

  // Low-stock: available (on-hand − reserved) below the minimum.
  const lowRows = await prisma.stockItem.findMany({ where: { tenantId, minQty: { gt: 0 } }, select: { quantity: true, reserved: true, minQty: true } });
  const lowStockCount = lowRows.filter((s) => D(s.quantity).minus(s.reserved).lessThan(s.minQty)).length;

  const cash = accounts.reduce((s, a) => s + a.balanceMinor, 0n);
  const stockValue = stockItems.reduce((s, it) => s + BigInt(D(it.quantity).mul(it.avgCostMinor.toString()).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0)), 0n);

  return {
    revenueMinor: revenue, cogsMinor: cogs, grossProfitMinor: revenue - cogs,
    cashMinor: cash, stockValueMinor: stockValue, arMinor: ar, apMinor: ap,
    lowStockCount, totalStockSkus: stockItems.length,
    salesOrders, purchaseOrders, productionDone: prodDone,
    openDeals: openDeals._count, openDealsAmountMinor: openDeals._sum.amountMinor ?? 0n,
  };
}

// Revenue time-series bucketed by month or day, from posted revenue postings.
export async function revenueSeries(tenantId: string, r: Range, bucket: 'day' | 'month' = 'month') {
  const lines = await prisma.journalLine.findMany({
    where: { accountCode: '6010', entry: { tenantId, status: 'posted', ...dateWhere(r) } },
    select: { debitMinor: true, creditMinor: true, entry: { select: { date: true } } },
  });
  const map = new Map<string, bigint>();
  for (const l of lines) {
    const d = l.entry.date;
    const key = bucket === 'day' ? d.toISOString().slice(0, 10) : `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    map.set(key, (map.get(key) ?? 0n) + (l.creditMinor - l.debitMinor));
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, amountMinor]) => ({ label, amountMinor }));
}

// Top products by shipped quantity (from stock OUT movements of type sales shipment).
export async function topProducts(tenantId: string, r: Range, limit = 8) {
  const movements = await prisma.stockMovement.findMany({
    where: { tenantId, type: 'OUT', reason: { contains: 'Отгрузка' }, ...(r.from || r.to ? { createdAt: { ...(r.from ? { gte: r.from } : {}), ...(r.to ? { lte: r.to } : {}) } } : {}) },
    select: { productId: true, quantity: true, costMinor: true },
  });
  const agg = new Map<string, { qty: Prisma.Decimal; costMinor: bigint }>();
  for (const m of movements) {
    const cur = agg.get(m.productId) ?? { qty: D(0), costMinor: 0n };
    // OUT quantities/costs are negative in the ledger; use magnitude for "top sold".
    const c = m.costMinor ?? 0n;
    cur.qty = cur.qty.plus(D(m.quantity).abs());
    cur.costMinor += c < 0n ? -c : c;
    agg.set(m.productId, cur);
  }
  const ids = [...agg.keys()];
  const products = ids.length ? await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, sku: true } }) : [];
  const nameById = new Map(products.map((p) => [p.id, p]));
  return [...agg.entries()]
    .map(([id, v]) => ({ productId: id, name: nameById.get(id)?.name ?? id, sku: nameById.get(id)?.sku ?? '', quantity: v.qty.toString(), costMinor: v.costMinor }))
    .sort((a, b) => Number(b.quantity) - Number(a.quantity)).slice(0, limit);
}

// ---- Tabular reports (generic {columns, rows} for export) ----
export interface ReportTable { title: string; columns: { key: string; label: string }[]; rows: Record<string, unknown>[] }

function orderTotal(items: { quantity: Prisma.Decimal; priceMinor: number }[]): number {
  return items.reduce((s, it) => s + Math.round(Number(it.quantity) * it.priceMinor), 0);
}

export async function buildReport(tenantId: string, type: string, r: Range = {}): Promise<ReportTable> {
  const created = r.from || r.to ? { createdAt: { ...(r.from ? { gte: r.from } : {}), ...(r.to ? { lte: r.to } : {}) } } : {};
  if (type === 'sales') {
    const orders = await prisma.salesOrder.findMany({ where: { tenantId, ...created }, include: { customer: { select: { name: true } }, items: true }, orderBy: { createdAt: 'desc' } });
    return {
      title: 'Отчёт по продажам',
      columns: [{ key: 'number', label: '№' }, { key: 'customer', label: 'Клиент' }, { key: 'status', label: 'Статус' }, { key: 'total', label: 'Сумма' }, { key: 'date', label: 'Дата' }],
      rows: orders.map((o) => ({ number: o.number, customer: o.customer?.name ?? '', status: o.status, total: orderTotal(o.items), date: o.createdAt.toISOString().slice(0, 10) })),
    };
  }
  if (type === 'purchases') {
    const orders = await prisma.purchaseOrder.findMany({ where: { tenantId, ...created }, include: { supplier: { select: { name: true } }, items: true }, orderBy: { createdAt: 'desc' } });
    return {
      title: 'Отчёт по закупкам',
      columns: [{ key: 'number', label: '№' }, { key: 'supplier', label: 'Поставщик' }, { key: 'status', label: 'Статус' }, { key: 'total', label: 'Сумма' }, { key: 'date', label: 'Дата' }],
      rows: orders.map((o) => ({ number: o.number, supplier: o.supplier?.name ?? '', status: o.status, total: orderTotal(o.items), date: o.createdAt.toISOString().slice(0, 10) })),
    };
  }
  if (type === 'stock') {
    const items = await prisma.stockItem.findMany({ where: { tenantId, quantity: { gt: 0 } }, include: { product: { select: { name: true, sku: true } }, warehouse: { select: { name: true } } } });
    return {
      title: 'Отчёт по складу',
      columns: [{ key: 'sku', label: 'Артикул' }, { key: 'product', label: 'Товар' }, { key: 'warehouse', label: 'Склад' }, { key: 'qty', label: 'Кол-во' }, { key: 'value', label: 'Стоимость' }],
      rows: items.map((it) => ({ sku: it.product?.sku ?? '', product: it.product?.name ?? '', warehouse: it.warehouse?.name ?? '', qty: Number(it.quantity), value: Math.round(Number(it.quantity) * Number(it.avgCostMinor)) })),
    };
  }
  if (type === 'production') {
    const orders = await prisma.productionOrder.findMany({ where: { tenantId, ...created }, orderBy: { createdAt: 'desc' } });
    return {
      title: 'Отчёт по производству',
      columns: [{ key: 'number', label: '№' }, { key: 'product', label: 'Продукт' }, { key: 'planned', label: 'План' }, { key: 'produced', label: 'Выпущено' }, { key: 'status', label: 'Статус' }, { key: 'cost', label: 'Себест. материалов' }],
      rows: orders.map((o) => ({ number: o.number, product: o.productName, planned: Number(o.quantity), produced: Number(o.producedQty), status: o.status, cost: Number(o.materialCostMinor) })),
    };
  }
  throw new Error('Unknown report type');
}

// ---- Stage 20 (ТЗ 7.6): inventory turnover + ABC (Pareto) analysis ----
// Classifies products by consumption value over a period (A = top 80% of value, B = next
// 15%, C = last 5%) and computes annualized stock turnover + days-on-hand per product.
export interface AbcRow {
  productId: string; sku: string; name: string;
  consumedQty: number; consumedValueMinor: bigint; sharePct: number; cumulativePct: number; abcClass: 'A' | 'B' | 'C';
  stockQty: number; stockValueMinor: bigint; turnover: number | null; daysOnHand: number | null;
}

export async function inventoryAnalysis(tenantId: string, r: Range = {}) {
  const to = r.to ?? new Date();
  const from = r.from ?? new Date(to.getTime() - 365 * 24 * 60 * 60 * 1000);
  const periodDays = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000));

  // Consumption = outbound movements (magnitude) over the period.
  const movements = await prisma.stockMovement.findMany({
    where: { tenantId, type: 'OUT', createdAt: { gte: from, lte: to } },
    select: { productId: true, quantity: true, costMinor: true },
  });
  const consumed = new Map<string, { qty: Prisma.Decimal; valueMinor: bigint }>();
  for (const m of movements) {
    const cur = consumed.get(m.productId) ?? { qty: D(0), valueMinor: 0n };
    const c = m.costMinor ?? 0n;
    cur.qty = cur.qty.plus(D(m.quantity).abs());
    cur.valueMinor += c < 0n ? -c : c;
    consumed.set(m.productId, cur);
  }

  // Current stock value per product.
  const stockItems = await prisma.stockItem.findMany({ where: { tenantId }, select: { productId: true, quantity: true, avgCostMinor: true } });
  const stock = new Map<string, { qty: Prisma.Decimal; valueMinor: bigint }>();
  for (const si of stockItems) {
    const cur = stock.get(si.productId) ?? { qty: D(0), valueMinor: 0n };
    cur.qty = cur.qty.plus(si.quantity);
    cur.valueMinor += BigInt(D(si.quantity).mul(si.avgCostMinor.toString()).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0));
    stock.set(si.productId, cur);
  }

  // Candidate products: anything consumed or currently in stock.
  const ids = new Set<string>([...consumed.keys(), ...stock.keys()]);
  const products = ids.size ? await prisma.product.findMany({ where: { tenantId, id: { in: [...ids] } }, select: { id: true, name: true, sku: true } }) : [];
  const pById = new Map(products.map((p) => [p.id, p]));

  const totalConsumedValue = [...consumed.values()].reduce((s, v) => s + v.valueMinor, 0n);
  const annualFactor = 365 / periodDays;

  // Build + sort by consumption value desc for the Pareto cumulative.
  const rows: AbcRow[] = [...ids].map((id) => {
    const c = consumed.get(id) ?? { qty: D(0), valueMinor: 0n };
    const s = stock.get(id) ?? { qty: D(0), valueMinor: 0n };
    const annualConsumption = Number(c.valueMinor) * annualFactor;
    const avgInv = Number(s.valueMinor);
    const turnover = avgInv > 0 ? annualConsumption / avgInv : null;
    const daysOnHand = turnover && turnover > 0 ? 365 / turnover : null;
    return {
      productId: id, sku: pById.get(id)?.sku ?? '', name: pById.get(id)?.name ?? id,
      consumedQty: Number(c.qty), consumedValueMinor: c.valueMinor, sharePct: 0, cumulativePct: 0, abcClass: 'C' as 'A' | 'B' | 'C',
      stockQty: Number(s.qty), stockValueMinor: s.valueMinor, turnover, daysOnHand,
    };
  }).sort((a, b) => Number(b.consumedValueMinor - a.consumedValueMinor));

  let cum = 0n;
  for (const row of rows) {
    const share = totalConsumedValue > 0n ? Number(row.consumedValueMinor) / Number(totalConsumedValue) * 100 : 0;
    cum += row.consumedValueMinor;
    const cumPct = totalConsumedValue > 0n ? Number(cum) / Number(totalConsumedValue) * 100 : 100;
    row.sharePct = Math.round(share * 10) / 10;
    row.cumulativePct = Math.round(cumPct * 10) / 10;
    row.abcClass = row.consumedValueMinor === 0n ? 'C' : (cumPct <= 80 ? 'A' : (cumPct <= 95 ? 'B' : 'C'));
  }

  const cls = (k: 'A' | 'B' | 'C') => {
    const items = rows.filter((r2) => r2.abcClass === k);
    const value = items.reduce((s, r2) => s + r2.consumedValueMinor, 0n);
    return { count: items.length, valueMinor: value, valuePct: totalConsumedValue > 0n ? Math.round(Number(value) / Number(totalConsumedValue) * 1000) / 10 : 0 };
  };

  return {
    from: from.toISOString(), to: to.toISOString(), periodDays,
    totalConsumedValueMinor: totalConsumedValue,
    classes: { A: cls('A'), B: cls('B'), C: cls('C') },
    rows,
  };
}
