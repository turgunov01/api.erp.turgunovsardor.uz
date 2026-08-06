// Stage 7 (Advanced warehouse) integration tests: bin locations + transfer (7.1),
// inventory count → variance reconciled via ADJUST (7.2), batch receive/consume +
// expiry report (7.3), min-stock low-stock signal + auto purchase request (7.4),
// and barcode generate + scan lookup (7.5). Stock only moves via the warehouse contract.
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

test('inventory: RBAC — operator cannot create a bin location (403)', async () => {
  const app = await getApp();
  const token = await operatorToken();
  const wh = await findWarehouse(app, token, 'WH-MAIN');
  const res = await app.inject({ method: 'POST', url: '/api/v1/inventory/locations', headers: authHeader(token), payload: { warehouseId: wh.id, code: 'X', name: 'x' } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'MISSING_PERMISSION');
});

test('inventory: stock count reconciles a variance via ADJUST (7.2)', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const wh = await findWarehouse(app, token, 'WH-MAIN');
  const product = await findProduct(app, token, 'SHELF-STD');
  const before = await stockOf(app, token, wh.id, product.id);

  const opened = await app.inject({ method: 'POST', url: '/api/v1/inventory/counts', headers: authHeader(token), payload: { warehouseId: wh.id } });
  assert.equal(opened.statusCode, 201);
  const countId = opened.json().count.id;

  // Physically count 7 more than the system shows.
  const target = before + 7;
  const patch = await app.inject({ method: 'PATCH', url: `/api/v1/inventory/counts/${countId}/items`, headers: authHeader(token), payload: { items: [{ productId: product.id, countedQty: target }] } });
  assert.equal(patch.statusCode, 200);
  const done = await app.inject({ method: 'POST', url: `/api/v1/inventory/counts/${countId}/complete`, headers: authHeader(token) });
  assert.equal(done.statusCode, 200);
  assert.ok(done.json().adjusted >= 1);

  const after = await stockOf(app, token, wh.id, product.id);
  assert.equal(after, target, 'on-hand reconciled to the counted quantity');
});

test('inventory: batch receive adds stock, consume removes it, expiry report lists it (7.3)', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const wh = await findWarehouse(app, token, 'WH-RAW');
  const paint = await findProduct(app, token, 'PAINT-WHITE');
  const before = await stockOf(app, token, wh.id, paint.id);

  const batchNo = `T-${Date.now()}`;
  const soon = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  const recv = await app.inject({ method: 'POST', url: '/api/v1/inventory/batches/receive', headers: authHeader(token),
    payload: { warehouseId: wh.id, productId: paint.id, batchNo, expiryDate: soon, quantity: 50 } });
  assert.equal(recv.statusCode, 201);
  const batchId = recv.json().batch.id;
  assert.equal(await stockOf(app, token, wh.id, paint.id), before + 50, 'batch receive bumped aggregate on-hand');

  // Expiring-within-30-days report includes our new lot.
  const exp = await app.inject({ url: '/api/v1/inventory/batches/expiring?days=30', headers: authHeader(token) });
  assert.ok(exp.json().batches.some((b: any) => b.id === batchId), 'expiring report lists the soon-expiry batch');

  const cons = await app.inject({ method: 'POST', url: `/api/v1/inventory/batches/${batchId}/consume`, headers: authHeader(token), payload: { quantity: 20 } });
  assert.equal(cons.statusCode, 200);
  assert.equal(await stockOf(app, token, wh.id, paint.id), before + 30, 'consume reduced aggregate on-hand');

  // Over-consuming the batch is blocked.
  const over = await app.inject({ method: 'POST', url: `/api/v1/inventory/batches/${batchId}/consume`, headers: authHeader(token), payload: { quantity: 9999 } });
  assert.equal(over.statusCode, 400);
  assert.equal(over.json().error.code, 'INSUFFICIENT_BATCH');
});

