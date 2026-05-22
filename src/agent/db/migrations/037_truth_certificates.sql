-- ═══════════════════════════════════════════════════════════════
-- HELIX Migration 037 — Truth Certificates (2026-05-21)
--
-- DIFERENCIADOR ÚNICO DE MERCADO:
--   Cada predicción HELIX viene con certificado verificable que prueba:
--     • Wilson 95% CI del algoritmo usado
--     • Hit rate histórico walk-forward
--     • Edge Discovery p-values más recientes
--     • Conformal coverage garantizada
--     • Signature HMAC para anti-forgery
--
-- "We don't promise edge — we prove honesty"
--
-- Esto convierte la TRANSPARENCIA en producto vendible.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS hitdash.truth_certificates (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  certificate_id      TEXT         NOT NULL UNIQUE,    -- e.g. "TC-2026-05-21-AB12CD34"
  prediction_id       UUID,                            -- FK opcional a pair_recommendations
  game_type           TEXT         NOT NULL,
  draw_type           TEXT         NOT NULL,
  half                TEXT         NOT NULL,
  draw_date           DATE         NOT NULL,
  -- Predicción
  predicted_top       TEXT[]       NOT NULL,
  predicted_n         INTEGER      NOT NULL,
  algo_used           TEXT,                            -- líder Thompson UCB
  -- Estadísticas honestas
  hit_rate_wf         FLOAT,                            -- walk-forward hit rate de este combo
  wilson_lo           FLOAT,                            -- 95% CI lower bound
  wilson_hi           FLOAT,                            -- 95% CI upper bound
  baseline_rate       FLOAT        NOT NULL DEFAULT 0.15,
  edge_multiplier     FLOAT,
  -- Conformal guarantee
  conformal_threshold FLOAT,
  conformal_level     FLOAT        DEFAULT 0.80,
  -- Última verificación
  last_edge_discovery TEXT,                            -- run_id del último Edge Discovery
  last_edge_verdict   TEXT,                            -- veredicto al momento
  n_tests_total       INTEGER,
  n_tests_significant INTEGER,
  -- Auditoría
  generated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  signature           TEXT         NOT NULL,           -- HMAC-SHA256 del payload
  payload_json        JSONB        NOT NULL,           -- contenido completo serializado
  -- Outcome (filled after draw)
  actual_pair         TEXT,
  hit                 BOOLEAN,
  resolved_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_truth_cert_combo
  ON hitdash.truth_certificates (game_type, draw_type, half, draw_date);

CREATE INDEX IF NOT EXISTS idx_truth_cert_lookup
  ON hitdash.truth_certificates (certificate_id);

CREATE INDEX IF NOT EXISTS idx_truth_cert_pending
  ON hitdash.truth_certificates (resolved_at) WHERE resolved_at IS NULL;

COMMENT ON TABLE hitdash.truth_certificates IS
  'Certificados verificables por predicción. signature HMAC permite '
  'verificación criptográfica de integridad. payload_json contiene todo el '
  'snapshot del estado estadístico en el momento de la predicción.';

COMMENT ON COLUMN hitdash.truth_certificates.signature IS
  'HMAC-SHA256(payload_json, secret_key). El cliente puede pedir el secret '
  'una vez y verificar offline cualquier certificado emitido.';
