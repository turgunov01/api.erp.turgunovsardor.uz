// Stage 10.1/10.2/10.4 — KPIs, time-series, tabular reports with CSV/XLSX export, and
// the local demand forecast. All read-only and tenant-scoped.
import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../../plugins/rbac.js';
import { BadRequest } from '../../lib/errors.js';
import { computeKpis, revenueSeries, topProducts, buildReport, inventoryAnalysis, type Range } from '../../lib/analytics.js';
import { demandForecast } from '../../lib/forecast.js';
import { buildXlsx, buildCsv } from '../../lib/xlsx.js';

function range(q: { from?: string; to?: string }): Range {
  // A bare YYYY-MM-DD `to` parses to midnight; extend it to end-of-day so same-day
  // postings are included.
  return {
    from: q.from ? new Date(q.from) : undefined,
    to: q.to ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(q.to) ? `${q.to}T23:59:59.999Z` : q.to) : undefined,
  };
}

export default async function analyticsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/kpis', { preHandler: [requirePermission('analytics.read')] }, async (req) => {
    return computeKpis(req.auth.tid, range(req.query as any));
  });

  app.get('/series', { preHandler: [requirePermission('analytics.read')] }, async (req) => {
    const q = req.query as { from?: string; to?: string; bucket?: 'day' | 'month' };
    const r = range(q);
    const [revenue, top] = await Promise.all([revenueSeries(req.auth.tid, r, q.bucket === 'day' ? 'day' : 'month'), topProducts(req.auth.tid, r)]);
    return { revenue, topProducts: top };
  });

  app.get('/reports/:type', { preHandler: [requirePermission('analytics.read')] }, async (req) => {
    const { type } = req.params as { type: string };
    try { return { report: await buildReport(req.auth.tid, type, range(req.query as any)) }; }
    catch { throw BadRequest('Неизвестный тип отчёта', 'BAD_REPORT'); }
  });

  // Download a report as CSV or XLSX (both generated dependency-free).
  app.get('/reports/:type/export', { preHandler: [requirePermission('analytics.read')] }, async (req, reply) => {
    const { type } = req.params as { type: string };
    const q = req.query as { format?: string; from?: string; to?: string };
    let table;
    try { table = await buildReport(req.auth.tid, type, range(q)); }
    catch { throw BadRequest('Неизвестный тип отчёта', 'BAD_REPORT'); }
    const fname = `${type}-${new Date().toISOString().slice(0, 10)}`;
    if (q.format === 'xlsx') {
      const buf = buildXlsx({ name: table.title.slice(0, 31), columns: table.columns, rows: table.rows });
      reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      reply.header('Content-Disposition', `attachment; filename="${fname}.xlsx"`);
      return reply.send(buf);
    }
    const csv = buildCsv(table.columns, table.rows);
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${fname}.csv"`);
    return reply.send(csv);
  });

  app.get('/forecast', { preHandler: [requirePermission('analytics.read')] }, async (req) => {
    const q = req.query as { lookback?: string; horizon?: string };
    return demandForecast(req.auth.tid, Number(q.lookback) || 90, Number(q.horizon) || 30);
  });

  // Stage 20 (ТЗ 7.6): inventory turnover + ABC analysis.
  app.get('/inventory-analysis', { preHandler: [requirePermission('analytics.read')] }, async (req) => {
    return inventoryAnalysis(req.auth.tid, range(req.query as any));
  });
}
