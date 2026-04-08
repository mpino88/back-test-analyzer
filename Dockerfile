# ═══════════════════════════════════════════════════════════════
# HITDASH — Dockerfile (Node.js App)
# Multi-stage: build frontend Vue 3 + runtime servidor Express
# ═══════════════════════════════════════════════════════════════

# ─── Stage 1: Build frontend Vue 3 ──────────────────────────────
FROM node:20-alpine AS frontend-builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build:client

# ─── Stage 2: Runtime servidor Express ──────────────────────────
FROM node:20-alpine AS runtime

# ts-node para ejecutar TypeScript directamente
RUN npm install -g ts-node typescript

WORKDIR /app

# Solo dependencias de producción
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# Código del servidor y del agente
COPY src/agent ./src/agent
COPY src/server ./src/server
COPY tsconfig.server.json ./

# Frontend build del stage anterior
COPY --from=frontend-builder /app/dist ./dist

# SQL migrations
COPY src/agent/db/migrations ./src/agent/db/migrations

# Usuario no-root para seguridad
RUN addgroup -S bliss && adduser -S bliss -G bliss
RUN chown -R bliss:bliss /app
USER bliss

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "--loader", "ts-node/esm", "src/server/index.ts"]
