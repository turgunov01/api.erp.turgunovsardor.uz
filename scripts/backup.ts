// Stage 13.6 — physical backup of the local embedded Postgres cluster (.pgdata).
// The bundled embedded-postgres has no pg_dump, so we snapshot the data directory.
// For a CONSISTENT backup the app/DB should be stopped first (cold backup); in
// production (external Postgres) use `pg_dump -Fc` instead — see deploy/DEPLOYMENT.md.
import 'dotenv/config';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const DATA = path.join(process.cwd(), '.pgdata');
const OUT = path.join(process.cwd(), 'backups');

function isPgRunning(port = 5433): Promise<boolean> {
  return new Promise((res) => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    s.on('connect', () => { s.destroy(); res(true); });
    s.on('error', () => res(false));
    setTimeout(() => { s.destroy(); res(false); }, 800);
  });
}
function dirSizeMb(dir: string): number {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSizeMb(p) * 1024 * 1024;
    else try { total += fs.statSync(p).size; } catch { /* ignore */ }
  }
  return total / 1024 / 1024;
}

async function main() {
  if (!fs.existsSync(DATA)) { console.error('Нет .pgdata — база ещё не инициализирована.'); process.exit(1); }
  if (await isPgRunning()) {
    console.warn('⚠ Postgres запущен на :5433. Для консистентного бэкапа остановите приложение (Ctrl+C) и повторите.');
    console.warn('  Продолжаю горячее копирование (для dev обычно восстановимо)…');
  }
  fs.mkdirSync(OUT, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = path.join(OUT, `pgdata-${stamp}`);
  console.log(`Копирую .pgdata → ${dest} …`);
  fs.cpSync(DATA, dest, { recursive: true });
  const mb = dirSizeMb(dest).toFixed(1);
  console.log(`✅ Бэкап готов: ${dest} (${mb} МБ)`);
  console.log('   Восстановить: npm run restore -- ' + path.basename(dest));
}
main().catch((e) => { console.error(e); process.exit(1); });
