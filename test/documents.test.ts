// Stage 9.5 document flow: templates, versioned documents, approval/signature chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, tokenFor, authHeader } from './helpers.js';
import { prisma } from '../src/db.js';

async function ownerToken() { return tokenFor(await getApp(), 'admin@demo-factory.com', 'Admin123!'); }
const H = (t: string) => authHeader(t);

async function adminUserId() {
  const u = await prisma.user.findFirst({ where: { email: 'admin@demo-factory.com' } });
  return u!.id;
}

test('9.5 documents: create from template renders {{fields}}', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const tpls = (await app.inject({ url: '/api/v1/documents/templates', headers: H(token) })).json();
  const tpl = tpls.templates.find((t: any) => t.code === 'SUPPLY-CONTRACT');
  assert.ok(tpl, 'seeded template present');

  const created = await app.inject({ method: 'POST', url: '/api/v1/documents/documents', headers: H(token), payload: {
    title: 'Договор №42', templateId: tpl.id, fields: { number: '42', city: 'Ташкент', supplier: 'ООО Сталь', buyer: 'Demo', amount: '1000000' } } });
  assert.equal(created.statusCode, 201);
  const id = created.json().document.id;
  assert.ok(created.json().document.number.startsWith('DOC-'));

  const detail = (await app.inject({ url: `/api/v1/documents/documents/${id}`, headers: H(token) })).json();
  const body = detail.document.versions[0].body;
  assert.match(body, /№42/); assert.match(body, /ООО Сталь/); assert.ok(!body.includes('{{'), 'no unrendered placeholders');
});

test('9.5 documents: submit → approve finalizes (signature recorded)', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const uid = await adminUserId();
  const created = await app.inject({ method: 'POST', url: '/api/v1/documents/documents', headers: H(token), payload: { title: 'Акт выполненных работ', body: 'Акт на 500000 сум.' } });
  const id = created.json().document.id;

  const submit = await app.inject({ method: 'POST', url: `/api/v1/documents/documents/${id}/submit`, headers: H(token), payload: { approverIds: [uid] } });
  assert.equal(submit.statusCode, 200);
  assert.equal(submit.json().status, 'pending');

  const approve = await app.inject({ method: 'POST', url: `/api/v1/documents/documents/${id}/approve`, headers: H(token), payload: { comment: 'Согласовано' } });
  assert.equal(approve.statusCode, 200);
  assert.equal(approve.json().finalized, true);

  const detail = (await app.inject({ url: `/api/v1/documents/documents/${id}`, headers: H(token) })).json();
  assert.equal(detail.document.status, 'approved');
  assert.ok(detail.document.approvals[0].actedAt, 'signature timestamp recorded');
  assert.equal(detail.document.approvals[0].status, 'approved');
});

test('9.5 documents: reject requires a reason and marks the document rejected', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const uid = await adminUserId();
  const created = await app.inject({ method: 'POST', url: '/api/v1/documents/documents', headers: H(token), payload: { title: 'Счёт на оплату', body: 'Счёт.' } });
  const id = created.json().document.id;
  await app.inject({ method: 'POST', url: `/api/v1/documents/documents/${id}/submit`, headers: H(token), payload: { approverIds: [uid] } });

  const noReason = await app.inject({ method: 'POST', url: `/api/v1/documents/documents/${id}/reject`, headers: H(token), payload: {} });
  assert.equal(noReason.statusCode, 400);

  const rejected = await app.inject({ method: 'POST', url: `/api/v1/documents/documents/${id}/reject`, headers: H(token), payload: { comment: 'Неверная сумма' } });
  assert.equal(rejected.statusCode, 200);
  const detail = (await app.inject({ url: `/api/v1/documents/documents/${id}`, headers: H(token) })).json();
  assert.equal(detail.document.status, 'rejected');

  // After rejection a new version can be added, returning it to draft.
  const ver = await app.inject({ method: 'POST', url: `/api/v1/documents/documents/${id}/version`, headers: H(token), payload: { body: 'Счёт (исправлено).', note: 'fix' } });
  assert.equal(ver.statusCode, 201);
  const d2 = (await app.inject({ url: `/api/v1/documents/documents/${id}`, headers: H(token) })).json();
  assert.equal(d2.document.status, 'draft');
  assert.equal(d2.document.currentVersion, 2);
});

