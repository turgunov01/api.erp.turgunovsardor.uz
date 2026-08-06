# TTR ONE — Production deployment (nginx + Let's Encrypt)

Three hosts on one VPS, all DNS A-records already pointing at the server:

| Host | Project | Served as | Upstream |
|------|---------|-----------|----------|
| `erp.turgunovsardor.uz`  | ERP frontend (Nuxt SPA) | static files | `/var/www/erp` |
| `api.erp.turgunovsardor.uz`  | Backend API (Fastify) | reverse proxy | `127.0.0.1:3000` (systemd `ttr-api`) |
| `docs.erp.turgunovsardor.uz` | Developer docs (Nuxt Content) | static files | `/var/www/docs` |

Postgres 16 and the API port (3000) are **internal only** — never exposed publicly.

## One-shot install

On a fresh Ubuntu/Debian server, as a **non-root sudo user** (see hardening below):

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/turgunov01/api.erp.turgunovsardor.uz.git /tmp/ttr-api
sudo bash /tmp/ttr-api/deploy/server-setup.sh
```

The script installs Node 20, nginx, Postgres, certbot; generates all secrets locally
(`JWT_SECRET`, `SECRET_KEY`, DB password via `openssl rand`); clones the three repos to
`/opt/ttr/{api,erp,docs}`; runs migrations + demo seed; registers the `ttr-api` systemd
service; builds both static frontends; installs the nginx configs; obtains TLS certs; and
turns on the `ufw` firewall.

## What the nginx layer enforces

- **TLS 1.2/1.3 only**, modern cipher suite, OCSP stapling, `ssl_session_tickets off`.
- **HSTS** `max-age=63072000; includeSubDomains`.
- Security headers on every response: `X-Content-Type-Options`, `X-Frame-Options: SAMEORIGIN`,
  `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`. `server_tokens off`.
- **Rate limiting**: 20 req/s general API, **5 req/s on `/auth/login|register|refresh|password`**
  (brute-force surface), plus a per-IP connection cap.
- `client_max_body_size 25m`; static asset immutable caching that preserves security headers.

## Updating after a `git push`

```bash
# API
cd /opt/ttr/api && git pull && npm ci && npx prisma migrate deploy && sudo systemctl restart ttr-api
# ERP
cd /opt/ttr/erp && git pull && npm ci && NUXT_PUBLIC_API_BASE="https://api.erp.turgunovsardor.uz/api/v1" npx nuxi generate && sudo cp -r .output/public/* /var/www/erp/
# docs
cd /opt/ttr/docs && git pull && npm ci && npx nuxi generate && sudo cp -r .output/public/* /var/www/docs/
```

## Post-install hardening (do this first!)

```bash
# 1. Rotate the (now-exposed) root password
passwd

# 2. Create a non-root sudo user + key auth, then disable root & password SSH login
adduser deploy && usermod -aG sudo deploy
# ...copy your public key to /home/deploy/.ssh/authorized_keys...
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/;  s/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh

# 3. Change the seeded admin password inside the app (Settings → change password)
#    Default seed: admin@demo-factory.com / Admin123!
```

## For a real client (empty system instead of demo data)

```bash
cd /opt/ttr/api && npx tsx scripts/reset-for-client.ts   # 1 clean tenant, no demo junk
```
