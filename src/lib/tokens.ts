// Refresh-token service: opaque random tokens, stored hashed, rotated on use.
import crypto from 'node:crypto';
import { prisma } from '../db.js';
import { config } from '../config.js';

function sha256(v: string): string {
  return crypto.createHash('sha256').update(v).digest('hex');
}

export interface AccessClaims {
  sub: string; // userId
  tid: string; // tenantId
  email: string;
  name: string;
  perms: string[];
  roles: string[];
  admin: boolean; // platform-level super admin
}

export async function issueRefreshToken(userId: string, ua?: string, ip?: string): Promise<string> {
  const raw = crypto.randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  await prisma.refreshToken.create({
    data: { userId, tokenHash: sha256(raw), expiresAt, userAgent: ua ?? null, ip: ip ?? null },
  });
  return raw;
}

// Validate + rotate: returns userId or null. Old token is revoked; a fresh one is issued by caller.
export async function consumeRefreshToken(raw: string): Promise<string | null> {
  const rec = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(raw) } });
  if (!rec || rec.revokedAt || rec.expiresAt < new Date()) return null;
  await prisma.refreshToken.update({ where: { id: rec.id }, data: { revokedAt: new Date() } });
  return rec.userId;
}

export async function revokeAllForUser(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
