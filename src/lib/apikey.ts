// Developer API keys. The raw key is shown once; we persist only its SHA-256 hash.
import crypto from 'node:crypto';
import { PERMISSIONS } from './permissions.js';

export function hashApiKey(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function generateApiKey(): { raw: string; hash: string; prefix: string } {
  const raw = 'ttr_live_' + crypto.randomBytes(24).toString('base64url'); // ~41 chars total
  return { raw, hash: hashApiKey(raw), prefix: raw.slice(0, 16) };
}

// Resolve the permission set a key gets from its scope.
// read  → every "*.read" permission (safe, read-only integrations)
// full  → every permission (full programmatic access; use with care)
export function permsForScope(scope: string): string[] {
  const all = PERMISSIONS.map((p) => p.code);
  if (scope === 'full') return all;
  return all.filter((c) => c.endsWith('.read'));
}
