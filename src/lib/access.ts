// Resolve a user's roles + permission codes for embedding into the access token.
import { prisma } from '../db.js';
import type { AccessClaims } from './tokens.js';

export async function buildClaims(userId: string): Promise<AccessClaims | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      roles: {
        include: {
          role: { include: { permissions: { include: { permission: true } } } },
        },
      },
    },
  });
  if (!user || user.status !== 'active') return null;

  const roles = user.roles.map((ur) => ur.role.code);
  const perms = new Set<string>();
  for (const ur of user.roles) {
    for (const rp of ur.role.permissions) perms.add(rp.permission.code);
  }

  return {
    sub: user.id,
    tid: user.tenantId,
    email: user.email,
    name: user.fullName,
    perms: [...perms],
    roles,
    admin: user.platformAdmin,
  };
}
