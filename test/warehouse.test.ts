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
async function stockOf(app: any, token: string, warehouseId: string, productId: string): Promise<number> {
  const res = await app.inject({ url: `/api/v1/warehouse/stock?warehouseId=${warehouseId}&pageSize=200`, headers: authHeader(token) });
  const row = res.json().stock.find((s: any) => s.productId === productId);
  return row ? Number(row.quantity) : 0;
}

test('RBAC: operator cannot create a product (403)', async () => {
  const app = await getApp();
  const token = await operatorToken();
  const res = await app.inject({ method: 'POST', url: '/api/v1/catalog/products', headers: authHeader(token), payload: { sku: 'RBAC-TEST', name: 'x' } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'MISSING_PERMISSION');
});

test('stock receive increases on-hand by the received amount', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const wh = await findWarehouse(app, token, 'WH-RAW');
  const product = await findProduct(app, token, 'BOLT');
  const before = await stockOf(app, token, wh.id, product.id);

  const res = await app.inject({ method: 'POST', url: '/api/v1/warehouse/movements', headers: authHeader(token),
    payload: { warehouseId: wh.id, productId: product.id, type: 'IN', quantity: 10, reason: 'unit-test receive' } });
  assert.equal(res.statusCode, 201);
  assert.equal(Number(res.json().movement.balanceAfter), before + 10);

  const after = await stockOf(app, token, wh.id, product.id);
  assert.equal(after, before + 10);
});

test('over-issue is blocked with INSUFFICIENT_STOCK', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const wh = await findWarehouse(app, token, 'WH-RAW');
  const product = await findProduct(app, token, 'BOLT');
  const res = await app.inject({ method: 'POST', url: '/api/v1/warehouse/movements', headers: authHeader(token),
    payload: { warehouseId: wh.id, productId: product.id, type: 'OUT', quantity: 1_000_000_000 } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'INSUFFICIENT_STOCK');
});

test('quantity with too many decimals is rejected', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const wh = await findWarehouse(app, token, 'WH-RAW');
  const product = await findProduct(app, token, 'BOLT');
  const res = await app.inject({ method: 'POST', url: '/api/v1/warehouse/movements', headers: authHeader(token),
    payload: { warehouseId: wh.id, productId: product.id, type: 'IN', quantity: 1.1234567 } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'VALIDATION_ERROR');
});

test('products list returns pagination meta', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const res = await app.inject({ url: '/api/v1/catalog/products?page=1&pageSize=2', headers: authHeader(token) });
  const body = res.json();
  assert.ok(body.meta, 'has meta');
  assert.equal(body.meta.pageSize, 2);
  assert.ok(body.meta.total >= 1);
  assert.ok(body.products.length <= 2);
});

test('money must be integer minor units (float price rejected)', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const res = await app.inject({ method: 'POST', url: '/api/v1/catalog/products', headers: authHeader(token),
    payload: { sku: `MONEY-${Date.now()}`, name: 'Money test', priceMinor: 99.99 } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'VALIDATION_ERROR');
});
