// RBAC guard factory: returns a preHandler that requires a permission code.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Forbidden } from '../lib/errors.js';

export function requirePermission(code: string) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const perms = req.auth?.perms ?? [];
    if (!perms.includes(code)) {
      throw Forbidden(`Missing permission: ${code}`, 'MISSING_PERMISSION');
    }
  };
}

export async function requirePlatformAdmin(req: FastifyRequest, _reply: FastifyReply) {
  if (!req.auth?.admin) throw Forbidden('Platform admin only', 'NOT_PLATFORM_ADMIN');
}
