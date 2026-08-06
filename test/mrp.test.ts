// Stage 19 — MRP: net material requirements from production demand + stock + open POs,
// then auto-generate a purchase request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, tokenFor, authHeader } from './helpers.js';

async function ownerToken() { return tokenFor(await getApp(), 'admin@demo-factory.com', 'Admin123!'); }
const H = (t: string) => authHeader(t);

test('MRP preview surfaces material shortages', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const p = (await app.inject({ url: '/api/v1/mrp/preview?includeMinStock=true', headers: H(token) })).json();
  assert.ok(p.lines.length > 0, 'MRP produced lines');
  assert.ok(p.shortageCount > 0, 'at least one shortage (demo has a draft order + a low-stock material)');
  // Steel is below its min level (opening 1200 < min 1500) → a suggested order.
  const steel = p.lines.find((l: any) => l.productSku === 'STEEL-SHEET-2MM');
  assert.ok(steel && Number(steel.suggestedQty) > 0, 'steel flagged for reorder');
});

test('MRP run → apply creates a single purchase request from the shortages', async () => {
  const app = await getApp();
  const token = await ownerToken();

  const run = (await app.inject({ method: 'POST', url: '/api/v1/mrp/runs', headers: H(token), payload: { includeMinStock: true } })).json();
  assert.match(run.run.number, /^MRP-\d{4}-\d{5}$/);
  assert.equal(run.run.status, 'draft');
  const shortages = run.lines.filter((l: any) => Number(l.suggestedQty) > 0);
  assert.ok(shortages.length > 0, 'run has shortage lines');
  // net = demand + minTopUp − onHand − onOrder (sanity check on one line)
  const l = run.lines[0];
  const expectedNet = Number(l.demandQty) + Number(l.minTopUpQty) - Number(l.onHandQty) - Number(l.onOrderQty);
  assert.ok(Math.abs(Number(l.netQty) - expectedNet) < 0.001, 'net requirement formula holds');

  const apply = await app.inject({ method: 'POST', url: `/api/v1/mrp/runs/${run.run.id}/apply`, headers: H(token) });
  assert.equal(apply.statusCode, 201);
  assert.match(apply.json().requestNumber, /^PR-\d{4}-\d{4}$/);
  assert.equal(apply.json().itemCount, shortages.length);

  // Re-apply is blocked.
  const again = await app.inject({ method: 'POST', url: `/api/v1/mrp/runs/${run.run.id}/apply`, headers: H(token) });
  assert.equal(again.statusCode, 400);
  assert.equal(again.json().error.code, 'ALREADY_APPLIED');

  // The purchase request is now visible in procurement.
  const reqs = (await app.inject({ url: '/api/v1/procurement/requests?pageSize=100', headers: H(token) })).json();
  assert.ok(reqs.requests.find((r: any) => r.number === apply.json().requestNumber), 'PR appears in procurement');
});

test('MRP RBAC: operator without procurement.read is denied (403)', async () => {
  const app = await getApp();
  const token = await tokenFor(app, 'operator@demo-factory.com', 'Operator123!');
  const res = await app.inject({ url: '/api/v1/mrp/preview', headers: H(token) });
  assert.equal(res.statusCode, 403);
});
