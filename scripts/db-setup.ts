// One-command local database bootstrap: start embedded Postgres, apply
// migrations, generate client, seed. No Docker, no manual steps.
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { ensurePg, stopPg } from '../src/pg.js';

function run(cmd: string) {
  console.log(`\n$ ${cmd}`);
  const r = spawnSync(cmd, { stdio: 'inherit', shell: true, env: process.env });
  if (r.status !== 0) throw new Error(`Command failed: ${cmd}`);
}

async function main() {
  await ensurePg((m) => console.log('[db]', m));

  const hasMigrations = fs.existsSync('prisma/migrations');
  if (hasMigrations) {
    run('npx prisma migrate deploy');
  } else {
    run('npx prisma migrate dev --name init --skip-seed');
  }
  run('npx prisma generate');
  run('npx tsx prisma/seed.ts');

  await stopPg();
  console.log('\n✅ Local database ready (embedded PostgreSQL).');
  process.exit(0);
}

main().catch(async (e) => { console.error(e); await stopPg(); process.exit(1); });
