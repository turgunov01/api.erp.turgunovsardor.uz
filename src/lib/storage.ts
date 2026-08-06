// 9.4 File storage abstraction. Local filesystem backend (no S3/Docker). Bytes are
// written under STORAGE_DIR; the DB Attachment row holds the metadata + storageKey.
// Swap this module's body for an S3 client to move to object storage — callers and
// the schema stay the same.
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.env.STORAGE_DIR || path.join(process.cwd(), '.storage');

// Build a safe, collision-free storage key. Never derived from raw user input beyond
// a sanitized filename suffix (for readability); the random id guarantees uniqueness.
export function makeKey(tenantId: string, id: string, filename: string): string {
  const safe = filename.replace(/[^\w.\-]+/g, '_').slice(-60);
  return `${tenantId}/${id}-${safe}`;
}

export async function putObject(key: string, data: Buffer): Promise<void> {
  const full = path.join(ROOT, key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, data);
}

export async function getObject(key: string): Promise<Buffer> {
  return fs.readFile(path.join(ROOT, key));
}

export async function deleteObject(key: string): Promise<void> {
  await fs.rm(path.join(ROOT, key), { force: true });
}
