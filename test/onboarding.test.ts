import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, authHeader } from './helpers.js';

const uniq = () => Math.floor(performance.now() * 1000).toString(36);

function reg(app: any, overrides: any = {}) {
  const suffix = uniq();
  return app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: {
    companyName: `Onbo ${suffix}`, industry: 'wholesale',
    fullName: 'Onbo Owner', email: `onbo+${suffix}@test.local`, password: 'Owner123!',
    ...overrides,
  }});
}

test('onboarding-meta is public and returns niches, modules, selectable plans', async () => {
  const app = await getApp();
  const res = await app.inject({ url: '/api/v1/auth/onboarding-meta' });
  assert.equal(res.statusCode, 200);
  const b = res.json();
  assert.ok(b.niches.length >= 5 && b.niches[0].key && Array.isArray(b.niches[0].modules));
  assert.ok(b.modules.some((m: any) => m.key === 'catalog' && m.status));
  const planKeys = b.plans.map((p: any) => p.key);
  assert.deepEqual(planKeys.sort(), ['business', 'enterprise', 'starter', 'trial']);
  assert.equal(b.plans.find((p: any) => p.key === 'starter').maxModules, 3);
  assert.equal(b.plans.find((p: any) => p.key === 'business').maxModules, 6);
  assert.equal(b.plans.find((p: any) => p.key === 'trial').maxModules, null); // free tier: all modules
  assert.equal(b.plans.find((p: any) => p.key === 'enterprise').maxModules, null);
});

test('wizard: plan quota rejects selecting more modules than the plan allows', async () => {
  const app = await getApp();
  // starter allows 3; request 4 -> rejected
  const res = await reg(app, { plan: 'starter', modules: ['catalog', 'warehouse', 'sales', 'crm'] });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'PLAN_MODULE_LIMIT');
});

test('wizard: free (trial) tier accepts all available modules', async () => {
  const app = await getApp();
  const meta = (await app.inject({ url: '/api/v1/auth/onboarding-meta' })).json();
  const allAvailable = meta.modules.filter((m: any) => m.status === 'available').map((m: any) => m.key);
  const res = await reg(app, { plan: 'trial', modules: allAvailable });
  assert.equal(res.statusCode, 201);
  const h = authHeader(res.json().accessToken);
  const settings = (await app.inject({ url: '/api/v1/tenant/settings', headers: h })).json();
  const enabled = settings.modules.filter((m: any) => m.enabled).map((m: any) => m.key).sort();
  assert.deepEqual(enabled, [...allAvailable].sort());
  assert.equal(settings.tenant.plan, 'trial');
});

test('wizard: starter with a single module provisions with only that module enabled', async () => {
  const app = await getApp();
  const res = await reg(app, { plan: 'starter', modules: ['catalog'] });
  assert.equal(res.statusCode, 201);
  const h = authHeader(res.json().accessToken);
  const settings = (await app.inject({ url: '/api/v1/tenant/settings', headers: h })).json();
  const enabled = settings.modules.filter((m: any) => m.enabled).map((m: any) => m.key);
  assert.deepEqual(enabled, ['catalog']);
});

test('wizard: explicit module selection overrides the niche preset', async () => {
  const app = await getApp();
  // wholesale preset suggests 5 modules, but we pick 3 under business (quota 8)
  const res = await reg(app, { plan: 'business', modules: ['sales', 'crm', 'finance'] });
  assert.equal(res.statusCode, 201);
  const h = authHeader(res.json().accessToken);
  const settings = (await app.inject({ url: '/api/v1/tenant/settings', headers: h })).json();
  const enabled = settings.modules.filter((m: any) => m.enabled).map((m: any) => m.key).sort();
  assert.deepEqual(enabled, ['crm', 'finance', 'sales']);
  assert.equal(settings.tenant.plan, 'business');
});

test('wizard: company billing requisites captured at signup are stored', async () => {
  const app = await getApp();
  const res = await reg(app, { plan: 'business', modules: ['catalog'], bill: { billInn: '305123456', billLegalName: 'ООО Тест' } });
  assert.equal(res.statusCode, 201);
  const h = authHeader(res.json().accessToken);
  const details = (await app.inject({ url: '/api/v1/billing/details', headers: h })).json();
  assert.equal(details.details.inn, '305123456');
  assert.equal(details.details.legalName, 'ООО Тест');
});

test('post-signup: enabling modules beyond the plan quota is blocked', async () => {
  const app = await getApp();
  // starter quota = 3; provision with 3, then a 4th toggle is blocked
  const res = await reg(app, { plan: 'starter', modules: ['catalog', 'warehouse', 'sales'] });
  const h = authHeader(res.json().accessToken);
  const toggle = await app.inject({ method: 'PATCH', url: '/api/v1/tenant/modules/crm', headers: h, payload: { enabled: true } });
  assert.equal(toggle.statusCode, 400);
  assert.equal(toggle.json().error.code, 'PLAN_MODULE_LIMIT');
});
