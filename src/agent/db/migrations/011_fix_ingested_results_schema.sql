-- ═══════════════════════════════════════════════════════════════
-- Migración 011: Sincronización de esquema Ingested Results
--
-- FALLA F03 FORENSE: IngestionWorker requiere almacenar los dígitos
-- y metadatos del sorteo (p1, p2, p3, p4, draw_date, game_type, draw_type)
-- para el Feedback Loop y el PostDrawProcessor.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE hitdash.ingested_results
  ADD COLUMN IF NOT EXISTS p1 integer,
  ADD COLUMN IF NOT EXISTS p2 integer,
  ADD COLUMN IF NOT EXISTS p3 integer,
  ADD COLUMN IF NOT EXISTS p4 integer,
  ADD COLUMN IF NOT EXISTS draw_date date,
  ADD COLUMN IF NOT EXISTS game_type text,
  ADD COLUMN IF NOT EXISTS draw_type text;

-- Agregar índices para acelerar búsquedas de feedback y dashboards
CREATE INDEX IF NOT EXISTS idx_ingested_results_date ON hitdash.ingested_results(draw_date);
CREATE INDEX IF NOT EXISTS idx_ingested_results_context ON hitdash.ingested_results(game_type, draw_type);

-- Comentario informativo
COMMENT ON TABLE hitdash.ingested_results IS 'Registro de sorteos procesados por RAG y el motor de ingesta';
