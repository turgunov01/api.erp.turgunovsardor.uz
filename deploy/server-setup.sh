#!/usr/bin/env bash
# =============================================================================
#  TTR ONE — one-shot production bootstrap for a fresh Ubuntu/Debian VPS.
#
#  Deploys three hosts behind nginx + Let's Encrypt TLS:
#    erp.turgunovsardor.uz       → Nuxt SPA (static)      /var/www/erp
#    api.erp.turgunovsardor.uz   → Node/Fastify API :9990 (systemd: ttr-api)
#    docs.erp.turgunovsardor.uz  → Nuxt Content (static)  /var/www/docs
#
#  Idempotent-ish: safe to re-run. Secrets are generated ON THIS SERVER and
#  never leave it. Run as root:   bash server-setup.sh
#
#  PREREQUISITES: DNS A-records for all three hosts already point here (they do).
# =============================================================================
set -euo pipefail

# ---- config ----------------------------------------------------------------
LE_EMAIL="sardorceeksamurai@gmail.com"          # Let's Encrypt expiry notices
ERP_HOST="erp.turgunovsardor.uz"
API_HOST="api.erp.turgunovsardor.uz"
DOCS_HOST="docs.erp.turgunovsardor.uz"

REPO_API="https://github.com/turgunov01/api.erp.turgunovsardor.uz.git"
REPO_ERP="https://github.com/turgunov01/erp.turgunovsardor.uz.git"
REPO_DOCS="https://github.com/turgunov01/docs.erp.turgunovsardor.uz.git"

WWW=/var/www
API_DIR="$WWW/$API_HOST"     # /var/www/api.erp.turgunovsardor.uz
ERP_DIR="$WWW/$ERP_HOST"     # /var/www/erp.turgunovsardor.uz
DOCS_DIR="$WWW/$DOCS_HOST"   # /var/www/docs.erp.turgunovsardor.uz
PGDB=ttr_one
PGUSER=ttr
say(){ printf "\n\033[1;36m▶ %s\033[0m\n" "$*"; }
# Prefer reproducible `npm ci`, but fall back to `npm install` if a lockfile generated on
# another OS trips EBADPLATFORM on a platform-specific optional binary (sharp, etc.).
npm_install(){ npm ci --no-audit --no-fund || { echo "  npm ci failed — falling back to npm install"; rm -rf node_modules; npm install --no-audit --no-fund; }; }

# ---- 1. base packages ------------------------------------------------------
say "Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ufw nginx postgresql postgresql-contrib \
    certbot python3-certbot-nginx ca-certificates gnupg openssl \
    build-essential python3 pkg-config   # build-essential: native modules (better-sqlite3)

# ---- 2. Node.js 22 (Nuxt 4 / undici / oxc require >=22) --------------------
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 22 ]; then
  say "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

# ---- 3. PostgreSQL role + database ----------------------------------------
say "Provisioning PostgreSQL ($PGDB / $PGUSER)"
systemctl enable --now postgresql
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$PGUSER'" | grep -q 1; then
  PGPASS="$(openssl rand -hex 24)"
  sudo -u postgres psql -c "CREATE ROLE $PGUSER LOGIN PASSWORD '$PGPASS';"
  sudo -u postgres psql -c "CREATE DATABASE $PGDB OWNER $PGUSER;"
  echo "$PGPASS" > /root/.ttr_pgpass && chmod 600 /root/.ttr_pgpass
  echo "  (db password saved to /root/.ttr_pgpass)"
else
  PGPASS="$(cat /root/.ttr_pgpass)"
  echo "  role exists — reusing saved password"
fi
DATABASE_URL="postgresql://$PGUSER:$PGPASS@127.0.0.1:5432/$PGDB?schema=public"

# ---- 4. clone / update repos ----------------------------------------------
say "Fetching source"
mkdir -p "$WWW"
# Robust for shallow clones: fetch + hard-reset to origin/main (untracked .env/.seeded survive).
clone_or_pull(){
  if [ -d "$2/.git" ]; then
    git -C "$2" fetch --depth 1 origin main && git -C "$2" reset --hard origin/main
  else
    git clone --depth 1 "$1" "$2"
  fi
}
clone_or_pull "$REPO_API"  "$API_DIR"
clone_or_pull "$REPO_ERP"  "$ERP_DIR"
clone_or_pull "$REPO_DOCS" "$DOCS_DIR"

# ---- 5. API: env, deps, migrate, seed, systemd ----------------------------
say "Building API"
cd "$API_DIR"
if [ ! -f .env ]; then
  cat > .env <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=9990
DATABASE_URL=$DATABASE_URL
JWT_SECRET=$(openssl rand -hex 32)
SECRET_KEY=$(openssl rand -hex 32)
CORS_ORIGINS=https://$ERP_HOST
APP_URL=https://$ERP_HOST
# Optional integrations — fill in later if needed:
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
AI_MODEL=
SMTP_URL=
TELEGRAM_BOT_TOKEN=
EOF
  chmod 600 .env
  echo "  wrote $API_DIR/.env (secrets generated locally)"
