#!/usr/bin/env bash
# =============================================================================
#  TTR ONE — update all three apps from git + apply DB migrations.
#  Run after pushing changes:   sudo bash /var/www/api.erp.turgunovsardor.uz/deploy/update.sh
#  Re-installs npm deps only when package.json/lock changed; always applies
#  pending Prisma migrations; rebuilds the two static frontends.
# =============================================================================
set -euo pipefail

API=/var/www/api.erp.turgunovsardor.uz
ERP=/var/www/erp.turgunovsardor.uz
DOCS=/var/www/docs.erp.turgunovsardor.uz
API_BASE="https://api.erp.turgunovsardor.uz/api/v1"
say(){ printf "\n\033[1;36m▶ %s\033[0m\n" "$*"; }

# Pull origin/main into $1; run `npm ci` (fallback install) only if package files changed.
pull_and_install(){
  local dir="$1"
  cd "$dir"
  local before after
  before=$(git rev-parse HEAD)
  git fetch --depth 1 origin main
  git reset --hard origin/main
  after=$(git rev-parse HEAD)
  if git diff --name-only "$before" "$after" | grep -qE '^package(-lock)?\.json$'; then
    echo "  package files changed → installing deps"
    npm ci --no-audit --no-fund || { rm -rf node_modules; npm install --no-audit --no-fund; }
  else
    echo "  deps unchanged — skip npm install"
  fi
}

# ---- API: pull, migrate, restart ----
say "API — обновление, миграции, перезапуск"
pull_and_install "$API"
npx prisma migrate deploy
npx prisma generate
systemctl restart ttr-api
sleep 3
curl -sk -o /dev/null -w "  API /health → %{http_code}\n" "$API_BASE/health" || true

# ---- ERP frontend (static) ----
say "ERP — пересборка статики"
pull_and_install "$ERP"
NUXT_PUBLIC_API_BASE="$API_BASE" npx nuxi generate
chown -R www-data:www-data "$ERP/.output"

# ---- Docs (static) ----
say "Docs — пересборка статики"
pull_and_install "$DOCS"
npx nuxi generate
chown -R www-data:www-data "$DOCS/.output"

say "Готово. Обнови сайты в браузере с Ctrl+Shift+R."
