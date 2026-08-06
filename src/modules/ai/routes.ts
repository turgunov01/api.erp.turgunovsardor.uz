// Stage 10.3/10.4 — AI assistant (NL questions over a data snapshot) and invoice OCR,
// plus per-tenant AI settings (provider / model / own API key). Assistant & OCR require
// ai.use; settings require tenant.manage. Degrade to a stub when no key is configured.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { requirePermission } from '../../plugins/rbac.js';
import { getAiConfig, askAI, ocrInvoice, AI_MODELS } from '../../lib/ai.js';
import { encryptSecret, maskHint } from '../../lib/secretbox.js';
import { computeKpis, topProducts } from '../../lib/analytics.js';
import { demandForecast } from '../../lib/forecast.js';
import { audit } from '../../lib/audit.js';

export default async function aiRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  // Public-to-tenant status: is AI usable right now, and with what provider/model.
  app.get('/status', async (req) => {
    const cfg = await getAiConfig(req.auth.tid);
    return { enabled: cfg.enabled, provider: cfg.provider, model: cfg.model, source: cfg.source };
  });

  // ---- Settings (owner / tenant.manage). The key is write-only: never returned. ----
  app.get('/settings', { preHandler: [requirePermission('tenant.manage')] }, async (req) => {
    const t = await prisma.tenant.findUnique({ where: { id: req.auth.tid }, select: { aiProvider: true, aiApiKeyEnc: true, aiModel: true } });
    const cfg = await getAiConfig(req.auth.tid);
    return {
      provider: t?.aiProvider ?? 'anthropic',
      model: t?.aiModel ?? '',
      keySet: !!t?.aiApiKeyEnc,
      keyHint: maskHint(t?.aiApiKeyEnc),
      usingEnvKey: cfg.source === 'env',
      enabled: cfg.enabled,
      models: AI_MODELS,
    };
  });

  app.patch('/settings', { preHandler: [requirePermission('tenant.manage')] }, async (req) => {
    const body = z.object({
      provider: z.enum(['anthropic', 'openai']).optional(),
      model: z.string().max(80).optional(),
      apiKey: z.string().max(300).optional(),   // '' clears the stored key
    }).parse(req.body);
    const data: Record<string, unknown> = {};
    if (body.provider !== undefined) data.aiProvider = body.provider;
    if (body.model !== undefined) data.aiModel = body.model || null;
    if (body.apiKey !== undefined) data.aiApiKeyEnc = body.apiKey.trim() ? encryptSecret(body.apiKey.trim()) : null;
    await prisma.tenant.update({ where: { id: req.auth.tid }, data });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'ai.settings.update', entity: 'Tenant', entityId: req.auth.tid, meta: { provider: body.provider, model: body.model, keyChanged: body.apiKey !== undefined }, ip: req.ip });
    const cfg = await getAiConfig(req.auth.tid);
    return { ok: true, enabled: cfg.enabled, provider: cfg.provider, model: cfg.model };
  });

  // ---- Assistant ----
  app.post('/ask', { preHandler: [requirePermission('ai.use')] }, async (req) => {
    const { question } = z.object({ question: z.string().min(2).max(500) }).parse(req.body);
    const cfg = await getAiConfig(req.auth.tid);
    const [kpis, top, forecast] = await Promise.all([
      computeKpis(req.auth.tid), topProducts(req.auth.tid, {}), demandForecast(req.auth.tid),
    ]);
    const snapshot = { kpis, topProducts: top, lowStockForecast: forecast.rows.filter((r) => r.suggestReorder > 0).slice(0, 15) };
    const out = await askAI(cfg, question, snapshot);
    if (out.enabled) await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'ai.ask', entity: 'AI', entityId: 'ask', meta: { q: question.slice(0, 120) }, ip: req.ip });
    return out;
  });

  app.post('/ocr-invoice', { preHandler: [requirePermission('ai.use')], bodyLimit: 12 * 1024 * 1024 }, async (req) => {
    const body = z.object({ imageBase64: z.string().min(1), mediaType: z.string().default('image/jpeg') }).parse(req.body);
    const cfg = await getAiConfig(req.auth.tid);
    const out = await ocrInvoice(cfg, body.imageBase64, body.mediaType);
    if (out.enabled) await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'ai.ocr', entity: 'AI', entityId: 'ocr', ip: req.ip });
    return out;
  });
}
