-- ═══════════════════════════════════════════════════════════════
-- HELIX — Migration 017: algorithm_candidate_history
--
-- Registra los candidatos predichos por cada algoritmo ANTES de
-- cada sorteo y el resultado real DESPUÉS, igual que el
-- buildTestingVerificationBlock de Ballbot.
--
-- Flujo:
--   Pre-sorteo  → HitdashAgent inserta candidatos (hit=NULL)
--   Post-sorteo → PostDrawProcessor actualiza hit/hit_at_position
--
-- Permite:
--   • Comparación simétrica algoritmo vs algoritmo (como Ballbot)
--   • Hit rate histórico por algoritmo con N configurable
--   • Vista Cognición → tab Comparativa
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS hitdash.algorithm_candidate_history (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  algo_name        TEXT        NOT NULL,
  game_type        TEXT        NOT NULL,
  draw_type        TEXT        NOT NULL,
  draw_date        DATE        NOT NULL,
  half             TEXT        NOT NULL DEFAULT 'du',
  -- Candidatos predichos (pares "00"–"99", ordenados por score desc)
  candidates       TEXT[]      NOT NULL,
  candidate_count  INT         NOT NULL,
  -- Resultado real (rellenado por PostDrawProcessor)
  actual_pair      TEXT,
  hit              BOOLEAN,
  hit_at_position  INT,        -- posición 1-based del par ganador en candidates[]
  -- Metadata
  session_id       TEXT,       -- session del agente que generó la predicción
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  evaluated_at     TIMESTAMPTZ,

  UNIQUE (algo_name, game_type, draw_type, draw_date, half)
);

CREATE INDEX IF NOT EXISTS idx_ach_game_draw
  ON hitdash.algorithm_candidate_history (game_type, draw_type, draw_date DESC);

CREATE INDEX IF NOT EXISTS idx_ach_algo_hit
  ON hitdash.algorithm_candidate_history (algo_name, game_type, draw_type, hit);

COMMENT ON TABLE hitdash.algorithm_candidate_history IS
  'Comparativa diaria algoritmo vs resultado real — espejo de Ballbot buildTestingVerificationBlock';
