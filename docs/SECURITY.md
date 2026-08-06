# TTR ONE — Security Review

**Scope:** Backend API (Fastify + Prisma + PostgreSQL) and Nuxt/Pinia web client of the TTR ONE multi-tenant SaaS ERP.
**Method:** Source-code review (read-only). No dynamic testing, no dependency CVE scan, no infrastructure review.
**Review date:** 2026-07-21
**Reviewer:** Application security review (static / architectural)

> This document is an honest, pentest-style assessment. It calls out real strengths and real gaps. Line references point at the reviewed source tree under `src/` and `web/`. "Gap" does not always mean "exploitable today" — several items are latent risks or hardening opportunities that matter before this reaches untrusted production tenants.

---

## 1. Executive summary & overall posture

TTR ONE is a **single-database, multi-tenant** ERP. Every business record carries a `tenantId`, and isolation is enforced **at the application layer**: each query filters on `req.auth.tid`, the tenant id carried inside a signed JWT. Authentication is JWT access tokens + rotating opaque refresh tokens; authorization is a permission-code RBAC model with optional record-level warehouse scoping and field-level price masking. There is a subscription write-gate, an immutable accounting ledger, an audit trail, TOTP MFA, a client-side PIN vault, and AES-256-GCM encryption of tenant secrets (AI keys, integration credentials).

**Overall posture: reasonable-to-good for a self-hosted / early-stage SaaS, with a clear set of pre-production gaps.** The architecture shows security awareness well beyond a typical MVP (rotation, hashed-at-rest tokens, GCM auth-tag PIN vault, generic auth errors, audit logging). The dominant residual risks are:

1. **Tenant isolation is discipline-based, not enforced.** There is no database-level Row-Level Security and no ORM-level tenant guard. A single missing `where: { tenantId }` clause = silent cross-tenant data exposure. The current code is consistent, but nothing *prevents* regression. **This is the top concern.**
2. **Dev-grade cryptographic defaults ship in the tree.** A weak `JWT_SECRET` and a hardcoded secretbox fallback (`'ttr-one-dev-secret'`) exist in code/`.env`, and `.env` is **not** git-ignored.
3. **XSS blast radius is high.** CSP allows `'unsafe-inline'` scripts, and an active session keeps the access token in memory plus a raw AES key + tokens in `sessionStorage` — so any script execution in the SPA fully compromises the session, PIN vault notwithstanding.
4. **Secrets use one static, non-rotatable key** derived from the same server secret as JWT signing (shared blast radius, no KMS, no rotation).

None of these are unusual for the stage; all are addressable. Priorities are in §9.

---

## 2. OWASP Top 10 (2021) assessment

| # | Category | Status |
|---|----------|--------|
| A01 | Broken Access Control | **Partial** |
| A02 | Cryptographic Failures | **Partial** |
| A03 | Injection | **OK / Partial (XSS)** |
| A04 | Insecure Design | **OK** |
| A05 | Security Misconfiguration | **Partial / Gap** |
| A06 | Vulnerable & Outdated Components | **Not assessed** |
| A07 | Identification & Authentication Failures | **Partial** |
| A08 | Software & Data Integrity Failures | **OK** |
| A09 | Logging & Monitoring Failures | **Partial** |
| A10 | SSRF | **OK (low)** |

### A01 — Broken Access Control — Partial
**What the app does.** Authentication is a preHandler (`src/plugins/auth.ts`) that verifies the JWT and populates `req.auth`. Authorization is `requirePermission(code)` (`src/plugins/rbac.ts`), which checks `req.auth.perms` — a permission list baked into the token at login by `buildClaims` (`src/lib/access.ts`). Platform-wide admin routes are gated by `requirePlatformAdmin` (`src/modules/superadmin/routes.ts:15`). Tenant scoping is applied in every data query (see §3). Mutating writes on inactive subscriptions are blocked (`src/plugins/subscription.ts`). There is field-level masking (prices hidden without `catalog.price`, `src/modules/catalog/routes.ts:74-77`) and record-level warehouse scoping (`allowedWarehouses`, `src/modules/warehouse/routes.ts:53-57`).

