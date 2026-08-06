// Server bootstrap.
import 'dotenv/config';
import { buildApp } from './app.js';
import { config } from './config.js';
import { prisma } from './db.js';
import { ensurePg, stopPg } from './pg.js';
import { startJobWorker, stopJobWorker } from './lib/jobs.js';

async function main() {
  // Boot the local embedded Postgres for dev/test only. In production DATABASE_URL
  // points to an external Postgres, so skip the embedded server (unless explicitly forced).
  if (config.NODE_ENV !== 'production' || process.env.USE_EMBEDDED_PG === '1') {
    await ensurePg((m) => console.log('[pg]', m));
  }

  const app = await buildApp();

  // Start the background job worker (9.1) — polls the DB for due jobs.
  startJobWorker();

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down...`);
    stopJobWorker();
    await app.close();
    await prisma.$disconnect();
    await stopPg();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    app.log.info(`TTR ONE API + UI ready on http://localhost:${config.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
