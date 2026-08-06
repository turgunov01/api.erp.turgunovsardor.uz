# TTR ONE — Enterprise ERP Platform (Foundation MVP)

A running, multi-tenant ERP foundation with authentication, RBAC, an organization model,
a product catalog, and a warehouse/inventory module with an append-only movement ledger —
plus a clean web UI. Built as a **modular monolith** that maps 1:1 onto the microservice split later.

> This is the **foundation (Wave 0 + Wave 1)** from the project TZ, plus a warehouse vertical
> slice so a factory can log in and manage real inventory today.

---

## Quick start (Windows / macOS / Linux)

Requires **Node.js 20+** (tested on Node 24). **No Docker, no manual PostgreSQL install.**
The app boots its own **embedded PostgreSQL** locally (data in `./.pgdata`).

```bash
cd ttr-one
npm install
npm run setup     # start local Postgres + apply migrations + seed the Demo Factory
npm run dev       # start API + UI (also boots Postgres automatically)
```

Open **http://localhost:3000**

### Pages / subdomain model
- `/` — **public landing** (marketing site + Register/Login CTAs). In production this is your root domain, e.g. `company.uz`.
- `/app.html` — the **dashboard app** (login / register / ERP panel). In production this is `app.company.uz`.
  Locally we emulate the subdomain split with the `/app.html` path.

### Registering a company
Click **Регистрация** on the landing (or open `/app.html#register`): enter company name, pick your
**industry/niche**, create the owner account. The platform provisions a tenant + owner + company +
warehouse + units and **enables the modules that fit your niche** — then logs you straight in. You can
turn modules on/off anytime under **Модули и настройки** (like WordPress plugins).

> The database is real PostgreSQL running locally (port 5433), managed automatically by the app —
> no container, no service to start. In production, point `DATABASE_URL` at a managed Postgres and
> run `prisma migrate deploy`; nothing else changes.

### Demo logins

| Role | Email | Password | Can do |
|------|-------|----------|--------|
| Owner | `admin@demo-factory.com` | `Admin123!` | Everything |
| Operator | `operator@demo-factory.com` | `Operator123!` | View catalog, receive/issue/adjust stock |

---

## Tests

```bash
npm test     # self-bootstraps local Postgres + seed, runs the suite (12 tests)
```

Covers health/readiness, auth (login/401/no-token/refresh rotation), RBAC denial, stock
receive + over-issue guard, pagination meta, and money/quantity validation.

## What works today

- **Local PostgreSQL, zero-install** — embedded Postgres auto-managed by the app; real Prisma migrations.
- **Pagination + search + sort** on all list endpoints (`page`/`pageSize`/`sort`/`order`/`search`) with `meta`.
- **Strict value validation** — money as integer minor units (float rejected), quantities bounded to 6 decimals.
- **Automated tests** — `npm test`, 15 integration tests via Fastify inject.
- **Subscriptions & billing** — plans (trial/starter/business/enterprise) with **limits** (users/warehouses/products,
  enforced → 402), 14-day trial, and a **write-gate** that blocks mutations when a subscription is past-due/suspended.
  Two payment paths:
  - **Bank transfer (official)** — generates a printable **счёт на оплату** with seller + buyer requisites and VAT (QQS)
    breakdown; the client pays by bank transfer to your account; a **platform admin confirms** receipt → subscription
    activates. Seller requisites are configurable (env / super-admin). **Didox** e-invoice (ЭСФ) is wired as a stub —
    set `DIDOX_API_KEY`/`DIDOX_TOKEN` to enable.
  - **Card (online)** — built-in **sandbox** (no real money). Payme/Click/Stripe are stubbed for later credentials.
- **Super-admin panel** — platform admins manage all tenants (status, plan, extend trial) via `/superadmin/*` + UI.
- **White-label** — per-tenant brand name + accent color applied live across the UI.
- **Onboarding** — niche-based module presets at signup + a first-run checklist on the dashboard.
- **Team & security (Stage 3)** — email **invitations** (invite link → accept → auto-login); **custom roles**
  with a permission builder (system roles protected); **MFA (TOTP)** with a from-scratch RFC-6238 implementation
  (login enforces the code) + mobile **PIN**; **session/device** management (list, revoke one, log out everywhere);
  **record-level** access (limit a user to specific warehouses); **field-level** masking (hide prices without `catalog.price`).
- **Production hardening** — helmet security headers (CSP/HSTS/X-Frame-Options), rate limiting
  (strict on `/auth/*`), strict CORS allowlist via env, `x-request-id` correlation header,
  `/health` (liveness) + `/ready` (DB check).
- **Password lifecycle** — **UI screens**: "Забыли пароль?" on the login page (forgot → set new
  password) and a "Сменить пароль" button in the top bar. Backend: single-use, expiring, hashed
  tokens; reset/change invalidates all sessions. Email delivery is stubbed until Stage 9 wires the
  notification service — in dev the reset token is returned so the flow is fully usable.
