-- ═══════════════════════════════════════════════════════════════
-- HELIX — Migration 020: Fix YY→YYYY century rollover bug
-- 2026-05-15
--
-- BUG DETECTADO en diagnostics:
--   backtest_points_v2.latest_eval = "2092-03-01"
--   Eso es una fecha FUTURA imposible. El parser interpretó "92" como
--   2092 en lugar de 1992. Probable causa: algún UPDATE/INSERT antiguo
--   que no aplicó la regla `century = YY > 30 ? '19' : '20'` correctamente.
--
-- FIX:
--   Mover toda fecha eval_date > (current_date + 5 años) a 100 años atrás.
--   Eso convierte 2092 → 1992, 2095 → 1995, etc.
--   Lo aplicamos a todas las tablas con columnas de fecha que pudieran tener
--   este envenenamiento: backtest_points_v2.eval_date.
--
-- SAFETY:
--   - Solo toca filas con fecha > current_date + 5 años (no afecta predicciones recientes)
--   - Idempotente: aplicado 2 veces, la 2a no encuentra nada que mover
-- ═══════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_fixed int;
BEGIN
  -- ── 1. backtest_points_v2.eval_date ────────────────────────────
  UPDATE hitdash.backtest_points_v2
  SET eval_date = eval_date - INTERVAL '100 years'
  WHERE eval_date > (CURRENT_DATE + INTERVAL '5 years');
  GET DIAGNOSTICS v_fixed = ROW_COUNT;
  RAISE NOTICE 'Migration 020: backtest_points_v2 — % filas con fecha futura corregidas', v_fixed;

  -- ── 2. ingested_results.draw_date (por si acaso) ───────────────
  -- Esta tabla es la fuente de verdad. Verificar pero NO modificar si NO existe el bug.
  -- (cualquier change aquí impactaría todo el motor — máxima cautela)
  IF EXISTS (
    SELECT 1 FROM hitdash.ingested_results
    WHERE draw_date > (CURRENT_DATE + INTERVAL '5 years')
  ) THEN
    UPDATE hitdash.ingested_results
    SET draw_date = draw_date - INTERVAL '100 years'
    WHERE draw_date > (CURRENT_DATE + INTERVAL '5 years');
    GET DIAGNOSTICS v_fixed = ROW_COUNT;
    RAISE NOTICE 'Migration 020: ingested_results — % filas con fecha futura corregidas', v_fixed;
  ELSE
    RAISE NOTICE 'Migration 020: ingested_results — sin fechas futuras detectadas';
  END IF;

  -- ── 3. algo_prediction_snapshot.draw_date ──────────────────────
  IF EXISTS (
    SELECT 1 FROM hitdash.algo_prediction_snapshot
    WHERE draw_date > (CURRENT_DATE + INTERVAL '5 years')
  ) THEN
    UPDATE hitdash.algo_prediction_snapshot
    SET draw_date = draw_date - INTERVAL '100 years'
    WHERE draw_date > (CURRENT_DATE + INTERVAL '5 years');
    GET DIAGNOSTICS v_fixed = ROW_COUNT;
    RAISE NOTICE 'Migration 020: algo_prediction_snapshot — % filas con fecha futura corregidas', v_fixed;
  ELSE
    RAISE NOTICE 'Migration 020: algo_prediction_snapshot — sin fechas futuras detectadas';
  END IF;

  -- ── 4. algo_rank_history.draw_date ─────────────────────────────
  IF EXISTS (
    SELECT 1 FROM hitdash.algo_rank_history
    WHERE draw_date > (CURRENT_DATE + INTERVAL '5 years')
  ) THEN
    UPDATE hitdash.algo_rank_history
    SET draw_date = draw_date - INTERVAL '100 years'
    WHERE draw_date > (CURRENT_DATE + INTERVAL '5 years');
    GET DIAGNOSTICS v_fixed = ROW_COUNT;
    RAISE NOTICE 'Migration 020: algo_rank_history — % filas con fecha futura corregidas', v_fixed;
  ELSE
    RAISE NOTICE 'Migration 020: algo_rank_history — sin fechas futuras detectadas';
  END IF;

  -- ── 5. pair_recommendations.draw_date ──────────────────────────
  IF EXISTS (
    SELECT 1 FROM hitdash.pair_recommendations
    WHERE draw_date > (CURRENT_DATE + INTERVAL '5 years')
  ) THEN
    UPDATE hitdash.pair_recommendations
    SET draw_date = draw_date - INTERVAL '100 years'
    WHERE draw_date > (CURRENT_DATE + INTERVAL '5 years');
    GET DIAGNOSTICS v_fixed = ROW_COUNT;
    RAISE NOTICE 'Migration 020: pair_recommendations — % filas con fecha futura corregidas', v_fixed;
  ELSE
    RAISE NOTICE 'Migration 020: pair_recommendations — sin fechas futuras detectadas';
  END IF;

  RAISE NOTICE 'Migration 020 completed.';
END $$;
