// Stage 12 — Studio: module Marketplace (12.2), Integrations (12.3) and a no-code
// custom-form builder (12.1). Marketplace reuses the tenant-module system; installing
// a module = PATCH /tenant/modules/:key (kept there, quota-enforced).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { requirePermission } from '../../plugins/rbac.js';
import { blockIfInactiveWrite } from '../../plugins/subscription.js';
import { audit } from '../../lib/audit.js';
import { BadRequest, NotFound } from '../../lib/errors.js';
import { MODULE_CATALOG } from '../../lib/modules.js';
import { getPlan } from '../../lib/plans.js';
import { integrationStatus, saveIntegration, disconnectIntegration, INTEGRATION_KEYS } from '../../lib/integrations.js';

const MODULE_CATEGORY: Record<string, string> = {
  catalog: 'Товары', warehouse: 'Склад', sales: 'Продажи и CRM', crm: 'Продажи и CRM',
  procurement: 'Закупки', manufacturing: 'Производство', finance: 'Финансы',
  pos: 'Розница', projects: 'Проекты', hr: 'Персонал', logistics: 'Логистика', documents: 'Документооборот',
};

// The embedded dev DB cluster is WIN1251-encoded — keep icons to ASCII/Cyrillic so
// inserts don't fail (emoji/box-drawing chars aren't representable). UI still renders it.
function safeIcon(s: string): string {
  const cleaned = (s || '').replace(/[^\x20-\x7Eа-яА-ЯёЁ0-9]/g, '').slice(0, 4);
  return cleaned || 'F';
}

const fieldSchema = z.object({
  key: z.string().min(1).max(40),
  label: z.string().min(1).max(80),
  type: z.enum(['text', 'textarea', 'number', 'date', 'select', 'checkbox']).default('text'),
  required: z.boolean().default(false),
  options: z.array(z.string()).optional(),
});

