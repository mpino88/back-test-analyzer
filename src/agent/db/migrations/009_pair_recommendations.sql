-- ═══════════════════════════════════════════════════════════════
-- Migración 009: tabla pair_recommendations
-- Persiste las recomendaciones de pares generadas por HitdashAgent.
-- Permite al frontend consultar qué pares se recomendaron y si acertaron.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS hitdash.pair_recommendations (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID          REFERENCES hitdash.agent_sessions(id) ON DELETE SET NULL,
  game_type       TEXT          NOT NULL CHECK (game_type IN ('pick3','pick4')),
  draw_type       TEXT          NOT NULL CHECK (draw_type IN ('midday','evening')),
  draw_date       DATE          NOT NULL,
  half            TEXT          NOT NULL CHECK (half IN ('du','ab','cd')),

  -- Recomendación cognitiva
  optimal_n               INT     NOT NULL DEFAULT 15,
  predicted_effectiveness NUMERIC(6,4) NOT NULL DEFAULT 0,
  cognitive_basis         TEXT,

  -- Pares recomendados (ordered array, top optimal_n primero)
  pairs           TEXT[]        NOT NULL DEFAULT '{}',

  -- Métricas del análisis en el momento de generar
  confidence      NUMERIC(6,4)  NOT NULL DEFAULT 0,
  top_n_backtest  INT           NOT NULL DEFAULT 15,
  kelly_fraction  NUMERIC(6,4),
  wilson_lower    NUMERIC(6,4),

  -- Resultado post-sorteo (se actualiza con PostDrawProcessor)
  actual_pair     TEXT,                              -- par real que salió
  hit             BOOLEAN       DEFAULT NULL,        -- NULL = pendiente
  hit_at_rank     INT,                              -- en qué posición estaba el par acertado

  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Índice principal para consultas por sorteo
CREATE INDEX IF NOT EXISTS idx_pair_rec_game_date
  ON hitdash.pair_recommendations (game_type, draw_type, draw_date DESC);

-- Índice para auditoría de sesión
CREATE INDEX IF NOT EXISTS idx_pair_rec_session
  ON hitdash.pair_recommendations (session_id);

-- Índice para resultados pendientes (hit IS NULL = pendiente evaluación)
CREATE INDEX IF NOT EXISTS idx_pair_rec_pending
  ON hitdash.pair_recommendations (hit)
  WHERE hit IS NULL;

-- Trigger: actualizar updated_at automáticamente
CREATE OR REPLACE FUNCTION hitdash.update_pair_rec_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pair_rec_updated_at ON hitdash.pair_recommendations;
CREATE TRIGGER pair_rec_updated_at
  BEFORE UPDATE ON hitdash.pair_recommendations
  FOR EACH ROW EXECUTE FUNCTION hitdash.update_pair_rec_updated_at();
