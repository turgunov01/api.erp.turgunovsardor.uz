# TTR ONE — API Reference

Human-readable overview of the TTR ONE REST API. The machine-readable contract lives
in [`openapi.yaml`](./openapi.yaml) (OpenAPI 3.0.3) — load it in Swagger UI, Redoc,
Postman, or Insomnia to explore requests interactively.

- **Backend**: Node.js + Fastify 5, Prisma 6, PostgreSQL
- **Base URL (dev)**: `http://localhost:3000/api/v1`
- **Content type**: `application/json` (except file download/export endpoints)
- **Product**: multi-tenant SaaS ERP for Uzbekistan (Russian-language UI)

---

## Base URL and versioning

Every endpoint is mounted under a single version prefix:

```
http://<host>:<port>/api/v1/<module>/<resource>
```

Two unversioned operational endpoints live at the root:

| Method | Path      | Purpose                                  |
|--------|-----------|------------------------------------------|
| GET    | `/health` | Liveness — process is up                 |
| GET    | `/ready`  | Readiness — database reachable (`SELECT 1`) |

The web SPA is served statically from the same origin (`/`).

---

## Authentication

TTR ONE uses **JWT Bearer** authentication with short-lived access tokens and rotating
refresh tokens.

### Flow

1. **Log in** — `POST /auth/login` with `{ email, password }`. If the same email exists
   in more than one tenant, include `tenant` (the tenant slug). If MFA is enabled, include
   `mfaCode` (a 6-digit TOTP; a `401 MFA_REQUIRED` is returned when it is missing).

   ```json
   { "email": "admin@demo-factory.com", "password": "Admin123!" }
   ```

   Response:

   ```json
   {
     "accessToken": "<JWT>",
     "refreshToken": "<opaque>",
     "user": {
       "id": "...", "email": "...", "fullName": "...", "tenantId": "...",
       "roles": ["owner"], "permissions": ["catalog.read", "..."], "platformAdmin": false
     }
   }
   ```

2. **Call the API** — send the access token on every request:

   ```
   Authorization: Bearer <accessToken>
   ```

3. **Refresh** — the access token lives ~15 minutes. When it expires, call
   `POST /auth/refresh` with `{ refreshToken }` to get a **new** access **and** refresh
   token (refresh tokens are single-use / rotating; the old one is consumed).

4. **Log out** — `POST /auth/logout` revokes all refresh tokens for the user.

### Self-registration

`POST /auth/register` creates a brand-new tenant + owner account and returns a session in
one call (companyName, industry niche, owner name/email/password, optional plan + module
selection). `GET /auth/onboarding-meta` returns the niches, module catalog and selectable
plans that drive the sign-up wizard.

### Related auth endpoints

- **Password lifecycle** — `POST /auth/change-password`, `POST /auth/forgot-password`,
  `POST /auth/reset-password` (each invalidates existing sessions).
- **MFA (TOTP)** — `POST /auth/mfa/setup` → `POST /auth/mfa/enable` → `POST /auth/mfa/disable`.
- **Mobile PIN** — `POST /auth/pin/set` · `/pin/verify` · `/pin/clear`.
- **Sessions / devices** — `GET /auth/sessions`, `POST /auth/sessions/:id/revoke`,
  `POST /auth/sessions/revoke-all`.
- **Invitations** — `GET /auth/invite?token=`, `POST /auth/accept-invite`.

---

## Error envelope

All errors share a single JSON shape:

```json
{ "error": { "code": "MACHINE_CODE", "message": "Human-readable message" } }
```

Validation errors add a `details` object (a flattened Zod report). Common codes:

| HTTP | `code`                | Meaning                                            |
|------|-----------------------|----------------------------------------------------|
| 400  | `VALIDATION_ERROR`    | Request body/query failed schema validation        |
| 400  | `INSUFFICIENT_STOCK`  | Stock movement/shipment exceeds on-hand            |
| 400  | `BAD_TRANSITION`      | Illegal status transition (order/quotation/period) |
| 401  | `UNAUTHORIZED`        | Missing/invalid token or credentials               |
| 401  | `MFA_REQUIRED` / `MFA_INVALID` | Second factor needed or wrong             |
| 403  | `MISSING_PERMISSION`  | RBAC guard denied the caller                       |
| 402  | (limit codes)         | Plan quota exceeded (users/warehouses/products)    |
| 404  | `NOT_FOUND`           | Record not found                                   |
| 409  | `UNIQUE_VIOLATION` / `SKU_EXISTS` / `CODE_EXISTS` | Duplicate         |
| 429  | `RATE_LIMITED`        | Too many requests (strict on `/auth/*`)            |
| 500  | `INTERNAL`            | Unexpected server error                            |

