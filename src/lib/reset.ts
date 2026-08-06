// Password reset tokens: opaque random, stored hashed, single-use, expiring.
import crypto from 'node:crypto';
import { prisma } from '../db.js';

const TTL_MINUTES = 30;
const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

export async function createResetToken(userId: string): Promise<string> {
  const raw = crypto.randomBytes(32).toString('base64url');
  await prisma.passwordResetToken.create({
    data: { userId, tokenHash: sha256(raw), expiresAt: new Date(Date.now() + TTL_MINUTES * 60 * 1000) },
  });
  return raw;
}

// Returns userId if valid+unused+unexpired, and marks it used. Otherwise null.
export async function consumeResetToken(raw: string): Promise<string | null> {
  const rec = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(raw) } });
  if (!rec || rec.usedAt || rec.expiresAt < new Date()) return null;
  await prisma.passwordResetToken.update({ where: { id: rec.id }, data: { usedAt: new Date() } });
  return rec.userId;
}
