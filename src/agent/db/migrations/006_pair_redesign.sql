-- ═══════════════════════════════════════════════════════════════
-- Migración 006: Pair-based redesign
--   1. Extender adaptive_weights con top_n y hit_rate_history
--   2. Crear backtest_results_v2 y backtest_points_v2
--   3. Registrar estrategias v2 en strategy_registry
-- ═══════════════════════════════════════════════════════════════

-- ─── 1. Extender adaptive_weights ────────────────────────────────
ALTER TABLE hitdash.adaptive_weights
  ADD COLUMN IF NOT EXISTS top_n
    INT NOT NULL DEFAULT 15
    CONSTRAINT top_n_range CHECK (top_n BETWEEN 1 AND 50),
  ADD COLUMN IF NOT EXISTS hit_rate_history
    JSONB NOT NULL DEFAULT '[]';

-- Seed top_n=15 en filas existentes (ya tienen DEFAULT, solo por claridad)
UPDATE hitdash.adaptive_weights SET top_n = 15 WHERE top_n IS NULL;

-- ─── 2. backtest_results_v2 ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS hitdash.backtest_results_v2 (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_name       VARCHAR(100) NOT NULL,
  game_type           VARCHAR(10)  NOT NULL CHECK (game_type IN ('pick3','pick4')),
  mode                VARCHAR(10)  NOT NULL CHECK (mode IN ('midday','evening','combined')),
  half                VARCHAR(2)   NOT NULL CHECK (half IN ('du','ab','cd')),
  train_window_draws  INT          NOT NULL DEFAULT 90,
  eval_step_draws     INT          NOT NULL DEFAULT 7,
  total_eval_pts      INT          NOT NULL DEFAULT 0,
  hits_pair           INT          NOT NULL DEFAULT 0,
  centena_plus_hits   INT          NOT NULL DEFAULT 0,
  hit_rate            FLOAT        NOT NULL DEFAULT 0.0,
  centena_plus_acc    FLOAT        NOT NULL DEFAULT 0.0,
  avg_top_n           FLOAT        NOT NULL DEFAULT 15.0,
  final_top_n         INT          NOT NULL DEFAULT 15,
  date_from           DATE,
  date_to             DATE,
  run_duration_ms     INT          NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ  DEFAULT now(),
  updated_at          TIMESTAMPTZ  DEFAULT now(),
  CONSTRAINT backtest_v2_unique UNIQUE (strategy_name, game_type, mode, half)
);

CREATE INDEX IF NOT EXISTS idx_backtest_v2_lookup
  ON hitdash.backtest_results_v2 (game_type, mode, half, hit_rate DESC);

-- ─── 3. backtest_points_v2 ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS hitdash.backtest_points_v2 (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  backtest_id       UUID        NOT NULL
                      REFERENCES hitdash.backtest_results_v2(id) ON DELETE CASCADE,
  eval_date         DATE        NOT NULL,
  draw_index        INT         NOT NULL,
  top_pairs         TEXT[]      NOT NULL,
  centena_plus      INT,
  actual_pair       VARCHAR(2)  NOT NULL,
  hit_pair          BOOLEAN     NOT NULL DEFAULT false,
  hit_centena_plus  BOOLEAN     NOT NULL DEFAULT false,
  top_n_used        INT         NOT NULL DEFAULT 15,
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_backtest_points_v2_backtest
  ON hitdash.backtest_points_v2 (backtest_id, eval_date);

CREATE INDEX IF NOT EXISTS idx_backtest_points_v2_hits
  ON hitdash.backtest_points_v2 (backtest_id, hit_pair);
