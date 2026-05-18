-- ═══════════════════════════════════════════════════════════════
-- HELIX — Migration 024: Tabla algo_edge_report (F1 Validation)
-- 2026-05-18
--
-- CONTEXTO:
--   StatisticalEdgeValidator computa hit_rate@N, z-score, Wilson CI
--   y veredictos de edge por algoritmo.
--   Esta tabla persiste el último reporte para consulta rápida
--   desde el dashboard sin re-computar contra algo_rank_history.
--
-- IDEMPOTENTE: CREATE TABLE IF NOT EXISTS + ON CONFLICT en validator.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS hitdash.algo_edge_report (
  algo_name      TEXT        PRIMARY KEY,
  total_n        INTEGER     NOT NULL DEFAULT 0,
  hr_n15         FLOAT       NOT NULL DEFAULT 0,   -- hit_rate @ N=15
  z_n15          FLOAT       NOT NULL DEFAULT 0,   -- z-score vs baseline 15%
  p_value_n15    FLOAT       NOT NULL DEFAULT 0.5, -- one-sided p-value
  wilson_lower   FLOAT       NOT NULL DEFAULT 0,   -- Wilson 95% CI lower
  roi_n15        FLOAT       NOT NULL DEFAULT -1,  -- ROI @ N=15 ($50 payout)
  has_edge       BOOLEAN     NOT NULL DEFAULT FALSE,
  verdict        TEXT        NOT NULL DEFAULT 'NOISE'
                             CHECK (verdict IN ('EDGE', 'NOISE', 'HARMFUL')),
  computed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE hitdash.algo_edge_report IS
  'Cache del último reporte de validación estadística de edge por algoritmo. '
  'Generado por StatisticalEdgeValidator (GET /api/agent/statistical-edge). '
  'Fuente de verdad: algo_rank_history. F1 validation.';

-- Índice para consultas rápidas del dashboard
CREATE INDEX IF NOT EXISTS idx_algo_edge_report_verdict
  ON hitdash.algo_edge_report (verdict, z_n15 DESC);

DO $$
BEGIN
  RAISE NOTICE 'Migration 024 completed: tabla algo_edge_report creada.';
END $$;