- **Multi-tenant** data model — every record is scoped to a `tenantId`; users belong to a tenant.
- **Authentication** — email/password (bcrypt), JWT access tokens (15 min) + rotating refresh tokens
  (stored hashed, revocable). Auto-refresh in the UI.
- **RBAC** — global permission catalog, roles (`owner`, `warehouse_manager`, `operator`, `viewer`),
  per-route permission guards. Permissions are embedded in the access token.
- **Organization** — companies (+ branches/departments/positions in the schema).
- **Catalog** — units, categories, products (money stored as integer minor units — no float).
- **Warehouse / Inventory** — warehouses, on-hand stock per (warehouse, product), and an
  **immutable movement ledger**: Receive (IN), Issue (OUT), Adjust (stock count), Transfer.
  Movements run in a DB transaction and record `balanceAfter`. Over-issue is blocked.
- **Audit log** — every write action is recorded (who / what / when / details).
- **Web UI** — login, dashboard KPIs, inventory grid with stock actions, movement ledger,
  products, warehouses, companies, users, audit — all filtered by the signed-in user's permissions.

## Verified (smoke tests)

- Owner login returns 10 permissions; operator returns 3.
- Receiving 100 units moves Bolt M8 stock 5000 → 5100.
- Over-issue returns `INSUFFICIENT_STOCK`.
- Operator creating a product is denied with `403 MISSING_PERMISSION`.
- Unauthenticated request returns `401`.

---

## Architecture

```
src/
  config.ts            validated env (zod)
  db.ts                Prisma client
  app.ts               Fastify assembly, error envelope, route mounting, static UI
  server.ts            bootstrap + graceful shutdown
  plugins/
    auth.ts            JWT verify -> request.auth
    rbac.ts            requirePermission(code) guard
  lib/
    errors.ts          typed AppError -> HTTP
    password.ts        bcrypt
    tokens.ts          refresh-token issue/rotate/revoke
    access.ts          resolve a user's roles+permissions -> token claims
    permissions.ts     permission catalog + default roles (seeded)
    audit.ts           append-only audit trail
  modules/
    auth/  org/  catalog/  warehouse/  admin/     (one folder = one bounded context)
prisma/
  schema.prisma        multi-tenant model (SQLite dev, PostgreSQL-portable)
  seed.ts              Demo Factory tenant, users, products, opening stock
public/                login + dashboard SPA (vanilla JS, no build step)
```

### Design rules honoured
- **One module = one bounded context**; only the warehouse module mutates stock.
- **No float for money** — prices are integer minor units.
- **API-first** — every capability is a documented REST route under `/api/v1`.
- **Audit + RBAC by default**; secrets from env, never hardcoded.

---

## API surface (`/api/v1`)

| Method | Path | Permission |
|--------|------|-----------|
| POST | `/auth/login` · `/auth/refresh` · `/auth/logout` · GET `/auth/me` | — / bearer |
| GET/POST | `/org/companies` · `/org/branches` | `org.read` / `org.manage` |
| GET/POST | `/catalog/units` · `/catalog/categories` · `/catalog/products` | `catalog.read` / `catalog.write` |
| GET | `/warehouse/warehouses` · `/warehouse/stock` · `/warehouse/movements` | `warehouse.read` |
| POST | `/warehouse/warehouses` | `warehouse.manage` |
| POST | `/warehouse/movements` · `/warehouse/transfer` | `warehouse.move` |
| GET/POST | `/admin/users` · GET `/admin/roles` · GET `/admin/audit` | `admin.users` / `admin.roles` / `audit.read` |

---

## Going to production (PostgreSQL)

1. In `prisma/schema.prisma` set `datasource.provider = "postgresql"` and point `DATABASE_URL` at Postgres.
2. `npx prisma migrate deploy` (switch from `db push` to real migrations).
3. Set strong `JWT_SECRET`, `NODE_ENV=production`.
4. Containerize (Dockerfile + K8s/Helm) — see the TZ Wave 5.

The schema is written to be portable, so this is a config change, not a rewrite.

---

## Roadmap (next waves — from the TZ)

1. **Harden auth**: MFA/PIN, password reset, tenant self-signup + onboarding, per-tenant subscription/billing (to actually sell subscriptions).
2. **Domain depth**: reservations & availability, purchasing (GRN → 3-way match), sales orders, basic manufacturing (BOM → production order consuming stock).
3. **Platform**: search (OpenSearch), realtime (Socket.IO), notifications, background jobs.
4. **Ops**: PostgreSQL migrations, Docker/K8s, observability, backups.
5. **Quality**: automated test suite (unit/integration/contract/E2E), security review.

See `../клод-техническое-задание/README.md` for the full plan and the 39-agent breakdown.
