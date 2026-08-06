import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, login } from './helpers.js';

test('GET /health is ok', async () => {
  const app = await getApp();
  const res = await app.inject({ url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'ok');
});

test('GET /ready reports DB up', async () => {
  const app = await getApp();
  const res = await app.inject({ url: '/ready' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().db, 'up');
});

test('login with valid owner credentials returns tokens + permissions', async () => {
  const app = await getApp();
  const { status, body } = await login(app, 'admin@demo-factory.com', 'Admin123!');
  assert.equal(status, 200);
  assert.ok(body.accessToken, 'has access token');
  assert.ok(body.refreshToken, 'has refresh token');
  assert.ok(body.user.permissions.length >= 10, 'owner has all permissions');
  assert.ok(body.user.roles.includes('owner'));
});

test('login with wrong password returns 401', async () => {
  const app = await getApp();
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'admin@demo-factory.com', password: 'wrong' } });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, 'UNAUTHORIZED');
});

test('protected route without a token returns 401', async () => {
  const app = await getApp();
  const res = await app.inject({ url: '/api/v1/warehouse/stock' });
  assert.equal(res.statusCode, 401);
});

test('refresh rotates tokens', async () => {
  const app = await getApp();
  const { body } = await login(app, 'admin@demo-factory.com', 'Admin123!');
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: body.refreshToken } });
  assert.equal(res.statusCode, 200);
  assert.ok(res.json().accessToken);
  assert.notEqual(res.json().refreshToken, body.refreshToken, 'refresh token is rotated');
});
