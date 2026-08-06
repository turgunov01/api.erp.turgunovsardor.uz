// Application assembly: plugins, error handling, routes, static UI.
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { config, isProd } from './config.js';
import { prisma } from './db.js';
import { AppError } from './lib/errors.js';
import authPlugin from './plugins/auth.js';
import authRoutes from './modules/auth/routes.js';
import orgRoutes from './modules/org/routes.js';
import catalogRoutes from './modules/catalog/routes.js';
import warehouseRoutes from './modules/warehouse/routes.js';
import adminRoutes from './modules/admin/routes.js';
import tenantRoutes from './modules/tenant/routes.js';
import billingRoutes from './modules/billing/routes.js';
import superadminRoutes from './modules/superadmin/routes.js';
import procurementRoutes from './modules/procurement/routes.js';
import salesRoutes from './modules/sales/routes.js';
import crmRoutes from './modules/crm/routes.js';
import productionRoutes from './modules/production/routes.js';
import inventoryRoutes from './modules/inventory/routes.js';
import financeRoutes from './modules/finance/routes.js';
import platformRoutes from './modules/platform/routes.js';
import documentsRoutes from './modules/documents/routes.js';
import analyticsRoutes from './modules/analytics/routes.js';
import aiRoutes from './modules/ai/routes.js';
import studioRoutes from './modules/studio/routes.js';
import hrRoutes from './modules/hr/routes.js';
import posRoutes from './modules/pos/routes.js';
import projectsRoutes from './modules/projects/routes.js';
import logisticsRoutes from './modules/logistics/routes.js';
import mrpRoutes from './modules/mrp/routes.js';
import portalRoutes from './modules/portal/routes.js';
import apiKeyRoutes from './modules/apikeys/routes.js';
import webhookRoutes from './modules/webhooks/routes.js';
import { registerWebhooks } from './lib/webhooks.js';
import { registerFinancePostings } from './modules/finance/postings.js';
import { registerPlatformJobs } from './modules/platform/jobs.js';
import { resetEventHandlers } from './lib/events.js';
import { requestStart, requestEnd, renderMetrics } from './lib/metrics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Serialize BigInt money columns (e.g. creditLimitMinor, Deal.amountMinor) as JS
// numbers in JSON responses. Safe: all money is bounded to MAX_SAFE_INTEGER by the
// moneyMinor validator, so no precision is lost. Without this, JSON.stringify throws.
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function () {
  return Number(this as unknown as bigint);
};