**Evidence of good practice.** Update/delete follow a **read-before-write** pattern: `findFirst({ id, tenantId })` then `update({ id })` (e.g. `catalog/routes.ts:93-95`, `crm/routes.ts:68-70`, `finance/routes.ts:170-172`), so an attacker cannot mutate another tenant's row by guessing an id.

**Gaps.**
- **No defense-in-depth.** Isolation is 100% application-layer; there is no RLS and no ORM middleware asserting tenant scope.
- **Permissions are frozen in the JWT** for the access-token lifetime (`ACCESS_TOKEN_TTL=15m`). Revoking a role or permission does **not** take effect until the token expires/refreshes — `buildClaims` re-runs only on login/refresh. Privilege revocation lag up to 15 minutes.
- **`currentQty` reads a `stockItem` by composite key without `tenantId`** (`src/modules/warehouse/routes.ts:44`: `findUnique({ where: { warehouseId_productId } })`). Exploitability depends on whether the calling handler validates warehouse ownership first, but the lookup itself is not tenant-scoped — exactly the class of omission that RLS would neutralize.

### A02 — Cryptographic Failures — Partial
**What the app does.** Passwords: bcrypt, cost 10 (`src/lib/password.ts`). Refresh/reset tokens: 32–48 bytes CSPRNG, stored as SHA-256 hashes, never in plaintext (`src/lib/tokens.ts`, `src/lib/reset.ts`). Tenant secrets: AES-256-GCM with random 12-byte IV + auth tag (`src/lib/secretbox.ts`). Client PIN vault: PBKDF2-SHA256 210k iterations → AES-GCM-256 (`web/utils/crypto.ts`). TOTP: RFC 6238 HMAC-SHA1 (`src/lib/totp.ts`).

**Gaps.**
- **Weak/committed key material.** `.env` ships `JWT_SECRET="dev-only-change-me-…"` and is **not** in `.gitignore` (only `.env.local` is). `secretbox` falls back to `'ttr-one-dev-secret'` if no env key is set (`src/lib/secretbox.ts:6`).
- **bcrypt cost 10** is on the low side for 2026; cost 12+ is preferable (trade-off with the pure-JS `bcryptjs` performance).
- SHA-256 (unsalted) for tokens is acceptable **only** because the tokens are high-entropy random values (not user secrets) — fine here, but worth documenting so nobody reuses the helper for low-entropy inputs.
- TOTP over SHA-1 is spec-standard and acceptable.

### A03 — Injection — OK for SQL; Partial for XSS
- **SQL:** All data access goes through Prisma with parameterized queries; no string-built SQL except `prisma.$queryRaw`SELECT 1`` (a constant, `src/app.ts:124`). Input is validated with Zod schemas across routes. **OK.**
- **XSS:** CSP permits `'unsafe-inline'` for `script-src` and `style-src` (`src/app.ts:70-71`), substantially weakening the app's XSS defense. See A05 and §7.
- **File download** sets `Content-Disposition: attachment` with an encoded filename and echoes the stored `mime` (`platform/routes.ts:117-118`); attachment disposition mitigates inline-render XSS, but the stored MIME is attacker-controlled at upload — serve user files from a separate origin / force a safe content type where possible.

### A04 — Insecure Design — OK
Positive design choices: immutable journal entries with explicit reversal instead of edit (`finance/routes.ts` journal endpoints, `lib/ledger.ts`), subscription write-gate, per-tenant resource limits (`assertWithinLimit`), audit trail on sensitive actions, generic authentication errors, refresh-token rotation, MFA-gated login. The AI assistant is intentionally **read-only over a server-assembled snapshot with no tools** (§6) — a deliberately safe design.

