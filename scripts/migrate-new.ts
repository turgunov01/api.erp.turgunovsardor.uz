// One-off: boot embedded Postgres, create+apply a new migration, regenerate client.
// Usage: tsx scripts/migrate-new.ts <migration_name>
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { ensurePg, stopPg } from '../src/pg.js';

function run(cmd: string) {
  console.log(`\n$ ${cmd}`);
  const r = spawnSync(cmd, { stdio: 'inherit', shell: true, env: process.env });
  if (r.status !== 0) throw new Error(`Command failed: ${cmd}`);
}

async function main() {
  const name = process.argv[2] || 'change';
  await ensurePg((m) => console.log('[db]', m));
  run(`npx prisma migrate dev --name ${name} --skip-seed`);
  run('npx prisma generate');
  await stopPg();
  console.log('\n✅ Migration created + applied.');
  process.exit(0);
}

main().catch(async (e) => { console.error(e); await stopPg(); process.exit(1); });
