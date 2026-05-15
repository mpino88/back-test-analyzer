-- ═══════════════════════════════════════════════════════════════
-- HELIX — Migration 018: Backfill ingested_results desde public.draws
--
-- v2.0 (2026-05-14) — IDEMPOTENT + GRACEFUL para entornos sin public.draws.
--
-- PROBLEMA RESUELTO:
--   La versión v1 fallaba en VPS porque `public.draws` está en la BD de
--   Ballbot (Render), no en la BD local de Hitdash (VPS Postgres). El error
--   `relation "public.draws" does not exist` abortaba toda la migración 018
--   y bloqueaba 019 y posteriores.
--
-- v2 STRATEGY:
--   - PASO 1: backfill draw_key parsing — siempre seguro, NO requiere
--     public.draws (solo SPLIT_PART sobre la propia columna)
--   - PASO 2/3: protegidos por IF EXISTS check. Si public.draws no está,
--     loggea NOTICE y skip. La migration completa exitosamente.
--   - En el VPS los datos se cargan via IngestionWorker (webhook de Ballbot)
--     no via migración. Esta migración 018 solo aporta valor en entornos
--     donde Hitdash y Ballbot comparten BD (development local).
-- ═══════════════════════════════════════════════════════════════

-- ── PASO 1: Backfill draw_date, game_type, draw_type desde draw_key ──────────
-- SAFE — no depende de tablas externas, solo procesa columnas propias.
UPDATE hitdash.ingested_results
SET
  game_type = CASE SPLIT_PART(draw_key, ':', 1)
                WHEN 'p3' THEN 'pick3'
                WHEN 'p4' THEN 'pick4'
                ELSE SPLIT_PART(draw_key, ':', 1)
              END,
  draw_type = CASE SPLIT_PART(draw_key, ':', 2)
                WHEN 'm' THEN 'midday'
                WHEN 'e' THEN 'evening'
                ELSE SPLIT_PART(draw_key, ':', 2)
              END,
  draw_date = SPLIT_PART(draw_key, ':', 3)::date
WHERE draw_date IS NULL
  AND draw_key IS NOT NULL
  AND draw_key LIKE '%:%:%';

-- ── PASO 2 + 3 + VERIFICACIÓN ────────────────────────────────────────────────
-- Wrappeado en bloque PL/pgSQL para detectar public.draws antes de tocar.
-- Sin esta guarda, el deploy falla en entornos donde Hitdash y Ballbot
-- son BD separadas (producción VPS).
DO $$
DECLARE
  v_has_public_draws boolean;
  total_rows         int;
  rows_with_date     int;
  rows_null_date     int;
  rows_null_p1       int;
BEGIN
  -- Detección defensiva
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'draws'
  ) INTO v_has_public_draws;

  IF v_has_public_draws THEN
    -- ── PASO 2: Backfill p1-p4 desde public.draws ──────────────────
    UPDATE hitdash.ingested_results ir
    SET
      p1 = SPLIT_PART(d.numbers, ',', 1)::int,
      p2 = SPLIT_PART(d.numbers, ',', 2)::int,
      p3 = SPLIT_PART(d.numbers, ',', 3)::int,
      p4 = CASE
             WHEN SPLIT_PART(d.numbers, ',', 4) ~ '^\s*[0-9]+\s*$'
             THEN SPLIT_PART(d.numbers, ',', 4)::int
             ELSE NULL
           END
    FROM public.draws d
    WHERE ir.p1 IS NULL
      AND ir.draw_key IS NOT NULL
      AND SPLIT_PART(ir.draw_key, ':', 1) = d.game
      AND SPLIT_PART(ir.draw_key, ':', 2) = d.period
      AND ir.draw_date = TO_DATE(d.date, 'MM/DD/YY');

    -- ── PASO 3: Bulk-ingest filas faltantes desde public.draws ─────
    INSERT INTO hitdash.ingested_results
      (draw_key, p1, p2, p3, p4, draw_date, game_type, draw_type)
    SELECT
      d.game || ':' || d.period || ':' ||
        TO_CHAR(TO_DATE(d.date, 'MM/DD/YY'), 'YYYY-MM-DD') AS draw_key,
      SPLIT_PART(d.numbers, ',', 1)::int AS p1,
      SPLIT_PART(d.numbers, ',', 2)::int AS p2,
      SPLIT_PART(d.numbers, ',', 3)::int AS p3,
      CASE
        WHEN SPLIT_PART(d.numbers, ',', 4) ~ '^\s*[0-9]+\s*$'
        THEN SPLIT_PART(d.numbers, ',', 4)::int
        ELSE NULL
      END AS p4,
      TO_DATE(d.date, 'MM/DD/YY')                AS draw_date,
      CASE d.game WHEN 'p3' THEN 'pick3' ELSE 'pick4' END AS game_type,
      CASE d.period WHEN 'm' THEN 'midday' ELSE 'evening' END AS draw_type
    FROM public.draws d
    WHERE d.numbers IS NOT NULL
      AND d.numbers ~ '^[0-9]'
      AND NOT EXISTS (
        SELECT 1 FROM hitdash.ingested_results ir2
        WHERE ir2.draw_key = d.game || ':' || d.period || ':' ||
          TO_CHAR(TO_DATE(d.date, 'MM/DD/YY'), 'YYYY-MM-DD')
      );

    RAISE NOTICE 'Migration 018: public.draws encontrada — backfill p1-p4 + bulk insert aplicados';
  ELSE
    RAISE NOTICE 'Migration 018: public.draws NO existe en esta BD (esperado en VPS)';
    RAISE NOTICE '  → Skipping PASO 2 (backfill p1-p4) y PASO 3 (bulk insert)';
    RAISE NOTICE '  → IngestionWorker.webhook se encarga de llenar ingested_results en producción';
  END IF;

  -- ── VERIFICACIÓN final ────────────────────────────────────────────
  SELECT COUNT(*) INTO total_rows     FROM hitdash.ingested_results;
  SELECT COUNT(*) INTO rows_with_date FROM hitdash.ingested_results WHERE draw_date IS NOT NULL;
  SELECT COUNT(*) INTO rows_null_date FROM hitdash.ingested_results WHERE draw_date IS NULL;
  SELECT COUNT(*) INTO rows_null_p1   FROM hitdash.ingested_results WHERE p1 IS NULL;

  RAISE NOTICE 'Migration 018 verification:';
  RAISE NOTICE '  Total rows:          %', total_rows;
  RAISE NOTICE '  Rows with draw_date: % (%.1f%%)', rows_with_date,
    CASE WHEN total_rows > 0 THEN rows_with_date::float / total_rows * 100 ELSE 0 END;
  RAISE NOTICE '  Rows NULL draw_date: %', rows_null_date;
  RAISE NOTICE '  Rows NULL p1:        %', rows_null_p1;
END $$;
