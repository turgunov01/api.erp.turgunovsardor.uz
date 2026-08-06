// Stage 10.4 demand forecast — local statistics, no AI. Projects consumption from the
// last N days of stock OUT movements and compares it to on-hand to suggest reorders.
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';

const D = (v: Prisma.Decimal | number | string) => new Prisma.Decimal(v);

export async function demandForecast(tenantId: string, lookbackDays = 90, horizonDays = 30) {
  const since = new Date(Date.now() - lookbackDays * 86400000);
  const outs = await prisma.stockMovement.findMany({
    where: { tenantId, type: 'OUT', createdAt: { gte: since } },
    select: { productId: true, quantity: true },
  });
  // Ledger stores OUT quantities as negative; consumption is the magnitude.
  const consumed = new Map<string, Prisma.Decimal>();
  for (const m of outs) consumed.set(m.productId, (consumed.get(m.productId) ?? D(0)).plus(D(m.quantity).abs()));

  // Current on-hand per product (summed across warehouses).
  const stock = await prisma.stockItem.findMany({ where: { tenantId, quantity: { gt: 0 } }, select: { productId: true, quantity: true } });
  const onHand = new Map<string, Prisma.Decimal>();
  for (const s of stock) onHand.set(s.productId, (onHand.get(s.productId) ?? D(0)).plus(s.quantity));

  const ids = [...new Set([...consumed.keys(), ...onHand.keys()])];
  const products = ids.length ? await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, sku: true } }) : [];
  const byId = new Map(products.map((p) => [p.id, p]));

  const rows = ids.map((id) => {
    const used = Number(consumed.get(id) ?? 0);
    const avgPerDay = used / lookbackDays;
    const projected = avgPerDay * horizonDays;
    const have = Number(onHand.get(id) ?? 0);
    const daysOfCover = avgPerDay > 0 ? Math.round(have / avgPerDay) : null;
    const suggestReorder = Math.max(0, Math.ceil(projected - have));
    return {
      productId: id, name: byId.get(id)?.name ?? id, sku: byId.get(id)?.sku ?? '',
      avgPerDay: Math.round(avgPerDay * 100) / 100, projectedDemand: Math.ceil(projected),
      onHand: have, daysOfCover, suggestReorder,
    };
  }).filter((r) => r.projectedDemand > 0 || r.onHand > 0)
    .sort((a, b) => b.projectedDemand - a.projectedDemand);

  return { lookbackDays, horizonDays, rows };
}
