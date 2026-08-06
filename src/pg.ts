// Local embedded PostgreSQL manager — no Docker, no manual install.
// The app boots its own Postgres server (data persisted in ./.pgdata) and
// reuses an already-running instance if one is detected on the port.
import EmbeddedPostgres from 'embedded-postgres';
import net from 'node:net';
import fs from 'node:fs';
import { join } from 'node:path';

export const PG = {
  port: Number(process.env.PG_PORT ?? 5433),
  dataDir: process.env.PG_DATA_DIR ?? '.pgdata',
  db: process.env.PG_DB ?? 'ttr_one',
  user: process.env.PG_USER ?? 'postgres',
  password: process.env.PG_PASSWORD ?? 'postgres',
};

function tcpOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (v: boolean) => { sock.destroy(); resolve(v); };
    sock.once('connect', () => done(true));
    sock.once('error', () => resolve(false));
    sock.setTimeout(1000, () => done(false));
  });
}

let instance: EmbeddedPostgres | null = null;

// Ensure a local Postgres is running + the app database exists. Idempotent.
export async function ensurePg(log: (m: string) => void = () => {}): Promise<void> {
  if (await tcpOpen(PG.port)) { log(`Postgres already running on :${PG.port} — reusing`); return; }

  const pg = new EmbeddedPostgres({
    databaseDir: PG.dataDir,
    port: PG.port,
    user: PG.user,
    password: PG.password,
    authMethod: 'password',
    persistent: true,
    // Fresh installs get UTF8 (ignored if the cluster already exists). Older dev
    // clusters may be WIN1251 — recreate .pgdata to switch a running one.
    initdbFlags: ['--encoding=UTF8', '--no-locale'],
    onLog: () => {},
    onError: (e) => {
      // Ignore benign connection resets that occur while the server shuts down.
      const msg = String((e as { code?: string; message?: string })?.code ?? (e as Error)?.message ?? e);
      if (msg.includes('ECONNRESET') || msg.includes('Connection terminated')) return;
      console.error('[pg]', e);
    },
  });

  if (!fs.existsSync(join(PG.dataDir, 'PG_VERSION'))) {
    log('Initialising local Postgres data directory (first run)…');
    await pg.initialise();
  }
  log(`Starting local Postgres on :${PG.port}…`);
  await pg.start();
  try { await pg.createDatabase(PG.db); log(`Created database "${PG.db}"`); }
  catch { /* database already exists */ }
  instance = pg;
}

export async function stopPg(): Promise<void> {
  if (instance) { await instance.stop(); instance = null; }
}
