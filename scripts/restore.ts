// Stage 13.6 — restore a physical .pgdata backup created by scripts/backup.ts.
// Usage: npm run restore -- <backup-folder-name>   (e.g. pgdata-2026-07-21T10-30-00)
// The app/Postgres MUST be stopped first. The current .pgdata is moved aside, not deleted.
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

async function main() {
  const name = process.argv[2];
  if (!name) {
    const list = fs.existsSync(OUT) ? fs.readdirSync(OUT).filter((d) => d.startsWith('pgdata-')) : [];
    console.error('Укажите бэкап: npm run restore -- <папка>');
    if (list.length) console.error('Доступны:\n  ' + list.join('\n  '));
    process.exit(1);
  }
  const src = path.join(OUT, name);
  if (!fs.existsSync(src)) { console.error(`Бэкап не найден: ${src}`); process.exit(1); }
  if (await isPgRunning()) { console.error('⚠ Postgres запущен на :5433 — остановите приложение перед восстановлением.'); process.exit(1); }

  if (fs.existsSync(DATA)) {
    const aside = `${DATA}.old-${Date.now()}`;
    fs.renameSync(DATA, aside);
    console.log(`Текущая .pgdata отложена в ${path.basename(aside)}`);
  }
  console.log(`Восстанавливаю ${name} → .pgdata …`);
  fs.cpSync(src, DATA, { recursive: true });
  console.log('✅ Восстановлено. Запустите приложение: npm run dev');
}
main().catch((e) => { console.error(e); process.exit(1); });
