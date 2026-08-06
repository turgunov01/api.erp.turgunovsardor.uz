// Stage 9 platform services: notifications (9.2), realtime SSE (9.3), files (9.4),
// search (9.6) and a jobs admin view (9.1). All tenant-scoped.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { requirePermission } from '../../plugins/rbac.js';
import { NotFound, BadRequest } from '../../lib/errors.js';
import { pageQuery, skipTake, pageMeta } from '../../lib/pagination.js';
import { addClient, removeClient } from '../../lib/realtime.js';
import { makeKey, putObject, getObject, deleteObject } from '../../lib/storage.js';
import { searchAll } from '../../lib/search.js';
import { TENDER_SOURCES, refreshTenders } from '../../lib/tenders.js';
import type { AccessClaims } from '../../lib/tokens.js';

const MAX_FILE_BYTES = 12 * 1024 * 1024; // 12 MB

export default async function platformRoutes(app: FastifyInstance) {
  // ==================== 9.3 REALTIME (SSE) ====================
  // EventSource can't set headers, so the access token comes via ?token=. The stream
  // pushes `notification` events (and tenant-wide `stock` pings) in real time.
  app.get('/realtime', async (req, reply) => {
    const token = (req.query as { token?: string }).token;
    let claims: AccessClaims;
    try { claims = app.jwt.verify(token ?? '') as AccessClaims; } catch { return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Bad token' } }); }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': (req.headers.origin as string) || '*',
    });
    raw.write('event: ready\ndata: {}\n\n');
    const client = addClient(reply, claims.tid, claims.sub);
    const ping = setInterval(() => { try { raw.write(': ping\n\n'); } catch { /* closed */ } }, 25000);
    req.raw.on('close', () => { clearInterval(ping); removeClient(client); });
  });

  // Everything below needs a normal authenticated request.
  app.register(async (r) => {
    r.addHook('preHandler', app.authenticate);

    // ==================== 9.2 NOTIFICATIONS ====================
    r.get('/notifications', async (req) => {
      const { unread } = req.query as { unread?: string };
      const q = pageQuery.parse(req.query);
      const where = { tenantId: req.auth.tid, userId: req.auth.sub, ...(unread === '1' ? { readAt: null } : {}) };
      const [items, total, unreadCount] = await prisma.$transaction([
        prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(q) }),
        prisma.notification.count({ where }),
        prisma.notification.count({ where: { tenantId: req.auth.tid, userId: req.auth.sub, readAt: null } }),
      ]);
      return { items, meta: pageMeta(q, total), unreadCount };
    });

    r.post('/notifications/:id/read', async (req) => {
      const { id } = req.params as { id: string };
      await prisma.notification.updateMany({ where: { id, tenantId: req.auth.tid, userId: req.auth.sub, readAt: null }, data: { readAt: new Date() } });
      return { ok: true };
    });

    r.post('/notifications/read-all', async (req) => {
      const res = await prisma.notification.updateMany({ where: { tenantId: req.auth.tid, userId: req.auth.sub, readAt: null }, data: { readAt: new Date() } });
      return { ok: true, count: res.count };
    });

    // ==================== 9.6 SEARCH ====================
    r.get('/search', async (req) => {
      const { q } = req.query as { q?: string };
      const hits = await searchAll(req.auth.tid, q ?? '');
      return { hits };
    });

    // ==================== 9.4 FILES ====================
    r.get('/files', async (req) => {
      const { refType, refId } = req.query as { refType?: string; refId?: string };
      const where = { tenantId: req.auth.tid, ...(refType ? { refType } : {}), ...(refId ? { refId } : {}) };
      const files = await prisma.attachment.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
      return { files };
    });

    // Upload via base64 JSON (no multipart dependency). Small/medium files only.
    r.post('/files', { bodyLimit: MAX_FILE_BYTES + 2 * 1024 * 1024 }, async (req, reply) => {
      const body = z.object({
        filename: z.string().min(1).max(200),
        mime: z.string().max(120).optional(),
        dataBase64: z.string().min(1),
        refType: z.string().max(60).optional(),
        refId: z.string().max(60).optional(),
      }).parse(req.body);
      const buf = Buffer.from(body.dataBase64, 'base64');
      if (buf.length === 0) throw BadRequest('Пустой файл', 'EMPTY_FILE');
      if (buf.length > MAX_FILE_BYTES) throw BadRequest('Файл больше 12 МБ', 'FILE_TOO_LARGE');

      const attachment = await prisma.$transaction(async (tx) => {
        const a = await tx.attachment.create({
          data: {
            tenantId: req.auth.tid, filename: body.filename, mime: body.mime ?? 'application/octet-stream',
            sizeBytes: buf.length, storageKey: 'pending', refType: body.refType ?? null, refId: body.refId ?? null, uploadedBy: req.auth.sub,
          },
        });
        const key = makeKey(req.auth.tid, a.id, body.filename);
        await putObject(key, buf);
        return tx.attachment.update({ where: { id: a.id }, data: { storageKey: key } });
      });
      return reply.code(201).send({ file: attachment });
    });

    r.get('/files/:id/download', async (req, reply) => {
      const { id } = req.params as { id: string };
      const a = await prisma.attachment.findFirst({ where: { id, tenantId: req.auth.tid } });
      if (!a) throw NotFound('Файл не найден');
      const buf = await getObject(a.storageKey);
      reply.header('Content-Type', a.mime);
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(a.filename)}"`);
      return reply.send(buf);
    });

    r.delete('/files/:id', async (req) => {
      const { id } = req.params as { id: string };
      const a = await prisma.attachment.findFirst({ where: { id, tenantId: req.auth.tid } });
      if (!a) throw NotFound('Файл не найден');
      await deleteObject(a.storageKey).catch(() => { /* already gone */ });
      await prisma.attachment.delete({ where: { id } });
      return { ok: true };
    });

    // ==================== 9.1 JOBS (admin view) ====================
    r.get('/jobs', { preHandler: [requirePermission('tenant.manage')] }, async (req) => {
      const { status } = req.query as { status?: string };
      const q = pageQuery.parse(req.query);
      const where = { AND: [{ OR: [{ tenantId: req.auth.tid }, { tenantId: null }] }, ...(status ? [{ status }] : [])] };
      const [items, total] = await prisma.$transaction([
        prisma.job.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(q) }),
        prisma.job.count({ where }),
      ]);
      const counts = await prisma.job.groupBy({ by: ['status'], where: { OR: [{ tenantId: req.auth.tid }, { tenantId: null }] }, _count: true });
      return { items, meta: pageMeta(q, total), counts };
    });

    r.post('/jobs/:id/retry', { preHandler: [requirePermission('tenant.manage')] }, async (req) => {
      const { id } = req.params as { id: string };
      const job = await prisma.job.findFirst({ where: { id, OR: [{ tenantId: req.auth.tid }, { tenantId: null }] } });
      if (!job) throw NotFound('Задача не найдена');
      if (job.status !== 'failed') throw BadRequest('Повтор возможен только для проваленных задач', 'NOT_FAILED');
      await prisma.job.update({ where: { id }, data: { status: 'queued', attempts: 0, runAt: new Date(), lastError: null } });
      return { ok: true };
    });

    // ==================== 9.7 TENDERS (parsed from public portals) ====================
    r.get('/tenders', { preHandler: [requirePermission('procurement.read')] }, async (req) => {
      const { source, q, status } = req.query as { source?: string; q?: string; status?: string };
      const page = pageQuery.parse(req.query);
      const where: Prisma.TenderWhereInput = {
        tenantId: req.auth.tid,
        ...(source ? { source } : {}),
        ...(status ? { status } : {}),
        ...(q ? { OR: [{ title: { contains: q, mode: 'insensitive' } }, { organization: { contains: q, mode: 'insensitive' } }] } : {}),
      };
      const [items, total, last] = await prisma.$transaction([
        prisma.tender.findMany({ where, orderBy: [{ deadline: 'asc' }], ...skipTake(page) }),
        prisma.tender.count({ where }),
        prisma.tender.findFirst({ where: { tenantId: req.auth.tid }, orderBy: { fetchedAt: 'desc' }, select: { fetchedAt: true } }),
      ]);
      const counts = await prisma.tender.groupBy({ by: ['source'], where: { tenantId: req.auth.tid }, _count: true });
      return { items, meta: pageMeta(page, total), sources: TENDER_SOURCES, counts, lastFetchedAt: last?.fetchedAt ?? null };
    });

    // Fetch live from all portals and upsert (runs inline for immediate feedback).
    r.post('/tenders/refresh', { preHandler: [requirePermission('procurement.read')] }, async (req) => {
      const result = await refreshTenders(req.auth.tid);
      return { ok: true, ...result };
    });
  });
}
