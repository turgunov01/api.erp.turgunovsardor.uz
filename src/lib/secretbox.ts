// Server-side secret encryption (AES-256-GCM) for at-rest storage of tenant API keys.
// The key is derived from a server secret (SECRET_KEY, else JWT_SECRET) — stored values
// are useless without it, and the plaintext key is never returned to clients.
import crypto from 'node:crypto';

const SECRET = process.env.SECRET_KEY || process.env.JWT_SECRET || 'ttr-one-dev-secret';
const KEY = crypto.scryptSync(SECRET, 'ttr-ai-secretbox', 32);

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptSecret(enc: string): string {
  const b = Buffer.from(enc, 'base64');
  const iv = b.subarray(0, 12), tag = b.subarray(12, 28), ct = b.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// Last-4 hint for a "key is set" UI, without exposing the secret.
export function maskHint(enc: string | null | undefined): string | null {
  if (!enc) return null;
  try { const p = decryptSecret(enc); return '••••' + p.slice(-4); } catch { return '••••'; }
}
