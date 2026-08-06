// Shared stock-mutation primitive — the single place inventory changes.
// Warehouse and Procurement (goods receipts) both go through this, so stock is
// only ever modified via the warehouse "contract".
//
// Since Stage 8.2 this primitive also drives inventory costing: inbound movements
// carry a cost basis (from the caller, or the running average) and build FIFO
// layers; outbound movements yield a COGS figure recorded on the ledger movement.
import { Prisma } from '@prisma/client';
import { recordInbound, consumeOutbound } from './costing.js';

type Tx = Prisma.TransactionClient;

export interface StockDeltaResult {
  balance: Prisma.Decimal; // new on-hand balance
  unitCostMinor: bigint; // unit cost applied to this movement
  costMinor: bigint; // total cost/value of this movement (COGS for OUT)
}

// Apply a signed delta to on-hand and append the immutable ledger row. Returns the
// new balance plus the movement's cost (COGS for outbound). Backwards compatible:
// callers that ignore the return value keep working.
export async function applyStockDelta(tx: Tx, params: {
  tenantId: string;
  warehouseId: string;
  productId: string;
  type: string; // IN | OUT | ADJUST | TRANSFER_IN | TRANSFER_OUT | RECEIPT
  delta: Prisma.Decimal;      // signed change to on-hand
  reason?: string | null;
  refType?: string | null;
  refId?: string | null;
  userId?: string | null;
  unitCostMinor?: bigint | number | null; // cost basis for inbound movements
  costingMethod?: string | null;          // 'avg' | 'fifo' (defaults to tenant setting)
}): Promise<StockDeltaResult> {
  const existing = await tx.stockItem.findUnique({
    where: { warehouseId_productId: { warehouseId: params.warehouseId, productId: params.productId } },
  });
  const current = existing ? new Prisma.Decimal(existing.quantity) : new Prisma.Decimal(0);
  const newBalance = current.plus(params.delta);

  let unitCostMinor = 0n;
  let costMinor = 0n;

  if (params.delta.greaterThan(0)) {
    // Inbound: cost basis from caller, else keep the running average unchanged.
    const basis = params.unitCostMinor != null
      ? BigInt(params.unitCostMinor)
      : (existing ? BigInt(existing.avgCostMinor) : 0n);
    await recordInbound(tx, {
      tenantId: params.tenantId, warehouseId: params.warehouseId, productId: params.productId,
      qty: params.delta, unitCostMinor: basis, sourceType: params.refType, sourceId: params.refId,
    });
    unitCostMinor = basis;
    costMinor = BigInt(params.delta.mul(basis.toString()).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0));
  } else if (params.delta.lessThan(0)) {
    // Outbound: consume FIFO layers, compute COGS by the tenant's method.
    let method = params.costingMethod ?? undefined;
    if (!method) {
      const t = await tx.tenant.findUnique({ where: { id: params.tenantId }, select: { costingMethod: true } });
      method = t?.costingMethod ?? 'avg';
    }
    const out = await consumeOutbound(tx, {
      tenantId: params.tenantId, warehouseId: params.warehouseId, productId: params.productId,
      qty: params.delta.negated(), method,
    });
    unitCostMinor = out.unitCostMinor;
    costMinor = out.costMinor;
  }

  await tx.stockItem.upsert({
    where: { warehouseId_productId: { warehouseId: params.warehouseId, productId: params.productId } },
    create: { tenantId: params.tenantId, warehouseId: params.warehouseId, productId: params.productId, quantity: newBalance },
    update: { quantity: newBalance },
  });
  await tx.stockMovement.create({
    data: {
      tenantId: params.tenantId,
      warehouseId: params.warehouseId,
      productId: params.productId,
      type: params.type,
      quantity: params.delta,
      balanceAfter: newBalance,
      reason: params.reason ?? null,
      refType: params.refType ?? null,
      refId: params.refId ?? null,
      unitCostMinor,
      costMinor,
      userId: params.userId ?? null,
    },
  });
  return { balance: newBalance, unitCostMinor, costMinor };
}
