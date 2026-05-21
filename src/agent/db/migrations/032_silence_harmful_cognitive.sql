-- ═══════════════════════════════════════════════════════════════
-- HELIX — Migration 032: Silenciar HARMFUL también en cognitive_algo_weights (F2)
-- 2026-05-21
--
-- CONTEXTO FORENSE — Layer 81 del Master Audit:
--   Migrations 025 y 030 silenciaron frequency_rank/max_per_weekday/pair_correlation
--   en adaptive_weights → weight = 0.1
--
--   PERO AnalysisEngine.effectiveWeight() lee cognitive_algo_weights PRIMERO
--   (línea 717: `cognitiveWeights[algName] ?? ALGORITHM_WEIGHTS[algName]`).
--   Cuando hay PPS cargado (98% del tiempo), salta el bloque que lee
--   adaptive_weights. Resultado: los HARMFUL siguen con peso ~1.0.
--
-- VERIFICACIÓN PRE-MIGRATION (2026-05-21):
--   frequency:         w_actual = 0.996 a 1.038
--   max_per_week_day:  w_actual = 0.933 a 1.005
--   pairs_correlation: w_actual = 0.941 a 1.045
--
-- ACCIÓN:
--   Silenciar a 0.1 en cognitive_algo_weights para los 3 HARMFUL canónicos.
--   Nombres canónicos (sin sufijos):
--     'frequency'         (no 'frequency_rank')
--     'max_per_week_day'  (no 'max_per_weekday')
--     'pairs_correlation' (no 'pair_correlation')
-- ═══════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_updated int;
BEGIN

  UPDATE hitdash.cognitive_algo_weights
  SET learned_weight = 0.1,
      updated_at     = now()
  WHERE algo_name IN ('frequency', 'max_per_week_day', 'pairs_correlation')
    AND learned_weight > 0.15;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RAISE NOTICE 'Migration 032: % entradas HARMFUL silenciadas en cognitive_algo_weights', v_updated;

  RAISE NOTICE 'Migration 032 completed.';
END $$;