### A05 — Security Misconfiguration — Partial / Gap
- Helmet is enabled but CSP allows inline scripts/styles (`src/app.ts:66-77`); `crossOriginEmbedderPolicy` disabled.
- **CORS:** when `CORS_ORIGINS` is empty (the default), `origin` falls back to `true` — reflect **any** origin — **combined with `credentials: true`** (`src/app.ts:79-83`). In dev this is convenient; in production, with cookies in play, an unset allowlist is dangerous. (Note: the app currently sends the access token via `Authorization` header, not cookies, which reduces but does not eliminate the concern — `@fastify/cookie` is registered and the SSE endpoint accepts tokens.)
- **`.env` committed** with weak secrets and DB credentials; production seller/INN placeholders included.
- `trustProxy: true` (`src/app.ts:61`) is correct **only** behind a trusted reverse proxy; if the app is ever exposed directly, `req.ip` (used for audit + rate-limit keys) becomes client-spoofable via `X-Forwarded-For`.
- Default seed admin credentials (`admin@demo-factory.com` / `Admin123!`) are defined in config defaults (`src/config.ts:19-20`).

### A06 — Vulnerable & Outdated Components — Not assessed
Dependency versions were not audited in this review. `package-lock.json` is present (good for reproducibility). **Recommend** `npm audit` in CI and Dependabot/Renovate. Notable surface: `@fastify/*`, `bcryptjs`, `@prisma/client`, and the Nuxt front-end tree.

### A07 — Identification & Authentication Failures — Partial
**Strengths.** Auth endpoints get a stricter rate limit (`AUTH_RATE_MAX=10/min`, `src/modules/auth/routes.ts:57`). Generic "Invalid credentials" messages. User-enumeration avoided on login and forgot-password (`auth/routes.ts:190-191` always returns the same body). Refresh rotation with single-use consumption + revoke-all on password change/reset. Sessions/devices are listable and revocable. MFA (TOTP) is confirm-before-enable.

**Gaps.**
- **No account lockout / progressive backoff** beyond the shared IP rate limit — distributed/rotating-IP credential stuffing is only lightly deterred, and bcrypt cost 10 keeps verification cheap.
- **TOTP replay:** a code is valid across a ±1 step window (`totp.ts:36`) and is **not** consumed on use, so the same 6 digits work repeatedly for up to ~90s. Consider single-use tracking of the last accepted counter.
- **No MFA backup/recovery codes** — a lost authenticator locks the user out (recoverable only via platform admin).
- **Dev reset-token leak:** `forgot-password` returns `devResetToken` in the response body when `NODE_ENV !== 'production'` (`auth/routes.ts:188,191`) and logs the reset link (`:185`). Correct to gate on env, but ensure production is truly `production`.
- **PIN** is a UX unlock, not a second auth factor: `pin/verify` requires an already-authenticated session (`auth/routes.ts:284-290`) and returns a boolean — fine as designed, but it does not harden server-side auth.

### A08 — Software & Data Integrity Failures — OK
JWTs are signed (HS256 via `@fastify/jwt`). Refresh tokens rotate and are single-use. The accounting journal is append-only with explicit reversals. Front-end is self-hosted (no third-party CDN scripts to require SRI). No insecure deserialization observed (JSON only).

### A09 — Logging & Monitoring Failures — Partial
**Strengths.** Structured `audit()` writes (actor, action, entity, ip) on sensitive operations across modules; per-request correlation id surfaced as `x-request-id` (`src/app.ts:62,92-94`); pino logging.

**Gaps.**
- **Secret-adjacent data in logs:** the password-reset link (containing a live reset token) is logged at info level (`auth/routes.ts:185`). The SSE endpoint accepts the **access token in the query string** (`platform/routes.ts:22-25`) — query strings are commonly logged by proxies/access logs. Prefer a short-lived, single-purpose stream token or an `EventSource` polyfill that can set headers.
- No evidence of alerting/anomaly detection (expected at this stage).

