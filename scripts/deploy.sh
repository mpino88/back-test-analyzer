#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# HITDASH — Deploy script (VPS)
# Ejecutar desde el directorio del proyecto en el VPS
# ═══════════════════════════════════════════════════════════════

set -e
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

log()  { echo -e "${GREEN}▶${NC} $1"; }
warn() { echo -e "${YELLOW}⚠️${NC}  $1"; }
die()  { echo -e "${RED}❌${NC} $1"; exit 1; }

[ -f ".env" ] || die ".env no encontrado. Copiar .env.example → .env y completar."

log "Pre-flight check..."
bash scripts/vps-preflight.sh || die "Pre-flight fallido"

log "Pulling imágenes Docker..."
docker compose pull --quiet 2>/dev/null || true

log "Build de la imagen bliss-server..."
docker compose build hitdash-server

log "Levantando contenedores (detached)..."
docker compose up -d

log "Esperando que los servicios estén healthy..."
sleep 15

log "Ejecutando migraciones de schema..."
docker compose exec hitdash-server node --loader ts-node/esm src/agent/db/migrate.ts

log "Verificando health endpoint..."
sleep 5
curl -sf http://localhost:3001/health | python3 -m json.tool || warn "Health endpoint no responde aún — puede necesitar más tiempo"

echo ""
echo "════════════════════════════════════════════"
echo -e "${GREEN}✅ Deploy completado${NC}"
echo "   Dashboard: https://dash.ballbot.tel"
echo "   Health:    http://localhost:3001/health"
echo "   Logs:      docker compose logs -f hitdash-server"
echo "════════════════════════════════════════════"
echo ""
echo "Próximo paso — Seed inicial (puede tomar 15-30 min):"
echo "  docker compose exec hitdash-server node --loader ts-node/esm src/agent/scripts/seed-rag.ts"
