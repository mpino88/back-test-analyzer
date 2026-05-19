-- ═══════════════════════════════════════════════════════════════
-- HELIX Migration 028 — Thompson Sampling State Table
--
-- Phase 3 of the HELIX predictive engine upgrade.
-- Stores the Beta distribution parameters (alpha, beta_param)
-- per algorithm per context (game_type, draw_type, half, n_at).
--
-- These parameters accumulate over time as PostDrawProcessor
-- updates hits/misses after each real draw, enabling Bayesian
-- online learning without re-querying the full history.
--
-- alpha     = cumulative_hits + 1  (uniform prior, a=1)
-- beta_param = cumulative_misses + 1
-- n_at       = hit threshold (default 15 — top-15 counts as hit)
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS hitdash.thompson_state (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  algo_name   TEXT        NOT NULL,
  game_type   TEXT        NOT NULL,
  draw_type   TEXT        NOT NULL,
  half        TEXT        NOT NULL,
  n_at        INTEGER     NOT NULL DEFAULT 15,
  alpha       FLOAT       NOT NULL DEFAULT 1.0,   -- hits + 1
  beta_param  FLOAT       NOT NULL DEFAULT 1.0,   -- misses + 1
  n_total     INTEGER     NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (algo_name, game_type, draw_type, half, n_at)
);

CREATE INDEX IF NOT EXISTS idx_thompson_lookup
  ON hitdash.thompson_state (game_type, draw_type, half, n_at);

COMMENT ON TABLE hitdash.thompson_state IS
  'Thompson Sampling Beta distribution parameters per algo. '
  'Phase 3 of HELIX predictive engine upgrade. '
  'alpha = cumulative_hits + 1, beta_param = cumulative_misses + 1.';

COMMENT ON COLUMN hitdash.thompson_state.alpha       IS 'hits + 1 (Laplace/uniform prior)';
COMMENT ON COLUMN hitdash.thompson_state.beta_param  IS 'misses + 1';
COMMENT ON COLUMN hitdash.thompson_state.n_at        IS 'Hit threshold: rank_of_winner <= n_at counts as a hit';
COMMENT ON COLUMN hitdash.thompson_state.n_total     IS 'Total observations seen so far (alpha + beta - 2)';
