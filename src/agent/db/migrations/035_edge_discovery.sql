-- ═══════════════════════════════════════════════════════════════
-- HELIX Migration 035 — Edge Discovery Engine v1
--
-- "HELIX F1 SIEMPRE LO HA SIDO" — aprendizaje adaptativo autónomo
-- didáctico. Que el sistema PRUEBE autónomamente si hay edge real
-- y reporte la verdad sin maquillaje.
--
-- Tests ejecutados periódicamente sobre datos limpios:
--   1. Per-algo Wilson CI vs baseline 15% (binomial one-sided)
--   2. χ² DOW bias (valida calendar_pattern)
--   3. Autocorrelation lag-1..lag-7 + Ljung-Box (valida Markov)
--   4. Pair persistence χ² (valida streak_reversal/gap_overdue)
--   5. KS test drift estabilidad temporal
--   6. Algorithm diversity (Spearman ranking correlation)
--
-- Corrección Bonferroni para múltiples tests: α=0.05/m
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS hitdash.edge_discovery_runs (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          TEXT         NOT NULL UNIQUE,
  started_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  status          TEXT         NOT NULL DEFAULT 'running',  -- running | completed | failed
  total_tests     INTEGER,
  significant_tests INTEGER,
  edge_found      BOOLEAN,
  verdict         TEXT,
  duration_ms     INTEGER,
  metadata        JSONB
);

CREATE TABLE IF NOT EXISTS hitdash.edge_hypothesis_tests (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                TEXT         NOT NULL,
  test_family           TEXT         NOT NULL,    -- 'algo_edge' | 'dow_bias' | 'autocorrelation' | 'pair_persistence' | 'drift_ks' | 'diversity'
  test_name             TEXT         NOT NULL,    -- specific identifier
  game_type             TEXT,
  draw_type             TEXT,
  half                  TEXT,
  scope                 JSONB,                    -- algo_name, lag, position, etc
  null_hypothesis       TEXT         NOT NULL,
  test_statistic        FLOAT        NOT NULL,
  p_value               FLOAT        NOT NULL,
  bonferroni_threshold  FLOAT        NOT NULL,
  significant           BOOLEAN      NOT NULL,
  effect_size           FLOAT,
  effect_size_metric    TEXT,                     -- 'cohen_h' | 'cramer_v' | 'r' | 'd_max'
  sample_size           INTEGER      NOT NULL,
  interpretation        TEXT         NOT NULL,    -- plain English verdict
  data                  JSONB,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_edge_tests_run         ON hitdash.edge_hypothesis_tests (run_id);
CREATE INDEX IF NOT EXISTS idx_edge_tests_family      ON hitdash.edge_hypothesis_tests (test_family, significant);
CREATE INDEX IF NOT EXISTS idx_edge_tests_significant ON hitdash.edge_hypothesis_tests (significant) WHERE significant = true;

COMMENT ON TABLE hitdash.edge_discovery_runs IS
  'Cada ejecución del Edge Discovery Engine — autonomous statistical proof.';

COMMENT ON TABLE hitdash.edge_hypothesis_tests IS
  'Tests estadísticos individuales con corrección Bonferroni. '
  'significant=true indica edge real con confianza >95% incluso después de corrección por múltiples comparaciones.';
