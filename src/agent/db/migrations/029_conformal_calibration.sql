-- ═══════════════════════════════════════════════════════════════
-- HELIX Migration 029 — Conformal Calibration Table
--
-- Phase 4 of the HELIX predictive engine upgrade.
-- Stores conformal prediction calibration thresholds per
-- algorithm / context combination.
--
-- THEOREM GUARANTEE (Angelopoulos & Bates, 2023):
--   Given n calibration examples exchangeably drawn, the
--   conformal prediction set satisfies:
--     P(y_true ∈ C(x)) ≥ 1 - α   (marginal, exact)
--   under no distributional assumptions beyond exchangeability.
--
-- threshold_80: rank threshold for 80% guaranteed coverage
--   → All pairs with algo rank ≤ threshold_80 are in the set
--   → P(winner ∈ set) ≥ 0.80 by theorem
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS hitdash.conformal_calibration (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  game_type       TEXT        NOT NULL,
  draw_type       TEXT        NOT NULL,
  half            TEXT        NOT NULL,
  algo_name       TEXT        NOT NULL,
  n_calibration   INTEGER     NOT NULL,
  threshold_80    FLOAT       NOT NULL,  -- rank threshold for P(hit) ≥ 0.80
  threshold_90    FLOAT       NOT NULL,  -- rank threshold for P(hit) ≥ 0.90
  threshold_95    FLOAT       NOT NULL,  -- rank threshold for P(hit) ≥ 0.95
  empirical_80    FLOAT       NOT NULL,  -- observed coverage at threshold_80
  empirical_90    FLOAT       NOT NULL,  -- observed coverage at threshold_90
  calibrated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (game_type, draw_type, half, algo_name)
);

CREATE INDEX IF NOT EXISTS idx_conformal_lookup
  ON hitdash.conformal_calibration (game_type, draw_type, half);

COMMENT ON TABLE hitdash.conformal_calibration IS
  'Conformal prediction calibration thresholds per algo/combo. '
  'Phase 4 of HELIX v2. Guarantees marginal coverage ≥ 1-α by theorem.';

COMMENT ON COLUMN hitdash.conformal_calibration.threshold_80 IS
  'Conformal rank threshold: all pairs with rank <= threshold are in the '
  'prediction set, guaranteeing P(winner in set) >= 0.80 by the '
  'conformal prediction theorem (exchangeability assumption).';

COMMENT ON COLUMN hitdash.conformal_calibration.empirical_80 IS
  'Observed fraction of calibration draws where rank_of_winner <= threshold_80. '
  'Should be >= 0.80 by construction.';

COMMENT ON COLUMN hitdash.conformal_calibration.n_calibration IS
  'Number of draws used for calibration. Larger n → tighter confidence '
  'on the coverage guarantee. Recommended: >= 100 draws.';
