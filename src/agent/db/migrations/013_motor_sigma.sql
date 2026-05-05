-- ═══════════════════════════════════════════════════════════════
-- HITDASH — Migration 013: MOTOR-Σ
-- Self-Calibrating Predictive Pair Engine
--
-- Tres tablas nuevas:
--   algo_prediction_snapshot  → captura scores por par por algo en cada predicción
--   pps_state                 → estado actual del PPS (Predictive Power Score) por algo
--   algo_rank_history         → historial: en qué rank aterrizó el ganador por algo por sorteo
--
-- El PPS es la señal de aprendizaje real:
--   PPS(algo) = EMA(101 − rank_ganador, α=0.15)
--   Rango: 0 (siempre falla) → 100 (siempre predice rank 1)
--   Inicial: 50.0 (neutral)
-- ═══════════════════════════════════════════════════════════════

-- ── 1. Snapshot de scores por algoritmo en cada predicción ──────
-- Permite reconstruir el ranking post-sorteo sin re-ejecutar los algos.
-- pair_scores = {"37": 0.85, "45": 0.72, ...} scores normalizados 0–1
CREATE TABLE IF NOT EXISTS hitdash.algo_prediction_snapshot (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  game_type   TEXT        NOT NULL    CHECK (game_type IN ('pick3', 'pick4')),
  draw_type   TEXT        NOT NULL    CHECK (draw_type IN ('midday', 'evening')),
  draw_date   DATE        NOT NULL,
  half        VARCHAR(2)  NOT NULL    CHECK (half IN ('du', 'ab', 'cd')),
  algo_name   TEXT        NOT NULL,
  pair_scores JSONB       NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL    DEFAULT now(),

  UNIQUE (game_type, draw_type, draw_date, half, algo_name)
);

CREATE INDEX IF NOT EXISTS idx_algo_snapshot_lookup
  ON hitdash.algo_prediction_snapshot (game_type, draw_type, draw_date, half);

-- ── 2. Estado actual del PPS por algoritmo ──────────────────────
CREATE TABLE IF NOT EXISTS hitdash.pps_state (
  algo_name    TEXT        NOT NULL,
  game_type    TEXT        NOT NULL    CHECK (game_type IN ('pick3', 'pick4')),
  draw_type    TEXT        NOT NULL    CHECK (draw_type IN ('midday', 'evening')),
  half         VARCHAR(2)  NOT NULL    CHECK (half IN ('du', 'ab', 'cd')),
  pps          FLOAT       NOT NULL    DEFAULT 50.0,
  sample_count INTEGER     NOT NULL    DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL    DEFAULT now(),

  PRIMARY KEY (algo_name, game_type, draw_type, half)
);

-- ── 3. Historial diario: rank del ganador por algoritmo ─────────
-- "En el sorteo del 2026-05-01, Frequency puso al par ganador en rank 8"
CREATE TABLE IF NOT EXISTS hitdash.algo_rank_history (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  algo_name      TEXT        NOT NULL,
  game_type      TEXT        NOT NULL    CHECK (game_type IN ('pick3', 'pick4')),
  draw_type      TEXT        NOT NULL    CHECK (draw_type IN ('midday', 'evening')),
  draw_date      DATE        NOT NULL,
  half           VARCHAR(2)  NOT NULL    CHECK (half IN ('du', 'ab', 'cd')),
  winning_pair   VARCHAR(2)  NOT NULL,
  rank_of_winner INTEGER     NOT NULL    CHECK (rank_of_winner BETWEEN 1 AND 101),
  pps_before     FLOAT       NOT NULL,
  pps_after      FLOAT       NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL    DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_algo_rank_history_lookup
  ON hitdash.algo_rank_history (algo_name, game_type, draw_type, half, draw_date DESC);

CREATE INDEX IF NOT EXISTS idx_algo_rank_history_date
  ON hitdash.algo_rank_history (game_type, draw_type, draw_date DESC);

-- ── 4. Seed pps_state con valor inicial neutro (50.0) ───────────
-- Se inserta una fila por cada combinación algo × game × draw × half
-- solo si no existe ya. ON CONFLICT DO NOTHING garantiza idempotencia.
INSERT INTO hitdash.pps_state (algo_name, game_type, draw_type, half, pps, sample_count)
SELECT
  algo.name,
  g.game_type,
  d.draw_type,
  h.half,
  50.0,
  0
FROM
  (VALUES
    ('frequency'),
    ('gap_analysis'),
    ('hot_cold'),
    ('pairs_correlation'),
    ('fibonacci_pisano'),
    ('streak'),
    ('position'),
    ('moving_averages'),
    ('bayesian_score'),
    ('transition_follow'),
    ('markov_order2'),
    ('calendar_pattern'),
    ('decade_family'),
    ('max_per_week_day'),
    -- Algoritmos predictivos avanzados (v3)
    ('pair_return_cycle'),
    ('sum_pattern_filter'),
    ('double_triple'),
    ('cross_draw')
  ) AS algo(name)
  CROSS JOIN (VALUES ('pick3'), ('pick4')) AS g(game_type)
  CROSS JOIN (VALUES ('midday'), ('evening')) AS d(draw_type)
  CROSS JOIN (VALUES ('du'), ('ab'), ('cd')) AS h(half)
ON CONFLICT (algo_name, game_type, draw_type, half) DO NOTHING;
