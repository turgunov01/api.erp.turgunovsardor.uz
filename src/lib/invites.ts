// Invitation tokens: opaque random, stored hashed, single-use, expiring.
import crypto from 'node:crypto';
import { prisma } from '../db.js';

const TTL_DAYS = 7;
const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

export async function createInvite(tenantId: string, email: string, roleCodes: string[], invitedBy: string): Promise<{ id: string; token: string }> {
  const raw = crypto.randomBytes(32).toString('base64url');
  const inv = await prisma.invitation.create({
    data: {
      tenantId, email, roleCodes: roleCodes.join(','), tokenHash: sha256(raw),
      invitedBy, expiresAt: new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000),
    },
  });
  return { id: inv.id, token: raw };
}

export async function findValidInvite(raw: string) {
  const inv = await prisma.invitation.findUnique({ where: { tokenHash: sha256(raw) } });
  if (!inv || inv.status !== 'pending' || inv.expiresAt < new Date()) return null;
  return inv;
}

export async function markInviteAccepted(id: string) {
  await prisma.invitation.update({ where: { id }, data: { status: 'accepted', acceptedAt: new Date() } });
}
