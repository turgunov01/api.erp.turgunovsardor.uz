// Stock reservation primitive — the single place StockItem.reserved changes.
// Available-to-promise = quantity(on-hand) - reserved. Sales orders reserve stock
// (available check) before shipment; shipments release the reservation as they
// consume on-hand via the warehouse contract (src/lib/stock.ts).
import { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

// Adjust the reserved quantity for a (warehouse, product) by a signed delta.
// Positive delta = reserve more (guarded against exceeding availability);
// negative delta = release. Returns the new reserved amount.
export async function adjustReserved(tx: Tx, params: {
  tenantId: string;
  warehouseId: string;
  productId: string;
  delta: Prisma.Decimal;      // signed change to reserved
  guardAvailable?: boolean;   // when reserving, ensure enough available on-hand
}): Promise<Prisma.Decimal> {
  const existing = await tx.stockItem.findUnique({
    where: { warehouseId_productId: { warehouseId: params.warehouseId, productId: params.productId } },
  });
  const onHand = existing ? new Prisma.Decimal(existing.quantity) : new Prisma.Decimal(0);
  const reserved = existing ? new Prisma.Decimal(existing.reserved) : new Prisma.Decimal(0);
  let newReserved = reserved.plus(params.delta);
  if (newReserved.lessThan(0)) newReserved = new Prisma.Decimal(0); // never negative

  if (params.guardAvailable && params.delta.greaterThan(0)) {
    const available = onHand.minus(reserved);
    if (params.delta.greaterThan(available)) {
      const err = new Error(`Недостаточно доступного остатка (доступно ${available.toString()}, требуется ${params.delta.toString()})`);
      (err as any).__insufficient = true;
      throw err;
    }
  }

  await tx.stockItem.upsert({
    where: { warehouseId_productId: { warehouseId: params.warehouseId, productId: params.productId } },
    create: { tenantId: params.tenantId, warehouseId: params.warehouseId, productId: params.productId, quantity: new Prisma.Decimal(0), reserved: newReserved },
    update: { reserved: newReserved },
  });
  return newReserved;
}