Every response also carries an `x-request-id` header for correlation.

---

## Pagination, sorting, search

List endpoints accept a common query contract and return a `meta` block:

| Query param | Default | Notes                                   |
|-------------|---------|-----------------------------------------|
| `page`      | `1`     | 1-based page index                      |
| `pageSize`  | `50`    | Max `200`                               |
| `sort`      | —       | Whitelisted field per endpoint          |
| `order`     | `asc`   | `asc` or `desc`                         |
| `search`    | —       | Free-text over name/code/etc.           |

```json
"meta": { "page": 1, "pageSize": 50, "total": 213, "totalPages": 5 }
```

Some list endpoints add resource-specific filters (e.g. `status`, `warehouseId`,
`productId`, `direction`, `source`).

---

## Money and quantities

- **Money is stored and transmitted as integer minor units (tiyin)** — never floats.
  A field named `priceMinor: 1000000` means **10 000.00 UZS**. This applies to all
  `*Minor` fields (`priceMinor`, `amountMinor`, `balanceMinor`, `creditLimitMinor`,
  `debitMinor`/`creditMinor`, `totalMinor`, `openingMinor`, …). Float amounts are rejected
  by validation.
- **Quantities are decimals** (transmitted as numbers or decimal strings), bounded to 6
  decimal places. Stock quantities are returned as strings to preserve precision.
- Default currency is `UZS`.

---

## Multi-tenancy and access control

- Every record is scoped to the caller's **tenant**, derived from the JWT — there is no
  tenant id in the path. You only ever see your own tenant's data.
- **RBAC**: routes are guarded by permission codes (e.g. `catalog.write`, `warehouse.move`,
  `finance.accounting`). The caller's permissions are embedded in the access token and
  surfaced by `GET /auth/me`. `GET /admin/permissions` returns the full catalog.
- **Record-level scope**: a user can be limited to specific warehouses
  (`PUT /admin/users/:id/warehouses`).
- **Field-level masking**: product prices are hidden (returned as `null`) unless the caller
  holds `catalog.price`.
- **Subscription write-gate**: when a tenant's subscription is past-due/suspended, mutating
  endpoints are blocked while reads continue.

---

## Modules and key endpoints

All paths below are relative to `/api/v1`. See `openapi.yaml` for full request/response
schemas of the representative subset.

### auth — authentication & account
`POST /auth/login` · `/register` · `/refresh` · `/logout` · `GET /auth/me` ·
`/auth/onboarding-meta` · password reset · MFA · PIN · sessions.

### org — organization
`GET/POST /org/companies` · `GET/POST /org/branches`.

### catalog — products & pricing
`GET/POST /catalog/products`, `PATCH /catalog/products/:id`,
`POST /catalog/products/:id/barcode`, `GET /catalog/products/by-barcode/:code`,
`GET/POST /catalog/units`, `GET/POST /catalog/categories`.

### warehouse — stock & the movement ledger
`GET/POST /warehouse/warehouses`, `GET /warehouse/stock`,
`GET/POST /warehouse/movements` (IN/OUT/ADJUST), `POST /warehouse/transfer`.
Only this module mutates stock — it is the single source of truth for on-hand inventory,
and every movement records `balanceAfter`.

### inventory — WMS depth
`GET/POST/PATCH /inventory/locations` (bins), `GET/POST /inventory/bin-stock` (+place/transfer),
`GET/POST /inventory/counts` (+`/items`, `/complete`, `/cancel`),
`GET/POST /inventory/batches` (+`/expiring`, `/receive`, `/:id/consume`),
`GET/POST/PATCH /inventory/serials`, `PATCH /inventory/stock-levels`,
`GET /inventory/low-stock`, `POST /inventory/reorder/auto-request`.

### procurement — purchasing & tenders
`GET/POST/PATCH /procurement/suppliers`, `GET/POST /procurement/prices`,
`GET /procurement/compare`, `GET/POST /procurement/requests` (+approve/reject/convert),
`GET/POST /procurement/orders` (+send/cancel/receive), `GET /procurement/receipts`,
`GET/POST /procurement/invoices` (+match/pay, 3-way match).

