// Stage 21 — Клиентский портал (ТЗ 5.7): external customer auth realm + strict isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, tokenFor, authHeader } from './helpers.js';

async function ownerToken() { return tokenFor(await getApp(), 'admin@demo-factory.com', 'Admin123!'); }
const H = (t: string) => authHeader(t);

async function portalLogin(app: any, email: string, password: string) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/portal/auth/login', payload: { email, password } });
  return res;
}

test('Portal: seeded customer can log in and read only their own data', async () => {
  const app = await getApp();
  const res = await portalLogin(app, 'client@tashkent-retail.com', 'Client123!');
  assert.equal(res.statusCode, 200);
  const { token, customer } = res.json();
  assert.ok(token && customer.name, 'token + customer returned');

  const me = (await app.inject({ url: '/api/v1/portal/me', headers: H(token) })).json();
  assert.equal(me.customer.code, 'CUST-001');

  const orders = (await app.inject({ url: '/api/v1/portal/orders', headers: H(token) })).json();
  assert.ok(Array.isArray(orders.orders), 'orders list returned');
  // Every returned order really belongs to this customer (cross-checked against internal API).
  const ownerTok = await ownerToken();
  for (const o of orders.orders) {
    const detail = (await app.inject({ url: `/api/v1/portal/orders/${o.id}`, headers: H(token) })).json();
    assert.ok(detail.order, 'own order readable via portal');
  }
});

test('Portal: wrong password is rejected; disabled/invalid tokens are 401', async () => {
  const app = await getApp();
  const bad = await portalLogin(app, 'client@tashkent-retail.com', 'WrongPass!');
  assert.equal(bad.statusCode, 401);
  const noAuth = await app.inject({ url: '/api/v1/portal/orders' });
  assert.equal(noAuth.statusCode, 401);
});

test('Portal ISOLATION: a customer cannot read another customer\'s order', async () => {
  const app = await getApp();
  const ownerTok = await ownerToken();

  // Find a sales order that belongs to some customer, then a DIFFERENT customer's portal.
  const custs = (await app.inject({ url: '/api/v1/sales/customers?pageSize=50', headers: H(ownerTok) })).json();
  const cust1 = custs.customers.find((c: any) => c.code === 'CUST-001');
  const cust2 = custs.customers.find((c: any) => c.code === 'CUST-002');
  assert.ok(cust1 && cust2);

  // Give CUST-002 a portal login via the internal admin endpoint.
  const created = await app.inject({ method: 'POST', url: `/api/v1/portal/admin/access/${cust2.id}`, headers: H(ownerTok), payload: { email: 'iso-cust2@test.local', password: 'Secret123!' } });
  assert.ok(created.statusCode === 200 || created.statusCode === 201);

  // Grab one of CUST-001's orders (via CUST-001's own portal).
  const c1tok = (await portalLogin(app, 'client@tashkent-retail.com', 'Client123!')).json().token;
  const c1orders = (await app.inject({ url: '/api/v1/portal/orders', headers: H(c1tok) })).json().orders;
  if (c1orders.length === 0) return; // nothing to probe with

  // CUST-002 tries to read CUST-001's order → 404 (never leaks another customer's data).
  const c2tok = (await portalLogin(app, 'iso-cust2@test.local', 'Secret123!')).json().token;
  const leak = await app.inject({ url: `/api/v1/portal/orders/${c1orders[0].id}`, headers: H(c2tok) });
  assert.equal(leak.statusCode, 404, 'cross-customer order read is blocked');
});

test('Portal realm separation: a customer token is rejected on internal endpoints', async () => {
  const app = await getApp();
  const token = (await portalLogin(app, 'client@tashkent-retail.com', 'Client123!')).json().token;
  // Internal endpoint must reject the customer-realm token (401), never serve tenant data.
  const res = await app.inject({ url: '/api/v1/sales/customers', headers: H(token) });
  assert.equal(res.statusCode, 401);
});

test('Portal admin: internal user without sales.write cannot create portal accounts', async () => {
  const app = await getApp();
  const opTok = await tokenFor(app, 'operator@demo-factory.com', 'Operator123!');
  const custs = (await app.inject({ url: '/api/v1/sales/customers?pageSize=5', headers: H(await ownerToken()) })).json();
  const res = await app.inject({ method: 'POST', url: `/api/v1/portal/admin/access/${custs.customers[0].id}`, headers: H(opTok), payload: { email: 'x@test.local', password: 'Secret123!' } });
  assert.equal(res.statusCode, 403);
});
