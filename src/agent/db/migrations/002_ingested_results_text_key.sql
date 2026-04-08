-- ═══════════════════════════════════════════════════════════════
-- HITDASH — Migration 002
-- Adapta ingested_results para schema real de Ballbot (public.draws)
-- La tabla draws no tiene UUID — usamos clave compuesta TEXT:
--   "{game}:{period}:{YYYY-MM-DD}"  ej: "p3:m:2026-03-22"
-- ═══════════════════════════════════════════════════════════════

-- Recrear tabla con TEXT PK (sin datos en dev, DROP + CREATE es safe)
DROP TABLE IF EXISTS hitdash.ingested_results;

CREATE TABLE IF NOT EXISTS hitdash.ingested_results (
  draw_key         TEXT        PRIMARY KEY,  -- "{game}:{period}:{YYYY-MM-DD}"
  ingested_at      TIMESTAMPTZ DEFAULT now(),
  rag_knowledge_id UUID        REFERENCES hitdash.rag_knowledge(id) ON DELETE SET NULL
);