fi
# Self-heal: :3000 is taken by another app on this host, so pin our API to :9990
# (matches proxy_pass in the api nginx config). Applies to pre-existing .env too.
sed -i 's/^PORT=.*/PORT=9990/' .env
npm_install
npx prisma generate
npx prisma migrate deploy
# First run only: seed demo data + admin so the app is testable.
# For a real client start empty instead:  npx tsx scripts/reset-for-client.ts
if [ ! -f .seeded ]; then npm run db:seed && touch .seeded; fi

cat > /etc/systemd/system/ttr-api.service <<EOF
[Unit]
Description=TTR ONE API
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
WorkingDirectory=$API_DIR
EnvironmentFile=$API_DIR/.env
ExecStart=/usr/bin/npx tsx src/server.ts
Restart=always
RestartSec=3
# hardening
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now ttr-api
systemctl restart ttr-api

# ---- 6. Frontends: static builds ------------------------------------------
say "Building ERP frontend (static SPA)"
cd "$ERP_DIR"
npm_install
NUXT_PUBLIC_API_BASE="https://$API_HOST/api/v1" npx nuxi generate
# nginx serves $ERP_DIR/.output/public directly (see erp site config).

say "Building docs site (static)"
cd "$DOCS_DIR"
npm_install
npx nuxi generate
# nginx serves $DOCS_DIR/.output/public directly (see docs site config).

# nginx (www-data) must be able to traverse the dirs and read the built output.
chmod 755 "$ERP_DIR" "$DOCS_DIR"
chown -R www-data:www-data "$ERP_DIR/.output" "$DOCS_DIR/.output"

# ---- 7. nginx: shared snippets + rate-limit + upgrade map -----------------
say "Installing nginx config"
mkdir -p /etc/nginx/snippets /var/www/certbot
cp "$API_DIR/deploy/nginx/snippets/"*.conf /etc/nginx/snippets/
cp "$API_DIR/deploy/nginx/conf.d/"*.conf   /etc/nginx/conf.d/

# Phase A — HTTP-only bootstrap so certbot can solve the ACME challenge.
cat > /etc/nginx/sites-available/ttr-bootstrap.conf <<EOF
server {
    listen 80;
    server_name $ERP_HOST $API_HOST $DOCS_HOST;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 200 'ttr bootstrap'; }
}
EOF
ln -sf /etc/nginx/sites-available/ttr-bootstrap.conf /etc/nginx/sites-enabled/ttr-bootstrap.conf
rm -f /etc/nginx/sites-enabled/default
# Drop any stale TTR site symlinks from a previous (failed) run so this test can't trip on them.
rm -f "/etc/nginx/sites-enabled/$ERP_HOST.conf" "/etc/nginx/sites-enabled/$API_HOST.conf" "/etc/nginx/sites-enabled/$DOCS_HOST.conf"
nginx -t && systemctl reload nginx

# ---- 8. certificates -------------------------------------------------------
say "Obtaining Let's Encrypt certificates"
# ONE multi-SAN certificate for all three hosts, stored under a fixed lineage name
# ($ERP_HOST) — every site config points at /etc/letsencrypt/live/$ERP_HOST/.
certbot certonly --webroot -w /var/www/certbot --non-interactive --agree-tos \
    -m "$LE_EMAIL" --cert-name "$ERP_HOST" --keep-until-expiring \
    -d "$ERP_HOST" -d "$API_HOST" -d "$DOCS_HOST"

# Phase B — swap in the real TLS site configs.
say "Enabling TLS sites"
rm -f /etc/nginx/sites-enabled/ttr-bootstrap.conf
for H in "$ERP_HOST" "$API_HOST" "$DOCS_HOST"; do
  cp "$API_DIR/deploy/nginx/$H.conf" "/etc/nginx/sites-available/$H.conf"
  ln -sf "/etc/nginx/sites-available/$H.conf" "/etc/nginx/sites-enabled/$H.conf"
done
nginx -t && systemctl reload nginx
systemctl enable certbot.timer 2>/dev/null || true   # auto-renew

# ---- 9. firewall -----------------------------------------------------------
say "Configuring firewall (ufw)"
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
# 3000 (API) and 5432 (Postgres) are NOT opened — internal only.

# ---- 10. smoke test --------------------------------------------------------
say "Smoke test"
sleep 3
curl -sko /dev/null -w "API  /health   → %{http_code}\n" "https://$API_HOST/health"  || true
curl -sko /dev/null -w "ERP  /          → %{http_code}\n" "https://$ERP_HOST/"                || true
curl -sko /dev/null -w "DOCS /          → %{http_code}\n" "https://$DOCS_HOST/"               || true

say "Done. Admin login (demo seed): admin@demo-factory.com / Admin123!  ← CHANGE IT."
echo "Next: rotate the root password, create a non-root sudo user, disable SSH root+password login."