### A10 — SSRF — OK (low)
Outbound calls target **fixed** hosts: `api.openai.com` / `api.anthropic.com` (`src/lib/ai.ts:50,62`). Model and provider are constrained (provider is an enum; model is a free string used only as an API parameter, not a URL). Tender refresh (`lib/tenders.ts`, invoked from `platform/routes.ts:173`) fetches external portals — confirm those URLs are a fixed allowlist and not tenant-controlled. No user-supplied URL is fetched in the reviewed paths.

---

## 3. Multi-tenant isolation analysis (top concern)

**Model.** One PostgreSQL database, shared schema, `tenantId` column on tenant-owned tables. The tenant id is a **trusted JWT claim** (`AccessClaims.tid`, `src/lib/tokens.ts:12`) set from `user.tenantId` at claim-build time (`src/lib/access.ts:27`). Every handler reads `req.auth.tid` and filters on it.

**Consistency observed (sampled).** The pattern is applied uniformly across the modules reviewed:
- `catalog/routes.ts` — every `findMany/findFirst/create` includes `tenantId: req.auth.tid` (e.g. `:33, :43, :52-56, :83, :93`).
- `finance/routes.ts` — accounts, transactions, chart, journal, reports, budgets, payment schedule all filter `tenantId`, including nested relation filters on journal lines (`:356, :382, :435, :455`).
- `platform/routes.ts` — notifications additionally scope by `userId`; files, search, tenders all scope `tenantId`; the jobs view intentionally unions tenant-owned and global (`tenantId: null`) jobs (`:135`), which is appropriate for platform jobs.
- Cross-tenant reach is **only** in `superadmin/routes.ts`, correctly gated by `requirePlatformAdmin`.

**Where the risk is.**
1. **Enforcement is manual.** Nothing structurally guarantees the `where` clause. One omission ships a cross-tenant leak with no failing test.
2. **Composite-key lookups can bypass scope** — `currentQty` (`warehouse/routes.ts:44`) fetches by `warehouseId_productId` with no `tenantId`. `finance/routes.ts:433` fetches a ledger account by `tenantId_code` (safe, because the composite key *includes* tenantId) — the difference shows how easy it is to slip.
3. **`buildClaims` trusts the DB link.** Correct today, but any future endpoint that lets a user influence `tenantId` (e.g. an admin "act as tenant" feature) would need very careful handling.

**Recommendations.**
- **Adopt a Prisma Client Extension / middleware** that automatically injects `tenantId` into `where` and `data` for all tenant-scoped models, sourced from an async-local-storage request context — turning isolation from a convention into an invariant. Explicitly opt out for the handful of platform/global queries.
- **Or/and enable PostgreSQL Row-Level Security**: `ALTER TABLE … ENABLE ROW LEVEL SECURITY` with a `USING (tenant_id = current_setting('app.tenant_id'))` policy, and `SET app.tenant_id` per transaction. This is the strongest defense-in-depth and neutralizes forgotten `where` clauses.
- **Add a test/lint that asserts tenant scoping.** A unit test that iterates handlers (or a static check) verifying every tenant-owned-model query carries a `tenantId` filter; plus an integration test that logs in as Tenant A and asserts 404/empty for Tenant B's ids across each module. Fix the `currentQty` lookup to include `tenantId`.

---

## 4. Authentication & Authorization

**JWT.** HS256 via `@fastify/jwt`, `expiresIn = ACCESS_TOKEN_TTL` (15m). Claims carry `sub, tid, email, name, perms, roles, admin` (`src/lib/tokens.ts:10-18`). Verification is centralized (`src/plugins/auth.ts:24-31`) and failures return a generic 401.
- *Strength:* short access-token lifetime; correlation of tenant/permissions in one signed object avoids per-request DB hits.
- *Gap:* HS256 (shared secret) means the same secret that signs tokens also (by fallback) derives the secretbox key — see §5. Permission/role changes lag until token refresh.

