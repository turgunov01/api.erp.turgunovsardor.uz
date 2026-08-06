// Inventory costing (Stage 8.2) — tied to stock movements. Every inbound movement
// with a cost basis pushes a FIFO CostLayer and updates the running weighted-average
// unit cost on StockItem. Every outbound movement consumes layers oldest-first and
// yields a COGS figure computed by the tenant's chosen method (avg | fifo).
//
// Money is integer minor units (BigInt for accounting); quantities are Prisma.Decimal.
import { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;
const D = (v: number | string | Prisma.Decimal) => new Prisma.Decimal(v);

// Round a Decimal minor-unit amount to an integer BigInt (bankers-free, half-up).
function toMinor(v: Prisma.Decimal): bigint {
  return BigInt(v.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0));
}

// Record the cost of an inbound quantity: push a FIFO layer + roll the weighted average.
export async function recordInbound(tx: Tx, params: {
  tenantId: string;
  warehouseId: string;
  productId: string;
  qty: Prisma.Decimal; // positive
  unitCostMinor: bigint; // cost basis for this receipt
  sourceType?: string | null;
  sourceId?: string | null;
}): Promise<void> {
  const { tenantId, warehouseId, productId, qty, unitCostMinor } = params;
  if (qty.lessThanOrEqualTo(0)) return;

  await tx.costLayer.create({
    data: {
      tenantId, warehouseId, productId,
      remainingQty: qty, unitCostMinor,
      sourceType: params.sourceType ?? null, sourceId: params.sourceId ?? null,
    },
  });

  // Weighted average: newAvg = (oldQty*oldAvg + inQty*inCost) / (oldQty + inQty).
  const item = await tx.stockItem.findUnique({ where: { warehouseId_productId: { warehouseId, productId } } });
  const oldQty = item ? D(item.quantity) : D(0);
  const oldAvg = item ? D(item.avgCostMinor.toString()) : D(0);
  const denom = oldQty.plus(qty);
  const newAvg = denom.greaterThan(0)
    ? oldQty.mul(oldAvg).plus(qty.mul(D(unitCostMinor.toString()))).div(denom)
    : D(unitCostMinor.toString());
  // StockItem row is upserted by applyStockDelta before/after; ensure it exists here.
  await tx.stockItem.upsert({
    where: { warehouseId_productId: { warehouseId, productId } },
    create: { tenantId, warehouseId, productId, quantity: oldQty, avgCostMinor: toMinor(newAvg) },
    update: { avgCostMinor: toMinor(newAvg) },
  });
}

// Consume the cost of an outbound quantity. Always depletes FIFO layers (physical
// FIFO), but the reported unit cost / COGS depends on the tenant's costing method.
export async function consumeOutbound(tx: Tx, params: {
  tenantId: string;
  warehouseId: string;
  productId: string;
  qty: Prisma.Decimal; // positive magnitude
  method: string; // 'avg' | 'fifo'
}): Promise<{ unitCostMinor: bigint; costMinor: bigint }> {
  const { tenantId, warehouseId, productId, method } = params;
  let qty = params.qty;
  if (qty.lessThanOrEqualTo(0)) return { unitCostMinor: 0n, costMinor: 0n };

  const item = await tx.stockItem.findUnique({ where: { warehouseId_productId: { warehouseId, productId } } });
  const avg = item ? D(item.avgCostMinor.toString()) : D(0);

  // Deplete FIFO layers oldest-first; accumulate FIFO cost as we go.
  const layers = await tx.costLayer.findMany({
    where: { tenantId, warehouseId, productId, remainingQty: { gt: 0 } },
    orderBy: { createdAt: 'asc' },
  });
  let remaining = qty;
  let fifoCost = D(0);
  for (const layer of layers) {
    if (remaining.lessThanOrEqualTo(0)) break;
    const take = Prisma.Decimal.min(remaining, D(layer.remainingQty));
    fifoCost = fifoCost.plus(take.mul(D(layer.unitCostMinor.toString())));
    await tx.costLayer.update({ where: { id: layer.id }, data: { remainingQty: D(layer.remainingQty).minus(take) } });
    remaining = remaining.minus(take);
  }
  // If layers ran dry (e.g. items received before costing existed), value the
  // shortfall at the weighted average so COGS is never understated to zero.
  if (remaining.greaterThan(0)) fifoCost = fifoCost.plus(remaining.mul(avg));

  const costDec = method === 'fifo' ? fifoCost : qty.mul(avg);
  const costMinor = toMinor(costDec);
  const unitCostMinor = toMinor(qty.greaterThan(0) ? costDec.div(qty) : D(0));
  return { unitCostMinor, costMinor };
}