// A minimal valid .docx (Heading1 "TITLE" + a bold run) built with Python zipfile.
const DOCX_B64 = 'UEsDBBQAAAAIAPsT9Vx5bjPX7AAAAK0BAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2Qy07DMBBFf8XyFsUOLBBCcbrgsQQW5QMse5JYtWcsjxvSv0dpSxeosL6Pc3W7zZKimKFwIDTyVrVSADryAUcjP7evzYMUXC16GwnByAOw3PTd9pCBxZIispFTrflRa3YTJMuKMuCS4kAl2cqKyqizdTs7gr5r23vtCCtgberaIfvuGQa7j1W8LBXwtKNAZCmeTsaVZaTNOQZnayDUM/pflOZMUAXi0cNTyHyzpCj1VcKq/A04595nKCV4EB+21DebwEj9RcVrT26fAKv6v+bKThqG4OCSX9tyIQfMAccU1UVJNuDPfn28u/8GUEsDBBQAAAAIAPsT9Vyb/TfqsQAAACkBAAALAAAAX3JlbHMvLnJlbHONz8FqwzAQBNBfEXuv5eQQQrDsSwjkWtwPENLaFpV2hVZNnb/PJYc49NDrMLxhumFNUd2wSGAysGtaUEiOfaDZwNd4+TiCkmrJ28iEBu4oMPTdJ0ZbA5MsIYtaUyQxsNSaT1qLWzBZaTgjrSlOXJKt0nCZdbbu286o92170OXVgK2prt5AufodqPGe8T82T1NweGb3k5DqHxNvDVCjLTNWA79cvPbPuFlTBN13enOxfwBQSwMEFAAAAAgA+xP1XEAWUfTIAAAAMwEAABEAAAB3b3JkL2RvY3VtZW50LnhtbG1PQU7EMAz8SuQ7TZcDQlWTPS3alTggUR6QNqZbKbGrxGzb36O2sFy4zMj2zGhcH+cY1A1THpgMHIoSFFLHfqDewEfz8vAMKosj7wITGlgww9HWU+W5+4pIouYYKFeTgavIWGmduytGlwsekeYYPjlFJ7ng1OuJkx8Td5jzQH0M+rEsn3R0A8Ea2bJfVh43eEsbvcsSUE3VzQUDZ3RrswNoW+u7ZgOxzaV5Pa1r2Y5pl9wDd+nuaHf/zyS25eD/cerfTvrvX/sNUEsBAhQAFAAAAAgA+xP1XHluM9fsAAAArQEAABMAAAAAAAAAAAAAAIABAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAAUAAAACAD7E/Vcm/036rEAAAApAQAACwAAAAAAAAAAAAAAgAEdAQAAX3JlbHMvLnJlbHNQSwECFAAUAAAACAD7E/VcQBZR9MgAAAAzAQAAEQAAAAAAAAAAAAAAgAH3AQAAd29yZC9kb2N1bWVudC54bWxQSwUGAAAAAAMAAwC5AAAA7gIAAAAA';

test('9.5 documents: import-docx converts Word (built-in zlib) to HTML', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const r = await app.inject({ method: 'POST', url: '/api/v1/documents/import-docx', headers: H(token), payload: { dataBase64: DOCX_B64, filename: 'contract.docx' } });
  assert.equal(r.statusCode, 200);
  const html = r.json().html as string;
  assert.match(html, /<h1>TITLE<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.equal(r.json().title, 'contract');
});

test('9.5 documents: HTML body is sanitized (script stripped)', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const created = await app.inject({ method: 'POST', url: '/api/v1/documents/documents', headers: H(token), payload: { title: 'XSS', body: '<p>ok</p><script>alert(1)</script><img src=x onerror="alert(2)">' } });
  assert.equal(created.statusCode, 201);
  const id = created.json().document.id;
  const detail = (await app.inject({ url: `/api/v1/documents/documents/${id}`, headers: H(token) })).json();
  const body = detail.document.versions[0].body as string;
  assert.ok(!/<script/i.test(body), 'no script tag');
  assert.ok(!/onerror/i.test(body), 'no inline handler');
  assert.match(body, /<p>ok<\/p>/);
});

test('9.5 documents: RBAC — operator cannot create documents', async () => {
  const app = await getApp();
  const token = await tokenFor(app, 'operator@demo-factory.com', 'Operator123!');
  const res = await app.inject({ method: 'POST', url: '/api/v1/documents/documents', headers: H(token), payload: { title: 'x', body: 'x' } });
  assert.equal(res.statusCode, 403);
});