export default async function studioRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  // ==================== 12.2 MARKETPLACE ====================
  app.get('/marketplace', { preHandler: [requirePermission('tenant.manage')] }, async (req) => {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.auth.tid } });
    const rows = await prisma.tenantModule.findMany({ where: { tenantId: req.auth.tid } });
    const enabled = new Set(rows.filter((r) => r.enabled).map((r) => r.moduleKey));
    const plan = getPlan(tenant?.plan);
    const items = MODULE_CATALOG.map((m) => ({
      ...m, category: MODULE_CATEGORY[m.key] ?? 'Прочее',
      installed: enabled.has(m.key), available: m.status === 'available',
    }));
    const usedCount = items.filter((i) => i.installed && i.available).length;
    return { items, plan: { key: plan.key, name: plan.name, maxModules: plan.maxModules }, usedCount };
  });

  // ==================== 12.3 INTEGRATIONS ====================
  app.get('/integrations', { preHandler: [requirePermission('tenant.manage')] }, async (req) => {
    return { integrations: await integrationStatus(req.auth.tid) };
  });

  app.patch('/integrations/:provider', { preHandler: [requirePermission('tenant.manage')] }, async (req) => {
    const { provider } = req.params as { provider: string };
    if (!INTEGRATION_KEYS.includes(provider)) throw NotFound('Интеграция не найдена');
    const body = z.object({ config: z.record(z.string(), z.string()) }).parse(req.body);
    await saveIntegration(req.auth.tid, provider, body.config);
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'integration.connect', entity: 'Integration', entityId: provider, ip: req.ip });
    const integrations = await integrationStatus(req.auth.tid);
    return { ok: true, integration: integrations.find((i) => i.key === provider) };
  });

  app.post('/integrations/:provider/disconnect', { preHandler: [requirePermission('tenant.manage')] }, async (req) => {
    const { provider } = req.params as { provider: string };
    await disconnectIntegration(req.auth.tid, provider);
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'integration.disconnect', entity: 'Integration', entityId: provider, ip: req.ip });
    return { ok: true };
  });

  // ==================== 12.1 NO-CODE FORMS ====================
  app.get('/forms', { preHandler: [requirePermission('forms.use')] }, async (req) => {
    const forms = await prisma.customForm.findMany({ where: { tenantId: req.auth.tid }, include: { _count: { select: { records: true } } }, orderBy: { createdAt: 'desc' } });
    return { forms };
  });

  app.post('/forms', { preHandler: [requirePermission('studio.manage'), blockIfInactiveWrite] }, async (req, reply) => {
    const body = z.object({
      key: z.string().min(1).max(40).regex(/^[a-z0-9_-]+$/i, 'Латиница/цифры/дефис'),
      name: z.string().min(1).max(80),
      description: z.string().max(300).optional(),
      icon: z.string().max(8).optional(),
      fields: z.array(fieldSchema).min(1, 'Добавьте хотя бы одно поле'),
    }).parse(req.body);
    const exists = await prisma.customForm.findUnique({ where: { tenantId_key: { tenantId: req.auth.tid, key: body.key } } });
    if (exists) throw BadRequest('Форма с таким ключом уже есть', 'KEY_EXISTS');
    const form = await prisma.customForm.create({ data: { tenantId: req.auth.tid, key: body.key, name: body.name, description: body.description ?? null, icon: safeIcon(body.icon ?? 'F'), fields: body.fields, createdBy: req.auth.sub } });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'form.create', entity: 'CustomForm', entityId: form.id, meta: { key: body.key }, ip: req.ip });
    return reply.code(201).send({ form });
  });

  app.get('/forms/:id', { preHandler: [requirePermission('forms.use')] }, async (req) => {
    const { id } = req.params as { id: string };
    const form = await prisma.customForm.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!form) throw NotFound('Форма не найдена');
    const records = await prisma.customRecord.findMany({ where: { tenantId: req.auth.tid, formId: id }, orderBy: { createdAt: 'desc' }, take: 200 });
    return { form, records };
  });

  app.patch('/forms/:id', { preHandler: [requirePermission('studio.manage')] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ name: z.string().min(1).optional(), description: z.string().optional(), icon: z.string().max(8).optional(), fields: z.array(fieldSchema).optional() }).parse(req.body);
    const form = await prisma.customForm.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!form) throw NotFound('Форма не найдена');
    const updated = await prisma.customForm.update({ where: { id }, data: { ...body, ...(body.icon !== undefined ? { icon: safeIcon(body.icon) } : {}) } });
    return { form: updated };
  });

  app.delete('/forms/:id', { preHandler: [requirePermission('studio.manage')] }, async (req) => {
    const { id } = req.params as { id: string };
    const form = await prisma.customForm.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!form) throw NotFound('Форма не найдена');
    await prisma.customForm.delete({ where: { id } });
    return { ok: true };
  });

  // Submit a record against a form (validates required fields).
  app.post('/forms/:id/records', { preHandler: [requirePermission('forms.use'), blockIfInactiveWrite] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ data: z.record(z.string(), z.any()) }).parse(req.body);
    const form = await prisma.customForm.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!form) throw NotFound('Форма не найдена');
    const fields = form.fields as { key: string; label: string; required?: boolean }[];
    for (const f of fields) {
      if (f.required && (body.data[f.key] === undefined || body.data[f.key] === '' || body.data[f.key] === null)) throw BadRequest(`Заполните поле «${f.label}»`, 'FIELD_REQUIRED');
    }
    const record = await prisma.customRecord.create({ data: { tenantId: req.auth.tid, formId: id, data: body.data, createdBy: req.auth.sub } });
    return reply.code(201).send({ record });
  });

  app.delete('/forms/:id/records/:rid', { preHandler: [requirePermission('forms.use')] }, async (req) => {
    const { id, rid } = req.params as { id: string; rid: string };
    await prisma.customRecord.deleteMany({ where: { id: rid, tenantId: req.auth.tid, formId: id } });
    return { ok: true };
  });
}
