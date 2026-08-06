// Stage 12 — Marketplace (12.2), Integrations (12.3, encrypted creds), no-code forms (12.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, tokenFor, authHeader } from './helpers.js';

async function ownerToken() { return tokenFor(await getApp(), 'admin@demo-factory.com', 'Admin123!'); }
const H = (t: string) => authHeader(t);
const uniq = () => Math.floor(performance.now() * 1000).toString(36);

test('12.2 marketplace lists modules with categories, plan and used count', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const d = (await app.inject({ url: '/api/v1/studio/marketplace', headers: H(token) })).json();
  assert.ok(d.items.length >= 10 && d.items[0].category);
  assert.ok(d.plan.name);
  assert.ok(d.items.some((m: any) => m.installed));
});

test('12.3 integrations: connect stores an encrypted key (never returned) and disconnects', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const patch = await app.inject({ method: 'PATCH', url: '/api/v1/studio/integrations/telegram', headers: H(token), payload: { config: { botToken: 'secret-BOT-123', chatId: '42' } } });
  assert.equal(patch.statusCode, 200);
  const list = (await app.inject({ url: '/api/v1/studio/integrations', headers: H(token) })).json();
  const tg = list.integrations.find((i: any) => i.key === 'telegram');
  assert.equal(tg.connected, true);
  assert.ok(tg.filledFields.includes('botToken'));
  assert.ok(!JSON.stringify(list).includes('secret-BOT-123'), 'raw secret never returned');
  const off = await app.inject({ method: 'POST', url: '/api/v1/studio/integrations/telegram/disconnect', headers: H(token) });
  assert.equal(off.statusCode, 200);
  const after = (await app.inject({ url: '/api/v1/studio/integrations', headers: H(token) })).json();
  assert.equal(after.integrations.find((i: any) => i.key === 'telegram').status, 'disconnected');
});

test('12.1 no-code form: create → submit record (required enforced) → list → delete', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const key = `t-${uniq()}`;
  const created = await app.inject({ method: 'POST', url: '/api/v1/studio/forms', headers: H(token), payload: {
    key, name: 'Тестовая форма', icon: '🔧', fields: [{ key: 'name', label: 'ФИО', type: 'text', required: true }, { key: 'note', label: 'Примечание', type: 'textarea' }] } });
  assert.equal(created.statusCode, 201);
  const form = created.json().form;
  assert.equal(form.icon, 'F', 'non-WIN1251 icon sanitized');

  // Missing required field → 400.
  const bad = await app.inject({ method: 'POST', url: `/api/v1/studio/forms/${form.id}/records`, headers: H(token), payload: { data: { note: 'x' } } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, 'FIELD_REQUIRED');

  const ok = await app.inject({ method: 'POST', url: `/api/v1/studio/forms/${form.id}/records`, headers: H(token), payload: { data: { name: 'Иван Иванов', note: 'Тест' } } });
  assert.equal(ok.statusCode, 201);
  const detail = (await app.inject({ url: `/api/v1/studio/forms/${form.id}`, headers: H(token) })).json();
  assert.equal(detail.records.length, 1);
  assert.equal(detail.records[0].data.name, 'Иван Иванов');

  await app.inject({ method: 'DELETE', url: `/api/v1/studio/forms/${form.id}`, headers: H(token) });
});

test('12.1 RBAC: operator cannot build forms (studio.manage)', async () => {
  const app = await getApp();
  const token = await tokenFor(app, 'operator@demo-factory.com', 'Operator123!');
  const res = await app.inject({ method: 'POST', url: '/api/v1/studio/forms', headers: H(token), payload: { key: 'x', name: 'x', fields: [{ key: 'a', label: 'A', type: 'text' }] } });
  assert.equal(res.statusCode, 403);
});
