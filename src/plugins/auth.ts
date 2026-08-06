// Auth plugin: registers JWT + `authenticate` preHandler that populates request.auth.
import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { Unauthorized } from '../lib/errors.js';
import type { AccessClaims } from '../lib/tokens.js';
import { prisma } from '../db.js';
import { hashApiKey } from '../lib/apikey.js';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    auth: AccessClaims;
  }
}

export default fp(async (app) => {
  app.register(fastifyJwt, {
    secret: config.JWT_SECRET,
    sign: { expiresIn: config.ACCESS_TOKEN_TTL },
  });

  app.decorate('authenticate', async (req: FastifyRequest, _reply: FastifyReply) => {
    // Developer API key: presented via `X-API-Key` or `Authorization: Bearer ttr_...`.
    // Keys start with "ttr_" so they never collide with JWTs; resolve to a synthetic auth.
    const headerKey = (req.headers['x-api-key'] as string | undefined) ?? '';
    const authz = (req.headers['authorization'] as string | undefined) ?? '';
    const bearer = authz.startsWith('Bearer ') ? authz.slice(7).trim() : '';
    const presented = headerKey.startsWith('ttr_') ? headerKey : bearer.startsWith('ttr_') ? bearer : '';
    if (presented) {
      const key = await prisma.apiKey.findFirst({ where: { hash: hashApiKey(presented), revokedAt: null } });
      if (!key) throw Unauthorized('Invalid or revoked API key');
      let perms: string[] = [];
      try { perms = JSON.parse(key.perms) as string[]; } catch { perms = []; }
      req.auth = { sub: key.createdBy ?? `apikey:${key.id}`, tid: key.tenantId, email: 'api-key', name: key.name, perms, roles: [], admin: false };
      // Best-effort last-used stamp (don't block the request on it).
      void prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
      return;
    }
    try {
      const payload = await req.jwtVerify<AccessClaims & { kind?: string }>();
      // Customer-portal tokens (kind:"customer") are a separate auth realm and must never
      // be accepted on internal endpoints, even though they share the signing secret.
      if (payload.kind === 'customer') throw new Error('wrong realm');
      req.auth = payload;
    } catch {
      throw Unauthorized('Invalid or expired access token');
    }
  });
});
