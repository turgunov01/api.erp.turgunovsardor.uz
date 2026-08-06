// Stage 17 — Логистика: fleet, deliveries (routes) with stops, dispatch/complete flow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, tokenFor, authHeader } from './helpers.js';

async function ownerToken() { return tokenFor(await getApp(), 'admin@demo-factory.com', 'Admin123!'); }
const H = (t: string) => authHeader(t);
const uniq = () => Math.floor(performance.now() * 1000).toString(36).toUpperCase();

test('Logistics: fleet + delivery seeded', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const v = (await app.inject({ url: '/api/v1/logistics/vehicles', headers: H(token) })).json();
  assert.ok(v.vehicles.length >= 2, 'seeded vehicles');
  const d = (await app.inject({ url: '/api/v1/logistics/deliveries', headers: H(token) })).json();
  assert.ok(d.deliveries.find((x: any) => x.number === 'DLV-2026-00001'), 'seeded delivery');
});

test('Logistics: vehicle CRUD + delivery dispatch → complete syncs vehicle status', async () => {
  const app = await getApp();
  const token = await ownerToken();

  // Create a vehicle.
  const plate = `77Z${uniq()}`;
  const created = await app.inject({ method: 'POST', url: '/api/v1/logistics/vehicles', headers: H(token), payload: { plate, model: 'Test Van', type: 'van', capacityKg: 800 } });
  assert.equal(created.statusCode, 201);
  const vehicle = created.json().vehicle;
  assert.equal(vehicle.status, 'available');

  // Duplicate plate rejected.
  const dup = await app.inject({ method: 'POST', url: '/api/v1/logistics/vehicles', headers: H(token), payload: { plate } });
  assert.equal(dup.statusCode, 400);
  assert.equal(dup.json().error.code, 'PLATE_EXISTS');

  // Create a delivery with two stops on that vehicle.
  const del = await app.inject({ method: 'POST', url: '/api/v1/logistics/deliveries', headers: H(token), payload: {
    vehicleId: vehicle.id, scheduledDate: '2026-08-01', costMinor: 5_000_000,
    stops: [{ address: 'Точка 1', customerName: 'Клиент А' }, { address: 'Точка 2' }],
  } });
  assert.equal(del.statusCode, 201);
  const delivery = del.json().delivery;
  assert.match(delivery.number, /^DLV-\d{4}-\d{5}$/);
  assert.equal(delivery.status, 'planned');

  // Cannot delete a vehicle with an active delivery.
  const delVeh = await app.inject({ method: 'DELETE', url: `/api/v1/logistics/vehicles/${vehicle.id}`, headers: H(token) });
  assert.equal(delVeh.statusCode, 400);
  assert.equal(delVeh.json().error.code, 'VEHICLE_BUSY');

  // Dispatch → vehicle becomes in_use.
  const disp = await app.inject({ method: 'POST', url: `/api/v1/logistics/deliveries/${delivery.id}/dispatch`, headers: H(token) });
  assert.equal(disp.statusCode, 200);
  assert.equal(disp.json().delivery.status, 'in_transit');
  let v = (await app.inject({ url: `/api/v1/logistics/vehicles`, headers: H(token) })).json().vehicles.find((x: any) => x.id === vehicle.id);
  assert.equal(v.status, 'in_use');

  // Complete → vehicle freed, stops completed.
  const done = await app.inject({ method: 'POST', url: `/api/v1/logistics/deliveries/${delivery.id}/complete`, headers: H(token) });
  assert.equal(done.statusCode, 200);
  assert.equal(done.json().delivery.status, 'delivered');
  v = (await app.inject({ url: `/api/v1/logistics/vehicles`, headers: H(token) })).json().vehicles.find((x: any) => x.id === vehicle.id);
  assert.equal(v.status, 'available');
  const detail = (await app.inject({ url: `/api/v1/logistics/deliveries/${delivery.id}`, headers: H(token) })).json();
  assert.ok(detail.stops.every((s: any) => s.status === 'completed'), 'stops completed on delivery');
});

test('Logistics: dispatch is blocked with no stops', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const del = (await app.inject({ method: 'POST', url: '/api/v1/logistics/deliveries', headers: H(token), payload: { stops: [] } })).json().delivery;
  const disp = await app.inject({ method: 'POST', url: `/api/v1/logistics/deliveries/${del.id}/dispatch`, headers: H(token) });
  assert.equal(disp.statusCode, 400);
  assert.equal(disp.json().error.code, 'NO_STOPS');
});

test('Logistics RBAC: operator without logistics.read is denied (403)', async () => {
  const app = await getApp();
  const token = await tokenFor(app, 'operator@demo-factory.com', 'Operator123!');
  const res = await app.inject({ url: '/api/v1/logistics/vehicles', headers: H(token) });
  assert.equal(res.statusCode, 403);
});
