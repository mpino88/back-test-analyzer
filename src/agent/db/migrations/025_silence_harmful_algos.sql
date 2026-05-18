-- ═══════════════════════════════════════════════════════════════
-- HELIX — Migration 025: Silenciar HARMFUL algos + purgar pps_state fantasmas
-- 2026-05-18 (F1-A + E2)
--
-- CONTEXTO FORENSE:
--   StatisticalEdgeValidator (F1 validation, 495,795 registros, 5 años):
--   3 algoritmos están SIGNIFICATIVAMENTE POR DEBAJO del azar puro:
--     • frequency_rank   z=-1.77  hr@15=14.70%  (n=43,856)
--     • max_per_weekday  z=-3.63  hr@15=14.38%  (n=43,857) ← más dañino
--     • pair_correlation z=-1.76  hr@15=14.40%  (n=11,198)
--
--   Sus adaptive_weights actuales AMPLIFICAN el daño:
--     frequency_rank   → pick4/evening = 1.2558 (amplificando algo harmful)
--     max_per_weekday  → pick3/combined = 1.1009 (idem)
--     pair_correlation → pick3/midday   = 1.0600 (idem)
--
--   SOLUCIÓN: Reducir todos sus adaptive_weights a 0.1 (mínimo técnico).
--   Esto prácticamente silencia su contribución al consensus sin eliminarlos
--   del sistema (preserva trazabilidad y permite re-activar si mejoran).
--
-- E2 — pps_state fantasma:
--   fibonacci_resonance tiene 3 rows en pps_state (residuo de
--   AlgorithmCandidateService legacy). DELETE directo.
--   Migration 022 ya tiene trigger que bloquea re-inserción de
--   'fibonacci_pisano'. fibonacci_resonance no está cubierto — DELETE
--   es suficiente (no hay código activo que lo inserte).
--
-- IDEMPOTENTE: UPDATE con WHERE siempre procesa mismo resultado.
-- ═══════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_updated_harmful int;
  v_deleted_phantom int;
BEGIN

  -- ── 1. Silenciar HARMFUL algos en adaptive_weights ────────────
  UPDATE hitdash.adaptive_weights
  SET weight = 0.1
  WHERE strategy IN ('frequency_rank', 'max_per_weekday', 'pair_correlation')
    AND weight != 0.1;

  GET DIAGNOSTICS v_updated_harmful = ROW_COUNT;
  RAISE NOTICE 'Migration 025: % entradas de adaptive_weights silenciadas (3 algos HARMFUL → weight=0.1)', v_updated_harmful;

  -- ── 2. Purgar fibonacci_resonance de pps_state ────────────────
  DELETE FROM hitdash.pps_state
  WHERE algo_name = 'fibonacci_resonance';

  GET DIAGNOSTICS v_deleted_phantom = ROW_COUNT;
  RAISE NOTICE 'Migration 025: % filas de pps_state eliminadas (fibonacci_resonance)', v_deleted_phantom;

  -- ── 3. Purgar fibonacci_resonance de algo_rank_history ────────
  -- 15 rows con avg_rank=50-85 son basura histórica del AlgorithmCandidateService
  DELETE FROM hitdash.algo_rank_history
  WHERE algo_name = 'fibonacci_resonance';

  RAISE NOTICE 'Migration 025: algo_rank_history fibonacci_resonance purgado.';
  RAISE NOTICE 'Migration 025 completed.';
END $$;
