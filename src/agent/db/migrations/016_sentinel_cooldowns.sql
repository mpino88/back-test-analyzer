-- ═══════════════════════════════════════════════════════════════
-- HELIX — Migration 016: sentinel_cooldowns
-- Anti-spam table for HelixSentinel proactive alerts.
-- Prevents the same alert type from firing more than once per 6h.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS hitdash.sentinel_cooldowns (
  event_key   TEXT        PRIMARY KEY,
  fired_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
