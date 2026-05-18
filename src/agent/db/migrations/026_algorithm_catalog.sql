-- ═══════════════════════════════════════════════════════════════
-- HELIX — Migration 026: Tabla algorithm_catalog + FK en pps_state
-- 2026-05-18 (M1)
--
-- CONTEXTO:
--   pps_state admite cualquier algo_name como PK libre. Históricamente
--   esto permitió la acumulación de entradas fantasma:
--     • fibonacci_pisano (migration 021/022 — trigger bloquea INSERT)
--     • fibonacci_resonance (migration 025 — DELETE manual)
--     • apex_adaptive, consensus_top, momentum_ema (migration 023 — DELETE)
--
--   El trigger de migration 022 solo cubre ELIMINATED_ALGORITHMS explícitos.
--   No hay garantía DB-level de que pps_state solo tenga algos canónicos.
--
-- SOLUCIÓN (M1):
--   1. Crear hitdash.algorithm_catalog — tabla de catálogo con los 21
--      algoritmos canónicos + sus metadatos básicos.
--   2. FK en pps_state.algo_name → algorithm_catalog.algo_name
--      (DEFERRABLE INITIALLY DEFERRED para no bloquear writes existentes).
--
-- NOTA: La FK es ON DELETE RESTRICT. Para añadir un nuevo algoritmo, primero
-- hay que insertarlo en algorithm_catalog (migration explícita requerida).
-- Esto es intencional: cualquier nuevo algo debe ser aprobado formalmente.
--
-- IDEMPOTENTE: CREATE TABLE IF NOT EXISTS, INSERT ON CONFLICT DO NOTHING.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. Tabla de catálogo canónico ────────────────────────────────
CREATE TABLE IF NOT EXISTS hitdash.algorithm_catalog (
  algo_name    TEXT        PRIMARY KEY,
  label        TEXT        NOT NULL,
  category     TEXT        NOT NULL DEFAULT 'unknown',
  status       TEXT        NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'deprecated', 'eliminated')),
  added_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes        TEXT
);

COMMENT ON TABLE hitdash.algorithm_catalog IS
  'Catálogo canónico de algoritmos del sistema HELIX. '
  'Single Source of Truth a nivel DB. Cualquier nuevo algoritmo '
  'debe insertarse aquí antes de poder escribir en pps_state. '
  'Referencia: CANONICAL_ALGORITHMS en analysis.types.ts (M1, 2026-05-18).';

-- ── 2. Seed con los 21 algoritmos canónicos ──────────────────────
INSERT INTO hitdash.algorithm_catalog (algo_name, label, category, status) VALUES
  ('frequency',           'Frequency Analysis',     'statistical',  'active'),
  ('hot_cold',            'Hot/Cold Classifier',    'momentum',     'active'),
  ('gap_analysis',        'Gap/Overdue Analysis',   'momentum',     'active'),
  ('calendar_pattern',    'Calendar Pattern',       'temporal',     'active'),
  ('markov_order2',       'Markov Order-2',         'probabilistic','active'),
  ('transition_follow',   'Transition Follow',      'probabilistic','active'),
  ('decade_family',       'Decade Family',          'structural',   'active'),
  ('max_per_week_day',    'Max per Weekday',        'temporal',     'active'),
  ('pairs_correlation',   'Pairs Correlation',      'structural',   'active'),
  ('streak',              'Streak Detection',       'momentum',     'active'),
  ('position',            'Position Bias',          'structural',   'active'),
  ('moving_averages',     'Moving Averages',        'trend',        'active'),
  ('bayesian_score',      'Bayesian Score',         'probabilistic','active'),
  ('pair_return_cycle',   'Pair Return Cycle',      'cyclic',       'active'),
  ('sum_pattern_filter',  'Sum Pattern Filter',     'structural',   'active'),
  ('double_triple',       'Double/Triple Detector', 'regime',       'active'),
  ('cross_draw',          'Cross-Draw Correlation', 'cross',        'active'),
  ('trend_momentum',      'Trend Momentum',         'momentum',     'active'),
  ('trend_momentum_sweet','Trend Momentum Sweet',   'momentum',     'active'),
  ('est_individuales',    'Est. Individuales',      'digit',        'active'),
  ('terminal_analysis',   'Terminal Analysis',      'digit',        'active')
ON CONFLICT (algo_name) DO NOTHING;

-- ── 3. Insertar eliminados con status='eliminated' (trazabilidad) ─
INSERT INTO hitdash.algorithm_catalog (algo_name, label, category, status, notes) VALUES
  ('fibonacci_pisano',   'Fibonacci Pisano',    'eliminated', 'eliminated', 'Eliminado v2.4: sin base empírica en RNG certificado'),
  ('cycle_detector',     'Cycle Detector',      'eliminated', 'eliminated', 'Eliminado v2.4: artefacto estadístico'),
  ('mirror_complement',  'Mirror Complement',   'eliminated', 'eliminated', 'Eliminado v2.4: simetría sin mecanismo generativo')
ON CONFLICT (algo_name) DO NOTHING;

-- ── 4. FK en pps_state → algorithm_catalog ───────────────────────
-- DEFERRABLE para no bloquear transacciones existentes.
-- Solo applies a algo_names NEW — filas existentes que no estén en catalog
-- fallarán; pero con migration 023+025 ya están limpias.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'hitdash'
      AND table_name = 'pps_state'
      AND constraint_name = 'pps_state_algo_name_fk'
  ) THEN
    ALTER TABLE hitdash.pps_state
      ADD CONSTRAINT pps_state_algo_name_fk
        FOREIGN KEY (algo_name)
        REFERENCES hitdash.algorithm_catalog(algo_name)
        ON DELETE RESTRICT
        DEFERRABLE INITIALLY DEFERRED;
    RAISE NOTICE 'Migration 026: FK pps_state.algo_name → algorithm_catalog creada.';
  ELSE
    RAISE NOTICE 'Migration 026: FK ya existe, skip.';
  END IF;
END $$;

DO $$
BEGIN
  RAISE NOTICE 'Migration 026 completed: algorithm_catalog creado con 21 activos + 3 eliminados. pps_state FK aplicada.';
END $$;
