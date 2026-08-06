# TTR ONE — Deployment Guide

Production runs two images against an **external PostgreSQL**:

| Component | Image | Port | Notes |
|-----------|-------|------|-------|
| API       | `Dockerfile` (repo root)   | 3000 | Fastify + Prisma, runs via `tsx`. |
| Web       | `web/Dockerfile`           | 8080 | Nuxt 3 SPA (`ssr:false`) served by nginx. |
| Postgres  | `postgres:16`              | 5432 | Provide your own managed instance in real prod. |

The API serves its own routes under `/api/v1`, the SPA fallback under `/`, and
health probes at `GET /health` (liveness) and `GET /ready` (readiness — checks DB).

---

## Required environment / secrets

| Var | Where | Required | Purpose |
|-----|-------|----------|---------|
| `DATABASE_URL` | API | yes | External Postgres connection string. |
| `JWT_SECRET`   | API | yes | Min 16 chars. `openssl rand -hex 32`. |
| `SECRET_KEY`   | API | yes | App encryption secret. `openssl rand -hex 32`. |
| `CORS_ORIGINS` | API | yes (prod) | Comma-separated allowed browser origins. |
| `APP_URL`      | API | recommended | Public API URL (password-reset links). |
| `PORT` / `HOST`| API | defaults 3000 / 0.0.0.0 | |
| `NODE_ENV`     | API | `production` | |
| `NUXT_PUBLIC_API_BASE` | Web (**build-time**) | yes | Browser-facing API base, e.g. `https://app.example.com/api/v1`. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AI_MODEL`, `SMTP_URL`, `TELEGRAM_BOT_TOKEN` | API | optional | Integrations. |

> `NUXT_PUBLIC_API_BASE` is baked into the SPA at **build time** (Nuxt public
> runtime config for a static SPA). Rebuild the web image to change it.

## Database migrations

Migrations live in `prisma/migrations/` and are applied with:

```bash
npx prisma migrate deploy
```

Run this as an **init step** before the API serves traffic:
- **docker-compose:** folded into the `api` service `command`.
- **Kubernetes / Helm:** an `initContainer` on the API Deployment (same image).

---

## 1. Build images

```bash
# API
docker build -t ghcr.io/ttr-one/api:latest .

# Web (bake the public API base for your environment)
docker build -t ghcr.io/ttr-one/web:latest \
  --build-arg NUXT_PUBLIC_API_BASE=https://app.ttr-one.example.com/api/v1 \
  ./web
```

## 2. docker-compose (single host)

```bash
cp .env.example .env      # then edit secrets
docker compose up --build -d
# API -> http://localhost:3000   Web -> http://localhost:8080
```

The `api` service waits for Postgres to be healthy, runs `prisma migrate deploy`,
then starts. Data persists in the `pgdata` named volume.

## 3. Kubernetes (raw manifests)

```bash
kubectl apply -f deploy/k8s/namespace.yaml

# Create the real secret (do NOT apply secret.example.yaml as-is):
kubectl -n ttr-one create secret generic ttr-one-secrets \
  --from-literal=DATABASE_URL='postgresql://ttr:PASS@ttr-one-postgres:5432/ttr_one?schema=public' \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)" \
  --from-literal=SECRET_KEY="$(openssl rand -hex 32)" \
  --from-literal=POSTGRES_PASSWORD='PASS'

kubectl apply -f deploy/k8s/configmap.yaml
kubectl apply -f deploy/k8s/postgres-statefulset.yaml   # omit if using managed Postgres
kubectl apply -f deploy/k8s/api-deployment.yaml         # includes migrate initContainer
kubectl apply -f deploy/k8s/web-deployment.yaml
kubectl apply -f deploy/k8s/ingress.yaml
kubectl apply -f deploy/k8s/hpa.yaml
```

- API probes: readiness `/ready`, liveness `/health`.
- HPA autoscales the API on 70% CPU (2–10 replicas).
- Ingress routes `/api`, `/health`, `/ready` → API service; everything else → web.
- Update the `image:` refs in the Deployments to your registry/tag.

## 4. Helm

```bash
helm upgrade --install ttr-one deploy/helm/ttr-one \
  --namespace ttr-one --create-namespace \
  --set api.image.repository=ghcr.io/ttr-one/api \
  --set api.image.tag=latest \
  --set web.image.repository=ghcr.io/ttr-one/web \
  --set web.image.tag=latest \
  --set secret.databaseUrl='postgresql://ttr:PASS@postgres:5432/ttr_one?schema=public' \
  --set secret.jwtSecret="$(openssl rand -hex 32)" \
  --set secret.secretKey="$(openssl rand -hex 32)" \
  --set ingress.host=app.ttr-one.example.com
```

Prefer a pre-created secret in production:
`--set secret.existingSecret=ttr-one-secrets` (keys: `DATABASE_URL`,
`JWT_SECRET`, `SECRET_KEY`, and any optional integration vars). The chart renders
API + web Deployments/Services, ConfigMap, Secret (optional), Ingress, and HPA.

---

## Notes & caveats

- **External Postgres:** these artifacts target an external DB via `DATABASE_URL`.
  The bundled `postgres` service (compose) and StatefulSet (k8s) are conveniences
  for non-managed environments — drop them and point `DATABASE_URL` at your
  managed instance (RDS/Cloud SQL/etc.) for real production.
- **Embedded Postgres side effect:** `src/server.ts` calls `ensurePg()`, which in
  dev boots an embedded Postgres on `PG_PORT` (default 5433). It is *not* used in
  production (Prisma connects to `DATABASE_URL`), but it will still attempt to
  start locally inside the API container. To disable it for production without
  side effects, guard that call — e.g. `if (config.NODE_ENV !== 'production') await ensurePg(...)`
  in `src/server.ts` (one-line change, outside these deployment artifacts). Until
  then the runtime image keeps the `embedded-postgres` dependency so the import
  resolves.
- **TLS:** the Ingress assumes an nginx ingress controller + cert-manager
  (`letsencrypt-prod`). Remove those annotations if you terminate TLS elsewhere.
- **Secrets:** never commit real secrets. `secret.example.yaml` and the values in
  `.env.example` are placeholders only.
