// Record-level warehouse scoping. If a user has UserWarehouse rows, they are
// restricted to those warehouses; otherwise (empty) they see all.
import { prisma } from '../db.js';
import { Forbidden } from './errors.js';

// Returns array of allowed warehouse ids, or null = unrestricted (all).
export async function allowedWarehouses(userId: string): Promise<string[] | null> {
  const rows = await prisma.userWarehouse.findMany({ where: { userId }, select: { warehouseId: true } });
  if (rows.length === 0) return null;
  return rows.map((r) => r.warehouseId);
}

// Throws if the warehouse is outside the user's allowed set.
export function assertWarehouseAllowed(allowed: string[] | null, warehouseId: string): void {
  if (allowed && !allowed.includes(warehouseId)) {
    throw Forbidden('Нет доступа к этому складу', 'WAREHOUSE_FORBIDDEN');
  }
}
