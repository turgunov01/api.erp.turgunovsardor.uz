// 9.2 Notification helper: create the in-app record, push it over SSE in real time
// (9.3), and enqueue out-of-band channel delivery as a job (9.1) so a slow email
// never blocks the request. Uses the global client (decoupled from business tx).
import { prisma } from '../db.js';
import { publishToUser } from './realtime.js';
import { enqueue } from './jobs.js';

export interface NotifyInput {
  tenantId: string;
  userId: string;
  type?: 'info' | 'success' | 'warning' | 'error';
  title: string;
  body?: string;
  refType?: string;
  refId?: string;
  email?: string | null;       // if set, also enqueue an email
  telegramChatId?: string | null; // if set, also enqueue a telegram message
}

export async function notify(input: NotifyInput): Promise<void> {
  const n = await prisma.notification.create({
    data: {
      tenantId: input.tenantId, userId: input.userId, type: input.type ?? 'info',
      title: input.title, body: input.body ?? null, refType: input.refType ?? null, refId: input.refId ?? null,
    },
  });
  publishToUser(input.tenantId, input.userId, 'notification', {
    id: n.id, type: n.type, title: n.title, body: n.body, refType: n.refType, refId: n.refId, createdAt: n.createdAt,
  });
  if (input.email) await enqueue('email.send', { to: input.email, subject: input.title, text: input.body ?? input.title }, { tenantId: input.tenantId });
  if (input.telegramChatId) await enqueue('telegram.send', { chatId: input.telegramChatId, text: `${input.title}\n${input.body ?? ''}` }, { tenantId: input.tenantId });
}

// Notify every active owner of a tenant (used for tenant-wide signals like low stock).
export async function notifyOwners(tenantId: string, base: Omit<NotifyInput, 'tenantId' | 'userId' | 'email'>): Promise<void> {
  const owners = await prisma.user.findMany({
    where: { tenantId, status: 'active', roles: { some: { role: { code: 'owner' } } } },
    select: { id: true, email: true },
  });
  for (const o of owners) await notify({ tenantId, userId: o.id, email: o.email, ...base });
}
