-- ═══════════════════════════════════════════════════════════════
-- Migration 019: DROP tablas legacy vacías + limpieza de schema
-- 2026-05-13 — Auditoría Senior HELIX v2.4
--
-- Tablas eliminadas:
--   • feedback_loop   — VACÍA permanentemente. Solo era poblada por el
--     sistema de cartones legacy (digits JSONB). El sistema pair-mode
--     escribe DIRECTAMENTE en pair_recommendations. Nunca más se usará.
--
-- PPS states huérfanos:
--   Eliminar entradas de pps_state para los 3 algoritmos eliminados
--   (fibonacci_pisano, cycle_detector, mirror_complement).
--   Liberan ~18 rows × 6 combos = ~108 rows de ruido histórico.
-- ═══════════════════════════════════════════════════════════════

-- STEP 1: DROP feedback_loop (vacía, legacy)
DROP TABLE IF EXISTS hitdash.feedback_loop CASCADE;

-- STEP 2: Limpiar pps_state de algoritmos eliminados en v2.4
DELETE FROM hitdash.pps_state
WHERE algo_name IN ('fibonacci_pisano', 'cycle_detector', 'mirror_complement');

-- STEP 3: Limpiar algo_prediction_snapshot de algoritmos eliminados
-- (los snapshots históricos de estos algos ya no tienen valor)
DELETE FROM hitdash.algo_prediction_snapshot
WHERE algo_name IN ('fibonacci_pisano', 'cycle_detector', 'mirror_complement');

-- STEP 4: Limpiar algo_rank_history de algoritmos eliminados
DELETE FROM hitdash.algo_rank_history
WHERE algo_name IN ('fibonacci_pisano', 'cycle_detector', 'mirror_complement');

-- STEP 5: Limpiar cognitive_algo_weights de algoritmos eliminados
DELETE FROM hitdash.cognitive_algo_weights
WHERE algo_name IN ('fibonacci_pisano', 'cycle_detector', 'mirror_complement');

-- Verificación
DO $$
DECLARE
  v_feedback_exists  boolean;
  v_pps_orphans      int;
BEGIN
  SELECT EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'hitdash' AND table_name = 'feedback_loop'
  ) INTO v_feedback_exists;

  SELECT COUNT(*) INTO v_pps_orphans
  FROM hitdash.pps_state
  WHERE algo_name IN ('fibonacci_pisano', 'cycle_detector', 'mirror_complement');

  IF v_feedback_exists THEN
    RAISE NOTICE 'WARN: feedback_loop todavía existe — DROP falló';
  ELSE
    RAISE NOTICE 'OK: feedback_loop eliminada correctamente';
  END IF;

  IF v_pps_orphans = 0 THEN
    RAISE NOTICE 'OK: PPS huérfanos limpiados';
  ELSE
    RAISE NOTICE 'WARN: % entradas PPS huérfanas restantes', v_pps_orphans;
  END IF;

  RAISE NOTICE 'Migration 019 completada — HELIX v2.4 schema limpio';
END $$;
