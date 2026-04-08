-- ═══════════════════════════════════════════════════════════════
-- HITDASH — Schema SQL v2.0
-- Empresa: Bliss Systems LLC
-- Ejecutar en: VPS PostgreSQL (local) — NO en Render (Ballbot DB)
-- Requiere: pgvector extension + uuid-ossp
-- ═══════════════════════════════════════════════════════════════

-- Extensiones (requiere superuser la primera vez)
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Schema aislado — NUNCA modifica schema "public" de Ballbot
CREATE SCHEMA IF NOT EXISTS hitdash;

-- ─── TABLA 1: rag_knowledge ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hitdash.rag_knowledge (
  id          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  content     TEXT         NOT NULL,
  embedding   vector(3072) NOT NULL,
  category    VARCHAR(20)  NOT NULL CHECK (category IN ('analysis','strategy','learning','pattern')),
  source      VARCHAR(255) NOT NULL,
  confidence  FLOAT        DEFAULT 0.5 CHECK (confidence BETWEEN 0.0 AND 1.0),
  metadata    JSONB        DEFAULT '{}',
  created_at  TIMESTAMPTZ  DEFAULT now(),
  updated_at  TIMESTAMPTZ  DEFAULT now()
);

-- Unique: misma fuente + categoría = un solo registro (idempotencia en seed e ingesta)
CREATE UNIQUE INDEX IF NOT EXISTS idx_rag_source_category
  ON hitdash.rag_knowledge (source, category);

-- HNSW para búsqueda semántica (cosine similarity)
-- halfvec cast: pgvector 0.7+ soporta HNSW hasta 4000 dims vía halfvec
CREATE INDEX IF NOT EXISTS idx_rag_embedding
  ON hitdash.rag_knowledge
  USING hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 200);

CREATE INDEX IF NOT EXISTS idx_rag_category
  ON hitdash.rag_knowledge (category, created_at DESC);

-- ─── TABLA 2: ingested_results ──────────────────────────────────────────────
-- Tracking de qué lottery_results ya fueron procesados.
-- NUNCA se toca la tabla public.lottery_results de Ballbot.
CREATE TABLE IF NOT EXISTS hitdash.ingested_results (
  lottery_result_id  UUID        PRIMARY KEY,
  ingested_at        TIMESTAMPTZ DEFAULT now(),
  rag_knowledge_id   UUID        REFERENCES hitdash.rag_knowledge(id) ON DELETE SET NULL
);

