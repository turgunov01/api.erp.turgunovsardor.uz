// Append-only audit trail helper.
import { prisma } from '../db.js';

export async function audit(params: {
  tenantId: string;
  userId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  meta?: unknown;
  ip?: string | null;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId: params.tenantId,
        userId: params.userId ?? null,
        action: params.action,
        entity: params.entity,
        entityId: params.entityId ?? null,
        meta: params.meta ? JSON.stringify(params.meta) : null,
        ip: params.ip ?? null,
      },
    });
  } catch {
    // Auditing must never break the business operation.
  }
}
