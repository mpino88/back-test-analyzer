-- ═══════════════════════════════════════════════════════════════
-- HELIX — Migration 022: Purga DEFINITIVA fibonacci_pisano
-- 2026-05-18
--
-- CONTEXTO FORENSE:
--   Migration 021 corrió 2026-05-15 16:41 y eliminó fibonacci_pisano
--   de pps_state. Pero el scheduler cognitive-relearn corrió después con
--   CognitiveLearner.ALGO_NAMES viejo (que aún tenía fibonacci_pisano) y
--   lo re-insertó. Resultado: 6 filas con sample_count hasta 13,863.
--
--   El bug en ALGO_NAMES de CognitiveLearner se corrigió en commit
--   35d5daf el 2026-05-17 17:12. Después de ese commit, ningún componente
--   debe re-insertar fibonacci_pisano. Esta migration purga el residuo.
--
-- ACCIÓN MÁS AGRESIVA QUE 021:
--   Además de DELETE, añade un trigger BLOQUEANTE que rechaza INSERTs
--   futuros de cualquier algo en la blacklist. Esto previene regresiones
--   por código legacy o componentes externos no auditados.
--
-- IDEMPOTENTE: re-ejecutable sin efectos secundarios.
-- ═══════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_deleted int;
  v_algos text[] := ARRAY['fibonacci_pisano', 'cycle_detector', 'mirror_complement'];
BEGIN

  -- ── 1. Purga residuos en TODAS las tablas de aprendizaje ───────
  DELETE FROM hitdash.pps_state WHERE algo_name = ANY(v_algos);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RAISE NOTICE 'Migration 022: pps_state — % filas residuales eliminadas', v_deleted;

  DELETE FROM hitdash.algo_prediction_snapshot WHERE algo_name = ANY(v_algos);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RAISE NOTICE 'Migration 022: algo_prediction_snapshot — % filas residuales eliminadas', v_deleted;

  DELETE FROM hitdash.algo_rank_history WHERE algo_name = ANY(v_algos);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RAISE NOTICE 'Migration 022: algo_rank_history — % filas residuales eliminadas', v_deleted;

  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='hitdash' AND table_name='cognitive_algo_weights') THEN
    DELETE FROM hitdash.cognitive_algo_weights WHERE algo_name = ANY(v_algos);
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RAISE NOTICE 'Migration 022: cognitive_algo_weights — % filas residuales eliminadas', v_deleted;
  END IF;

END $$;

-- ── 2. TRIGGER BLOQUEANTE: rechaza INSERT/UPDATE de algos eliminados ──
--    Esto previene que cualquier código legacy re-inserte estos algos.
--    Si un componente intenta insertar fibonacci_pisano, fallará con
--    una excepción clara en lugar de silenciar el problema.

CREATE OR REPLACE FUNCTION hitdash.block_eliminated_algos()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.algo_name IN ('fibonacci_pisano', 'cycle_detector', 'mirror_complement') THEN
    RAISE EXCEPTION
      'Algoritmo "%s" fue eliminado en v2.4 (2026-05-13). Revisa el código que intentó insertarlo — debería usar el catálogo actualizado.',
      NEW.algo_name
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- Aplicar trigger a las 4 tablas de aprendizaje
DROP TRIGGER IF EXISTS block_eliminated_algos_pps ON hitdash.pps_state;
CREATE TRIGGER block_eliminated_algos_pps
  BEFORE INSERT OR UPDATE OF algo_name ON hitdash.pps_state
  FOR EACH ROW EXECUTE FUNCTION hitdash.block_eliminated_algos();

DROP TRIGGER IF EXISTS block_eliminated_algos_snapshot ON hitdash.algo_prediction_snapshot;
CREATE TRIGGER block_eliminated_algos_snapshot
  BEFORE INSERT OR UPDATE OF algo_name ON hitdash.algo_prediction_snapshot
  FOR EACH ROW EXECUTE FUNCTION hitdash.block_eliminated_algos();

DROP TRIGGER IF EXISTS block_eliminated_algos_rank ON hitdash.algo_rank_history;
CREATE TRIGGER block_eliminated_algos_rank
  BEFORE INSERT OR UPDATE OF algo_name ON hitdash.algo_rank_history
  FOR EACH ROW EXECUTE FUNCTION hitdash.block_eliminated_algos();

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='hitdash' AND table_name='cognitive_algo_weights') THEN
    DROP TRIGGER IF EXISTS block_eliminated_algos_cog ON hitdash.cognitive_algo_weights;
    CREATE TRIGGER block_eliminated_algos_cog
      BEFORE INSERT OR UPDATE OF algo_name ON hitdash.cognitive_algo_weights
      FOR EACH ROW EXECUTE FUNCTION hitdash.block_eliminated_algos();
  END IF;
END $$;

DO $$ BEGIN
  RAISE NOTICE 'Migration 022 completed — fibonacci_pisano definitivamente purgado + trigger bloqueante activo.';
END $$;
