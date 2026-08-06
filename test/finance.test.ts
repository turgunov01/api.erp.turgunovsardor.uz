// Stage 8 (Finance & accounting) integration tests:
//  8.1 cash/bank accounts + receipts/payments (balance + auto-posted journal)
//  8.2 inventory costing / valuation report
//  8.3 chart of accounts, immutable balanced journal, reverse, period close
//  8.4 auto-postings from production events
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, tokenFor, authHeader } from './helpers.js';

async function ownerToken() { return tokenFor(await getApp(), 'admin@demo-factory.com', 'Admin123!'); }
async function operatorToken() { return tokenFor(await getApp(), 'operator@demo-factory.com', 'Operator123!'); }

async function findWarehouse(app: any, token: string, code: string) {
  const res = await app.inject({ url: '/api/v1/warehouse/warehouses', headers: authHeader(token) });
  return res.json().warehouses.find((w: any) => w.code === code);
}
async function firstBom(app: any, token: string) {
  const res = await app.inject({ url: '/api/v1/production/boms', headers: authHeader(token) });
  return res.json().boms[0];
}

test('finance: RBAC — operator cannot view finance (403)', async () => {
  const app = await getApp();
  const token = await operatorToken();
  const res = await app.inject({ url: '/api/v1/finance/accounts', headers: authHeader(token) });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'MISSING_PERMISSION');
});

test('finance: default chart of accounts is available', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const res = await app.inject({ url: '/api/v1/finance/chart', headers: authHeader(token) });
  assert.equal(res.statusCode, 200);
  const codes = res.json().accounts.map((a: any) => a.code);
  for (const c of ['1010', '1040', '5010', '6010', '7010']) assert.ok(codes.includes(c), `chart has ${c}`);
});

test('finance: cash account receipt updates balance and posts a journal entry', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const created = await app.inject({ method: 'POST', url: '/api/v1/finance/accounts', headers: authHeader(token),
    payload: { name: 'Тест-касса', kind: 'cash', openingMinor: 1_000_000 } });
  assert.equal(created.statusCode, 201);
  const acc = created.json().account;
  assert.equal(Number(acc.balanceMinor), 1_000_000);

  const rec = await app.inject({ method: 'POST', url: '/api/v1/finance/transactions', headers: authHeader(token),
    payload: { accountId: acc.id, direction: 'in', category: 'sale', amountMinor: 500_000, counterparty: 'Клиент А' } });
  assert.equal(rec.statusCode, 201);
  assert.equal(Number(rec.json().transaction.balanceAfter), 1_500_000);

  const detail = await app.inject({ url: `/api/v1/finance/accounts/${acc.id}`, headers: authHeader(token) });
  assert.equal(Number(detail.json().account.balanceMinor), 1_500_000);
  assert.ok(detail.json().transactions.length >= 2, 'opening + receipt transactions');
  // The receipt produced a linked journal entry.
  const je = rec.json().transaction.journalEntryId;
  assert.ok(je, 'transaction linked to a journal entry');
});

test('finance: paying out more than the balance is blocked (INSUFFICIENT_FUNDS)', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const created = await app.inject({ method: 'POST', url: '/api/v1/finance/accounts', headers: authHeader(token),
    payload: { name: 'Пустая касса', kind: 'cash', openingMinor: 0 } });
  const acc = created.json().account;
  const res = await app.inject({ method: 'POST', url: '/api/v1/finance/transactions', headers: authHeader(token),
    payload: { accountId: acc.id, direction: 'out', category: 'rent', amountMinor: 100 } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'INSUFFICIENT_FUNDS');
});

