-- ═══════════════════════════════════════════════════════════════
-- HITDASH — Migration 012: Agentic Strategies
-- Registra las 6 estrategias Ballbot clonadas en strategy_registry
-- y adaptive_weights, y crea hitdash.strategy_conditions para
-- almacenar las condiciones de juego calculadas por
-- AgenticProgressiveEngine.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. Seed strategy_registry ───────────────────────────────────
INSERT INTO hitdash.strategy_registry (name, description, algorithm_version, win_rate, status)
VALUES
  ('bayesian_score',    'Bayesiano multi-señal 6 componentes (freq+gap+mom+cycle+markov+streak)', '1.0.0', 0.0, 'active'),
  ('transition_follow', 'Markov-1: P(sucesor|anterior) — cadena de transición secuencial',       '1.0.0', 0.0, 'active'),
  ('markov_order2',     'Markov-2: estado compuesto (X→Y)→Z con memoria de 2 pasos',             '1.0.0', 0.0, 'active'),
  ('calendar_pattern',  'Sesgo temporal DoW×mes diagonal — 4 dimensiones ponderadas',            '1.0.0', 0.0, 'active'),
  ('decade_family',     'Familias 00-09…90-99: momentum familiar → selección de miembros',       '1.0.0', 0.0, 'active'),
  ('max_per_weekday',   'Top-N por día de semana: frecuencia histórica en el DoW objetivo',      '1.0.0', 0.0, 'active')
ON CONFLICT (name) DO NOTHING;

-- ── 2. Seed adaptive_weights (peso inicial 1.0, top_n 15) ───────
INSERT INTO hitdash.adaptive_weights (strategy, game_type, mode, weight, top_n)
SELECT s.name, g.game_type, m.mode, 1.0, 15
FROM (VALUES
  ('bayesian_score'),
  ('transition_follow'),
  ('markov_order2'),
  ('calendar_pattern'),
  ('decade_family'),
  ('max_per_weekday')
) AS s(name)
CROSS JOIN (VALUES ('pick3'), ('pick4')) AS g(game_type)
CROSS JOIN (VALUES ('midday'), ('evening'), ('combined')) AS m(mode)
ON CONFLICT (strategy, game_type, mode) DO NOTHING;

-- ── 3. Crear tabla strategy_conditions ──────────────────────────
-- Almacena las condiciones de juego calculadas por AgenticProgressiveEngine.
-- Calculadas mediante sliding-window + análisis temporal (Welford online).
CREATE TABLE IF NOT EXISTS hitdash.strategy_conditions (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_name   TEXT         NOT NULL,
  game_type       TEXT         NOT NULL    CHECK (game_type IN ('pick3', 'pick4')),
  draw_type       TEXT         NOT NULL    CHECK (draw_type IN ('midday', 'evening')),
  half            VARCHAR(2)   NOT NULL    CHECK (half IN ('du', 'ab', 'cd')),

  -- Señal de juego
  play_signal     TEXT         NOT NULL    CHECK (play_signal IN ('PLAY', 'WAIT', 'ALERT')),

  -- Racha de misses actual vs histórico
  current_misses  INTEGER      NOT NULL DEFAULT 0,
  avg_pre_miss    NUMERIC(8,3) NOT NULL DEFAULT 0,
  std_pre_miss    NUMERIC(8,3) NOT NULL DEFAULT 0,
  max_pre_miss    INTEGER      NOT NULL DEFAULT 0,

  -- Condiciones temporales (DoW y mes con hit_rate >= 1.2x baseline)
  best_dows       INTEGER[]    NOT NULL DEFAULT '{}',    -- 0=Domingo…6=Sábado
  best_months     INTEGER[]    NOT NULL DEFAULT '{}',    -- 1-12

  -- Tasas de transición
  hit_after_hit   NUMERIC(6,4) NOT NULL DEFAULT 0,
  hit_after_miss  NUMERIC(6,4) NOT NULL DEFAULT 0,

  -- Clustering
  clustering      TEXT         NOT NULL DEFAULT 'NEUTRAL' CHECK (clustering IN ('HOT', 'COLD', 'NEUTRAL')),

  -- Tendencia reciente (últimos 50 sorteos)
  recent_hit_rate NUMERIC(6,4) NOT NULL DEFAULT 0,
  global_hit_rate NUMERIC(6,4) NOT NULL DEFAULT 0,
  trend           TEXT         NOT NULL DEFAULT 'STABLE' CHECK (trend IN ('UP', 'DOWN', 'STABLE')),

  -- Métricas
  total_eval_pts  INTEGER      NOT NULL DEFAULT 0,
  computed_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),

  UNIQUE (strategy_name, game_type, draw_type, half)
);

-- Índice para queries rápidas por juego+tipo
CREATE INDEX IF NOT EXISTS idx_strategy_conditions_game
  ON hitdash.strategy_conditions (game_type, draw_type);
