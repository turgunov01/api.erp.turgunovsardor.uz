// Developer API keys management (tenant.manage). Keys authenticate third-party apps
// against the same REST API — see plugins/auth.ts for how a key is accepted.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { requirePermission } from '../../plugins/rbac.js';
import { audit } from '../../lib/audit.js';
import { NotFound } from '../../lib/errors.js';
import { generateApiKey, permsForScope } from '../../lib/apikey.js';

export default async function apiKeyRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  // List keys (never returns the secret — only prefix + metadata).
  app.get('/', { preHandler: [requirePermission('tenant.manage')] }, async (req) => {
    const keys = await prisma.apiKey.findMany({
      where: { tenantId: req.auth.tid },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, prefix: true, scope: true, lastUsedAt: true, revokedAt: true, createdAt: true },
    });
    return { keys };
  });

  // Create a key — the RAW secret is returned ONCE and never stored in clear.
  app.post('/', { preHandler: [requirePermission('tenant.manage')] }, async (req, reply) => {
    const body = z.object({
      name: z.string().min(1).max(80),
      scope: z.enum(['read', 'full']).default('read'),
    }).parse(req.body);
    const { raw, hash, prefix } = generateApiKey();
    const key = await prisma.apiKey.create({
      data: {
        tenantId: req.auth.tid, name: body.name, prefix, hash, scope: body.scope,
        perms: JSON.stringify(permsForScope(body.scope)), createdBy: req.auth.sub,
      },
      select: { id: true, name: true, prefix: true, scope: true, createdAt: true },
    });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'apikey.create', entity: 'ApiKey', entityId: key.id, meta: { name: body.name, scope: body.scope }, ip: req.ip });
    // `key` (raw) is the only time the secret is exposed.
    return reply.code(201).send({ key, secret: raw });
  });

  // Revoke a key (soft — keeps it in the list, marked revoked).
  app.delete('/:id', { preHandler: [requirePermission('tenant.manage')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const key = await prisma.apiKey.findFirst({ where: { id, tenantId: req.auth.tid } });
    if (!key) throw NotFound('Ключ не найден');
    await prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    await audit({ tenantId: req.auth.tid, userId: req.auth.sub, action: 'apikey.revoke', entity: 'ApiKey', entityId: id, ip: req.ip });
    return reply.send({ ok: true });
  });
}
