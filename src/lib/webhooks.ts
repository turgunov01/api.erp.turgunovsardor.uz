// Outbound webhooks. Subscribes to domain events; each matching subscription enqueues a
// `webhook.deliver` job (atomically, inside the event's transaction) which the job worker
// POSTs to the external URL with an HMAC-SHA256 signature and automatic retry/backoff.
import crypto from 'node:crypto';
import { prisma } from '../db.js';
import { onEvent } from './events.js';
import { registerJob } from './jobs.js';

// The domain events a webhook can subscribe to (must match emitEvent(...) call sites).
export const WEBHOOK_EVENTS = [
  'sales.shipped',
  'sales.returned',
  'purchase.received',
  'production.issued',
  'production.completed',
  'pos.sale',
  'pos.refund',
  'payroll.accrued',
] as const;

export function generateWebhookSecret(): string {
  return 'whsec_' + crypto.randomBytes(24).toString('base64url');
}

function parseEvents(raw: string): string[] {
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch { return []; }
}

// Register event → job fan-out and the delivery job handler. Call once at buildApp
// (after resetEventHandlers()).
export function registerWebhooks(): void {
  for (const evt of WEBHOOK_EVENTS) {
    onEvent(evt, async (payload, ctx) => {
      const hooks = await ctx.tx.webhook.findMany({ where: { tenantId: ctx.tenantId, active: true } });
      if (hooks.length === 0) return;
      const at = new Date().toISOString();
      for (const h of hooks) {
        const subscribed = parseEvents(h.events);
        if (!subscribed.includes('*') && !subscribed.includes(evt)) continue;
        // Enqueue in the SAME transaction → no webhook fires for a rolled-back operation.
        await ctx.tx.job.create({
          data: {
            type: 'webhook.deliver',
            tenantId: ctx.tenantId,
            maxAttempts: 5,
            payloadJson: { webhookId: h.id, event: evt, at, data: payload } as object,
          },
        });
      }
    });
  }

  registerJob('webhook.deliver', deliver);
}

// Deliver one webhook payload. Throws on failure so the job queue retries with backoff.
export async function deliver(payload: Record<string, unknown>): Promise<void> {
  const { webhookId, event, at, data } = payload as { webhookId: string; event: string; at: string; data: unknown };
  const hook = await prisma.webhook.findUnique({ where: { id: webhookId } });
  if (!hook || !hook.active) return; // deleted/disabled since enqueue → drop silently

  const body = JSON.stringify({ event, tenantId: hook.tenantId, at, data });
  const signature = crypto.createHmac('sha256', hook.secret).update(body).digest('hex');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let status = 0;
  let error: string | null = null;
  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'TTR-ONE-Webhook/1',
        'X-TTR-Event': event,
        'X-TTR-Signature': `sha256=${signature}`,
      },
      body,
      signal: controller.signal,
    });
    status = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (e) {
    error = (e as Error).message.slice(0, 200);
  } finally {
    clearTimeout(timer);
  }

  await prisma.webhook.update({ where: { id: hook.id }, data: { lastStatus: status, lastAt: new Date(), lastError: error } }).catch(() => {});
  if (error) throw new Error(`webhook ${hook.id}: ${error}`);
}
