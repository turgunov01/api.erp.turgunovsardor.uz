// Webhook subscriptions management (tenant.manage). Delivery + signing live in lib/webhooks.ts.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { requirePermission } from '../../plugins/rbac.js';
import { audit } from '../../lib/audit.js';
import { BadRequest, NotFound } from '../../lib/errors.js';
import { enqueue } from '../../lib/jobs.js';
import { WEBHOOK_EVENTS, generateWebhookSecret } from '../../lib/webhooks.js';

const bodySchema = z.object({
  url: z.string().url('Нужен корректный URL (https://…)'),
  events: z.array(z.string()).min(1).default(['*']),
  active: z.boolean().default(true),
});

function cleanEvents(events: string[]): string[] {
  if (events.includes('*')) return ['*'];
  const valid = events.filter((e) => (WEBHOOK_EVENTS as readonly string[]).includes(e));
  return valid.length ? valid : ['*'];
}

export default async function webhookRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  // Catalog of subscribable events (for the UI).
  app.get('/events', { preHandler: [requirePermission('tenant.manage')] }, async () => {
    return { events: WEBHOOK_EVENTS };
  });

  app.get('/', { preHandler: [requirePermission('tenant.manage')] }, async (req) => {
    const rows = await prisma.webhook.findMany({ where: { tenantId: req.auth.tid }, orderBy: { createdAt: 'desc' } });
    return { webhooks: rows.map((w) => ({ ...w, events: JSON.parse(w.events) })) };
  });

  app.post('/', { preHandler: [requirePermission('tenant.manage')] }, async (req, reply) => {
    const b = bodySchema.parse(req.body);
    const wh = await prisma.webhook.create({
      data: {
        tenantId: req.auth.tid, url: b.url, events: JSON.stringify(cleanEvents(b.events)),
        active: b.active, secret: generateWebhookSecret(), createdBy: req.auth.sub,
      },
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'webhook.create', entity: 'Webhook', entityId: wh.id, meta: { url: b.url }, ip: req.ip });
    return reply.code(201).send({ webhook: { ...wh, events: JSON.parse(wh.events) } });
  });

  app.patch('/:id', { preHandler: [requirePermission('tenant.manage')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = bodySchema.partial().parse(req.body);
    const existing = await prisma.webhook.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!existing) throw NotFound('Вебхук не найден');
    const wh = await prisma.webhook.update({
      where: { id },
      data: {
        ...(b.url !== undefined ? { url: b.url } : {}),
        ...(b.events !== undefined ? { events: JSON.stringify(cleanEvents(b.events)) } : {}),
        ...(b.active !== undefined ? { active: b.active } : {}),
      },
    });
    return reply.send({ webhook: { ...wh, events: JSON.parse(wh.events) } });
  });

  app.delete('/:id', { preHandler: [requirePermission('tenant.manage')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.webhook.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!existing) throw NotFound('Вебхук не найден');
    await prisma.webhook.delete({ where: { id } });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'webhook.delete', entity: 'Webhook', entityId: id, ip: req.ip });
    return reply.send({ ok: true });
  });

  // Send a test `ping` event to this webhook immediately (via the queue).
  app.post('/:id/test', { preHandler: [requirePermission('tenant.manage')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const wh = await prisma.webhook.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!wh) throw NotFound('Вебхук не найден');
    if (!wh.active) throw BadRequest('Вебхук отключён', 'INACTIVE');
    await enqueue('webhook.deliver', { webhookId: wh.id, event: 'ping', at: new Date().toISOString(), data: { message: 'Тестовое событие от TTR ONE' } }, { tenantId: req.auth.tid, maxAttempts: 1 });
    return reply.send({ ok: true });
  });
}
