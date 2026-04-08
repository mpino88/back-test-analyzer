#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# HITDASH — VPS Pre-flight (Rocky Linux + Nginx + Docker)
# Ejecutar en el VPS desde el directorio del proyecto:
#   bash scripts/vps-preflight.sh
# ═══════════════════════════════════════════════════════════════

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
PASS=0; WARN=0; FAIL=0

ok()   { echo -e "${GREEN}✅ OK${NC}    $1"; ((PASS++)); }
warn() { echo -e "${YELLOW}⚠️  WARN${NC}  $1"; ((WARN++)); }
fail() { echo -e "${RED}❌ FAIL${NC}  $1"; ((FAIL++)); }

check() {
  local label="$1"; local cmd="$2"; local req="${3:-required}"
  if eval "$cmd" &>/dev/null; then ok "$label"
  elif [ "$req" = "required" ]; then fail "$label"
  else warn "$label (opcional)"; fi
}

echo ""
echo "════════════════════════════════════════════"
echo "  HITDASH — VPS Pre-flight Check"
echo "  Subdominio: dash.ballbot.tel"
echo "════════════════════════════════════════════"
echo ""

echo "── Sistema ─────────────────────────────────"
check "Rocky Linux" "grep -q 'rocky' /etc/os-release"
check "Docker daemon activo" "docker info"
check "Docker Compose v2" "docker compose version"
check "Node.js >= 20" "node -e 'process.exit(parseInt(process.versions.node)>=20?0:1)'"
check "Nginx activo" "systemctl is-active nginx"

echo ""
echo "── Puertos libres (necesarios) ─────────────"
check "Puerto 3001 libre en localhost" "! ss -tlnp | grep -q ':3001'"
check "Puerto 5433 libre en localhost" "! ss -tlnp | grep -q ':5433'"
check "Puerto 6380 libre en localhost" "! ss -tlnp | grep -q ':6380'"

echo ""
echo "── Imágenes Docker ─────────────────────────"
check "Imagen pgvector/pgvector:pg16" \
  "docker image inspect pgvector/pgvector:pg16" optional
check "Imagen redis:7-alpine" \
  "docker image inspect redis:7-alpine" optional

echo ""
echo "── .env configurado ────────────────────────"
if [ ! -f ".env" ]; then
  fail ".env no encontrado — copiar desde .env.example y completar"
else
  check "POSTGRES_PASSWORD definida" "grep -q 'POSTGRES_PASSWORD=.' .env"
  check "REDIS_PASSWORD definida" "grep -q 'REDIS_PASSWORD=.' .env"
  check "BALLBOT_DATABASE_URL definida" "grep -q 'BALLBOT_DATABASE_URL=.' .env"
  check "GEMINI_API_KEY definida" "grep -q 'GEMINI_API_KEY=.' .env"
  check "ANTHROPIC_API_KEY definida" "grep -q 'ANTHROPIC_API_KEY=.' .env"
  check "TELEGRAM_BOT_TOKEN definida" "grep -q 'TELEGRAM_BOT_TOKEN=.' .env"
  check "TELEGRAM_CHAT_ID definida" "grep -q 'TELEGRAM_CHAT_ID=.' .env"
fi

echo ""
echo "── Nginx conf disponible ───────────────────"
check "Archivo nginx conf en conf.d" \
  "test -f /etc/nginx/conf.d/dash.ballbot.tel.conf" optional
check "Nginx config válida" "nginx -t" optional

echo ""
echo "── Conectividad Ballbot (Render) ───────────"
if [ -f ".env" ]; then
  source .env 2>/dev/null
  check "Ballbot DB accesible (READ-ONLY)" \
    "psql \"$BALLBOT_DATABASE_URL\" -c 'SELECT 1' -t" optional
fi

echo ""
echo "════════════════════════════════════════════"
echo -e "  ${GREEN}✅ $PASS${NC}  |  ${YELLOW}⚠️  $WARN${NC}  |  ${RED}❌ $FAIL${NC}"
echo "════════════════════════════════════════════"
if [ $FAIL -gt 0 ]; then
  echo "❌ Resolver los FAIL antes de continuar"; exit 1
else
  echo "✅ Listo para deployment"; exit 0
fi
