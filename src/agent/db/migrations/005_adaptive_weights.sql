-- ═══════════════════════════════════════════════════════════════
-- Migración 005: tabla adaptive_weights + registro de nuevas estrategias
-- ═══════════════════════════════════════════════════════════════

-- ─── Tabla de pesos adaptativos por estrategia ───────────────
-- weight: factor multiplicador sobre el peso base [0.5, 2.0]
-- Se actualiza via EMA(α=0.25) tras cada ciclo de backtest
-- Un weight=1.5 significa "esta estrategia rindió 1.5× mejor que el baseline"
CREATE TABLE IF NOT EXISTS hitdash.adaptive_weights (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy    TEXT        NOT NULL,
  game_type   TEXT        NOT NULL,   -- 'pick3' | 'pick4'
  mode        TEXT        NOT NULL,   -- 'midday' | 'evening' | 'combined'
  weight      NUMERIC(8,4) NOT NULL DEFAULT 1.0,
  sample_size INT         NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT adaptive_weights_unique UNIQUE (strategy, game_type, mode)
);

CREATE INDEX IF NOT EXISTS idx_adaptive_weights_lookup
  ON hitdash.adaptive_weights (game_type, mode);

-- ─── Registrar nuevas estrategias en strategy_registry ───────
INSERT INTO hitdash.strategy_registry (name, description, algorithm, parameters, status)
VALUES
  ('momentum_ema',
   'EMA multi-ventana [3,7,14,30d] con decay α=0.85 — captura momentum reciente real',
   'moving_avg',
   '{"windows": [3,7,14,30], "alpha": 0.85}',
   'testing'),
  ('apex_adaptive',
   'Meta-estrategia con pesos adaptativos aprendidos del historial de backtest — autocorrección continua',
   'consensus',
   '{"ema_alpha": 0.25, "weight_range": [0.5, 2.0]}',
   'active')
ON CONFLICT (name) DO NOTHING;

-- ─── Seed de pesos neutros para primer arranque ───────────────
-- Se sobreescribirán tras el primer ciclo de backtest
INSERT INTO hitdash.adaptive_weights (strategy, game_type, mode, weight, sample_size)
SELECT s.name, g.game_type, m.mode, 1.0, 0
FROM (VALUES
  ('frequency_rank'), ('hot_cold_weighted'), ('gap_overdue_focus'),
  ('moving_avg_signal'), ('momentum_ema'), ('streak_reversal'),
  ('position_bias'), ('pair_correlation'), ('fibonacci_pisano'),
  ('consensus_top')
) AS s(name)
CROSS JOIN (VALUES ('pick3')) AS g(game_type)
CROSS JOIN (VALUES ('combined'), ('midday'), ('evening')) AS m(mode)
ON CONFLICT (strategy, game_type, mode) DO NOTHING;
