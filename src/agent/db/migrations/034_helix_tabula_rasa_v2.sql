-- ═══════════════════════════════════════════════════════════════
-- HELIX Migration 034 — Tabula Rasa v2 · Cognitive Cache Purge
--
-- CRÍTICA DEL CEO (2026-05-21):
--   "Necesitamos limpieza de cache inservible. Limpiar los ojos,
--    lavarse la cara, dormir y levantarse como nuevo. Sino
--    tendremos falsa información y análisis estadísticos una y
--    otra vez."
--
-- DIAGNÓSTICO:
--   El walk-forward de HELIX v2 sobre datos históricos arrojó
--   15.06% (baseline aleatorio) porque las tablas derivadas
--   estaban contaminadas con:
--     • 4 algoritmos fantasma eliminados solo hace 24h
--     • Pesos cognitivos sesgados por aprendizaje pre-clean
--     • backtest_points_v2 = 5.69 GB de runs históricos con
--       configuración fantasma
--     • Thompson α/β nunca tuvo data limpia
--
-- ACCIÓN:
--   TRUNCATE de TODAS las tablas derivadas/cognitivas.
--   PRESERVAR: ingested_results, algo_prediction_snapshot,
--              algo_rank_history (post-dedup), rag_knowledge,
--              algorithm_catalog, schema_migrations.
--
-- POST-MIGRATION:
--   El sistema arranca con cognición limpia. Cada draw nuevo
--   poblará Thompson/Conformal/PPS/cognitive con data v2-limpia.
--   BacktestEngine re-popula strategy_registry desde cero con
--   los 13 strats canónicos (sin fantasmas).
-- ═══════════════════════════════════════════════════════════════

-- ── Limpieza cognitiva (orden FK-safe: hijos antes que padres) ──

-- Backtest histórico (el monstruo de 5.69 GB)
TRUNCATE TABLE hitdash.backtest_points_v2 RESTART IDENTITY CASCADE;
TRUNCATE TABLE hitdash.backtest_results_v2 RESTART IDENTITY CASCADE;

-- Backtest legacy v1
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='hitdash' AND table_name='backtest_points') THEN
    TRUNCATE TABLE hitdash.backtest_points RESTART IDENTITY CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='hitdash' AND table_name='backtest_results') THEN
    TRUNCATE TABLE hitdash.backtest_results RESTART IDENTITY CASCADE;
  END IF;
END $$;

-- Progressive backtest
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='hitdash' AND table_name='progressive_results') THEN
    TRUNCATE TABLE hitdash.progressive_results RESTART IDENTITY CASCADE;
  END IF;
END $$;

-- Pesos adaptativos contaminados con fantasmas
TRUNCATE TABLE hitdash.adaptive_weights RESTART IDENTITY CASCADE;

-- Cognitive weights contaminados por aprendizaje pre-clean
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='hitdash' AND table_name='cognitive_algo_weights') THEN
    TRUNCATE TABLE hitdash.cognitive_algo_weights RESTART IDENTITY CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='hitdash' AND table_name='cognitive_learning_runs') THEN
    TRUNCATE TABLE hitdash.cognitive_learning_runs RESTART IDENTITY CASCADE;
  END IF;
END $$;

-- Strategy registry — repopulado por BacktestEngine con catálogo limpio (13 strats)
TRUNCATE TABLE hitdash.strategy_registry RESTART IDENTITY CASCADE;

-- PPS state — derivado de algo_rank_history, recomputado on-demand
TRUNCATE TABLE hitdash.pps_state RESTART IDENTITY CASCADE;

-- Thompson posteriors — recomputados por persistState()
TRUNCATE TABLE hitdash.thompson_state RESTART IDENTITY CASCADE;

-- Conformal calibration — recomputada por ConformalPredictor.calibrate()
TRUNCATE TABLE hitdash.conformal_calibration RESTART IDENTITY CASCADE;

-- EVT cache — recomputado por EVTScorer
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='hitdash' AND table_name='evt_state_cache') THEN
    TRUNCATE TABLE hitdash.evt_state_cache RESTART IDENTITY CASCADE;
  END IF;
END $$;

-- Retrospective runs — recomputados por HelixRetrospectiveSimulator
TRUNCATE TABLE hitdash.helix_retrospective_runs RESTART IDENTITY CASCADE;
TRUNCATE TABLE hitdash.helix_retrospective_summary RESTART IDENTITY CASCADE;

-- Predicciones históricas
TRUNCATE TABLE hitdash.pair_recommendations RESTART IDENTITY CASCADE;

-- Agente — sesiones, hipótesis, candidatos
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='hitdash' AND table_name='agent_sessions') THEN
    TRUNCATE TABLE hitdash.agent_sessions RESTART IDENTITY CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='hitdash' AND table_name='hypotheses') THEN
    TRUNCATE TABLE hitdash.hypotheses RESTART IDENTITY CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='hitdash' AND table_name='algorithm_candidate_history') THEN
    TRUNCATE TABLE hitdash.algorithm_candidate_history RESTART IDENTITY CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='hitdash' AND table_name='dynamic_strategies') THEN
    TRUNCATE TABLE hitdash.dynamic_strategies RESTART IDENTITY CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='hitdash' AND table_name='strategy_conditions') THEN
    TRUNCATE TABLE hitdash.strategy_conditions RESTART IDENTITY CASCADE;
  END IF;
END $$;

-- Alertas y cooldowns
TRUNCATE TABLE hitdash.proactive_alerts RESTART IDENTITY CASCADE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='hitdash' AND table_name='sentinel_cooldowns') THEN
    TRUNCATE TABLE hitdash.sentinel_cooldowns RESTART IDENTITY CASCADE;
  END IF;
END $$;

-- Job tracking
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='hitdash' AND table_name='agent_jobs') THEN
    TRUNCATE TABLE hitdash.agent_jobs RESTART IDENTITY CASCADE;
  END IF;
END $$;

-- Cartones legacy
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='hitdash' AND table_name='carton_generations') THEN
    TRUNCATE TABLE hitdash.carton_generations RESTART IDENTITY CASCADE;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- VACUUM FULL para reclamar el espacio en disco
-- (sin VACUUM, las páginas vacías quedan reservadas → no recupera GB)
-- NOTA: VACUUM FULL requiere lock exclusivo. Dado que estas tablas
-- acaban de ser TRUNCATEd, el lock es instantáneo. Ahorramos ~6 GB.
-- ─────────────────────────────────────────────────────────────────
-- Comentado: VACUUM FULL no puede correr dentro de transacción y
-- migrate.ts ejecuta cada migration en BEGIN/COMMIT. Se debe correr
-- manualmente post-migration o vía un job paralelo. Ver script:
-- src/agent/scripts/vacuum-after-tabula-rasa.sh

COMMENT ON SCHEMA hitdash IS
  'Schema hitdash. Tabula Rasa v2 ejecutada 2026-05-21. '
  'Tablas derivadas/cognitivas wipe-ed. Cognición limpia desde cero.';