**Refresh rotation.** Opaque 48-byte tokens, SHA-256-hashed at rest, single-use (revoked on consume), 30-day TTL, per-device rows with UA/IP (`src/lib/tokens.ts`). Revoke-all on password change/reset (`auth/routes.ts:163, 201`). Sessions listable/revocable (`auth/routes.ts:293-310`).
- *Strength:* textbook rotation + revocation.
- *Gap:* No **reuse detection** — if a stolen-but-already-rotated refresh token is replayed, it simply fails; consider detecting reuse of a revoked token as a signal to revoke the whole family.

**RBAC / ABAC.** Permission-code RBAC (`requirePermission`), platform-admin flag, plus two ABAC-flavored controls: record-level warehouse allow-lists (`allowedWarehouses`) and field-level price masking (`catalog.price`). Solid, granular model.
- *Gap:* enforcement lives in each route's preHandler list; a route that forgets `requirePermission` is only protected by authentication. A default-deny convention or a route manifest test would help.

**MFA / TOTP.** Confirm-before-enable, disable requires a valid code if currently enabled (`auth/routes.ts:250-271`). Standard RFC 6238.
- *Gaps:* no replay consumption, no backup codes, ±1 window (see A07).

**PIN vault (client).** PIN → PBKDF2-SHA256 (210k) → AES-GCM-256; tokens encrypted at rest in `localStorage`; a wrong PIN fails the GCM tag (no oracle) (`web/utils/crypto.ts`, `web/stores/auth.ts:124-149`). Server stores a bcrypt `pinHash` for an online verify.
- *Strength:* good at-rest design; no plaintext token in `localStorage`; legacy plaintext keys actively wiped (`wipeLegacyPlaintext`).
- *Gap:* the **warm session** stores the *exported raw AES key* plus tokens in `sessionStorage` (`auth.ts:98-101`), and the live access token sits in memory. So the vault protects a *locked/at-rest* device, **not** an active session against XSS — any injected script reads the token and the raw key directly. This interacts badly with the `'unsafe-inline'` CSP (§7).

**Password reset.** Opaque 32-byte token, hashed, single-use, 30-min TTL (`src/lib/reset.ts`); revoke-all sessions on reset; no user enumeration. Good — except the dev-mode token echo/log noted in A07/A09.

---

## 5. Secrets management

**Mechanism.** `src/lib/secretbox.ts` encrypts tenant secrets with **AES-256-GCM**: random 12-byte IV, 16-byte auth tag, base64 `iv|tag|ct`. The key is `scryptSync(SECRET, 'ttr-ai-secretbox', 32)` where `SECRET = SECRET_KEY || JWT_SECRET || 'ttr-one-dev-secret'`. Used for:
- Per-tenant **AI API keys** (`tenant.aiApiKeyEnc`, `src/lib/ai.ts`, `modules/ai/routes.ts`). Keys are write-only over the API; only a `••••last4` hint is returned (`secretbox.ts:26-29`, `ai/routes.ts:31`).
- **Integration credentials** (Telegram, SMTP, Payme/Click/Stripe, Didox, SIP) stored as an encrypted JSON blob per tenant (`src/lib/integrations.ts:42-53`).

**Strengths.** Authenticated encryption (tamper-evident), random IV per encryption, plaintext never returned to clients, corrupt-ciphertext handled gracefully.

**Gaps / recommendations.**
- **Shared blast radius:** the encryption key defaults to being derived from `JWT_SECRET`. One leaked secret compromises **both** token forgery and all stored tenant credentials. **Use a dedicated `SECRET_KEY`, independent of `JWT_SECRET`.**
- **Hardcoded fallback** `'ttr-one-dev-secret'` must never be reachable in production — fail closed if `SECRET_KEY`/`JWT_SECRET` is unset in prod rather than silently using the dev constant.
- **No key rotation.** Ciphertext has no key-version/prefix, so rotating the server secret makes every stored secret undecryptable. Add a **versioned envelope** (`v2:keyId:iv:tag:ct`) and a re-encryption path.
- **No KMS / envelope encryption.** For production, move to a KMS (AWS KMS / GCP KMS / Vault) with envelope encryption and per-tenant data keys, so the master key never lives in app memory or `.env`.
- **`maskHint` decrypts the full secret** just to show the last four characters (`secretbox.ts:28`). Store a non-sensitive `last4` at write time instead of decrypting on read.
- **scrypt with a static salt** (`'ttr-ai-secretbox'`) is acceptable for deriving a single service key from a high-entropy secret, but a random, stored salt is preferable if the input secret is ever low-entropy.

