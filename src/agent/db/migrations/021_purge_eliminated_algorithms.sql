-- ═══════════════════════════════════════════════════════════════
-- HELIX — Migration 021: Purga definitiva de algoritmos eliminados
-- 2026-05-15
--
-- CONTEXTO:
--   Migration 019 eliminó fibonacci_pisano, cycle_detector, mirror_complement
--   de pps_state y algo_prediction_snapshot. Sin embargo Genesis Bootstrap
--   con force=true encontró snapshots residuales (creados por el live engine
--   antes del deploy v2.4) y re-pobló pps_state con 13,861 muestras de
--   fibonacci_pisano. Esto contamina el consensus y el dashboard.
--
-- ACCIÓN:
--   DELETE de TODAS las tablas de aprendizaje para los 3 algos eliminados.
--   Incluye algo_prediction_snapshot que migration 019 pudo haber dejado
--   incompleto.
--
-- IDEMPOTENTE: re-ejecutar no tiene efecto secundario.
-- ═══════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_deleted int;
  v_algos text[] := ARRAY['fibonacci_pisano', 'cycle_detector', 'mirror_complement'];
BEGIN

  -- ── 1. pps_state ────────────────────────────────────────────────
  DELETE FROM hitdash.pps_state WHERE algo_name = ANY(v_algos);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RAISE NOTICE 'Migration 021: pps_state — % filas eliminadas', v_deleted;

  -- ── 2. algo_prediction_snapshot ─────────────────────────────────
  DELETE FROM hitdash.algo_prediction_snapshot WHERE algo_name = ANY(v_algos);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RAISE NOTICE 'Migration 021: algo_prediction_snapshot — % filas eliminadas', v_deleted;

  -- ── 3. algo_rank_history ─────────────────────────────────────────
  DELETE FROM hitdash.algo_rank_history WHERE algo_name = ANY(v_algos);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RAISE NOTICE 'Migration 021: algo_rank_history — % filas eliminadas', v_deleted;

  -- ── 4. cognitive_algo_weights ────────────────────────────────────
  DELETE FROM hitdash.cognitive_algo_weights WHERE algo_name = ANY(v_algos);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RAISE NOTICE 'Migration 021: cognitive_algo_weights — % filas eliminadas', v_deleted;

  -- ── 5. backtest_results_v2 (si existen registros de estos algos) ──
  IF EXISTS (
    SELECT 1 FROM hitdash.backtest_results_v2
    WHERE strategy_name = ANY(v_algos)
  ) THEN
    DELETE FROM hitdash.backtest_results_v2 WHERE strategy_name = ANY(v_algos);
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RAISE NOTICE 'Migration 021: backtest_results_v2 — % filas eliminadas', v_deleted;
  ELSE
    RAISE NOTICE 'Migration 021: backtest_results_v2 — sin registros de algos eliminados';
  END IF;

  -- ── 6. adaptive_weights (si existe la tabla) ─────────────────────
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'hitdash' AND table_name = 'adaptive_weights'
  ) THEN
    DELETE FROM hitdash.adaptive_weights WHERE strategy = ANY(v_algos);
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RAISE NOTICE 'Migration 021: adaptive_weights — % filas eliminadas', v_deleted;
  END IF;

  RAISE NOTICE 'Migration 021 completed. Algoritmos eliminados: %', v_algos;
END $$;
