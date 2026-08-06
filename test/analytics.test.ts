// Stage 10 — KPIs, reports + export (dependency-free CSV/XLSX), forecast, AI (stub).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, tokenFor, authHeader } from './helpers.js';

async function ownerToken() { return tokenFor(await getApp(), 'admin@demo-factory.com', 'Admin123!'); }
const H = (t: string) => authHeader(t);

test('10.1 KPIs return numeric business metrics', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const k = (await app.inject({ url: '/api/v1/analytics/kpis', headers: H(token) })).json();
  for (const key of ['revenueMinor', 'cashMinor', 'stockValueMinor', 'lowStockCount', 'salesOrders']) assert.ok(key in k, `has ${key}`);
  assert.ok(typeof k.lowStockCount === 'number');
});

test('10.1 series returns revenue buckets + top products', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const s = (await app.inject({ url: '/api/v1/analytics/series?bucket=month', headers: H(token) })).json();
  assert.ok(Array.isArray(s.revenue) && Array.isArray(s.topProducts));
});

test('10.2 report returns a table; CSV + XLSX export work (dependency-free)', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const rep = (await app.inject({ url: '/api/v1/analytics/reports/stock', headers: H(token) })).json();
  assert.ok(rep.report.columns.length >= 3 && Array.isArray(rep.report.rows));

  const csv = await app.inject({ url: '/api/v1/analytics/reports/stock/export?format=csv', headers: H(token) });
  assert.equal(csv.statusCode, 200);
  assert.match(csv.headers['content-type'] as string, /csv/);

  const xlsx = await app.inject({ url: '/api/v1/analytics/reports/sales/export?format=xlsx', headers: H(token) });
  assert.equal(xlsx.statusCode, 200);
  assert.equal(xlsx.rawPayload.subarray(0, 2).toString('latin1'), 'PK', 'valid zip/xlsx magic');
});

test('10.4 demand forecast returns non-negative projections', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const f = (await app.inject({ url: '/api/v1/analytics/forecast', headers: H(token) })).json();
  assert.ok(Array.isArray(f.rows));
  for (const r of f.rows) assert.ok(r.avgPerDay >= 0 && r.projectedDemand >= 0, 'consumption is a magnitude');
});

test('10 analytics: operator without analytics.read is denied (403)', async () => {
  const app = await getApp();
  const token = await tokenFor(app, 'operator@demo-factory.com', 'Operator123!');
  const r = await app.inject({ url: '/api/v1/analytics/kpis', headers: H(token) });
  assert.equal(r.statusCode, 403);
});

test('10.3 AI status + ask degrade to a stub without an API key', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const status = (await app.inject({ url: '/api/v1/ai/status', headers: H(token) })).json();
  assert.equal(typeof status.enabled, 'boolean');
  const ask = await app.inject({ method: 'POST', url: '/api/v1/ai/ask', headers: H(token), payload: { question: 'Какая выручка?' } });
  assert.equal(ask.statusCode, 200);
  const body = ask.json();
  // Without any configured key, it returns the honest stub.
  if (!process.env.ANTHROPIC_API_KEY) { assert.equal(body.enabled, false); assert.match(body.answer, /ключ/i); }
});

test('10.3 AI settings: key is stored encrypted and never returned', async () => {
  const app = await getApp();
  const token = await ownerToken();
  await app.inject({ method: 'PATCH', url: '/api/v1/ai/settings', headers: H(token), payload: { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-secret-XYZ99' } });
  const s = (await app.inject({ url: '/api/v1/ai/settings', headers: H(token) })).json();
  assert.equal(s.provider, 'openai');
  assert.equal(s.keySet, true);
  assert.ok(!JSON.stringify(s).includes('sk-secret-XYZ99'), 'raw key is never returned');
  const status = (await app.inject({ url: '/api/v1/ai/status', headers: H(token) })).json();
  assert.equal(status.enabled, true);
  // Clean up so other tests see the stub state.
  await app.inject({ method: 'PATCH', url: '/api/v1/ai/settings', headers: H(token), payload: { provider: 'anthropic', apiKey: '' } });
});

test('7.6 inventory-analysis returns ABC classes + turnover', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const a = (await app.inject({ url: '/api/v1/analytics/inventory-analysis', headers: H(token) })).json();
  assert.ok(Array.isArray(a.rows) && a.rows.length > 0, 'analysis has rows');
  assert.ok(a.classes.A && a.classes.B && a.classes.C, 'ABC class buckets present');
  // Rows sorted by consumption value desc; cumulative % is monotonic non-decreasing.
  let prevCum = 0;
  for (const row of a.rows) {
    assert.ok(['A', 'B', 'C'].includes(row.abcClass), 'each row has an ABC class');
    assert.ok(row.cumulativePct >= prevCum - 0.001, 'cumulative % non-decreasing');
    prevCum = row.cumulativePct;
    if (row.turnover != null) assert.ok(row.turnover >= 0, 'turnover non-negative');
  }
  // Class value shares sum to ~100% when there is consumption.
  if (Number(a.totalConsumedValueMinor) > 0) {
    const sum = a.classes.A.valuePct + a.classes.B.valuePct + a.classes.C.valuePct;
    assert.ok(Math.abs(sum - 100) < 1.5, 'class value shares ~100%');
  }
});
