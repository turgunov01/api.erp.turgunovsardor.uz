// Self-contained test bootstrap: ensure local Postgres, seed known data,
// then run the node:test suite via tsx. No external services required.
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { ensurePg, stopPg } from '../src/pg.js';

// Test-mode env: quiet logger + effectively disable auth rate limiting.
process.env.NODE_ENV = 'test';
process.env.AUTH_RATE_MAX = '100000';

function run(cmd: string): boolean {
  console.log(`\n$ ${cmd}`);
  const r = spawnSync(cmd, { stdio: 'inherit', shell: true, env: process.env });
  return r.status === 0;
}

async function main() {
  await ensurePg((m) => console.log('[pg]', m));
  let ok = run('npx tsx prisma/seed.ts'); // restore known credentials/data
  // Serialize files: the integration suite shares one demo tenant's mutable stock &
  // ledger, so parallel files race on quantities/VAT. Determinism > a few seconds.
  if (ok) ok = run('npx tsx --test --test-concurrency=1 test/auth.test.ts test/warehouse.test.ts test/billing.test.ts test/security.test.ts test/sales.test.ts test/production.test.ts test/inventory.test.ts test/finance.test.ts test/finance-tax.test.ts test/platform.test.ts test/documents.test.ts test/analytics.test.ts test/studio.test.ts test/hr.test.ts test/pos.test.ts test/projects.test.ts test/logistics.test.ts test/production-depth.test.ts test/mrp.test.ts test/portal-customer.test.ts test/isolation.test.ts test/onboarding.test.ts');
  await stopPg();
  process.exit(ok ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await stopPg(); process.exit(1); });
