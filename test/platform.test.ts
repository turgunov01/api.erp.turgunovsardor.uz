// Stage 9 platform services: jobs (9.1), notifications (9.2), realtime (9.3),
// files (9.4), search (9.6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, tokenFor, authHeader } from './helpers.js';
import { enqueue, drainDue } from '../src/lib/jobs.js';
import { prisma } from '../src/db.js';

async function ownerToken() { return tokenFor(await getApp(), 'admin@demo-factory.com', 'Admin123!'); }
const H = (t: string) => authHeader(t);

test('9.2 notifications: list, mark-all-read clears the unread count', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const list = (await app.inject({ url: '/api/v1/platform/notifications', headers: H(token) })).json();
  assert.ok(list.items.length >= 1, 'seeded welcome notification present');
  const readAll = await app.inject({ method: 'POST', url: '/api/v1/platform/notifications/read-all', headers: H(token) });
  assert.equal(readAll.statusCode, 200);
  const after = (await app.inject({ url: '/api/v1/platform/notifications?unread=1', headers: H(token) })).json();
  assert.equal(after.unreadCount, 0);
});

test('9.6 search finds a product by SKU', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const r = (await app.inject({ url: '/api/v1/platform/search?q=CABINET', headers: H(token) })).json();
  assert.ok(r.hits.some((h: any) => h.type === 'product'), 'a product hit');
});

test('9.4 files: upload (base64) → list → download → delete', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const content = 'hello ttr one';
  const data = Buffer.from(content, 'utf8').toString('base64');
  const up = await app.inject({ method: 'POST', url: '/api/v1/platform/files', headers: H(token), payload: { filename: 'note.txt', mime: 'text/plain', dataBase64: data, refType: 'Test', refId: 'abc' } });
  assert.equal(up.statusCode, 201);
  const id = up.json().file.id;
  assert.equal(up.json().file.sizeBytes, content.length);

  const list = (await app.inject({ url: '/api/v1/platform/files?refType=Test&refId=abc', headers: H(token) })).json();
  assert.ok(list.files.some((f: any) => f.id === id));

  const dl = await app.inject({ url: `/api/v1/platform/files/${id}/download`, headers: H(token) });
  assert.equal(dl.statusCode, 200);
  assert.equal(dl.body, content, 'downloaded bytes match');

  const del = await app.inject({ method: 'DELETE', url: `/api/v1/platform/files/${id}`, headers: H(token) });
  assert.equal(del.statusCode, 200);
});

test('9.1 job queue: a queued job runs via the worker and completes', async () => {
  await getApp(); // building the app registers job handlers
  const id = await enqueue('email.send', { to: 'x@test.local', subject: 'Hi', text: 'body' });
  await drainDue();
  const job = await prisma.job.findUnique({ where: { id } });
  assert.equal(job?.status, 'done');
});

test('9.1 job queue: a job with no handler ends failed', async () => {
  await getApp();
  const id = await enqueue('nope.unknown', {});
  await drainDue();
  const job = await prisma.job.findUnique({ where: { id } });
  assert.equal(job?.status, 'failed');
});

test('9.3 realtime SSE rejects a missing/invalid token', async () => {
  const app = await getApp();
  const r = await app.inject({ url: '/api/v1/platform/realtime?token=bad' });
  assert.equal(r.statusCode, 401);
});

test('9.7 tenders: list returns the three source adapters as metadata', async () => {
  const app = await getApp();
  const token = await ownerToken();
  const r = await app.inject({ url: '/api/v1/platform/tenders', headers: H(token) });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.deepEqual(body.sources.map((s: any) => s.key).sort(), ['etender', 'tenderweek', 'xt-xarid']);
  assert.ok(Array.isArray(body.items) && 'meta' in body);
});

test('9.7 tenders: operator without procurement.read is denied (403)', async () => {
  const app = await getApp();
  const token = await tokenFor(app, 'operator@demo-factory.com', 'Operator123!');
  const r = await app.inject({ url: '/api/v1/platform/tenders', headers: H(token) });
  assert.equal(r.statusCode, 403);
});
