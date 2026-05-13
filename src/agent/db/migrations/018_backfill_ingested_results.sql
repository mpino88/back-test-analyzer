-- ═══════════════════════════════════════════════════════════════
-- HELIX — Migration 018: Backfill ingested_results desde public.draws
--
-- FORENSE F01: Las filas de ingested_results ingestadas ANTES de que
-- se aplicara migration 011 tienen draw_date/game_type/draw_type/p1-p4 = NULL.
-- El DRAWS_CTE filtra por draw_date, por lo que esas filas son INVISIBLES
-- para todos los algoritmos, HypothesisValidator, y SnapshotBackfillService.
-- Resultado: 13,889 filas en ingested_results pero solo 7 con draw_date != NULL.
--
-- PASO 1: Poblar draw_date, game_type, draw_type desde draw_key (sin join externo)
--   draw_key format: "{game}:{period}:{YYYY-MM-DD}"
--   Ejemplo: "p3:e:2026-03-22" → game_type='pick3', draw_type='evening', draw_date='2026-03-22'
--
-- PASO 2: Poblar p1,p2,p3,p4 desde public.draws para filas donde son NULL
--   Join por: game + period + TO_DATE(date, 'MM/DD/YY') = draw_date
--
-- PASO 3: Bulk-ingest filas de public.draws que aún no están en ingested_results
--   (20,457 en public.draws − 13,889 en ingested_results = ~6,568 pendientes)
-- ═══════════════════════════════════════════════════════════════

-- ── PASO 1: Backfill draw_date, game_type, draw_type desde draw_key ──────────
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
  AND draw_key LIKE '%:%:%';  -- safety guard: solo filas con formato válido

-- ── PASO 2: Backfill p1,p2,p3,p4 desde public.draws por filas con NULL dígitos ──
-- Join: draw_key "p3:e:2026-03-22" ↔ public.draws donde game='p3', period='e',
--       TO_CHAR(TO_DATE(date,'MM/DD/YY'),'YYYY-MM-DD') = '2026-03-22'
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

-- ── PASO 3: Bulk-ingest sorteos faltantes de public.draws ────────────────────
-- Inserta filas de public.draws que aún no existen en ingested_results.
-- ON CONFLICT DO NOTHING garantiza idempotencia total.
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
  AND d.numbers ~ '^[0-9]'  -- evitar filas con data corrupta
  AND NOT EXISTS (
    SELECT 1 FROM hitdash.ingested_results ir2
    WHERE ir2.draw_key = d.game || ':' || d.period || ':' ||
      TO_CHAR(TO_DATE(d.date, 'MM/DD/YY'), 'YYYY-MM-DD')
  );

-- ── VERIFICACIÓN (output informativo) ────────────────────────────────────────
DO $$
DECLARE
  total_rows      int;
  rows_with_date  int;
  rows_null_date  int;
  rows_null_p1    int;
BEGIN
  SELECT COUNT(*) INTO total_rows      FROM hitdash.ingested_results;
  SELECT COUNT(*) INTO rows_with_date  FROM hitdash.ingested_results WHERE draw_date IS NOT NULL;
  SELECT COUNT(*) INTO rows_null_date  FROM hitdash.ingested_results WHERE draw_date IS NULL;
  SELECT COUNT(*) INTO rows_null_p1    FROM hitdash.ingested_results WHERE p1 IS NULL;
  RAISE NOTICE 'Migration 018 complete:';
  RAISE NOTICE '  Total rows:          %', total_rows;
  RAISE NOTICE '  Rows with draw_date: % (%.1f%%)', rows_with_date,
    CASE WHEN total_rows > 0 THEN rows_with_date::float / total_rows * 100 ELSE 0 END;
  RAISE NOTICE '  Rows NULL draw_date: %', rows_null_date;
  RAISE NOTICE '  Rows NULL p1:        %', rows_null_p1;
END $$;
