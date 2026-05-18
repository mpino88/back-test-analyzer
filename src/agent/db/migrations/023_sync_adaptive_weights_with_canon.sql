-- ═══════════════════════════════════════════════════════════════
-- HELIX — Migration 023: Sincronizar adaptive_weights con catálogo canónico
-- 2026-05-18 (TIER 2 fix T2-E)
--
-- CONTEXTO FORENSE:
--   Auditoría TIER 2 reveló que adaptive_weights estaba desincronizada:
--   - 8 algos canónicos SIN entry adaptive (cross_draw_correlation,
--     double_triple_detector, est_individuales, pair_return_cycle,
--     sum_pattern_filter, terminal_analysis, trend_momentum,
--     trend_momentum_sweet)
--   - 4 strategies fantasma: fibonacci_pisano (eliminated), apex_adaptive
--     (meta alias), consensus_top (meta), momentum_ema (legacy alias)
--
--   Consecuencia: effectiveWeight() en AnalysisEngine amplifica vía
--   dbWeights[stratName] solo a 13 algos. Los 8 faltantes caen al peso
--   base sin amplificación → asimetría sistémica.
--
-- ACCIÓN:
--   1. DELETE de las 4 strategies fantasma
--   2. INSERT seed para 8 algos canónicos faltantes con weight=1.0
--      (neutral — el aprendizaje semanal Auto-Backtest las ajustará)
--
-- IDEMPOTENTE: ON CONFLICT DO NOTHING para inserts; DELETE no falla si
--   las filas ya no existen.
-- ═══════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_deleted int;
  v_inserted int := 0;
  v_phantom_strats text[] := ARRAY[
    'fibonacci_pisano',  -- eliminated v2.4 (sin base empírica)
    'apex_adaptive',     -- meta alias, no es algoritmo individual
    'consensus_top',     -- meta-strategy
    'momentum_ema'       -- legacy alias de moving_avg_signal
  ];
  v_missing_strats text[][] := ARRAY[
    -- [strategy_name, default_top_n]
    ['cross_draw_correlation',  '18'],
    ['double_triple_detector',  '20'],
    ['est_individuales',        '15'],
    ['pair_return_cycle',       '12'],
    ['sum_pattern_filter',      '15'],
    ['terminal_analysis',       '15'],
    ['trend_momentum',          '15'],
    ['trend_momentum_sweet',    '15']
  ];
  v_game_types text[] := ARRAY['pick3', 'pick4'];
  v_modes      text[] := ARRAY['midday', 'evening', 'combined'];
  v_row text[];
  v_game text;
  v_mode text;
BEGIN

  -- ── 1. Purgar strategies fantasma ────────────────────────────
  DELETE FROM hitdash.adaptive_weights WHERE strategy = ANY(v_phantom_strats);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RAISE NOTICE 'Migration 023: % filas fantasma eliminadas de adaptive_weights', v_deleted;

  -- ── 2. Seed para 8 algos canónicos faltantes ────────────────
  -- Cada algo recibe entries para 2 game_types × 3 modes = 6 entries.
  -- weight=1.0 (neutral), sample_size=0, top_n del DEFAULT_TOP_N_MAP.
  FOREACH v_row SLICE 1 IN ARRAY v_missing_strats LOOP
    FOREACH v_game IN ARRAY v_game_types LOOP
      FOREACH v_mode IN ARRAY v_modes LOOP
        INSERT INTO hitdash.adaptive_weights
          (strategy, game_type, mode, weight, sample_size, top_n)
        VALUES
          (v_row[1], v_game, v_mode, 1.0, 0, v_row[2]::int)
        ON CONFLICT (strategy, game_type, mode) DO NOTHING;
        IF FOUND THEN v_inserted := v_inserted + 1; END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'Migration 023: % filas seed insertadas para 8 algos canónicos', v_inserted;
  RAISE NOTICE 'Migration 023 completed.';
END $$;
