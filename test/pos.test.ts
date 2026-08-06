// Stage 15 — POS / Касса: registers, shifts, receipts (sale + refund), revenue postings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, tokenFor, authHeader } from './helpers.js';

async function ownerToken() { return tokenFor(await getApp(), 'admin@demo-factory.com', 'Admin123!'); }
const H = (t: string) => authHeader(t);

async function registerId(app: any, token: string) {
  const d = (await app.inject({ url: '/api/v1/pos/registers', headers: H(token) })).json();
  const reg = d.registers.find((r: any) => r.code === 'POS-1');
  assert.ok(reg, 'seeded register POS-1 present');
  return reg;
}

// Make sure no stale shift is open (a prior crashed run could leave one).
async function ensureNoOpenShift(app: any, token: string, regId: string) {
  const cur = (await app.inject({ url: `/api/v1/pos/shifts/current?registerId=${regId}`, headers: H(token) })).json();
  if (cur.shift) await app.inject({ method: 'POST', url: `/api/v1/pos/shifts/${cur.shift.id}/close`, headers: H(token), payload: { countedCashMinor: 0 } });
}

async function journalEntryFor(app: any, token: string, receiptId: string) {
  const j = (await app.inject({ url: '/api/v1/finance/journal?pageSize=100&source=pos', headers: H(token) })).json();
  return (j.entries ?? []).find((e: any) => e.refType === 'PosReceipt' && e.refId === receiptId);
}

test('POS: register seeded on the main warehouse', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const reg = await registerId(app, token);
  assert.ok(reg.warehouseName, 'register enriched with warehouse name');
});

test('POS: open shift → cash sale reduces stock & posts revenue → refund reverses → close reports variance', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const reg = await registerId(app, token);
  await ensureNoOpenShift(app, token, reg.id);

  // Open a shift with a 1,000,000 UZS float.
  const opened = await app.inject({ method: 'POST', url: '/api/v1/pos/shifts/open', headers: H(token), payload: { registerId: reg.id, openingFloatMinor: 100_000_000 } });
  assert.equal(opened.statusCode, 201);
  const shift = opened.json().shift;
  assert.equal(shift.status, 'open');

  // Second open on same register is blocked.
  const dup = await app.inject({ method: 'POST', url: '/api/v1/pos/shifts/open', headers: H(token), payload: { registerId: reg.id, openingFloatMinor: 0 } });
  assert.equal(dup.statusCode, 400);
  assert.equal(dup.json().error.code, 'SHIFT_ALREADY_OPEN');

  // Find a finished-good on the register's warehouse to sell.
  const prods = (await app.inject({ url: '/api/v1/catalog/products?pageSize=100', headers: H(token) })).json();
  const shelf = prods.products.find((p: any) => p.sku === 'SHELF-STD');
  assert.ok(shelf, 'SHELF-STD product present');

  // Cash sale of 1 unit at an explicit price (100,000 UZS net).
  const unit = 10_000_000; // minor
  const sale = await app.inject({ method: 'POST', url: '/api/v1/pos/receipts', headers: H(token), payload: {
    registerId: reg.id, paymentMethod: 'cash', tenderedMinor: 20_000_000,
    lines: [{ productId: shelf.id, qty: 1, unitPriceMinor: unit }],
  } });
  assert.equal(sale.statusCode, 201);
  const receipt = sale.json().receipt;
  // VAT 12% on top: total = 10,000,000 + 1,200,000 = 11,200,000; change = 20,000,000 − 11,200,000.
  assert.equal(Number(receipt.subtotalMinor), unit);
  assert.equal(Number(receipt.vatMinor), Math.round(unit * 0.12));
  assert.equal(Number(receipt.totalMinor), unit + Math.round(unit * 0.12));
  assert.equal(Number(receipt.cashMinor), Number(receipt.totalMinor));
  assert.equal(Number(receipt.changeMinor), 20_000_000 - Number(receipt.totalMinor));
  assert.ok(Number(receipt.cogsMinor) > 0, 'COGS captured from stock');

  // Revenue posted to the ledger (finance module on for the demo tenant).
  assert.ok(await journalEntryFor(app, token, receipt.id), 'pos.sale journal entry posted');

  // Refund the receipt → returns stock and reverses revenue.
  const refund = await app.inject({ method: 'POST', url: `/api/v1/pos/receipts/${receipt.id}/refund`, headers: H(token) });
  assert.equal(refund.statusCode, 201);
  assert.equal(refund.json().receipt.type, 'refund');
  assert.ok(await journalEntryFor(app, token, refund.json().receipt.id), 'pos.refund journal entry posted');

  // Double refund blocked.
  const again = await app.inject({ method: 'POST', url: `/api/v1/pos/receipts/${receipt.id}/refund`, headers: H(token) });
  assert.equal(again.statusCode, 400);
  assert.equal(again.json().error.code, 'ALREADY_REFUNDED');

  // Overselling is blocked (BOLT-M8 lives on the raw store, not this register's warehouse).
  const bolt = prods.products.find((p: any) => p.sku === 'BOLT-M8');
  const over = await app.inject({ method: 'POST', url: '/api/v1/pos/receipts', headers: H(token), payload: {
    registerId: reg.id, paymentMethod: 'card', lines: [{ productId: bolt.id, qty: 5, unitPriceMinor: 1000 }] } });
  assert.equal(over.statusCode, 400);
  assert.equal(over.json().error.code, 'INSUFFICIENT_STOCK');

  // Close the shift: sale + refund net cash to zero, so expected == opening float.
  const close = await app.inject({ method: 'POST', url: `/api/v1/pos/shifts/${shift.id}/close`, headers: H(token), payload: { countedCashMinor: 100_000_000 } });
  assert.equal(close.statusCode, 200);
  const closed = close.json().shift;
  assert.equal(closed.status, 'closed');
  assert.equal(Number(closed.expectedCashMinor), 100_000_000);
  assert.equal(Number(closed.cashVarianceMinor), 0);
});

test('POS RBAC: operator without pos.use is denied (403)', async () => {
  const app = await getApp();
  const token = await tokenFor(app, 'operator@demo-factory.com', 'Operator123!');
  const res = await app.inject({ url: '/api/v1/pos/registers', headers: H(token) });
  assert.equal(res.statusCode, 403);
});
