// Stage 5 (Sales + CRM) integration tests: RBAC, the full order→reserve→ship→return
// cycle (stock OUT/IN via the shared warehouse contract), reservation guards, and CRM funnel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, tokenFor, authHeader } from './helpers.js';

async function ownerToken() { return tokenFor(await getApp(), 'admin@demo-factory.com', 'Admin123!'); }
async function operatorToken() { return tokenFor(await getApp(), 'operator@demo-factory.com', 'Operator123!'); }

async function findWarehouse(app: any, token: string, code: string) {
  const res = await app.inject({ url: '/api/v1/warehouse/warehouses', headers: authHeader(token) });
  return res.json().warehouses.find((w: any) => w.code === code);
}
async function findProduct(app: any, token: string, search: string) {
  const res = await app.inject({ url: `/api/v1/catalog/products?search=${search}`, headers: authHeader(token) });
  return res.json().products[0];
}
async function firstCustomer(app: any, token: string) {
  const res = await app.inject({ url: '/api/v1/sales/customers', headers: authHeader(token) });
  return res.json().customers[0];
}
// Returns [onHand, reserved] for a (warehouse, product).
async function stockOf(app: any, token: string, warehouseId: string, productId: string): Promise<[number, number]> {
  const res = await app.inject({ url: `/api/v1/warehouse/stock?warehouseId=${warehouseId}&pageSize=200`, headers: authHeader(token) });
  const row = res.json().stock.find((s: any) => s.productId === productId);
  return row ? [Number(row.quantity), Number(row.reserved)] : [0, 0];
}

test('sales: RBAC — operator cannot create a customer (403)', async () => {
  const app = await getApp();
  const token = await operatorToken();
  const res = await app.inject({ method: 'POST', url: '/api/v1/sales/customers', headers: authHeader(token), payload: { code: `X-${Date.now()}`, name: 'x' } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'MISSING_PERMISSION');
});

test('sales: customers list returns seeded customers with pagination meta', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const res = await app.inject({ url: '/api/v1/sales/customers?page=1&pageSize=2', headers: authHeader(token) });
  const body = res.json();
  assert.equal(res.statusCode, 200);
  assert.ok(body.meta, 'has meta');
  assert.ok(body.meta.total >= 3, 'seeded >= 3 customers');
  assert.ok(body.customers.length <= 2);
});

test('sales: duplicate customer code is rejected (CODE_EXISTS)', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const res = await app.inject({ method: 'POST', url: '/api/v1/sales/customers', headers: authHeader(token), payload: { code: 'CUST-001', name: 'dup' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'CODE_EXISTS');
});

test('sales: full order → confirm → reserve → ship cycle moves stock OUT and releases reservation', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const wh = await findWarehouse(app, token, 'WH-MAIN');
  const product = await findProduct(app, token, 'SHELF-STD');
  const customer = await firstCustomer(app, token);
  const [onHand0, reserved0] = await stockOf(app, token, wh.id, product.id);

  // Create a draft sales order for 5 units.
  const created = await app.inject({ method: 'POST', url: '/api/v1/sales/orders', headers: authHeader(token),
    payload: { customerId: customer.id, warehouseId: wh.id, items: [{ productId: product.id, quantity: 5, priceMinor: 4_600_000_00 }] } });
  assert.equal(created.statusCode, 201);
  const orderId = created.json().order.id;

  // Confirm then reserve — reserved should rise by 5, on-hand unchanged.
  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/sales/orders/${orderId}/confirm`, headers: authHeader(token) })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/sales/orders/${orderId}/reserve`, headers: authHeader(token), payload: {} })).statusCode, 200);
  const [onHand1, reserved1] = await stockOf(app, token, wh.id, product.id);
  assert.equal(onHand1, onHand0, 'reservation does not touch on-hand');
  assert.equal(reserved1, reserved0 + 5, 'reserved rose by 5');

  // Ship all 5 — on-hand drops by 5, reservation released back to baseline.
  const shipped = await app.inject({ method: 'POST', url: `/api/v1/sales/orders/${orderId}/ship`, headers: authHeader(token),
    payload: { items: [{ productId: product.id, quantity: 5 }] } });
  assert.equal(shipped.statusCode, 201);
  const [onHand2, reserved2] = await stockOf(app, token, wh.id, product.id);
  assert.equal(onHand2, onHand0 - 5, 'on-hand dropped by shipped qty');
  assert.equal(reserved2, reserved0, 'reservation released on shipment');

  // Order is now fully shipped.
  const detail = await app.inject({ url: `/api/v1/sales/orders/${orderId}`, headers: authHeader(token) });
  assert.equal(detail.json().order.status, 'shipped');

  // Over-shipping beyond the ordered quantity is blocked.
  const over = await app.inject({ method: 'POST', url: `/api/v1/sales/orders/${orderId}/ship`, headers: authHeader(token),
    payload: { items: [{ productId: product.id, quantity: 1 }] } });
  assert.equal(over.statusCode, 400);
  assert.equal(over.json().error.code, 'OVER_SHIP');

  // A customer return puts stock back IN (net on-hand rises by 2).
  const ret = await app.inject({ method: 'POST', url: '/api/v1/sales/returns', headers: authHeader(token),
    payload: { soId: orderId, warehouseId: wh.id, items: [{ productId: product.id, quantity: 2 }] } });
  assert.equal(ret.statusCode, 201);
  const [onHand3] = await stockOf(app, token, wh.id, product.id);
  assert.equal(onHand3, onHand2 + 2, 'return restored 2 units on-hand');
});

