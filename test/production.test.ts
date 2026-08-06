// Stage 6 (Production) integration tests: BOM RBAC, and the full production-order
// cycle — create from BOM (scaled material snapshot) → confirm → issue materials
// (stock OUT) → complete (finished goods stock IN) — plus insufficient-material
// and over-produce guards. Stock only ever moves via the warehouse contract.
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
async function firstBom(app: any, token: string) {
  const res = await app.inject({ url: '/api/v1/production/boms', headers: authHeader(token) });
  return res.json().boms[0];
}
async function stockOf(app: any, token: string, warehouseId: string, productId: string): Promise<number> {
  const res = await app.inject({ url: `/api/v1/warehouse/stock?warehouseId=${warehouseId}&pageSize=200`, headers: authHeader(token) });
  const row = res.json().stock.find((s: any) => s.productId === productId);
  return row ? Number(row.quantity) : 0;
}

test('production: RBAC — operator cannot create a BOM (403)', async () => {
  const app = await getApp();
  const token = await operatorToken();
  const res = await app.inject({ method: 'POST', url: '/api/v1/production/boms', headers: authHeader(token), payload: { productId: 'x', name: 'x', items: [{ productId: 'y', quantity: 1 }] } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'MISSING_PERMISSION');
});

test('production: seeded BOM lists with its components', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const bom = await firstBom(app, token);
  assert.ok(bom, 'a seeded BOM exists');
  assert.ok(bom.items.length >= 1, 'BOM has components');
  assert.ok(Number(bom.outputQty) > 0);
});

test('production: BOM rejects a component equal to the finished product (SELF_COMPONENT)', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const cabinet = await findProduct(app, token, 'CABINET-A1');
  const res = await app.inject({ method: 'POST', url: '/api/v1/production/boms', headers: authHeader(token),
    payload: { productId: cabinet.id, name: 'bad', items: [{ productId: cabinet.id, quantity: 1 }] } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'SELF_COMPONENT');
});

test('production: full cycle — create → confirm → issue (stock OUT) → complete (stock IN)', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const whRaw = await findWarehouse(app, token, 'WH-RAW');
  const steel = await findProduct(app, token, 'STEEL-SHEET-2MM');
  const cabinet = await findProduct(app, token, 'CABINET-A1');
  const bom = await firstBom(app, token);
  const steelPerUnit = Number(bom.items.find((i: any) => i.productId === steel.id).quantity) / Number(bom.outputQty);

  const qty = 2;
  const steelBefore = await stockOf(app, token, whRaw.id, steel.id);
  const cabinetBefore = await stockOf(app, token, whRaw.id, cabinet.id);

  // Create the production order from the BOM, materials/FG at the raw store.
  const created = await app.inject({ method: 'POST', url: '/api/v1/production/orders', headers: authHeader(token),
    payload: { bomId: bom.id, quantity: qty, warehouseId: whRaw.id } });
  assert.equal(created.statusCode, 201);
  const orderId = created.json().order.id;
  // Materials were snapshotted and scaled to the order quantity.
  const steelLine = created.json().order.items.find((it: any) => it.productId === steel.id);
  assert.equal(Number(steelLine.requiredQty), steelPerUnit * qty);

  // Confirm, then issue — materials leave stock.
  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/production/orders/${orderId}/confirm`, headers: authHeader(token) })).statusCode, 200);
  const issued = await app.inject({ method: 'POST', url: `/api/v1/production/orders/${orderId}/issue`, headers: authHeader(token), payload: {} });
  assert.equal(issued.statusCode, 200);
  const steelAfter = await stockOf(app, token, whRaw.id, steel.id);
  assert.equal(steelAfter, steelBefore - steelPerUnit * qty, 'material consumed = per-unit * qty');

  // Order is now in progress; complete it — finished goods arrive on stock.
  const detail1 = await app.inject({ url: `/api/v1/production/orders/${orderId}`, headers: authHeader(token) });
  assert.equal(detail1.json().order.status, 'in_progress');
  const done = await app.inject({ method: 'POST', url: `/api/v1/production/orders/${orderId}/complete`, headers: authHeader(token), payload: {} });
  assert.equal(done.statusCode, 200);
  const cabinetAfter = await stockOf(app, token, whRaw.id, cabinet.id);
  assert.equal(cabinetAfter, cabinetBefore + qty, 'finished goods received into stock');

  const detail2 = await app.inject({ url: `/api/v1/production/orders/${orderId}`, headers: authHeader(token) });
  assert.equal(detail2.json().order.status, 'done');
});

test('production: issuing more materials than on hand is blocked (INSUFFICIENT_STOCK)', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const whRaw = await findWarehouse(app, token, 'WH-RAW');
  const bom = await firstBom(app, token);
  const created = await app.inject({ method: 'POST', url: '/api/v1/production/orders', headers: authHeader(token),
    payload: { bomId: bom.id, quantity: 1_000_000, warehouseId: whRaw.id } });
  const orderId = created.json().order.id;
  await app.inject({ method: 'POST', url: `/api/v1/production/orders/${orderId}/confirm`, headers: authHeader(token) });
  const res = await app.inject({ method: 'POST', url: `/api/v1/production/orders/${orderId}/issue`, headers: authHeader(token), payload: {} });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'INSUFFICIENT_STOCK');
});

test('production: cannot cancel an order after materials were issued (ALREADY_ISSUED)', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const whRaw = await findWarehouse(app, token, 'WH-RAW');
  const bom = await firstBom(app, token);
  const created = await app.inject({ method: 'POST', url: '/api/v1/production/orders', headers: authHeader(token),
    payload: { bomId: bom.id, quantity: 1, warehouseId: whRaw.id } });
  const orderId = created.json().order.id;
  await app.inject({ method: 'POST', url: `/api/v1/production/orders/${orderId}/confirm`, headers: authHeader(token) });
  await app.inject({ method: 'POST', url: `/api/v1/production/orders/${orderId}/issue`, headers: authHeader(token), payload: {} });
  // Over-producing beyond the plan is rejected.
  const over = await app.inject({ method: 'POST', url: `/api/v1/production/orders/${orderId}/complete`, headers: authHeader(token), payload: { quantity: 5 } });
  assert.equal(over.statusCode, 400);
  assert.equal(over.json().error.code, 'OVER_PRODUCE');
  // And cancelling after issue is refused.
  const cancel = await app.inject({ method: 'POST', url: `/api/v1/production/orders/${orderId}/cancel`, headers: authHeader(token) });
  assert.equal(cancel.statusCode, 400);
  assert.equal(cancel.json().error.code, 'ALREADY_ISSUED');
});

test('production: quantity must respect decimal-scale validation', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const whRaw = await findWarehouse(app, token, 'WH-RAW');
  const bom = await firstBom(app, token);
  const res = await app.inject({ method: 'POST', url: '/api/v1/production/orders', headers: authHeader(token),
    payload: { bomId: bom.id, quantity: 1.1234567, warehouseId: whRaw.id } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'VALIDATION_ERROR');
});
