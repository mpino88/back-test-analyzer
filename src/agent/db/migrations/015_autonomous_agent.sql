-- ═══════════════════════════════════════════════════════════════
-- HELIX — Migration 015: Agente Autónomo con Autocorrección Dinámica
-- Tablas: hypotheses, dynamic_strategies, anomaly_scan_log
-- ═══════════════════════════════════════════════════════════════

-- ─── 1. Hipótesis estadísticas generadas dinámicamente ──────────
CREATE TABLE IF NOT EXISTS hitdash.hypotheses (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  game_type        TEXT        NOT NULL CHECK (game_type IN ('pick3','pick4')),
  draw_type        TEXT        NOT NULL CHECK (draw_type IN ('midday','evening')),

  -- Tipo de hipótesis
  hypothesis_type  TEXT        NOT NULL CHECK (hypothesis_type IN (
    'positional_bias', 'temporal_pattern', 'absence_streak',
    'cross_draw_dependency', 'family_clustering'
  )),

  -- Condición serializada (para UNIQUE constraint y deduplicación)
  condition_json   JSONB       NOT NULL,
  -- {type, position?, value, direction, window, z_score}

  -- Predicción específica de la hipótesis
  predicted_pair       VARCHAR(2),
  predicted_digit      SMALLINT CHECK (predicted_digit BETWEEN 0 AND 9),
  predicted_position   TEXT CHECK (predicted_position IN ('p1','p2','p3','p4')),
  predicted_hit_rate   FLOAT    NOT NULL DEFAULT 0,
  confidence_basis     TEXT,           -- "z=2.3, window=21, p=0.021"
  anomaly_signal_id    TEXT,           -- ID en memoria de la señal origen

  -- Parámetros de validación
  minimum_sample       INTEGER NOT NULL DEFAULT 20,
  validation_window    INTEGER NOT NULL DEFAULT 60,

  -- Resultado de la validación walk-forward
  validation_status    TEXT    NOT NULL DEFAULT 'pending'
    CHECK (validation_status IN ('pending','validated','rejected')),
  validation_hit_rate  FLOAT,
  validation_lift      FLOAT,   -- hit_rate / baseline_random
  validation_p_value   FLOAT,
  validation_draws     INTEGER,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  validated_at     TIMESTAMPTZ,

  -- Evitar regenerar hipótesis rechazadas para el mismo patrón
  UNIQUE (game_type, draw_type, hypothesis_type, condition_json)
);

CREATE INDEX IF NOT EXISTS idx_hypotheses_lookup
  ON hitdash.hypotheses (game_type, draw_type, validation_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_hypotheses_pending
  ON hitdash.hypotheses (game_type, draw_type, created_at DESC)
  WHERE validation_status = 'pending';

-- ─── 2. Micro-estrategias dinámicas con ciclo de vida ───────────
CREATE TABLE IF NOT EXISTS hitdash.dynamic_strategies (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  game_type        TEXT        NOT NULL CHECK (game_type IN ('pick3','pick4')),
  draw_type        TEXT        NOT NULL CHECK (draw_type IN ('midday','evening')),
  hypothesis_id    UUID        REFERENCES hitdash.hypotheses(id) ON DELETE CASCADE,

  -- Estrategia generada
  name             TEXT        NOT NULL,
  description      TEXT,
  strategy_type    TEXT        NOT NULL CHECK (strategy_type IN (
    'pair_bias', 'digit_bias', 'temporal', 'cross_draw', 'family'
  )),

  -- Targets de la estrategia
  target_pairs     TEXT[],     -- pares que reciben boost de score
  target_digits    JSONB,      -- {p2: [3, 7], p3: [1, 8]}
  score_boost      FLOAT       NOT NULL DEFAULT 0.15 CHECK (score_boost BETWEEN 0 AND 0.40),

  -- Estado del ciclo de vida
  lifecycle_status TEXT        NOT NULL DEFAULT 'monitoring' CHECK (lifecycle_status IN (
    'monitoring', 'active', 'degrading', 'retired', 'consolidated'
  )),

  -- Métricas de rendimiento en producción
  draws_active          INTEGER NOT NULL DEFAULT 0,
  hits_in_prod          INTEGER NOT NULL DEFAULT 0,
  misses_in_prod        INTEGER NOT NULL DEFAULT 0,
  consecutive_misses    INTEGER NOT NULL DEFAULT 0,
  last_evaluated        TIMESTAMPTZ,

  -- Umbrales fijados en activación
  activation_hit_rate       FLOAT,
  min_expected_hit_rate     FLOAT,  -- threshold para DEGRADING

  -- Trazabilidad
  contribution_count        INTEGER NOT NULL DEFAULT 0,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at     TIMESTAMPTZ,
  retired_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_dynamic_strategies_active
  ON hitdash.dynamic_strategies (game_type, draw_type, lifecycle_status)
  WHERE lifecycle_status IN ('monitoring','active','degrading');

-- ─── 3. Log de escaneos de anomalías (auditoría / debugging) ────
CREATE TABLE IF NOT EXISTS hitdash.anomaly_scan_log (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_type             TEXT NOT NULL,
  draw_type             TEXT NOT NULL,
  signals_found         INTEGER NOT NULL DEFAULT 0,
  hypotheses_generated  INTEGER NOT NULL DEFAULT 0,
  hypotheses_validated  INTEGER NOT NULL DEFAULT 0,
  hypotheses_rejected   INTEGER NOT NULL DEFAULT 0,
  strategies_activated  INTEGER NOT NULL DEFAULT 0,
  strategies_retired    INTEGER NOT NULL DEFAULT 0,
  scan_duration_ms      INTEGER,
  triggered_by          TEXT    NOT NULL DEFAULT 'post_draw'
    CHECK (triggered_by IN ('manual','post_draw','cron')),
  error                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_anomaly_scan_log_recent
  ON hitdash.anomaly_scan_log (game_type, draw_type, created_at DESC);
