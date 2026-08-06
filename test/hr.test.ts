// Stage 14 — HR / Кадры: employees, org structure, leave approval, timesheet, payroll.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, tokenFor, authHeader } from './helpers.js';

async function ownerToken() { return tokenFor(await getApp(), 'admin@demo-factory.com', 'Admin123!'); }
const H = (t: string) => authHeader(t);
const uniq = () => Math.floor(performance.now() * 1000).toString(36);

test('HR seed: employees, departments, positions present', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const emps = (await app.inject({ url: '/api/v1/hr/employees', headers: H(token) })).json();
  assert.ok(emps.employees.length >= 4, 'demo employees seeded');
  const meta = (await app.inject({ url: '/api/v1/hr/meta', headers: H(token) })).json();
  assert.ok(meta.departments.length >= 3 && meta.positions.length >= 4);
});

test('HR employee: create → update salary → terminate', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const created = await app.inject({ method: 'POST', url: '/api/v1/hr/employees', headers: H(token), payload: {
    fullName: `Тест Сотрудник ${uniq()}`, employmentType: 'full_time', baseSalaryMinor: 300_000_000 } });
  assert.equal(created.statusCode, 201);
  const emp = created.json().employee;
  assert.match(emp.number, /^EMP-\d{4}-\d{5}$/);
  assert.equal(emp.status, 'active');
  assert.equal(Number(emp.baseSalaryMinor), 300_000_000);

  const patched = await app.inject({ method: 'PATCH', url: `/api/v1/hr/employees/${emp.id}`, headers: H(token), payload: { baseSalaryMinor: 350_000_000 } });
  assert.equal(Number(patched.json().employee.baseSalaryMinor), 350_000_000);

  const term = await app.inject({ method: 'POST', url: `/api/v1/hr/employees/${emp.id}/terminate`, headers: H(token), payload: {} });
  assert.equal(term.json().employee.status, 'terminated');
});

test('HR leave: create pending → approve (needs hr.approve)', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const emp = (await app.inject({ url: '/api/v1/hr/employees', headers: H(token) })).json().employees[0];
  const created = await app.inject({ method: 'POST', url: '/api/v1/hr/leaves', headers: H(token), payload: {
    employeeId: emp.id, type: 'vacation', startDate: '2026-09-01', endDate: '2026-09-05' } });
  assert.equal(created.statusCode, 201);
  const leave = created.json().leave;
  assert.equal(leave.days, 5);
  assert.equal(leave.status, 'pending');

  const approved = await app.inject({ method: 'POST', url: `/api/v1/hr/leaves/${leave.id}/approve`, headers: H(token) });
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.json().leave.status, 'approved');

  // Double-decide guarded.
  const again = await app.inject({ method: 'POST', url: `/api/v1/hr/leaves/${leave.id}/reject`, headers: H(token) });
  assert.equal(again.statusCode, 400);
  assert.equal(again.json().error.code, 'ALREADY_DECIDED');
});

test('HR payroll: compute → adjust bonus → approve accrues to ledger → pay from account', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const period = '2026-05'; // distinct from the seeded 2026-06 run

  // Timesheet for the period, then create the run.
  const gen = await app.inject({ method: 'POST', url: '/api/v1/hr/attendance/generate', headers: H(token), payload: { periodCode: period, normDays: 22 } });
  assert.equal(gen.statusCode, 200);

  const runRes = await app.inject({ method: 'POST', url: '/api/v1/hr/payroll', headers: H(token), payload: { periodCode: period, normDays: 22 } });
  assert.equal(runRes.statusCode, 201);
  const run = runRes.json().run;
  assert.ok(Number(run.totalGrossMinor) > 0);
  // 12% income tax withheld.
  assert.equal(Number(run.totalTaxMinor), Math.round(Number(run.totalGrossMinor) * 0.12));
  assert.equal(Number(run.totalNetMinor), Number(run.totalGrossMinor) - Number(run.totalTaxMinor));

  const detail = (await app.inject({ url: `/api/v1/hr/payroll/${run.id}`, headers: H(token) })).json();
  assert.ok(detail.items.length >= 4);
  const item = detail.items[0];
  const grossBefore = Number(detail.run.totalGrossMinor);

  // Add a bonus of 1,000,000 minor → gross/tax/net rise.
  const adj = await app.inject({ method: 'PATCH', url: `/api/v1/hr/payroll/${run.id}/items/${item.id}`, headers: H(token), payload: { accrualsMinor: 1_000_000 } });
  assert.equal(adj.statusCode, 200);
  assert.equal(Number(adj.json().run.totalGrossMinor), grossBefore + 1_000_000);

  // Approve → status approved.
  const approve = await app.inject({ method: 'POST', url: `/api/v1/hr/payroll/${run.id}/approve`, headers: H(token) });
  assert.equal(approve.statusCode, 200);
  assert.equal(approve.json().run.status, 'approved');

  // A wage-accrual journal entry was posted (finance module is on for the demo tenant).
  const journal = (await app.inject({ url: '/api/v1/finance/journal?pageSize=100', headers: H(token) })).json();
  const accrual = (journal.items ?? journal.entries ?? []).find((e: any) => e.refType === 'PayrollRun' && e.refId === run.id);
  assert.ok(accrual, 'payroll accrual entry posted');

  // Pay from the cash box account.
  const accounts = (await app.inject({ url: '/api/v1/finance/accounts', headers: H(token) })).json();
  const acc = (accounts.accounts ?? accounts.items ?? []).find((a: any) => a.kind === 'bank') ?? (accounts.accounts ?? accounts.items ?? [])[0];
  const pay = await app.inject({ method: 'POST', url: `/api/v1/hr/payroll/${run.id}/pay`, headers: H(token), payload: { accountId: acc.id } });
  assert.equal(pay.statusCode, 200);
  assert.equal(pay.json().run.status, 'paid');
  assert.equal(pay.json().paidViaFinance, true);
});

test('HR RBAC: operator cannot read HR (hr.read)', async () => {
  const app = await getApp();
  const token = await tokenFor(app, 'operator@demo-factory.com', 'Operator123!');
  const res = await app.inject({ url: '/api/v1/hr/employees', headers: H(token) });
  assert.equal(res.statusCode, 403);
});