### sales — order-to-cash
`GET/POST/PATCH /sales/customers` (+contacts), `GET/POST /sales/price-lists` (+items),
`GET/POST /sales/quotations` (+send/accept/reject/convert),
`GET/POST /sales/orders`, `GET /sales/orders/:id`, order lifecycle
(`/confirm`, `/reserve`, `/release`, `/cancel`, `/ship`), `GET /sales/shipments`,
`GET/POST /sales/returns`. Shipments post revenue + COGS; returns reverse them.

### crm — deals & funnel
`GET/POST/PATCH/DELETE /crm/deals`, `POST /crm/deals/:id/move`, `GET /crm/funnel` (kanban).

### production — manufacturing
`GET/POST/PATCH /production/boms` (+items), `GET/POST /production/orders`,
lifecycle (`/confirm`, `/availability`, `/issue`, `/complete`, `/cancel`).
Issuing consumes materials (stock OUT); completing receives finished goods (stock IN).

### finance — accounting & VAT
`GET/PATCH /finance/settings` (costing method, VAT), `GET/POST/PATCH /finance/accounts`
(cash/bank), `GET/POST /finance/transactions`, `GET/POST/PATCH /finance/chart`,
`GET /finance/periods` (+close/reopen), `GET/POST /finance/journal` (+`/:id/reverse`),
reports: `/reports/trial-balance`, `/reports/pnl`, `/reports/inventory-valuation`,
`/reports/account-ledger`, `/reports/vat`, `/reports/budget`, `/reports/cash-forecast`,
`POST /finance/vat/settle`, budgets and payment schedules. Double-entry; entries are
immutable (reverse, don't edit).

### analytics — BI
`GET /analytics/kpis`, `/series`, `/reports/:type`, `/reports/:type/export` (CSV/XLSX),
`/forecast`.

### ai — assistant & OCR
`GET /ai/status`, `GET/PATCH /ai/settings` (write-only API key),
`POST /ai/ask` (NL question over a live data snapshot), `POST /ai/ocr-invoice`.
Degrades to a stub when no provider key is configured.

### studio — no-code & extensibility
`GET /studio/marketplace`, `GET /studio/integrations` (+`PATCH /:provider`,
`/:provider/disconnect`), `GET/POST/PATCH/DELETE /studio/forms` (+`/:id/records`).

### platform — shared services
`GET /platform/notifications` (+`/:id/read`, `/read-all`), `GET /platform/search`,
`GET/POST /platform/files` (+`/:id/download`, `DELETE /:id`),
`GET /platform/jobs` (+`/:id/retry`), `GET /platform/tenders` (+`/refresh`),
`GET /platform/realtime` (SSE; token via `?token=`).

### documents — document flow & e-sign
`GET/POST/PATCH/DELETE /documents/templates`, `POST /documents/import-docx`,
`GET/POST /documents/documents`, `GET /documents/documents/:id`, lifecycle
(`/version`, `/submit`, `/approve`, `/reject`, `/cancel`) — a sequential approval chain.

### tenant — settings & modules
`GET /tenant/settings`, `PATCH /tenant/branding`, `PATCH /tenant/modules/:key`
(plan quota enforced).

### billing — subscriptions
`GET /billing/plans` · `/subscription` · `/requisites` · `/details` (+PATCH) ·
`/invoices` (+`/:id/document`), `POST /billing/subscribe`, `POST /billing/pay`.

### admin — team & governance
`GET/POST /admin/users`, `GET/POST/PATCH/DELETE /admin/roles`,
`GET /admin/permissions`, `GET/POST /admin/invitations` (+`/:id/revoke`),
`GET /admin/audit`, `GET/PUT /admin/users/:id/warehouses`.

### superadmin — platform operations (platform admins only)
`GET/PATCH /superadmin/tenants`, `GET/PATCH /superadmin/requisites`,
`GET /superadmin/invoices` (+`/:id/mark-paid`, `/:id/didox`).

---

## Quick cURL example

```bash
# 1. Log in
TOKEN=$(curl -s http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@demo-factory.com","password":"Admin123!"}' \
  | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).accessToken))")

# 2. List products
curl -s http://localhost:3000/api/v1/catalog/products?pageSize=5 \
  -H "Authorization: Bearer $TOKEN"

# 3. Receive 100 units into a warehouse
curl -s -X POST http://localhost:3000/api/v1/warehouse/movements \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"warehouseId":"<id>","productId":"<id>","type":"IN","quantity":100}'
```
