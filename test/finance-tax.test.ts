// Stage 8.5 (VAT + bank reconciliation) and 8.6 (budgets + treasury/payment calendar).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, tokenFor, authHeader } from './helpers.js';

async function ownerToken() { return tokenFor(await getApp(), 'admin@demo-factory.com', 'Admin123!'); }
const H = (t: string) => authHeader(t);

async function findWarehouse(app: any, token: string, code: string) {
  const res = await app.inject({ url: '/api/v1/warehouse/warehouses', headers: H(token) });
  return res.json().warehouses.find((w: any) => w.code === code);
}
async function findProduct(app: any, token: string, search: string) {
  const res = await app.inject({ url: `/api/v1/catalog/products?search=${search}`, headers: H(token) });
  return res.json().products[0];
}
async function firstCustomer(app: any, token: string) {
  const res = await app.inject({ url: '/api/v1/sales/customers', headers: H(token) });
  return res.json().customers[0];
}

// --- 8.5 VAT: a sale posts output VAT on top of net revenue ---
test('8.5 VAT: shipping a sale posts output VAT (12%) on top of net revenue', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const wh = await findWarehouse(app, token, 'WH-MAIN');
  const product = await findProduct(app, token, 'SHELF-STD'); // has stock at WH-MAIN
  const customer = await firstCustomer(app, token);

  const before = (await app.inject({ url: '/api/v1/finance/reports/vat', headers: H(token) })).json();

  const priceMinor = 1_000_000_00; // net unit price
  const qty = 2;
  const created = await app.inject({ method: 'POST', url: '/api/v1/sales/orders', headers: H(token),
    payload: { customerId: customer.id, warehouseId: wh.id, items: [{ productId: product.id, quantity: qty, priceMinor }] } });
  const orderId = created.json().order.id;
  await app.inject({ method: 'POST', url: `/api/v1/sales/orders/${orderId}/confirm`, headers: H(token) });
  await app.inject({ method: 'POST', url: `/api/v1/sales/orders/${orderId}/reserve`, headers: H(token), payload: {} });
  const shipped = await app.inject({ method: 'POST', url: `/api/v1/sales/orders/${orderId}/ship`, headers: H(token), payload: { items: [{ productId: product.id, quantity: qty }] } });
  assert.equal(shipped.statusCode, 201);

  const after = (await app.inject({ url: '/api/v1/finance/reports/vat', headers: H(token) })).json();
  const expectedVat = Math.round((priceMinor * qty * 12) / 100);
  assert.equal(Number(after.outputVatMinor) - Number(before.outputVatMinor), expectedVat, 'output VAT rose by 12% of the net sale');

  // The shipment's journal entry carries a dedicated output-VAT line (5030).
  const shipmentId = shipped.json().shipment.id;
  const je = (await app.inject({ url: `/api/v1/finance/journal?source=sales`, headers: H(token) })).json();
  const entry = je.entries.find((e: any) => e.refId === shipmentId);
  assert.ok(entry, 'a journal entry references the shipment');
  const detail = (await app.inject({ url: `/api/v1/finance/journal/${entry.id}`, headers: H(token) })).json();
  const vatLine = detail.entry.lines.find((l: any) => l.accountCode === '5030');
  assert.ok(vatLine && Number(vatLine.creditMinor) === expectedVat, 'output VAT posted to 5030');
});

// --- 8.5 VAT settlement offsets input against output ---
test('8.5 VAT: settle offsets input VAT against output VAT', async () => {
  const app = await getApp();
  const token = await ownerToken();
  // Post a manual entry that creates some input VAT (Dr 1060 / Cr 1020).
  await app.inject({ method: 'POST', url: '/api/v1/finance/journal', headers: H(token), payload: {
    memo: 'Тест: входящий НДС', lines: [
      { accountCode: '1060', debitMinor: 1_000_000, creditMinor: 0 },
      { accountCode: '1020', debitMinor: 0, creditMinor: 1_000_000 },
    ] } });
  const settle = await app.inject({ method: 'POST', url: '/api/v1/finance/vat/settle', headers: H(token), payload: {} });
  assert.equal(settle.statusCode, 201);
  assert.ok(Number(settle.json().offsetMinor) > 0, 'offset posted');
});

