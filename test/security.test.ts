import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, tokenFor, authHeader } from './helpers.js';

async function ownerTok() { return tokenFor(await getApp(), 'admin@demo-factory.com', 'Admin123!'); }
async function operatorTok() { return tokenFor(await getApp(), 'operator@demo-factory.com', 'Operator123!'); }
const uniq = () => Math.floor(performance.now() * 1000).toString(36);

test('3.1 invitation → accept creates a working user', async () => {
  const app = await getApp();
  const h = authHeader(await ownerTok());
  const email = `inv+${uniq()}@demo-factory.com`;
  const inv = await app.inject({ method: 'POST', url: '/api/v1/admin/invitations', headers: h, payload: { email, roleCodes: ['operator'] } });
  assert.equal(inv.statusCode, 201);
  const token = inv.json().devToken;
  assert.ok(token);
  const acc = await app.inject({ method: 'POST', url: '/api/v1/auth/accept-invite', payload: { token, fullName: 'Invited User', password: 'Invited123!' } });
  assert.equal(acc.statusCode, 201);
  assert.deepEqual(acc.json().user.roles, ['operator']);
  // token is single-use
  const again = await app.inject({ method: 'POST', url: '/api/v1/auth/accept-invite', payload: { token, fullName: 'x', password: 'Invited123!' } });
  assert.equal(again.statusCode, 400);
});

test('3.2 custom role can be created with chosen permissions', async () => {
  const app = await getApp();
  const h = authHeader(await ownerTok());
  const code = `role_${uniq()}`;
  const res = await app.inject({ method: 'POST', url: '/api/v1/admin/roles', headers: h, payload: { name: 'Custom', code, permissions: ['catalog.read', 'warehouse.read'] } });
  assert.equal(res.statusCode, 201);
  const roles = (await app.inject({ url: '/api/v1/admin/roles', headers: h })).json().roles;
  const created = roles.find((r: any) => r.code === code);
  assert.ok(created);
  assert.equal(created.permissions.length, 2);
});

test('3.6 field-level: operator gets no price, owner does', async () => {
  const app = await getApp();
  const op = await app.inject({ url: '/api/v1/catalog/products?pageSize=1', headers: authHeader(await operatorTok()) });
  assert.equal(op.json().priceVisible, false);
  assert.equal(op.json().products[0].priceMinor, null);
  const ow = await app.inject({ url: '/api/v1/catalog/products?pageSize=1', headers: authHeader(await ownerTok()) });
  assert.equal(ow.json().priceVisible, true);
  assert.notEqual(ow.json().products[0].priceMinor, null);
});

test('3.5 record-level: scoped user sees only allowed warehouses', async () => {
  const app = await getApp();
  const h = authHeader(await ownerTok());
  const whs = (await app.inject({ url: '/api/v1/warehouse/warehouses', headers: h })).json().warehouses;
  const raw = whs.find((w: any) => w.code === 'WH-RAW');
  const users = (await app.inject({ url: '/api/v1/admin/users', headers: h })).json().users;
  const op = users.find((u: any) => u.email === 'operator@demo-factory.com');

  await app.inject({ method: 'PUT', url: `/api/v1/admin/users/${op.id}/warehouses`, headers: h, payload: { warehouseIds: [raw.id] } });
  const opList = (await app.inject({ url: '/api/v1/warehouse/warehouses', headers: authHeader(await operatorTok()) })).json().warehouses;
  assert.equal(opList.length, 1);
  assert.equal(opList[0].code, 'WH-RAW');
  // reset
  await app.inject({ method: 'PUT', url: `/api/v1/admin/users/${op.id}/warehouses`, headers: h, payload: { warehouseIds: [] } });
});