test('inventory: low-stock signal + auto purchase request (7.4)', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const wh = await findWarehouse(app, token, 'WH-RAW');
  const steel = await findProduct(app, token, 'STEEL-SHEET-2MM');

  const low = await app.inject({ url: `/api/v1/inventory/low-stock?warehouseId=${wh.id}`, headers: authHeader(token) });
  const steelLow = low.json().lowStock.find((l: any) => l.productId === steel.id);
  assert.ok(steelLow, 'steel is below its seeded minimum');
  assert.ok(Number(steelLow.suggestedQty) > 0);

  const auto = await app.inject({ method: 'POST', url: '/api/v1/inventory/reorder/auto-request', headers: authHeader(token), payload: { warehouseId: wh.id } });
  assert.equal(auto.statusCode, 201);
  const pr = auto.json().purchaseRequest;
  assert.ok(pr.number.startsWith('PR-'));
  assert.ok(pr.items.some((it: any) => it.productId === steel.id), 'auto-request includes the low steel');
});

test('inventory: bin place is guarded and transfer moves between bins (7.1)', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const wh = await findWarehouse(app, token, 'WH-MAIN');
  const product = await findProduct(app, token, 'CABINET-A1');
  const stamp = Date.now();
  const binA = (await app.inject({ method: 'POST', url: '/api/v1/inventory/locations', headers: authHeader(token), payload: { warehouseId: wh.id, code: `TA-${stamp}`, name: 'bin A' } })).json().location;
  const binB = (await app.inject({ method: 'POST', url: '/api/v1/inventory/locations', headers: authHeader(token), payload: { warehouseId: wh.id, code: `TB-${stamp}`, name: 'bin B' } })).json().location;

  // Placing more than the warehouse holds is rejected.
  const tooMuch = await app.inject({ method: 'POST', url: '/api/v1/inventory/bin-stock/place', headers: authHeader(token), payload: { warehouseId: wh.id, locationId: binA.id, productId: product.id, quantity: 9_999_999 } });
  assert.equal(tooMuch.statusCode, 400);
  assert.equal(tooMuch.json().error.code, 'EXCEEDS_ONHAND');

  // Place a small amount, then move half to another bin.
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/inventory/bin-stock/place', headers: authHeader(token), payload: { warehouseId: wh.id, locationId: binA.id, productId: product.id, quantity: 4 } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/inventory/bin-stock/transfer', headers: authHeader(token), payload: { warehouseId: wh.id, fromLocationId: binA.id, toLocationId: binB.id, productId: product.id, quantity: 3 } })).statusCode, 200);

  const bins = await app.inject({ url: `/api/v1/inventory/bin-stock?warehouseId=${wh.id}&productId=${product.id}`, headers: authHeader(token) });
  const rows = bins.json().binStock;
  assert.equal(Number(rows.find((r: any) => r.locationId === binA.id).quantity), 1);
  assert.equal(Number(rows.find((r: any) => r.locationId === binB.id).quantity), 3);

  // Transferring more than a bin holds is blocked.
  const over = await app.inject({ method: 'POST', url: '/api/v1/inventory/bin-stock/transfer', headers: authHeader(token), payload: { warehouseId: wh.id, fromLocationId: binA.id, toLocationId: binB.id, productId: product.id, quantity: 100 } });
  assert.equal(over.statusCode, 400);
  assert.equal(over.json().error.code, 'INSUFFICIENT_BIN');
});

test('inventory: barcode generate + scan lookup (7.5)', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const product = await findProduct(app, token, 'BOLT-M8');
  const gen = await app.inject({ method: 'POST', url: `/api/v1/catalog/products/${product.id}/barcode`, headers: authHeader(token) });
  assert.equal(gen.statusCode, 200);
  const code = gen.json().product.barcode;
  assert.match(code, /^\d{13}$/, 'EAN-13 barcode generated');

  const scan = await app.inject({ url: `/api/v1/catalog/products/by-barcode/${code}`, headers: authHeader(token) });
  assert.equal(scan.statusCode, 200);
  assert.equal(scan.json().product.id, product.id, 'scan resolves back to the product');

  const miss = await app.inject({ url: '/api/v1/catalog/products/by-barcode/0000000000000', headers: authHeader(token) });
  assert.equal(miss.statusCode, 404);
});