export async function buildApp() {
  // Register finance auto-postings + platform job handlers once per process.
  resetEventHandlers();
  registerFinancePostings();
  registerPlatformJobs();
  registerWebhooks();

  const app = Fastify({
    logger:
      config.NODE_ENV === 'test'
        ? false
        : isProd
          ? true
          : { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } },
    trustProxy: true,
    genReqId: () => crypto.randomUUID(),
  });

  // Security headers. CSP relaxed enough for the self-hosted SPA (inline handlers).
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });

  // Never reflect an arbitrary origin while allowing credentials. Use the explicit
  // allowlist; in dev fall back to the known local origins (prod requires the allowlist).
  const allowlist = config.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  // Prod: strict allowlist (no reflect). Dev: reflect the request origin so the app works
  // from localhost AND any LAN IP (which changes with DHCP) without reconfiguration.
  const corsOrigin = allowlist.length ? allowlist : (isProd ? false : true);
  await app.register(cors, {
    origin: corsOrigin,
    credentials: true,
  });
  await app.register(cookie);

  // Rate limiting: a generous global cap in production (auth routes keep their stricter
  // per-route limit). Disabled in dev/test so tooling and the test suite aren't throttled.
  await app.register(rateLimit, {
    global: isProd,
    max: isProd ? 600 : 100000,
    timeWindow: '1 minute',
  });

  await app.register(authPlugin);

  // Surface the request/correlation id on every response.
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  // Prometheus metrics (13.5): count requests + durations (excluding /metrics itself).
  app.addHook('onRequest', async (req) => { if (req.url !== '/metrics') requestStart(); });
  app.addHook('onResponse', async (req, reply) => {
    if (req.url === '/metrics') return;
    requestEnd(req.method, req.url, reply.statusCode, reply.elapsedTime);
  });
  app.get('/metrics', async (_req, reply) => {
    reply.header('Content-Type', 'text/plain; version=0.0.4');
    return renderMetrics();
  });

  // API documentation (13.7): serve the OpenAPI spec + a lightweight docs page.
  const openapiPath = join(__dirname, '..', 'docs', 'openapi.yaml');
  app.get('/openapi.yaml', async (_req, reply) => {
    if (!existsSync(openapiPath)) return reply.code(404).send('openapi.yaml not found');
    reply.header('Content-Type', 'application/yaml; charset=utf-8');
    return readFileSync(openapiPath, 'utf8');
  });
  app.get('/api-docs', async (_req, reply) => {
    reply.header('Content-Type', 'text/html; charset=utf-8');
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>TTR ONE — API</title>
<style>body{font-family:system-ui,sans-serif;max-width:820px;margin:40px auto;padding:0 20px;color:#0f172a;line-height:1.6}
code{background:#f1f5f9;padding:2px 6px;border-radius:5px}a{color:#2563eb}h1{margin-bottom:4px}pre{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px;overflow:auto}</style></head>
<body><h1>TTR ONE — REST API для разработчиков</h1><p>База: <code>/api/v1</code>. Все ответы — JSON.</p>

<h2>Аутентификация</h2>
<p><b>Для интеграций (рекомендуется) — API-ключ.</b> Создайте ключ в приложении: <i>Управление → API-ключи</i>, затем передавайте его в каждом запросе заголовком <code>X-API-Key</code> (или <code>Authorization: Bearer ttr_live_…</code>). Ключ привязан к вашей организации; уровень доступа — «только чтение» или «полный».</p>
<pre>curl -s http://localhost:3000/api/v1/catalog/products \\
  -H 'X-API-Key: ttr_live_xxxxxxxxxxxxxxxxxxxxxxxx'</pre>
<p>Альтернатива для UI-сессий — токен из <code>POST /api/v1/auth/login</code>, передаётся как <code>Authorization: Bearer &lt;token&gt;</code> (живёт 15 мин, обновляется через refresh).</p>

<h2>Вебхуки</h2>
<p>Подпишитесь на события в <i>Управление → Вебхуки</i>: TTR ONE будет слать <code>POST</code> с JSON на ваш URL. Доступные события: <code>sales.shipped</code>, <code>sales.returned</code>, <code>purchase.received</code>, <code>production.issued</code>, <code>production.completed</code>, <code>pos.sale</code>, <code>pos.refund</code>, <code>payroll.accrued</code>. Тело: <code>{ event, tenantId, at, data }</code>. Заголовки: <code>X-TTR-Event</code>, <code>X-TTR-Signature: sha256=&lt;hmac&gt;</code> (HMAC-SHA256 тела вашим секретом). Неуспешные (не-2xx) доставки повторяются с нарастающей задержкой.</p>

<h2>Спецификация</h2>
<p><b>OpenAPI:</b> <a href="/openapi.yaml">/openapi.yaml</a> — импортируйте в Swagger UI, Postman или Insomnia (генерируйте клиент под любой язык).</p>

<h2>Соглашения</h2>
<p>• Ошибки: <code>{ "error": { "code": "...", "message": "..." } }</code> (HTTP 4xx/5xx).<br>
• Пагинация: <code>?page=&pageSize=</code> → поле <code>meta</code> в ответе.<br>
• Деньги — в тийинах (÷100 = сум). Количества — строки-Decimal.<br>
• Права: ключ «только чтение» видит все <code>GET</code>; «полный» — читает и пишет.</p>
<p>Подробное описание модулей — в <code>docs/API.md</code> и <code>docs/USER-GUIDE.md</code>.</p></body></html>`;
  });

  // Centralized error handler -> consistent JSON envelope.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: err.flatten() } });
    }
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2002') return reply.code(409).send({ error: { code: 'UNIQUE_VIOLATION', message: 'A record with these values already exists' } });
      if (err.code === 'P2025') return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Record not found' } });
    }
    // Rate limiter and other framework errors that already carry an HTTP status.
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429) return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many requests — please slow down.' } });
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: (err as { code?: string }).code ?? 'REQUEST_ERROR', message: (err as Error).message } });
    }
    req.log.error(err);
    return reply.code(500).send({ error: { code: 'INTERNAL', message: isProd ? 'Internal server error' : String((err as Error)?.message ?? err) } });
  });

  // Liveness — process is up.
  app.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));

  // Readiness — dependencies (DB) reachable.
  app.get('/ready', async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ready', db: 'up', ts: new Date().toISOString() };
    } catch {
      return reply.code(503).send({ status: 'not-ready', db: 'down' });
    }
  });

  // API routes
  await app.register(async (api) => {
    await api.register(authRoutes, { prefix: '/auth' });
    await api.register(orgRoutes, { prefix: '/org' });
    await api.register(catalogRoutes, { prefix: '/catalog' });
    await api.register(warehouseRoutes, { prefix: '/warehouse' });
    await api.register(adminRoutes, { prefix: '/admin' });
    await api.register(tenantRoutes, { prefix: '/tenant' });
    await api.register(billingRoutes, { prefix: '/billing' });
    await api.register(superadminRoutes, { prefix: '/superadmin' });
    await api.register(procurementRoutes, { prefix: '/procurement' });
    await api.register(salesRoutes, { prefix: '/sales' });
    await api.register(crmRoutes, { prefix: '/crm' });
    await api.register(productionRoutes, { prefix: '/production' });
    await api.register(inventoryRoutes, { prefix: '/inventory' });
    await api.register(financeRoutes, { prefix: '/finance' });
    await api.register(platformRoutes, { prefix: '/platform' });
    await api.register(apiKeyRoutes, { prefix: '/api-keys' });
    await api.register(webhookRoutes, { prefix: '/webhooks' });
    await api.register(documentsRoutes, { prefix: '/documents' });
    await api.register(analyticsRoutes, { prefix: '/analytics' });
    await api.register(aiRoutes, { prefix: '/ai' });
    await api.register(studioRoutes, { prefix: '/studio' });
    await api.register(hrRoutes, { prefix: '/hr' });
    await api.register(posRoutes, { prefix: '/pos' });
    await api.register(projectsRoutes, { prefix: '/projects' });
    await api.register(logisticsRoutes, { prefix: '/logistics' });
    await api.register(mrpRoutes, { prefix: '/mrp' });
    await api.register(portalRoutes, { prefix: '/portal' });
  }, { prefix: '/api/v1' });

  // Static SPA (login + dashboard)
  await app.register(fastifyStatic, { root: join(__dirname, '..', 'public'), prefix: '/' });

  return app;
}
