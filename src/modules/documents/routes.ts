// 9.5 Document flow: templates with {{placeholders}}, versioned documents and a
// sequential approval/signature chain. Gated by the `documents` module.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { requirePermission } from '../../plugins/rbac.js';
import { blockIfInactiveWrite } from '../../plugins/subscription.js';
import { audit } from '../../lib/audit.js';
import { NotFound, BadRequest } from '../../lib/errors.js';
import { pageQuery, skipTake, pageMeta } from '../../lib/pagination.js';
import { nextDocNumber } from '../../lib/ledger.js';
import { notify } from '../../lib/notify.js';
import { docxToHtml } from '../../lib/docx.js';
import { sanitizeHtml } from '../../lib/sanitize.js';

// Fill {{key}} placeholders from a fields map (missing keys are left blank).
function render(body: string, fields: Record<string, string> = {}): string {
  return body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k: string) => (fields[k] ?? ''));
}

export default async function documentsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', blockIfInactiveWrite);

  // ==================== TEMPLATES ====================
  app.get('/templates', { preHandler: [requirePermission('documents.read')] }, async (req) => {
    const templates = await prisma.docTemplate.findMany({ where: { tenantId: req.auth.tid }, orderBy: { name: 'asc' } });
    return { templates };
  });

  app.post('/templates', { preHandler: [requirePermission('documents.write')] }, async (req, reply) => {
    const body = z.object({
      code: z.string().min(1).max(40),
      name: z.string().min(1).max(120),
      kind: z.enum(['contract', 'invoice', 'act', 'order', 'generic']).default('generic'),
      body: z.string().min(1),
    }).parse(req.body);
    const template = await prisma.docTemplate.create({ data: { tenantId: req.auth.tid, code: body.code, name: body.name, kind: body.kind, body: body.body } });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'documents.template.create', entity: 'DocTemplate', entityId: template.id, meta: { code: body.code }, ip: req.ip });
    return reply.code(201).send({ template });
  });

  app.patch('/templates/:id', { preHandler: [requirePermission('documents.write')] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ name: z.string().min(1).optional(), body: z.string().min(1).optional(), kind: z.enum(['contract', 'invoice', 'act', 'order', 'generic']).optional() }).parse(req.body);
    const t = await prisma.docTemplate.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!t) throw NotFound('Шаблон не найден');
    const template = await prisma.docTemplate.update({ where: { id }, data: body });
    return { template };
  });

  app.delete('/templates/:id', { preHandler: [requirePermission('documents.write')] }, async (req) => {
    const { id } = req.params as { id: string };
    const t = await prisma.docTemplate.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!t) throw NotFound('Шаблон не найден');
    if (t.isSystem) throw BadRequest('Системный шаблон нельзя удалить', 'SYSTEM_TEMPLATE');
    await prisma.docTemplate.delete({ where: { id } });
    return { ok: true };
  });

  // Convert an uploaded Word file (.docx, base64) to editable HTML — dependency-free.
  app.post('/import-docx', { preHandler: [requirePermission('documents.write')], bodyLimit: 15 * 1024 * 1024 }, async (req) => {
    const body = z.object({ dataBase64: z.string().min(1), filename: z.string().optional() }).parse(req.body);
    const buf = Buffer.from(body.dataBase64, 'base64');
    let html: string;
    try { html = docxToHtml(buf); }
    catch (e) { throw BadRequest((e as Error).message || 'Не удалось разобрать .docx', 'DOCX_PARSE'); }
    const title = (body.filename || '').replace(/\.docx?$/i, '');
    return { html: sanitizeHtml(html), title };
  });

  // ==================== DOCUMENTS ====================
  app.get('/documents', { preHandler: [requirePermission('documents.read')] }, async (req) => {
    const { status } = req.query as { status?: string };
    const q = pageQuery.parse(req.query);
    const where = { tenantId: req.auth.tid, ...(status ? { status } : {}) };
    const [items, total] = await prisma.$transaction([
      prisma.document.findMany({ where, orderBy: { createdAt: 'desc' }, include: { _count: { select: { approvals: true, versions: true } } }, ...skipTake(q) }),
      prisma.document.count({ where }),
    ]);
    return { items, meta: pageMeta(q, total) };
  });

  app.get('/documents/:id', { preHandler: [requirePermission('documents.read')] }, async (req) => {
    const { id } = req.params as { id: string };
    const doc = await prisma.document.findFirst({
      where: { id, tenantId: req.auth.tid },
      include: { versions: { orderBy: { version: 'desc' } }, approvals: { orderBy: { seq: 'asc' } }, template: { select: { name: true, code: true } } },
    });
    if (!doc) throw NotFound('Документ не найден');
    // Attach approver names + attachments for convenience.
    const approverIds = doc.approvals.map((a) => a.approverId);
    const users = approverIds.length ? await prisma.user.findMany({ where: { id: { in: approverIds } }, select: { id: true, fullName: true } }) : [];
    const nameById = new Map(users.map((u) => [u.id, u.fullName]));
    const approvals = doc.approvals.map((a) => ({ ...a, approverName: nameById.get(a.approverId) ?? a.approverId }));
    const attachments = await prisma.attachment.findMany({ where: { tenantId: req.auth.tid, refType: 'Document', refId: doc.id }, orderBy: { createdAt: 'desc' } });
    return { document: { ...doc, approvals }, attachments };
  });

  // Create a document — from a template (with field values) or free-form body.
  app.post('/documents', { preHandler: [requirePermission('documents.write')] }, async (req, reply) => {
    const body = z.object({
      title: z.string().min(1).max(200),
      kind: z.enum(['contract', 'invoice', 'act', 'order', 'generic']).default('generic'),
      templateId: z.string().optional(),
      body: z.string().optional(),
      fields: z.record(z.string(), z.string()).optional(),
      refType: z.string().max(60).optional(),
      refId: z.string().max(60).optional(),
    }).parse(req.body);

    let content = body.body ?? '';
    let kind = body.kind;
    if (body.templateId) {
      const tpl = await prisma.docTemplate.findFirst({ where: { id: body.templateId, tenantId: req.auth.tid } });
      if (!tpl) throw NotFound('Шаблон не найден');
      content = render(tpl.body, body.fields ?? {});
      kind = tpl.kind as typeof kind;
    }
    content = sanitizeHtml(content);
    if (!content.trim()) throw BadRequest('Тело документа пустое', 'EMPTY_BODY');

    const doc = await prisma.$transaction(async (tx) => {
      const number = await nextDocNumber(tx, req.auth.tid, 'document', 'DOC');
      const created = await tx.document.create({
        data: {
          tenantId: req.auth.tid, number, templateId: body.templateId ?? null, title: body.title, kind,
          status: 'draft', currentVersion: 1, refType: body.refType ?? null, refId: body.refId ?? null, createdBy: req.auth.sub,
        },
      });
      await tx.documentVersion.create({ data: { documentId: created.id, version: 1, body: content, createdBy: req.auth.sub } });
      return created;
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'documents.create', entity: 'Document', entityId: doc.id, meta: { number: doc.number }, ip: req.ip });
    return reply.code(201).send({ document: doc });
  });

  // New version (draft/rejected only) — supersedes the current body.
  app.post('/documents/:id/version', { preHandler: [requirePermission('documents.write')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ body: z.string().min(1), note: z.string().optional() }).parse(req.body);
    const doc = await prisma.document.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!doc) throw NotFound('Документ не найден');
    if (!['draft', 'rejected'].includes(doc.status)) throw BadRequest('Новую версию можно добавить только в черновике или после отклонения', 'BAD_STATUS');
    const version = doc.currentVersion + 1;
    const clean = sanitizeHtml(body.body);
    await prisma.$transaction([
      prisma.documentVersion.create({ data: { documentId: doc.id, version, body: clean, note: body.note ?? null, createdBy: req.auth.sub } }),
      prisma.document.update({ where: { id: doc.id }, data: { currentVersion: version, status: 'draft' } }),
    ]);
    return reply.code(201).send({ version });
  });

  // Submit for approval — build a sequential approver chain and notify the first.
  app.post('/documents/:id/submit', { preHandler: [requirePermission('documents.write')] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ approverIds: z.array(z.string()).min(1) }).parse(req.body);
    const doc = await prisma.document.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!doc) throw NotFound('Документ не найден');
    if (!['draft', 'rejected'].includes(doc.status)) throw BadRequest('На согласование можно отправить только черновик', 'BAD_STATUS');
    const approvers = await prisma.user.findMany({ where: { id: { in: body.approverIds }, tenantId: req.auth.tid, status: 'active' } });
    if (approvers.length !== body.approverIds.length) throw BadRequest('Некоторые согласующие не найдены', 'BAD_APPROVERS');

    await prisma.$transaction(async (tx) => {
      await tx.documentApproval.deleteMany({ where: { documentId: doc.id } }); // reset any prior chain
      await tx.documentApproval.createMany({ data: body.approverIds.map((approverId, i) => ({ documentId: doc.id, seq: i + 1, approverId, status: 'pending' })) });
      await tx.document.update({ where: { id: doc.id }, data: { status: 'pending' } });
    });
    const first = approvers.find((u) => u.id === body.approverIds[0])!;
    await notify({ tenantId: req.auth.tid, userId: first.id, email: first.email, type: 'info', title: 'Документ на согласование', body: `${doc.number} — ${doc.title}`, refType: 'Document', refId: doc.id });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'documents.submit', entity: 'Document', entityId: doc.id, meta: { approvers: body.approverIds.length }, ip: req.ip });
    return { ok: true, status: 'pending' };
  });

  // Approve the caller's active slot (sign). Advances to the next approver or finalizes.
  app.post('/documents/:id/approve', { preHandler: [requirePermission('documents.approve')] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ comment: z.string().optional() }).parse(req.body ?? {});
    const doc = await prisma.document.findFirst({ where: { id, tenantId: req.auth.tid }, include: { approvals: { orderBy: { seq: 'asc' } } } });
    if (!doc) throw NotFound('Документ не найден');
    if (doc.status !== 'pending') throw BadRequest('Документ не на согласовании', 'NOT_PENDING');
    const active = doc.approvals.find((a) => a.status === 'pending');
    if (!active) throw BadRequest('Нет активного шага согласования', 'NO_ACTIVE_STEP');
    if (active.approverId !== req.auth.sub) throw BadRequest('Сейчас согласует другой сотрудник', 'NOT_YOUR_TURN');

    await prisma.documentApproval.update({ where: { id: active.id }, data: { status: 'approved', comment: body.comment ?? null, actedAt: new Date() } });
    const next = doc.approvals.find((a) => a.seq > active.seq && a.status === 'pending');
    if (next) {
      const u = await prisma.user.findUnique({ where: { id: next.approverId }, select: { email: true } });
      await notify({ tenantId: req.auth.tid, userId: next.approverId, email: u?.email, type: 'info', title: 'Документ на согласование', body: `${doc.number} — ${doc.title}`, refType: 'Document', refId: doc.id });
    } else {
      await prisma.document.update({ where: { id: doc.id }, data: { status: 'approved' } });
      if (doc.createdBy) await notify({ tenantId: req.auth.tid, userId: doc.createdBy, type: 'success', title: 'Документ согласован', body: `${doc.number} — ${doc.title}`, refType: 'Document', refId: doc.id });
    }
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'documents.approve', entity: 'Document', entityId: doc.id, meta: { seq: active.seq }, ip: req.ip });
    return { ok: true, finalized: !next };
  });

  app.post('/documents/:id/reject', { preHandler: [requirePermission('documents.approve')] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ comment: z.string().min(1, 'Укажите причину') }).parse(req.body);
    const doc = await prisma.document.findFirst({ where: { id, tenantId: req.auth.tid }, include: { approvals: { orderBy: { seq: 'asc' } } } });
    if (!doc) throw NotFound('Документ не найден');
    if (doc.status !== 'pending') throw BadRequest('Документ не на согласовании', 'NOT_PENDING');
    const active = doc.approvals.find((a) => a.status === 'pending');
    if (!active || active.approverId !== req.auth.sub) throw BadRequest('Сейчас согласует другой сотрудник', 'NOT_YOUR_TURN');
    await prisma.$transaction([
      prisma.documentApproval.update({ where: { id: active.id }, data: { status: 'rejected', comment: body.comment, actedAt: new Date() } }),
      prisma.document.update({ where: { id: doc.id }, data: { status: 'rejected' } }),
    ]);
    if (doc.createdBy) await notify({ tenantId: req.auth.tid, userId: doc.createdBy, type: 'error', title: 'Документ отклонён', body: `${doc.number} — ${body.comment}`, refType: 'Document', refId: doc.id });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'documents.reject', entity: 'Document', entityId: doc.id, meta: { seq: active.seq }, ip: req.ip });
    return { ok: true };
  });

  app.post('/documents/:id/cancel', { preHandler: [requirePermission('documents.write')] }, async (req) => {
    const { id } = req.params as { id: string };
    const doc = await prisma.document.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!doc) throw NotFound('Документ не найден');
    if (['approved', 'cancelled'].includes(doc.status)) throw BadRequest('Документ уже завершён', 'BAD_STATUS');
    await prisma.document.update({ where: { id }, data: { status: 'cancelled' } });
    return { ok: true };
  });
}
