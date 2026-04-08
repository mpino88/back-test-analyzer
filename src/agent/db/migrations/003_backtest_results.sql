-- ═══════════════════════════════════════════════════════════════
-- HITDASH — Migration 003
-- Tabla backtest_results: resultados de simulación histórica
-- por estrategia × game_type × mode
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS hitdash.backtest_results (
  id                    UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Identificación
  strategy_name         VARCHAR(100) NOT NULL,
  game_type             VARCHAR(10)  NOT NULL CHECK (game_type IN ('pick3','pick4')),
  mode                  VARCHAR(10)  NOT NULL CHECK (mode IN ('midday','evening','combined')),

  -- Configuración de la simulación
  max_combos            INT          NOT NULL DEFAULT 60,
  train_window_draws    INT          NOT NULL DEFAULT 90,
  eval_step_draws       INT          NOT NULL DEFAULT 7,
  total_evaluation_pts  INT          NOT NULL DEFAULT 0,

  -- Métricas de efectividad pick3 (centena + decena)
  hits_combination      INT          NOT NULL DEFAULT 0,   -- número exacto en los 60 combos
  hits_both             INT          NOT NULL DEFAULT 0,   -- centena Y decena correctas
  hits_centena          INT          NOT NULL DEFAULT 0,   -- solo centena correcta
  hits_decena           INT          NOT NULL DEFAULT 0,   -- solo decena correcta
  centena_plus_hits     INT          NOT NULL DEFAULT 0,   -- alto valor centena acertó

  -- Porcentajes
  effectiveness_pct     FLOAT        NOT NULL DEFAULT 0.0, -- hits_combination / total_pts
  centena_accuracy      FLOAT        NOT NULL DEFAULT 0.0,
  decena_accuracy       FLOAT        NOT NULL DEFAULT 0.0,
  both_accuracy         FLOAT        NOT NULL DEFAULT 0.0,
  centena_plus_accuracy FLOAT        NOT NULL DEFAULT 0.0,

  -- Metadatos
  date_from             DATE,
  date_to               DATE,
  run_duration_ms       INT          NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ  DEFAULT now(),
  updated_at            TIMESTAMPTZ  DEFAULT now()
);

-- Índice para consultas por estrategia + juego + modo
CREATE UNIQUE INDEX IF NOT EXISTS idx_backtest_strategy_mode
  ON hitdash.backtest_results (strategy_name, game_type, mode);

CREATE INDEX IF NOT EXISTS idx_backtest_effectiveness
  ON hitdash.backtest_results (effectiveness_pct DESC, both_accuracy DESC);

-- ─── TABLA auxiliar: puntos individuales del backtest ───────────────────────
-- Solo se guardan los puntos con hit para análisis de patrones
CREATE TABLE IF NOT EXISTS hitdash.backtest_points (
  id                UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  backtest_id       UUID        NOT NULL REFERENCES hitdash.backtest_results(id) ON DELETE CASCADE,
  eval_date         DATE        NOT NULL,
  draw_index        INT         NOT NULL,   -- posición en la secuencia histórica

  -- Predicción
  top_p1            INT[]       NOT NULL,   -- centena candidates (ordenados por score)
  top_p2            INT[]       NOT NULL,   -- decena candidates
  centena_plus      INT,                   -- alto valor centena (top 1)
  combinations      TEXT[],                -- muestra de 10 combos generados (no todos 60)

  -- Resultado real
  actual_p1         INT         NOT NULL,
  actual_p2         INT         NOT NULL,
  actual_p3         INT         NOT NULL,
  actual_number     VARCHAR(4)  NOT NULL,

  -- Resultado
  hit_combination   BOOLEAN     NOT NULL DEFAULT false,
  hit_both          BOOLEAN     NOT NULL DEFAULT false,
  hit_centena       BOOLEAN     NOT NULL DEFAULT false,
  hit_decena        BOOLEAN     NOT NULL DEFAULT false,
  hit_centena_plus  BOOLEAN     NOT NULL DEFAULT false,

  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_backtest_points_backtest
  ON hitdash.backtest_points (backtest_id, eval_date);

CREATE INDEX IF NOT EXISTS idx_backtest_points_hits
  ON hitdash.backtest_points (backtest_id, hit_both, hit_combination);
