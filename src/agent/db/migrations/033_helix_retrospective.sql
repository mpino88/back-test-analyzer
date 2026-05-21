-- ═══════════════════════════════════════════════════════════════
-- HELIX Migration 033 — Walk-Forward Retrospective Tables
--
-- Crítica de inversores (2026-05-21):
--   "No tienen historial retrospectivo de validación de efectividad.
--    El autoaprendizaje debió hacerse retrospectivo. Al día de hoy
--    el sistema está completamente ciego."
--
-- RESPUESTA: replay walk-forward del pipeline HELIX v2 completo
-- sobre 5+ años de datos (algo_prediction_snapshot desde 2021-05-16).
-- Sin future leakage. Cada predicción en T usa solo [start, T-1].
--
-- TABLAS:
--   helix_retrospective_runs    — fila por draw simulado
--   helix_retrospective_summary — agregado por (run_id, combo)
--
-- USO:
--   POST /api/agent/retrospective/helix-v2/run  (async, devuelve run_id)
--   GET  /api/agent/retrospective/helix-v2/summary?run_id=X
--   GET  /api/agent/retrospective/helix-v2/timeseries?run_id=X
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS hitdash.helix_retrospective_runs (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            TEXT         NOT NULL,
  game_type         TEXT         NOT NULL,
  draw_type         TEXT         NOT NULL,
  half              TEXT         NOT NULL,
  draw_date         DATE         NOT NULL,
  draw_seq          INTEGER      NOT NULL,         -- ordinal en el run
  predicted_top     TEXT[]       NOT NULL,         -- top-N pairs HELIX habría escogido
  predicted_n       INTEGER      NOT NULL,         -- |predicted_top|
  conformal_thr     FLOAT,                          -- rank threshold para 80%
  regime            TEXT         NOT NULL,         -- NORMAL | HAWKES | EVT_HIGH
  apex_algo         TEXT,                          -- líder consensus (Thompson UCB)
  actual_pair       TEXT         NOT NULL,         -- ganador real
  hit               BOOLEAN      NOT NULL,         -- predicted_top.includes(actual_pair)
  consensus_rank    INTEGER,                       -- posición del ganador en consensus
  thompson_window   INTEGER      NOT NULL,         -- días de historia usados (90 default)
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_helix_retro_run_combo
  ON hitdash.helix_retrospective_runs (run_id, game_type, draw_type, half, draw_date);

CREATE INDEX IF NOT EXISTS idx_helix_retro_run_date
  ON hitdash.helix_retrospective_runs (run_id, draw_date);

CREATE TABLE IF NOT EXISTS hitdash.helix_retrospective_summary (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            TEXT         NOT NULL,
  game_type         TEXT         NOT NULL,
  draw_type         TEXT         NOT NULL,
  half              TEXT         NOT NULL,
  -- Cantidades
  n_draws           INTEGER      NOT NULL,
  n_hits            INTEGER      NOT NULL,
  -- Métricas core
  hit_rate          FLOAT        NOT NULL,
  wilson_lo         FLOAT        NOT NULL,         -- 95% CI lower
  wilson_hi         FLOAT        NOT NULL,         -- 95% CI upper
  baseline_rate     FLOAT        NOT NULL,         -- top_n/100
  edge_pp           FLOAT        NOT NULL,         -- hit_rate - baseline (puntos %)
  edge_multiplier   FLOAT        NOT NULL,         -- hit_rate / baseline
  -- Calidad estadística
  mrr               FLOAT,                          -- mean reciprocal rank
  median_rank       FLOAT,                          -- mediana del consensus_rank
  conformal_emp_80  FLOAT,                          -- cobertura empírica del threshold 80
  -- Régimen distribution
  pct_normal        FLOAT,
  pct_hawkes        FLOAT,
  pct_evt           FLOAT,
  -- Period
  date_from         DATE         NOT NULL,
  date_to           DATE         NOT NULL,
  -- Audit
  duration_ms       INTEGER      NOT NULL,
  metadata          JSONB,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (run_id, game_type, draw_type, half)
);

CREATE INDEX IF NOT EXISTS idx_helix_retro_summary_lookup
  ON hitdash.helix_retrospective_summary (run_id, game_type, draw_type, half);

COMMENT ON TABLE hitdash.helix_retrospective_runs IS
  'Walk-forward replay del pipeline HELIX v2 sobre datos históricos. '
  'Cada fila = predicción en T usando solo data [start, T-1]. '
  'Sin future leakage. Garantía estricta de validación auditable.';

COMMENT ON TABLE hitdash.helix_retrospective_summary IS
  'Métricas agregadas por run/combo. Permite responder a inversores: '
  '"¿Cuál es la hit rate sostenida del sistema sobre 5 años?" en O(1).';

COMMENT ON COLUMN hitdash.helix_retrospective_summary.edge_multiplier IS
  'hit_rate / baseline. >1.0 = edge real. Reportar a inversores como '
  '"X.Xx mejor que el azar" (ej. 2.14x significa 32% vs 15% baseline).';
