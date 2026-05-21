-- ═══════════════════════════════════════════════════════════════
-- HELIX — Migration 030: Silenciar HARMFUL algos también en pick3
-- 2026-05-20 (A1 — closing gap from migration 025)
--
-- CONTEXTO:
--   Migration 025 (2026-05-18) silenció HARMFUL solo en pick4.
--   Auditoría post-revert reveló que pick3 sigue amplificándolos:
--     frequency_rank   pick3 midday  = 1.0763  (z=-1.77, hr@15=14.70%)
--     max_per_weekday  pick3 midday  = 1.0763  (z=-3.63, hr@15=14.38%)
--     pair_correlation pick3 midday  = 1.0879  (z=-1.76, hr@15=14.40%)
--     frequency_rank   pick3 evening = 1.0085  (mismo HARMFUL)
--     max_per_weekday  pick3 evening = 1.0510
--     pair_correlation pick3 evening = 1.0426
--
--   StatisticalEdgeValidator confirma estos algos están SIGNIFICATIVAMENTE
--   por debajo del azar puro (Wilson lower < baseline 15%).
--
-- ACCIÓN: weight=0.1 (mínimo técnico) en pick3 también.
-- IDEMPOTENTE: WHERE weight!=0.1 evita updates redundantes.
-- ═══════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_updated int;
BEGIN

  UPDATE hitdash.adaptive_weights
  SET weight = 0.1
  WHERE strategy IN ('frequency_rank', 'max_per_weekday', 'pair_correlation')
    AND game_type = 'pick3'
    AND mode IN ('midday', 'evening')
    AND weight != 0.1;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RAISE NOTICE 'Migration 030: % entradas pick3 silenciadas (3 algos HARMFUL × 2 modes)', v_updated;

  -- Confirmar estado final
  RAISE NOTICE 'Estado final HARMFUL:';
  FOR v_updated IN
    SELECT 1 FROM hitdash.adaptive_weights
    WHERE strategy IN ('frequency_rank','max_per_weekday','pair_correlation')
      AND weight = 0.1
  LOOP
    NULL;
  END LOOP;

  RAISE NOTICE 'Migration 030 completed.';
END $$;
