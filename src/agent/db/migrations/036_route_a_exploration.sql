-- ═══════════════════════════════════════════════════════════════
-- HELIX Migration 036 — Route A Surgical Exploration (2026-05-21)
--
-- POST Edge Discovery v2: 187 tests + DeepDive → 0/9 sobrevive Bonferroni.
-- Los 21 algoritmos canónicos no detectan edge. PERO no testeamos:
--   • Sum-of-digits distribution (sesgo físico)
--   • Within-draw adjacency (¿p2|p1?)
--   • Higher-order Markov lag-2
--   • Day-of-month bias (no solo DOW)
--   • Month/seasonal
--   • Pair anti-symmetry (P(23) vs P(32))
--   • Pair-level autocorrelation (índice 0-99, no posición digit)
--
-- Si CUALQUIERA de estos 7 cruza Bonferroni → señal nueva descubierta.
-- Si TODOS fallan → cementamos honestamente que el sistema no tiene edge
-- en estas 7 dimensiones adicionales. Total acumulado:
--   • 187 tests originales (Discovery v1+v2)
--   • 9 deep dives confirmatorios
--   • +N tests Route A
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS hitdash.route_a_exploration_runs (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          TEXT         NOT NULL UNIQUE,
  started_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  status          TEXT         NOT NULL DEFAULT 'running',
  total_tests     INTEGER,
  significant_tests INTEGER,
  candidates_for_validation INTEGER,
  edge_found      BOOLEAN,
  verdict         TEXT,
  duration_ms     INTEGER,
  metadata        JSONB
);

CREATE TABLE IF NOT EXISTS hitdash.route_a_exploration_tests (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                TEXT         NOT NULL,
  feature_family        TEXT         NOT NULL,
  test_name             TEXT         NOT NULL,
  game_type             TEXT,
  draw_type             TEXT,
  scope                 JSONB,
  null_hypothesis       TEXT         NOT NULL,
  test_statistic        FLOAT        NOT NULL,
  p_value               FLOAT        NOT NULL,
  bonferroni_threshold  FLOAT        NOT NULL,
  significant           BOOLEAN      NOT NULL,
  effect_size           FLOAT,
  effect_size_metric    TEXT,
  sample_size           INTEGER      NOT NULL,
  -- Holdout validation: si test pasa en train, validar en test
  train_p_value         FLOAT,
  test_p_value          FLOAT,
  replicates_in_holdout BOOLEAN,
  interpretation        TEXT         NOT NULL,
  data                  JSONB,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_route_a_tests_run         ON hitdash.route_a_exploration_tests (run_id);
CREATE INDEX IF NOT EXISTS idx_route_a_tests_family      ON hitdash.route_a_exploration_tests (feature_family, significant);
CREATE INDEX IF NOT EXISTS idx_route_a_tests_significant ON hitdash.route_a_exploration_tests (significant) WHERE significant = true;
CREATE INDEX IF NOT EXISTS idx_route_a_tests_replicates  ON hitdash.route_a_exploration_tests (replicates_in_holdout) WHERE replicates_in_holdout = true;

COMMENT ON TABLE hitdash.route_a_exploration_tests IS
  'Route A — feature exploration tests. replicates_in_holdout=true es la firma de edge real.';
