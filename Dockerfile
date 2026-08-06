# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# TTR ONE — API image (Fastify + Prisma, Node 20)
# Runs the app with tsx (the project ships TS run directly, not compiled).
# Production connects to an EXTERNAL Postgres via DATABASE_URL.
# ---------------------------------------------------------------------------

# ----- Stage 1: builder — install deps + generate Prisma client -----
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# Install deps against the lockfile (reproducible).
COPY package.json package-lock.json ./
RUN npm ci

# Generate the Prisma client (needs the schema).
COPY prisma ./prisma
RUN npx prisma generate

# App sources.
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY public ./public

# Drop dev-only deps but KEEP the generated Prisma client that now lives in
# node_modules. tsx + prisma stay because they are runtime deps here.
RUN npm prune --omit=dev

# ----- Stage 2: runtime — slim image, non-root -----
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

# Copy the pruned node_modules (incl. generated Prisma client) and app.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/src ./src
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/public ./public
COPY package.json ./

# Run as the unprivileged built-in `node` user.
RUN chown -R node:node /app
USER node

EXPOSE 3000

# Liveness check baked into the image (uses Node's global fetch).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations are run as a separate init step (compose command / k8s initContainer),
# so the default command just starts the API.
CMD ["npx", "tsx", "src/server.ts"]
