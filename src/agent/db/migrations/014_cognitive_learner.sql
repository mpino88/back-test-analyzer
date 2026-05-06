-- ═══════════════════════════════════════════════════════════════
-- HITDASH — Migration 014: CognitiveLearner
-- Auto-aprendizaje cognitivo desde TODO el historial.
--
-- Tablas nuevas:
--   cognitive_learning_runs  → registro de ejecuciones del learner
--   cognitive_algo_weights   → pesos óptimos aprendidos por optimización
--
-- El CognitiveLearner no necesita snapshots previos: simula
-- retrospectivamente lo que cada algoritmo habría predicho para
-- cada sorteo histórico y calcula su PPS real desde el pasado.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. Registro de ejecuciones del learner ──────────────────────
CREATE TABLE IF NOT EXISTS hitdash.cognitive_learning_runs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  game_type     TEXT        NOT NULL    CHECK (game_type IN ('pick3', 'pick4')),
  draw_type     TEXT        NOT NULL    CHECK (draw_type IN ('midday', 'evening')),
  half          VARCHAR(2)  NOT NULL    CHECK (half IN ('du', 'ab', 'cd')),
  draws_learned INTEGER     NOT NULL    DEFAULT 0,
  algos_updated INTEGER     NOT NULL    DEFAULT 0,
  -- Métricas de la optimización
  best_hit_rate FLOAT,
  best_top_n    INTEGER,
  best_roi      FLOAT,
  -- Estado
  status        TEXT        NOT NULL    DEFAULT 'running'
                            CHECK (status IN ('running', 'completed', 'failed')),
  error_message TEXT,
  started_at    TIMESTAMPTZ NOT NULL    DEFAULT now(),
  completed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cognitive_runs_lookup
  ON hitdash.cognitive_learning_runs (game_type, draw_type, half, started_at DESC);

-- ── 2. Pesos óptimos aprendidos por el optimizador ──────────────
-- Resultado de WeightOptimizer: combinación de los 20 algoritmos
-- que maximiza hit_rate en el holdout histórico.
-- Reemplaza los pesos base estáticos de ALGORITHM_WEIGHTS.
CREATE TABLE IF NOT EXISTS hitdash.cognitive_algo_weights (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  algo_name     TEXT        NOT NULL,
  game_type     TEXT        NOT NULL    CHECK (game_type IN ('pick3', 'pick4')),
  draw_type     TEXT        NOT NULL    CHECK (draw_type IN ('midday', 'evening')),
  half          VARCHAR(2)  NOT NULL    CHECK (half IN ('du', 'ab', 'cd')),
  -- Peso aprendido (0.0 = sin valor, 2.0 = máximo)
  learned_weight FLOAT      NOT NULL    DEFAULT 1.0,
  -- Métricas de validación (holdout 20% del historial)
  holdout_hit_rate    FLOAT,
  holdout_avg_rank    FLOAT,
  historical_pps      FLOAT,   -- PPS calculado desde toda la historia
  sample_draws        INTEGER, -- sorteos usados para aprender
  -- Metadatos
  run_id      UUID        REFERENCES hitdash.cognitive_learning_runs(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (algo_name, game_type, draw_type, half)
);

CREATE INDEX IF NOT EXISTS idx_cognitive_weights_lookup
  ON hitdash.cognitive_algo_weights (game_type, draw_type, half);