---

## 6. Prompt injection & AI safety

**Design (assistant).** `POST /ai/ask` assembles a **server-side snapshot** — KPIs, top products, low-stock forecast (`modules/ai/routes.ts:58-61`) — and sends it with the user's question to the tenant's chosen LLM (`askAI`, `src/lib/ai.ts:71-76`). The system prompt constrains the model to answer only from the JSON and not invent numbers. **The assistant has no tools and no write path** — it returns text only. This is the right design: even a fully successful prompt injection yields, at worst, misleading text, not a privileged action.

**Residual AI risks.**
1. **Indirect / stored prompt injection.** The snapshot is built from tenant data (product names, counterparties, notes) that users control. A crafted product name (e.g. "…ignore previous instructions and…") is fed to the model as data. Because there are no tools and no downstream automated action, impact is limited to a manipulated *answer*. Still, treat model output as **untrusted**: never render it as HTML without escaping, and never feed it into a code/SQL/command path.
2. **OCR / vision surface.** `POST /ai/ocr-invoice` accepts a base64 image up to 12 MB (`ai/routes.ts:67`), forwards it to the LLM, and **parses the returned text as JSON** (`ai.ts:82-85`) into `supplier` + `lines`. Risks: (a) the code strips ```` ```json ```` fences and `JSON.parse`s model output — a non-JSON or hostile response is caught and returned as `raw` (good, no crash); (b) an attacker-supplied invoice image can steer extracted values (supplier/prices) that may pre-fill procurement — ensure a **human confirms** before any GRN/PO is created (appears to be the intent), and validate/clamp numeric fields server-side before persistence. Also enforce an **allowed image MIME/type** and size (size is capped; MIME is currently free-form, `ai/routes.ts:68`).
3. **Data egress to third parties.** The snapshot (business KPIs) and invoice images leave the platform to `api.openai.com` / `api.anthropic.com` under the **tenant's own key**. This is a legitimate design but a **data-residency/privacy** consideration — document it, and make AI features opt-in per tenant (they already degrade to a stub without a key, `ai.ts:72`).

**Recommendations.**
- Explicitly label snapshot content as data (delimit, and instruct the model that everything inside is untrusted user data) and keep the "answer only from JSON / don't invent" guardrail (already present).
- Treat all AI output as untrusted in the UI: escape on render, never `v-html`, never auto-execute extracted values.
- Cap output tokens (already done: 700/1500) and add server-side validation of OCR JSON shape (types, ranges, positive quantities/prices) before it can flow into procurement.
- Consider PII minimization in the snapshot (send aggregates, not raw customer records — current snapshot is already aggregate-leaning).

---

## 7. Transport, headers, rate-limiting, CORS

- **TLS/HSTS.** No TLS in-app; termination is assumed at a reverse proxy (`trustProxy: true`). Helmet's default HSTS header is only meaningful over HTTPS — **ensure the proxy enforces HTTPS + HSTS** in production. The README claims HSTS/X-Frame-Options are covered by helmet.
- **CSP.** `default-src 'self'`, but `script-src`/`style-src` include **`'unsafe-inline'`** (`src/app.ts:70-71`) — a meaningful weakening. Given the high XSS blast radius (§4 PIN vault), move to **nonce/hash-based** inline handling and drop `'unsafe-inline'`. `img-src` allows `data:` (needed for the SPA); `connect-src 'self'`.
- **CORS.** `credentials: true` with `origin` = allowlist, **falling back to reflect-any when the allowlist is empty** (`src/app.ts:79-83`). **Set `CORS_ORIGINS` explicitly in production.** The SSE handler additionally echoes the request `Origin` into `Access-Control-Allow-Origin` (`platform/routes.ts:34`) — acceptable for a token-in-query stream, but revisit alongside the token-in-query concern.
- **Rate limiting.** Global limiter is registered with `global: false` (opt-in) at 300/min (`src/app.ts:87`); auth routes opt in at 10/min (`auth/routes.ts:57`). Because global is off, **non-auth routes are effectively unthrottled** unless individually configured — consider a sane default global cap plus stricter per-route limits. Keys derive from `req.ip`, which depends on `trustProxy` being correct.
- **Error handling.** Centralized handler returns a consistent envelope, maps Zod/Prisma/AppError, and **suppresses internal error detail in production** (`src/app.ts:97-116`) — good; verify `NODE_ENV=production` is actually set so raw messages aren't leaked.
- **Body limits.** File and OCR endpoints cap payloads (12 MB) (`platform/routes.ts:16,86`, `ai/routes.ts:67`).

---

## 8. Known limitations already present in the codebase

These are acknowledged in code/README and are development-stage by design; listed for completeness:

- **Tokens in the browser & XSS exposure.** By design the PIN vault stores only *encrypted* tokens in `localStorage`, but an active session keeps the access token in memory and a **raw AES key + tokens in `sessionStorage`** (`web/stores/auth.ts:98-101`). XSS in the SPA = full session compromise; the `'unsafe-inline'` CSP raises that likelihood.
- **`.env` committed with dev secrets.** `.gitignore` covers `.env.local` but **not `.env`**, which contains a weak `JWT_SECRET`, DB credentials, and placeholder seller requisites.
- **Embedded dev PostgreSQL / encoding.** The app boots its own Postgres into `.pgdata`; existing clusters "may be **WIN1251**" and must be recreated to get UTF-8 (`src/pg.ts:41-42`). A WIN1251 dev DB can mangle Cyrillic data — a data-integrity footgun, not a direct security issue. Production should point at managed UTF-8 Postgres.
- **Sandbox / stubbed payments.** Payme/Click/Stripe are **stubs**; card payment is a built-in **sandbox (no real money)**; bank-transfer invoices are activated by a manual `mark-paid` in super-admin (`superadmin/routes.ts:91-104`). Didox ЭСФ is a stub until credentials are set. No real payment-processing attack surface yet, but the manual activation path is a high-value privileged action (correctly platform-admin gated + audited).
- **Email delivery stubbed.** Reset links are logged for dev rather than emailed (`auth/routes.ts:184-185`).
- **Default seed admin** credentials in config defaults.

---

## 9. Prioritized remediation checklist

### High
1. **Enforce tenant isolation structurally.** Add a Prisma tenant-scoping extension/middleware **and/or** PostgreSQL RLS; add integration tests proving Tenant A cannot read/write Tenant B ids across every module. Fix the non-scoped `currentQty` lookup (`warehouse/routes.ts:44`). *(A01, §3)*
2. **Fix secret hygiene for production.** Generate a strong random `JWT_SECRET`; add `.env` to `.gitignore`; **fail closed** (no `'ttr-one-dev-secret'` / no dev JWT default) when secrets are unset in `production`. *(A02, A05)*
3. **Separate the encryption key from the signing key.** Introduce a dedicated `SECRET_KEY` for `secretbox`, independent of `JWT_SECRET`. *(§5)*
4. **Harden CSP + reduce token exposure.** Remove `'unsafe-inline'` (nonces/hashes); reconsider keeping the raw AES key in `sessionStorage`. Together these shrink the XSS blast radius. *(A03/A05/§7, §4)*
5. **Lock down CORS in production.** Require an explicit `CORS_ORIGINS`; never reflect-any with `credentials: true`. *(A05/§7)*

### Medium
6. **Secrets rotation + KMS path.** Versioned ciphertext envelope and a re-encryption routine; plan KMS/envelope encryption with per-tenant data keys. Stop decrypting in `maskHint` — store `last4` at write. *(§5)*
7. **Authentication hardening.** Account lockout / progressive backoff on repeated failures; TOTP single-use (consume the counter); MFA backup codes; consider bcrypt cost 12+ (or Argon2). *(A07)*
8. **Stop logging secret-adjacent data.** Don't log the reset link; move the SSE access token out of the query string (short-lived stream token). *(A09)*
9. **Refresh-token reuse detection.** Treat replay of a revoked token as a family-compromise signal and revoke all. *(A08/§4)*
10. **Global rate-limit default + verify `trustProxy` deployment.** Apply a baseline throttle to all routes; ensure `trustProxy` is only true behind a trusted proxy. *(A05/§7)*
11. **Reduce permission-revocation lag.** Consider a token version / revocation list so role/permission changes take effect before the 15-minute access-token expiry. *(A01/§4)*

### Low
12. **AI/OCR input-output handling.** Validate OCR JSON shape and clamp numeric fields server-side; enforce allowed image MIME; keep AI output escaped in the UI (never `v-html`); document third-party data egress and keep AI opt-in. *(§6)*
13. **Dependency scanning.** `npm audit` in CI + Dependabot/Renovate for both `src` and `web`. *(A06)*
14. **Serve user file downloads from a separate origin** or force safe content types; the stored MIME is attacker-controlled. *(A03)*
15. **Rotate/replace default seed admin** on first production boot; force password change. *(A05)*
16. **Recreate dev DB as UTF-8**; ensure production Postgres is UTF-8. *(§8)*

---

*End of review. Findings are based on static analysis of the current source; a follow-up dynamic test (authenticated cross-tenant probing, dependency CVE scan, and a review of `lib/ledger.ts`, `lib/tenders.ts`, and remaining modules not sampled here) is recommended before production launch.*

---

## Remediation applied (Stage 13 hardening)

The following findings from this review have been fixed in code:

- **Tenant isolation slip** — `warehouse currentQty()` now filters `tenantId` (was composite-key only). Added `test/isolation.test.ts` (cross-tenant read/write blocked, unauth → 401).
- **Production security gate** (`src/config.ts`) — the app now refuses to boot in `NODE_ENV=production` if: `JWT_SECRET` < 32 chars, `SECRET_KEY` unset/short or equal to `JWT_SECRET`, `CORS_ORIGINS` empty, or `SEED_ADMIN_PASSWORD` still the demo default. Verified: fails fast with a clear checklist.
- **CORS** (`src/app.ts`) — no longer reflects an arbitrary origin with `credentials:true`. Uses the explicit `CORS_ORIGINS` allowlist; dev falls back to fixed localhost origins; prod requires the allowlist. Verified: `localhost:3001` allowed, arbitrary origin blocked.
- **Global rate limit** (`src/app.ts`) — enabled in production (600/min per IP) on top of the stricter per-route auth limit; disabled in dev/test.
- **Password hashing** (`src/lib/password.ts`) — bcrypt cost 10 → 12 (existing hashes upgrade on next password change).
- **Secrets in git** — `.env` (and `.env.*`) added to `.gitignore` with `!.env.example`; `.pgdata/`, `.storage/`, `backups/`, `.output/`, `.nuxt/` ignored. `.env.example` documents required vars.

### Still open / documented (not yet fixed)
- CSP `script-src 'unsafe-inline'` on Fastify-served pages (legacy `public/*.html`); the primary app is a separate Nuxt origin.
- Access token + raw AES key in `sessionStorage` during an active session (XSS exposure) — inherent to the localStorage-token design.
- TOTP has no used-code replay consumption / backup codes; RBAC permission changes lag up to the access-token TTL (~15m).
- SSE access token passed in the query string (EventSource limitation).
