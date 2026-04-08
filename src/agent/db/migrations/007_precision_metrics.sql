-- ═══════════════════════════════════════════════════════════════
-- Migración 007: Métricas de precisión matemática en backtest v2
--
-- Añade 15 valores que multiplican el aprendizaje cognitivo:
--   MRR, Expected Rank, Brier Score, Precision@K (3/5/10)
--   Wilson CI, Cohen's h, p-value, CV, Sharpe, Max Miss Streak
--   Kelly Fraction, Autocorrelación lag-1
--
-- backtest_points_v2: agrega rank + score del par real por eval point
-- ═══════════════════════════════════════════════════════════════

-- ─── backtest_results_v2: métricas de precisión global ───────────
ALTER TABLE hitdash.backtest_results_v2

  -- Calidad de ranking (el par real, ¿en qué posición cae?)
  ADD COLUMN IF NOT EXISTS mrr              FLOAT NOT NULL DEFAULT 0.0,   -- Mean Reciprocal Rank [0,1]
  ADD COLUMN IF NOT EXISTS expected_rank    FLOAT NOT NULL DEFAULT 50.0,  -- Rank promedio del par real (1–100)

  -- Calibración (¿el score asignado predice la realidad?)
  ADD COLUMN IF NOT EXISTS brier_score      FLOAT NOT NULL DEFAULT 0.25,  -- Brier Score [0,1], lower=better

  -- Precision@K (¿qué % de veces el par real está en el top-K?)
  ADD COLUMN IF NOT EXISTS precision_at_3   FLOAT NOT NULL DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS precision_at_5   FLOAT NOT NULL DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS precision_at_10  FLOAT NOT NULL DEFAULT 0.0,

  -- Intervalo de confianza Wilson al 95%
  ADD COLUMN IF NOT EXISTS wilson_lower     FLOAT NOT NULL DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS wilson_upper     FLOAT NOT NULL DEFAULT 1.0,

  -- Significancia estadística vs baseline random (10%)
  ADD COLUMN IF NOT EXISTS cohens_h         FLOAT NOT NULL DEFAULT 0.0,   -- Effect size
  ADD COLUMN IF NOT EXISTS p_value          FLOAT NOT NULL DEFAULT 1.0,   -- Binomial p-value

  -- Estabilidad de la señal
  ADD COLUMN IF NOT EXISTS cv_hit_rate      FLOAT NOT NULL DEFAULT 0.0,   -- Coef. de variación (std/mean)
  ADD COLUMN IF NOT EXISTS sharpe           FLOAT NOT NULL DEFAULT 0.0,   -- hit_rate / std_rolling

  -- Resistencia y momentum
  ADD COLUMN IF NOT EXISTS max_miss_streak  INT   NOT NULL DEFAULT 0,     -- Mayor racha consecutiva de misses
  ADD COLUMN IF NOT EXISTS autocorr_lag1    FLOAT NOT NULL DEFAULT 0.0,   -- Autocorr hits lag-1

  -- Fracción óptima de cobertura (Kelly)
  ADD COLUMN IF NOT EXISTS kelly_fraction   FLOAT NOT NULL DEFAULT 0.0;   -- Fracción Kelly [0,1]

-- ─── backtest_points_v2: rank y score del par real por punto ─────
ALTER TABLE hitdash.backtest_points_v2
  ADD COLUMN IF NOT EXISTS actual_pair_rank  INT   NOT NULL DEFAULT 100,  -- Posición (1–100) del par real
  ADD COLUMN IF NOT EXISTS actual_pair_score FLOAT NOT NULL DEFAULT 0.0,  -- Score normalizado [0,1] del par real
  ADD COLUMN IF NOT EXISTS reciprocal_rank   FLOAT NOT NULL DEFAULT 0.01; -- 1 / actual_pair_rank