// --- 8.5 Bank reconciliation ---
test('8.5 reconciliation: marking a transaction reconciled updates the reconciled balance', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const acc = (await app.inject({ method: 'POST', url: '/api/v1/finance/accounts', headers: H(token), payload: { name: `Recon ${Date.now()}`, kind: 'bank', openingMinor: 0 } })).json().account;
  const tx = (await app.inject({ method: 'POST', url: '/api/v1/finance/transactions', headers: H(token), payload: { accountId: acc.id, direction: 'in', category: 'other', amountMinor: 500_000 } })).json().transaction;

  let recon = (await app.inject({ url: `/api/v1/finance/accounts/${acc.id}/reconciliation`, headers: H(token) })).json();
  assert.equal(recon.unreconciledCount, 1);
  assert.equal(Number(recon.reconciledBalanceMinor), 0);

  const res = await app.inject({ method: 'POST', url: `/api/v1/finance/accounts/${acc.id}/reconcile`, headers: H(token), payload: { txIds: [tx.id], statementBalanceMinor: 500_000 } });
  assert.equal(res.statusCode, 200);
  assert.equal(Number(res.json().reconciledBalanceMinor), 500_000);
  assert.equal(Number(res.json().differenceMinor), 0, 'matches the statement');
});

// --- 8.6 Budget plan vs fact ---
test('8.6 budget: plan-vs-fact reflects posted actuals for the period', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const now = new Date();
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  await app.inject({ method: 'POST', url: '/api/v1/finance/budgets', headers: H(token), payload: { periodCode: period, accountCode: '7030', plannedMinor: 8_000_000_00 } });
  // Post an actual rent expense (Dr 7030 / Cr 1010).
  await app.inject({ method: 'POST', url: '/api/v1/finance/journal', headers: H(token), payload: {
    memo: 'Аренда факт', lines: [
      { accountCode: '7030', debitMinor: 2_000_000_00, creditMinor: 0 },
      { accountCode: '1010', debitMinor: 0, creditMinor: 2_000_000_00 },
    ] } });
  const rep = (await app.inject({ url: `/api/v1/finance/reports/budget?periodCode=${period}`, headers: H(token) })).json();
  const rent = rep.rows.find((r: any) => r.accountCode === '7030');
  assert.ok(rent, 'rent budget row present');
  assert.ok(Number(rent.actualMinor) >= 2_000_000_00, 'actual reflects the posted expense');
  assert.equal(Number(rent.plannedMinor), 8_000_000_00);
});

// --- 8.6 Treasury: paying a scheduled payment creates a cash tx and settles it ---
test('8.6 treasury: paying a scheduled payment moves cash and marks it paid', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const acc = (await app.inject({ method: 'POST', url: '/api/v1/finance/accounts', headers: H(token), payload: { name: `Treasury ${Date.now()}`, kind: 'bank', openingMinor: 10_000_000 } })).json().account;
  const sched = (await app.inject({ method: 'POST', url: '/api/v1/finance/payment-schedule', headers: H(token), payload: {
    direction: 'out', title: 'Оплата поставщику', category: 'purchase', amountMinor: 3_000_000, dueDate: new Date().toISOString(), accountId: acc.id } })).json().item;
  assert.equal(sched.status, 'planned');

  const pay = await app.inject({ method: 'POST', url: `/api/v1/finance/payment-schedule/${sched.id}/pay`, headers: H(token), payload: {} });
  assert.equal(pay.statusCode, 201);
  assert.equal(Number(pay.json().transaction.balanceAfter), 7_000_000, 'account debited by the payment');

  const after = (await app.inject({ url: `/api/v1/finance/payment-schedule`, headers: H(token) })).json();
  const paid = after.items.find((i: any) => i.id === sched.id);
  assert.equal(paid.status, 'paid');
  assert.ok(paid.paidTxId, 'linked to the created cash transaction');
});

// --- 8.6 Cash forecast reflects planned payments ---
test('8.6 cash forecast returns a running projected balance', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const rep = (await app.inject({ url: '/api/v1/finance/reports/cash-forecast?days=60', headers: H(token) })).json();
  assert.ok(Number(rep.openingMinor) > 0, 'opening from active accounts');
  assert.ok(Array.isArray(rep.rows), 'has calendar rows');
});