test('finance: manual journal must balance; posted entry can be reversed', async () => {
  const app = await getApp();
  const token = await ownerToken();
  // Unbalanced is rejected.
  const bad = await app.inject({ method: 'POST', url: '/api/v1/finance/journal', headers: authHeader(token),
    payload: { memo: 'кривая', lines: [{ accountCode: '1010', debitMinor: 1000 }, { accountCode: '6020', creditMinor: 500 }] } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, 'UNBALANCED');

  // Balanced posts.
  const ok = await app.inject({ method: 'POST', url: '/api/v1/finance/journal', headers: authHeader(token),
    payload: { memo: 'тест-проводка', lines: [{ accountCode: '1010', debitMinor: 1000 }, { accountCode: '6020', creditMinor: 1000 }] } });
  assert.equal(ok.statusCode, 201);
  const entryId = ok.json().entry.id;

  // Reversal creates a mirror and marks the original.
  const rev = await app.inject({ method: 'POST', url: `/api/v1/finance/journal/${entryId}/reverse`, headers: authHeader(token) });
  assert.equal(rev.statusCode, 201);
  const detail = await app.inject({ url: `/api/v1/finance/journal/${entryId}`, headers: authHeader(token) });
  assert.ok(detail.json().entry.reversedById, 'original marked reversed');

  // A second reversal is refused.
  const rev2 = await app.inject({ method: 'POST', url: `/api/v1/finance/journal/${entryId}/reverse`, headers: authHeader(token) });
  assert.equal(rev2.statusCode, 400);
});

test('finance: inventory valuation reflects costed opening stock (8.2)', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const res = await app.inject({ url: '/api/v1/finance/reports/inventory-valuation', headers: authHeader(token) });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(Number(body.totalAvgMinor) > 0, 'non-zero average valuation');
  assert.ok(body.rows.some((r: any) => Number(r.avgCostMinor) > 0), 'some product has a cost basis');
});

test('finance: production cycle auto-posts to the journal (8.4)', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const whRaw = await findWarehouse(app, token, 'WH-RAW');
  const bom = await firstBom(app, token);

  const before = (await app.inject({ url: '/api/v1/finance/journal?source=production&pageSize=200', headers: authHeader(token) })).json().meta.total;

  const created = await app.inject({ method: 'POST', url: '/api/v1/production/orders', headers: authHeader(token),
    payload: { bomId: bom.id, quantity: 1, warehouseId: whRaw.id } });
  const orderId = created.json().order.id;
  await app.inject({ method: 'POST', url: `/api/v1/production/orders/${orderId}/confirm`, headers: authHeader(token) });
  await app.inject({ method: 'POST', url: `/api/v1/production/orders/${orderId}/issue`, headers: authHeader(token), payload: {} });
  await app.inject({ method: 'POST', url: `/api/v1/production/orders/${orderId}/complete`, headers: authHeader(token), payload: {} });

  const after = (await app.inject({ url: '/api/v1/finance/journal?source=production&pageSize=200', headers: authHeader(token) })).json().meta.total;
  assert.ok(after >= before + 2, 'issue + complete each posted a journal entry');

  // The books stay balanced.
  const tb = await app.inject({ url: '/api/v1/finance/reports/trial-balance', headers: authHeader(token) });
  assert.equal(tb.json().balanced, true, 'trial balance is balanced');
});

test('finance: a closed period blocks new postings (8.3)', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const periods = (await app.inject({ url: '/api/v1/finance/periods', headers: authHeader(token) })).json().periods;
  const current = periods[0]; // newest first = current month
  assert.ok(current, 'a period exists');

  const closed = await app.inject({ method: 'POST', url: `/api/v1/finance/periods/${current.id}/close`, headers: authHeader(token) });
  assert.equal(closed.statusCode, 200);
  try {
    const blocked = await app.inject({ method: 'POST', url: '/api/v1/finance/journal', headers: authHeader(token),
      payload: { memo: 'в закрытый период', lines: [{ accountCode: '1010', debitMinor: 10 }, { accountCode: '6020', creditMinor: 10 }] } });
    assert.equal(blocked.statusCode, 400);
    assert.equal(blocked.json().error.code, 'PERIOD_CLOSED');
  } finally {
    // Reopen so the shared DB stays usable for other tests.
    await app.inject({ method: 'POST', url: `/api/v1/finance/periods/${current.id}/reopen`, headers: authHeader(token) });
  }
});
