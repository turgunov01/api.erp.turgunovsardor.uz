// Plan-limit enforcement for tenant resources.
import { prisma } from '../db.js';
import { getPlan } from './plans.js';
import { AppError } from './errors.js';

const PaymentRequired = (msg: string) => new AppError(402, 'PLAN_LIMIT', msg);

type Resource = 'users' | 'warehouses' | 'products';

export async function assertWithinLimit(tenantId: string, resource: Resource): Promise<void> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return;
  const plan = getPlan(tenant.plan);

  const limit =
    resource === 'users' ? plan.maxUsers :
    resource === 'warehouses' ? plan.maxWarehouses :
    plan.maxProducts;

  if (limit === null) return; // unlimited

  const count =
    resource === 'users' ? await prisma.user.count({ where: { tenantId } }) :
    resource === 'warehouses' ? await prisma.warehouse.count({ where: { tenantId } }) :
    await prisma.product.count({ where: { tenantId } });

  if (count >= limit) {
    throw PaymentRequired(`Достигнут лимит тарифа «${plan.name}» (${limit} ${resource}). Обновите тариф, чтобы добавить больше.`);
  }
}