-- ─── TABLA 3: analysis_history ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hitdash.analysis_history (
  id                UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  game_type         VARCHAR(10) NOT NULL CHECK (game_type IN ('pick3','pick4')),
  analysis_type     VARCHAR(50) NOT NULL,
  algorithm_version VARCHAR(10) NOT NULL DEFAULT '1.0.0',
  input_params      JSONB       NOT NULL DEFAULT '{}',
  output_data       JSONB       NOT NULL DEFAULT '{}',
  output_summary    TEXT,
  model_used        VARCHAR(50),
  tokens_used       INT         DEFAULT 0,
  execution_ms      INT         NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_analysis_game_date
  ON hitdash.analysis_history (game_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_analysis_type_date
  ON hitdash.analysis_history (analysis_type, game_type, created_at DESC);

-- ─── TABLA 4: strategy_registry ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hitdash.strategy_registry (
  id             UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  name           VARCHAR(100) UNIQUE NOT NULL,
  description    TEXT,
  algorithm      VARCHAR(50)  NOT NULL,
  parameters     JSONB        DEFAULT '{}',
  win_rate       FLOAT        DEFAULT 0.0 CHECK (win_rate BETWEEN 0.0 AND 1.0),
  total_tests    INT          DEFAULT 0,
  last_evaluated TIMESTAMPTZ,
  status         VARCHAR(20)  DEFAULT 'testing' CHECK (status IN ('active','testing','retired')),
  embedding      vector(3072),
  created_at     TIMESTAMPTZ  DEFAULT now(),
  updated_at     TIMESTAMPTZ  DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_strategy_status_winrate
  ON hitdash.strategy_registry (status, win_rate DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_embedding
  ON hitdash.strategy_registry
  USING hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 200);

-- ─── TABLA 5: carton_generations ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hitdash.carton_generations (
  id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  game_type        VARCHAR(10) NOT NULL CHECK (game_type IN ('pick3','pick4')),
  draw_type        VARCHAR(10) NOT NULL CHECK (draw_type IN ('midday','evening')),
  carton_size      INT         NOT NULL CHECK (carton_size IN (9,10,16,20,25)),
  numbers          JSONB       NOT NULL,
  strategy_id      UUID        REFERENCES hitdash.strategy_registry(id),
  confidence_score FLOAT       DEFAULT 0.0 CHECK (confidence_score BETWEEN 0.0 AND 1.0),
  result_status    VARCHAR(10) DEFAULT 'pending' CHECK (result_status IN ('pending','hit','partial','miss')),
  draw_date        DATE        NOT NULL,
  draw_id          UUID,
  session_id       UUID,
  created_at       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_carton_draw_date
  ON hitdash.carton_generations (draw_date, game_type, draw_type);

CREATE INDEX IF NOT EXISTS idx_carton_status_date
  ON hitdash.carton_generations (result_status, created_at DESC);

-- ─── TABLA 6: agent_sessions ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hitdash.agent_sessions (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  trigger_type    VARCHAR(20) NOT NULL CHECK (trigger_type IN ('cron','manual','fallback')),
  game_type       VARCHAR(10) CHECK (game_type IN ('pick3','pick4')),
  draw_type       VARCHAR(10) CHECK (draw_type IN ('midday','evening')),
  context_data    JSONB       DEFAULT '{}',
  reasoning_chain JSONB       DEFAULT '[]',
  output_data     JSONB       DEFAULT '{}',
  duration_ms     INT         DEFAULT 0,
  model_used      VARCHAR(50),
  tokens_in       INT         DEFAULT 0,
  tokens_out      INT         DEFAULT 0,
  cost_usd        FLOAT       DEFAULT 0.0,
  status          VARCHAR(20) DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
  error_message   TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_date
  ON hitdash.agent_sessions (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_status
  ON hitdash.agent_sessions (status, created_at DESC);

-- ─── TABLA 7: agent_logs ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hitdash.agent_logs (
  id                UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id        UUID        REFERENCES hitdash.agent_sessions(id) ON DELETE CASCADE,
  level             VARCHAR(10) NOT NULL CHECK (level IN ('info','warn','error')),
  model             VARCHAR(50),
  prompt_tokens     INT         DEFAULT 0,
  completion_tokens INT         DEFAULT 0,
  latency_ms        INT         DEFAULT 0,
  cost_usd          FLOAT       DEFAULT 0.0,
  error_message     TEXT,
  metadata          JSONB       DEFAULT '{}',
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_logs_session
  ON hitdash.agent_logs (session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_logs_date
  ON hitdash.agent_logs (created_at DESC);

-- ─── TABLA 8: proactive_alerts ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hitdash.proactive_alerts (
  id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  alert_type   VARCHAR(20) NOT NULL CHECK (alert_type IN ('anomaly','streak','overdue','drift','system','low_data')),
  priority     VARCHAR(10) NOT NULL CHECK (priority IN ('low','medium','high','critical')),
  game_type    VARCHAR(10),
  message      TEXT        NOT NULL,
  data         JSONB       DEFAULT '{}',
  sent_at      TIMESTAMPTZ,
  channel      VARCHAR(100) DEFAULT 'telegram',
  acknowledged BOOLEAN     DEFAULT false,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alerts_priority_date
  ON hitdash.proactive_alerts (priority, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_alerts_unacknowledged
  ON hitdash.proactive_alerts (acknowledged, created_at DESC)
  WHERE acknowledged = false;

-- ─── TABLA 9: feedback_loop ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hitdash.feedback_loop (
  id             UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  carton_id      UUID        NOT NULL REFERENCES hitdash.carton_generations(id),
  draw_id        UUID        NOT NULL,
  predicted      JSONB       NOT NULL,
  actual         JSONB       NOT NULL,
  hits_exact     INT         DEFAULT 0,
  hits_partial   INT         DEFAULT 0,
  accuracy_score FLOAT       DEFAULT 0.0 CHECK (accuracy_score BETWEEN 0.0 AND 1.0),
  learning_notes TEXT,
  embedding      vector(3072),
  learned_at     TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT uq_carton_draw UNIQUE (carton_id, draw_id)
);

CREATE INDEX IF NOT EXISTS idx_feedback_accuracy
  ON hitdash.feedback_loop (accuracy_score DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_learned_at
  ON hitdash.feedback_loop (learned_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_draw_id
  ON hitdash.feedback_loop (draw_id);

-- ─── SEEDS DE ESTRATEGIAS INICIALES ─────────────────────────────────────────
INSERT INTO hitdash.strategy_registry (name, description, algorithm, parameters, status)
VALUES
  ('hot_cold_weighted',   'Prioriza dígitos Hot por posición usando z-score ponderado',      'hot_cold',    '{"z_threshold": 1.0, "period_days": 30}', 'testing'),
  ('gap_overdue_focus',   'Selecciona dígitos con mayor overdue_score por posición',          'gap_analysis','{"overdue_threshold": 1.5, "period_days": 90}', 'testing'),
  ('frequency_rank',      'Top dígitos por frecuencia relativa acumulada por posición',       'frequency',   '{"period_days": 365}', 'testing'),
  ('position_bias',       'Explota position bias detectado por chi-square en posiciones',     'position',    '{"p_value_threshold": 0.05}', 'testing'),
  ('pair_correlation',    'Combina dígitos con mayor correlation_ratio posicional',           'pairs',       '{"min_ratio": 1.3, "period_days": 90}', 'testing'),
  ('moving_avg_signal',   'Selecciona dígitos con señal alcista en SMA-7 cruzando SMA-14',   'moving_avg',  '{"sma_short": 7, "sma_long": 14}', 'testing'),
  ('consensus_top',       'Top dígitos por consensus_score ponderado de todos los algoritmos','consensus',  '{"min_algorithms": 5}', 'active'),
  ('streak_reversal',     'Dígitos con racha de ausencia > mean+2*std con alta frecuencia histórica', 'streak', '{"std_multiplier": 2.0}', 'testing')
ON CONFLICT (name) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- Schema hitdash creado correctamente.
-- Próximo paso: npm run migrate (o ejecutar este SQL directamente)
-- ═══════════════════════════════════════════════════════════════
