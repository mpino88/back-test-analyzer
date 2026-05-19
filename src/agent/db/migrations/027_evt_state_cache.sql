-- ═══════════════════════════════════════════════════════════════
-- Migration 027 — EVT state cache
-- Created: 2026-05-19
--
-- Caches the computed EVT (Extreme Value Theory) regime state
-- per (game_type, draw_type, as_of_date).
--
-- TTL strategy: the application layer considers a cached row
-- stale if computed_at < NOW() - INTERVAL '1 hour' and recomputes.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS hitdash.evt_state_cache (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  game_type               TEXT        NOT NULL,
  draw_type               TEXT        NOT NULL,
  as_of_date              DATE        NOT NULL,
  regime                  TEXT        NOT NULL,
  regime_strength         FLOAT       NOT NULL,
  days_since_quad         INTEGER,
  days_since_triple       INTEGER,
  quad_hawkes_intensity   FLOAT       NOT NULL DEFAULT 0,
  triple_hawkes_intensity FLOAT       NOT NULL DEFAULT 0,
  computed_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (game_type, draw_type, as_of_date)
);

-- Index for fast lookups by (game_type, draw_type, as_of_date)
CREATE INDEX IF NOT EXISTS idx_evt_state_cache_lookup
  ON hitdash.evt_state_cache (game_type, draw_type, as_of_date);

-- Index for TTL sweep: find stale rows quickly
CREATE INDEX IF NOT EXISTS idx_evt_state_cache_computed_at
  ON hitdash.evt_state_cache (computed_at DESC);

COMMENT ON TABLE hitdash.evt_state_cache IS
  'Cache of EVT (Extreme Value Theory) regime state for Hawkes cluster detection. '
  'Rows older than 1 hour are considered stale and recomputed on demand.';
