-- ═══════════════════════════════════════════════════════════════
-- HELIX — Migration 031: Dedupe + UNIQUE constraint en algo_rank_history (F3)
-- 2026-05-21
--
-- CONTEXTO FORENSE — Layer 37 del Master Audit:
--   algo_rank_history (541,919 rows) carecía de UNIQUE constraint.
--   Análisis pre-migración: 311,597 rows DUPLICADAS (57.5% del total).
--   Cada retry/race de processPostDraw insertaba la MISMA observación.
--
-- IMPACTO CONFIRMADO de los duplicados:
--   • Wilson lower bound: numerador y denominador doblados → CI artificialmente estrecho
--   • Beta posteriors (α=hits+1, β=misses+1): sample size inflado √2x
--   • Champion Mode pudo dispararse en artefactos
--   • Statistical edge (z-scores) sesgados hacia significancia
--
-- ESTRATEGIA:
--   1. Tabla temp con row_number() particionado, conservar MIN(id) (más antiguo determinístico)
--   2. DELETE rows duplicadas
--   3. ADD CONSTRAINT UNIQUE
--   4. Verificación post-migración
--
-- IDEMPOTENTE: Si ya hay UNIQUE, skip. Si no hay duplicates, skip dedupe.
-- ═══════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_total_before    int;
  v_distinct_before int;
  v_duplicates      int;
  v_total_after     int;
  v_has_constraint  boolean;
BEGIN

  -- Verificar si la constraint ya existe (idempotencia)
  SELECT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'hitdash'
      AND table_name = 'algo_rank_history'
      AND constraint_name = 'algo_rank_history_uniq'
  ) INTO v_has_constraint;

  IF v_has_constraint THEN
    RAISE NOTICE 'Migration 031: constraint algo_rank_history_uniq ya existe — skip';
    RETURN;
  END IF;

  -- ── 1. Diagnóstico pre-dedupe ──────────────────────────────────
  SELECT COUNT(*) INTO v_total_before FROM hitdash.algo_rank_history;
  SELECT COUNT(DISTINCT (algo_name, game_type, draw_type, draw_date, half))
    INTO v_distinct_before FROM hitdash.algo_rank_history;
  v_duplicates := v_total_before - v_distinct_before;

  RAISE NOTICE 'Migration 031 pre-dedupe: total=% distinct=% duplicates=%',
    v_total_before, v_distinct_before, v_duplicates;

  -- ── 2. Dedupe — conservar PRIMER row por combo (created_at ASC, id tiebreak) ──
  -- UUID no soporta MIN(), usamos ROW_NUMBER() para determinismo.
  IF v_duplicates > 0 THEN
    DELETE FROM hitdash.algo_rank_history
    WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY algo_name, game_type, draw_type, draw_date, half
          ORDER BY created_at ASC, id ASC
        ) AS rn
        FROM hitdash.algo_rank_history
      ) sub
      WHERE sub.rn > 1
    );

    SELECT COUNT(*) INTO v_total_after FROM hitdash.algo_rank_history;
    RAISE NOTICE 'Migration 031: % rows duplicadas eliminadas. Total post-dedupe: %',
      v_total_before - v_total_after, v_total_after;
  END IF;

  -- ── 3. Añadir UNIQUE constraint ─────────────────────────────────
  ALTER TABLE hitdash.algo_rank_history
    ADD CONSTRAINT algo_rank_history_uniq
    UNIQUE (algo_name, game_type, draw_type, draw_date, half);

  RAISE NOTICE 'Migration 031: UNIQUE constraint algo_rank_history_uniq añadida.';

  -- ── 4. Verificación final ───────────────────────────────────────
  SELECT COUNT(*) INTO v_total_after FROM hitdash.algo_rank_history;
  RAISE NOTICE 'Migration 031 completed. Estado final: % rows únicas.', v_total_after;

END $$;