test('sales: reserving more than available is blocked (INSUFFICIENT_STOCK)', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const wh = await findWarehouse(app, token, 'WH-MAIN');
  const product = await findProduct(app, token, 'SHELF-STD');
  const customer = await firstCustomer(app, token);
  const created = await app.inject({ method: 'POST', url: '/api/v1/sales/orders', headers: authHeader(token),
    payload: { customerId: customer.id, warehouseId: wh.id, items: [{ productId: product.id, quantity: 1_000_000, priceMinor: 4_600_000_00 }] } });
  const orderId = created.json().order.id;
  await app.inject({ method: 'POST', url: `/api/v1/sales/orders/${orderId}/confirm`, headers: authHeader(token) });
  const res = await app.inject({ method: 'POST', url: `/api/v1/sales/orders/${orderId}/reserve`, headers: authHeader(token), payload: {} });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'INSUFFICIENT_STOCK');
});

test('sales: money must be integer minor units (float price rejected)', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const product = await findProduct(app, token, 'SHELF-STD');
  const customer = await firstCustomer(app, token);
  const res = await app.inject({ method: 'POST', url: '/api/v1/sales/orders', headers: authHeader(token),
    payload: { customerId: customer.id, items: [{ productId: product.id, quantity: 1, priceMinor: 46000.5 }] } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'VALIDATION_ERROR');
});

test('crm: funnel returns all five stages with totals', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const res = await app.inject({ url: '/api/v1/crm/funnel', headers: authHeader(token) });
  const body = res.json();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(body.columns.map((c: any) => c.stage), ['lead', 'qualified', 'proposal', 'won', 'lost']);
  const total = body.columns.reduce((s: number, c: any) => s + c.count, 0);
  assert.ok(total >= 3, 'seeded deals present');
});

test('crm: moving a deal to "lost" requires a reason', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const created = await app.inject({ method: 'POST', url: '/api/v1/crm/deals', headers: authHeader(token), payload: { title: `Test deal ${Date.now()}` } });
  assert.equal(created.statusCode, 201);
  const dealId = created.json().deal.id;
  const bad = await app.inject({ method: 'POST', url: `/api/v1/crm/deals/${dealId}/move`, headers: authHeader(token), payload: { stage: 'lost' } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, 'LOST_REASON_REQUIRED');
  const ok = await app.inject({ method: 'POST', url: `/api/v1/crm/deals/${dealId}/move`, headers: authHeader(token), payload: { stage: 'lost', lostReason: 'Цена' } });
  assert.equal(ok.statusCode, 200);
});
