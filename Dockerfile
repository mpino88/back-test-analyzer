# syntax=docker/dockerfile:1
# ═══════════════════════════════════════════════════════════════
# HITDASH — Dockerfile (Node.js App)
# Multi-stage:
#   Stage 1 (frontend-builder): compila Vue 3 → /app/dist
#   Stage 2 (server-builder):   compila TypeScript → /app/dist-server
#   Stage 3 (runtime):          imagen final mínima, JS puro (sin ts-node)
#
# FIX OOM (2026-05-19): BuildKit cache mounts para npm.
#   Sin cache mounts: cada rebuild = 3× npm ci completos = pico 1.8GB RAM
#   Con cache mounts: npm ci cachea node_modules entre builds = pico ~350MB RAM
#   El cache de npm persiste en /var/cache/buildkit/npmcache entre deploys.
# ═══════════════════════════════════════════════════════════════

# ─── Stage 1: Build frontend Vue 3 ──────────────────────────────
FROM node:20-alpine AS frontend-builder

WORKDIR /app
COPY package*.json ./
# BuildKit cache mount: node_modules de deps reutilizados entre builds
# Cuando package.json NO cambia → esta capa viene del cache → 0 RAM extra
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --cache /root/.npm

# VITE_AGENT_API_KEY debe inyectarse en build-time para que Vite
# lo incluya en el bundle estático (import.meta.env.VITE_AGENT_API_KEY)
ARG VITE_AGENT_API_KEY
ENV VITE_AGENT_API_KEY=$VITE_AGENT_API_KEY

COPY . .
RUN npm run build:client

# ─── Stage 2: Compilar TypeScript del servidor ──────────────────
# Genera JS puro en /app/dist-server para que el runtime
# no dependa de ts-node (más rápido, más estable, menos RAM).
FROM node:20-alpine AS server-builder

WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --cache /root/.npm

COPY src ./src
COPY tsconfig.server.json ./
# Override outDir a dist-server para no colisionar con /app/dist (frontend)
RUN npx tsc -p tsconfig.server.json --outDir dist-server

# ─── Stage 3: Runtime mínimo ────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

# Solo dependencias de producción — sin typescript ni ts-node
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts --cache /root/.npm

# JS compilado del servidor (rootDir=src → dist-server/{server,agent}/...)
COPY --from=server-builder /app/dist-server ./dist-server

# Frontend estático
COPY --from=frontend-builder /app/dist ./dist

# Migrations SQL: deben quedar donde __dirname del migrate.js compilado
# apunta. migrate.ts usa fileURLToPath(import.meta.url), y el .js estará
# en dist-server/agent/db/migrate.js → busca migrations en dist-server/agent/db/migrations/
COPY src/agent/db/migrations ./dist-server/agent/db/migrations

# Usuario no-root
RUN addgroup -S bliss && adduser -S bliss -G bliss
RUN chown -R bliss:bliss /app
USER bliss

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

# Ejecutar JS compilado — arranque instantáneo sin overhead de compilación
CMD ["node", "dist-server/server/index.js"]
