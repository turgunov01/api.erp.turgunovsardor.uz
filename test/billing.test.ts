import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, authHeader } from './helpers.js';

// Unique-ish suffix per run so re-runs don't collide on tenant/email.
const uniq = () => Math.floor(performance.now() * 1000).toString(36);

async function register(app: any) {
  const suffix = uniq();
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: {
    companyName: `Test Co ${suffix}`, industry: 'wholesale',
    fullName: 'Test Owner', email: `owner+${suffix}@test.local`, password: 'Owner123!',
  }});
  return res;
}

test('registration creates a trialing tenant + owner with tenant.manage', async () => {
  const app = await getApp();
  const res = await register(app);
  assert.equal(res.statusCode, 201);
  const b = res.json();
  assert.ok(b.tenant.slug.startsWith('test-co'));
  assert.ok(b.user.permissions.includes('tenant.manage'));

  const sub = await app.inject({ url: '/api/v1/billing/subscription', headers: authHeader(b.accessToken) });
  assert.equal(sub.json().status, 'trialing');
  assert.equal(sub.json().trialDaysLeft, 14);
});

test('plan limit is enforced then lifted after upgrade', async () => {
  const app = await getApp();
  const b = (await register(app)).json();
  const h = authHeader(b.accessToken);
  // trial maxWarehouses = 3, tenant already has 1 (WH-MAIN)
  const w2 = await app.inject({ method: 'POST', url: '/api/v1/warehouse/warehouses', headers: h, payload: { code: 'W2', name: 'W2' } });
  const w3 = await app.inject({ method: 'POST', url: '/api/v1/warehouse/warehouses', headers: h, payload: { code: 'W3', name: 'W3' } });
  const w4 = await app.inject({ method: 'POST', url: '/api/v1/warehouse/warehouses', headers: h, payload: { code: 'W4', name: 'W4' } });
  assert.equal(w2.statusCode, 201);
  assert.equal(w3.statusCode, 201);
  assert.equal(w4.statusCode, 402);
  assert.equal(w4.json().error.code, 'PLAN_LIMIT');

  // Upgrade to business via sandbox payment
  const inv = (await app.inject({ method: 'POST', url: '/api/v1/billing/subscribe', headers: h, payload: { plan: 'business' } })).json().invoice;
  const pay = await app.inject({ method: 'POST', url: '/api/v1/billing/pay', headers: h, payload: { invoiceId: inv.id, method: 'mock' } });
  assert.equal(pay.statusCode, 200);
  assert.equal(pay.json().status, 'active');

  const w4b = await app.inject({ method: 'POST', url: '/api/v1/warehouse/warehouses', headers: h, payload: { code: 'W4b', name: 'W4b' } });
  assert.equal(w4b.statusCode, 201);
});

test('non-platform-admin is denied super-admin API (403)', async () => {
  const app = await getApp();
  const b = (await register(app)).json(); // fresh owner is NOT a platform admin
  const res = await app.inject({ url: '/api/v1/superadmin/tenants', headers: authHeader(b.accessToken) });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'NOT_PLATFORM_ADMIN');
});

test('bank-transfer invoice: stays trialing until super-admin confirms, then activates', async () => {
  const app = await getApp();
  const b = (await register(app)).json();
  const h = authHeader(b.accessToken);

  const inv = (await app.inject({ method: 'POST', url: '/api/v1/billing/subscribe', headers: h, payload: { plan: 'business', method: 'bank_transfer' } })).json().invoice;
  assert.equal(inv.method, 'bank_transfer');
  assert.equal(inv.status, 'open');
  assert.ok(inv.number.startsWith('TTR-'), 'invoice has a number');

  // official document renders
  const doc = await app.inject({ url: `/api/v1/billing/invoices/${inv.id}/document`, headers: h });
  assert.equal(doc.statusCode, 200);
  assert.match(doc.body, /Счёт на оплату/);

  // not active yet
  assert.equal((await app.inject({ url: '/api/v1/billing/subscription', headers: h })).json().status, 'trialing');

  // platform admin (seeded demo owner) confirms payment
  const adminTok = (await (await getApp()).inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'admin@demo-factory.com', password: 'Admin123!' } })).json().accessToken;
  const paid = await app.inject({ method: 'POST', url: `/api/v1/superadmin/invoices/${inv.id}/mark-paid`, headers: authHeader(adminTok) });
  assert.equal(paid.statusCode, 200);

  assert.equal((await app.inject({ url: '/api/v1/billing/subscription', headers: h })).json().status, 'active');
});
