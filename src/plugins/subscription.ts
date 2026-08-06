// Blocks mutating requests (POST/PATCH/PUT/DELETE) when the tenant's subscription
// is not active/trialing (e.g. trial expired -> past_due). Read access stays open.
// Attach AFTER app.authenticate in domain modules.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../db.js';
import { effectiveStatus, canWrite } from '../lib/subscription.js';
import { PaymentRequired } from '../lib/errors.js';

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export async function blockIfInactiveWrite(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!WRITE_METHODS.has(req.method)) return;
  const tenant = await prisma.tenant.findUnique({ where: { id: req.auth.tid } });
  if (!tenant) return;
  const status = effectiveStatus(tenant);
  if (!canWrite(status)) {
    throw PaymentRequired('Подписка неактивна. Оплатите тариф, чтобы продолжить вносить изменения.');
  }
}
