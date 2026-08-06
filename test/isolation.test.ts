// Stage 13.3 — multi-tenant isolation: tenant B must never see or reach tenant A's data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, authHeader } from './helpers.js';

const uniq = () => Math.floor(performance.now() * 1000).toString(36);

async function newTenant(app: any) {
  const s = uniq();
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: {
    companyName: `Iso ${s}`, industry: 'retail', fullName: 'Owner', email: `iso+${s}@test.local`, password: 'Owner123!',
  }});
  return res.json().accessToken as string;
}

test('13.3 tenant isolation: B cannot see or fetch A\'s product', async () => {
  const app = await getApp();
  const tokenA = await newTenant(app);
  const tokenB = await newTenant(app);

  // A creates a product.
  const created = await app.inject({ method: 'POST', url: '/api/v1/catalog/products', headers: authHeader(tokenA), payload: {
    sku: `ISO-${uniq()}`, name: 'Секретный товар A', type: 'stockable', priceMinor: 100 } });
  assert.equal(created.statusCode, 201);
  const productA = created.json().product;

  // B's product list must NOT contain A's product.
  const bList = (await app.inject({ url: '/api/v1/catalog/products?pageSize=200', headers: authHeader(tokenB) })).json();
  assert.ok(!bList.products.some((p: any) => p.id === productA.id), 'B does not see A\'s product in the list');

  // B trying to modify A's product by id → 404 (tenant-scoped write, not global).
  const bWrite = await app.inject({ method: 'PATCH', url: `/api/v1/catalog/products/${productA.id}`, headers: authHeader(tokenB), payload: { name: 'Взлом B' } });
  assert.equal(bWrite.statusCode, 404, 'B cannot modify A\'s product');

  // A can modify its own product.
  const aWrite = await app.inject({ method: 'PATCH', url: `/api/v1/catalog/products/${productA.id}`, headers: authHeader(tokenA), payload: { name: 'Секретный товар A (ред.)' } });
  assert.equal(aWrite.statusCode, 200);
});

test('13.3 tenant isolation: B\'s warehouse list is disjoint from A\'s', async () => {
  const app = await getApp();
  const tokenA = await newTenant(app);
  const tokenB = await newTenant(app);
  const aWh = (await app.inject({ url: '/api/v1/warehouse/warehouses', headers: authHeader(tokenA) })).json().warehouses;
  const bWh = (await app.inject({ url: '/api/v1/warehouse/warehouses', headers: authHeader(tokenB) })).json().warehouses;
  const aIds = new Set(aWh.map((w: any) => w.id));
  assert.ok(bWh.every((w: any) => !aIds.has(w.id)), 'no shared warehouse ids across tenants');
  // Each fresh tenant is provisioned with its own default warehouse.
  assert.ok(aWh.length >= 1 && bWh.length >= 1);
});

test('13.3 unauthenticated request to a protected route is rejected (401)', async () => {
  const app = await getApp();
  const res = await app.inject({ url: '/api/v1/catalog/products' });
  assert.equal(res.statusCode, 401);
});
