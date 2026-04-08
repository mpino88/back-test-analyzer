-- ═══════════════════════════════════════════════════════════════
-- Migración 008: Tabla para resultados del ProgressiveEngine
-- Almacena el último resultado por (map_source, period) como JSONB.
-- Permite que el Analyser dashboard lea análisis sin re-calcular.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS hitdash.progressive_results (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  map_source   VARCHAR(2)   NOT NULL CHECK (map_source IN ('p3','p4')),
  period       VARCHAR(1)   NOT NULL CHECK (period IN ('m','e')),
  top_n        INT          NOT NULL DEFAULT 10,
  start_date   DATE         NOT NULL,
  end_date     DATE         NOT NULL,
  result_json  JSONB        NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ  DEFAULT now(),
  CONSTRAINT progressive_unique UNIQUE (map_source, period)
);

CREATE INDEX IF NOT EXISTS idx_progressive_lookup
  ON hitdash.progressive_results (map_source, period, created_at DESC);
