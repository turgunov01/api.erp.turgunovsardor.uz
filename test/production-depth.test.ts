// Stage 18 — Производство 2.0: work centers, routing operations, quality control + scrap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, tokenFor, authHeader } from './helpers.js';

async function ownerToken() { return tokenFor(await getApp(), 'admin@demo-factory.com', 'Admin123!'); }
const H = (t: string) => authHeader(t);
const uniq = () => Math.floor(performance.now() * 1000).toString(36);

async function demoOrderId(app: any, token: string) {
  const d = (await app.inject({ url: '/api/v1/production/orders?pageSize=50', headers: H(token) })).json();
  return (d.orders ?? d.items ?? [])[0]?.id;
}

// The seeded order (with routing/QC) is the OLDEST one, numbered PRD-...-0001. Orders
// accumulate across runs and are returned newest-first, so it lives on the last page.
async function seededOrderId(app: any, token: string) {
  const first = (await app.inject({ url: '/api/v1/production/orders?pageSize=200', headers: H(token) })).json();
  const totalPages = first.meta?.totalPages ?? 1;
  let orders = first.orders ?? [];
  if (totalPages > 1) {
    const last = (await app.inject({ url: `/api/v1/production/orders?pageSize=200&page=${totalPages}`, headers: H(token) })).json();
    orders = last.orders ?? [];
  }
  return (orders.find((o: any) => /-0*1$/.test(o.number)) ?? orders[orders.length - 1])?.id;
}

test('Production 2.0: work centers + routing seeded on the demo order', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const wc = (await app.inject({ url: '/api/v1/production/work-centers', headers: H(token) })).json();
  assert.ok(wc.workCenters.length >= 4, 'seeded work centers');
  const oid = await seededOrderId(app, token);
  const routing = (await app.inject({ url: `/api/v1/production/orders/${oid}/routing`, headers: H(token) })).json();
  assert.ok(routing.operations.length >= 4, 'seeded operations');
  assert.ok(routing.quality.length >= 1, 'seeded quality check');
  assert.ok(Number(routing.summary.scrapQty) >= 1, 'scrap recorded');
  assert.ok(Number(routing.summary.laborCostMinor) > 0, 'labour cost accumulated');
});

test('Production 2.0: work center CRUD + operation cost = rate × minutes / 60', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const code = `wc-${uniq()}`;
  const created = await app.inject({ method: 'POST', url: '/api/v1/production/work-centers', headers: H(token), payload: { code, name: 'Тест-центр', type: 'assembly', hourlyCostMinor: 6_000_000 } });
  assert.equal(created.statusCode, 201);
  const wc = created.json().workCenter;

  // Duplicate code rejected.
  const dup = await app.inject({ method: 'POST', url: '/api/v1/production/work-centers', headers: H(token), payload: { code, name: 'x' } });
  assert.equal(dup.statusCode, 400);
  assert.equal(dup.json().error.code, 'CODE_EXISTS');

  // Attach an operation (90 min → cost = 6,000,000 × 90/60 = 9,000,000).
  const oid = await demoOrderId(app, token);
  const op = (await app.inject({ method: 'POST', url: `/api/v1/production/orders/${oid}/operations`, headers: H(token), payload: { name: 'Сборка', workCenterId: wc.id, plannedMinutes: 90 } })).json().operation;
  assert.equal(Number(op.costMinor), 9_000_000);
  assert.equal(op.status, 'pending');

  // Start → complete.
  const started = await app.inject({ method: 'POST', url: `/api/v1/production/operations/${op.id}/start`, headers: H(token) });
  assert.equal(started.json().operation.status, 'in_progress');
  const done = await app.inject({ method: 'POST', url: `/api/v1/production/operations/${op.id}/complete`, headers: H(token), payload: { actualMinutes: 60 } });
  assert.equal(done.json().operation.status, 'done');
  assert.equal(Number(done.json().operation.costMinor), 6_000_000); // recomputed from actual 60 min

  await app.inject({ method: 'DELETE', url: `/api/v1/production/operations/${op.id}`, headers: H(token) });
});

test('Production 2.0: quality check records scrap and rolls onto the order', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const oid = await demoOrderId(app, token);
  const before = (await app.inject({ url: `/api/v1/production/orders/${oid}/routing`, headers: H(token) })).json();
  const scrapBefore = Number(before.summary.scrapQty);

  const check = await app.inject({ method: 'POST', url: `/api/v1/production/orders/${oid}/quality`, headers: H(token), payload: { checkedQty: 3, defectQty: 1, inspector: 'ОТК' } });
  assert.equal(check.statusCode, 201);
  assert.equal(check.json().check.result, 'partial');
  assert.equal(Number(check.json().check.passedQty), 2);

  const after = (await app.inject({ url: `/api/v1/production/orders/${oid}/routing`, headers: H(token) })).json();
  assert.equal(Number(after.summary.scrapQty), scrapBefore + 1);

  // Defect can't exceed checked qty.
  const bad = await app.inject({ method: 'POST', url: `/api/v1/production/orders/${oid}/quality`, headers: H(token), payload: { checkedQty: 2, defectQty: 5 } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, 'DEFECT_TOO_LARGE');
});
