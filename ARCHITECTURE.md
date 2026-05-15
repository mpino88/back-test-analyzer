# HELIX — Arquitectura Completa v2.0
> Auditoría Senior Level | back-test-analyser | 2026-05-15

---

## 🧠 HELIX vs AGENT — Cerebro vs Conciencia

```
                  ┌─────────────────────────────────────────┐
                  │           HITDASH AGENT                 │
                  │       (La Conciencia / The Will)        │
                  │                                         │
                  │   • Decide CUÁNDO pensar (AgentScheduler│
                  │     cron, manual triggers, webhooks)    │
                  │   • Decide QUÉ HACER con el output      │
                  │     (Telegram, DB, cartones, alerts)    │
                  │   • Meta-cognición (am I performing?)   │
                  │   • Autonomía (HelixSentinel proactivo) │
                  │   • Bootstrap (BootstrapLearning,       │
                  │     GenesisBootstrap, AutoLearningLoop) │
                  │                                         │
                  │   USA Y CONSULTA ↓                      │
                  └─────────────────┬───────────────────────┘
                                    │
                                    ▼
                  ┌─────────────────────────────────────────┐
                  │              HELIX                      │
                  │       (El Cerebro / The Brain)          │
                  │                                         │
                  │   • AnalysisEngine: 20 algoritmos       │
                  │   • PPSService: aprendizaje EMA live    │
                  │   • CognitiveLearner: pesos óptimos     │
                  │   • DiversityAnalyzer: redundancia      │
                  │   • HealthMonitor: killswitch           │
                  │   • Champion Mode: dominancia auto      │
                  │   • MomentumBucketAnalyzer: empirismo   │
                  │                                         │
                  │   No actúa. Solo computa, ranquea,      │
                  │   aprende y se auto-modula.             │
                  └─────────────────────────────────────────┘
```

**La asociación:**
- HELIX **no hace nada** sin que el Agent lo invoque. Es puramente analítico.
- El Agent **no piensa** — orquesta tiempo, decide acciones, gestiona comunicación.
- Es la separación clásica `policy ↔ mechanism`. HELIX es el mecanismo. El Agent es la política.

**Bucle de aprendizaje completo (autónomo):**
```
1. Agent: AgentScheduler cron dispara → HitdashAgent.run()
2. Agent ↓ pide a HELIX: AnalysisEngine.analyzePairs(combo)
3. HELIX: 20 algos en paralelo → consensus ponderado → ranked_pairs
4. HELIX: PPSService.persistSnapshot() — guarda evidencia para aprender después
5. Agent: PairRecommender → genera ticket final → DB + Telegram
                              ⋮
                       [sorteo ocurre]
                              ⋮
6. Agent: IngestionWorker detecta sorteo → enqueue PostDrawProcessor
7. PostDrawProcessor:
   ├─ FASE A: marca pair_recommendations.hit
   ├─ FASE B: PPSService.processPostDraw() → HELIX aprende rank de ganador
   ├─ FASE E: DriftDetector → si cambió la distribución, recalibrar pesos
   ├─ FASE G: AutoLearningLoop → genera hipótesis exploratorias
   └─ FASE H: HelixSentinel → alertas proactivas Telegram
8. Próximo ciclo: HELIX usa el nuevo PPS para ponderar mejor el consensus
```

**Genesis Bootstrap (v3.1) — el "Big Bang Cognitivo":**

Permite saltarse las semanas de espera para acumular data nueva. Replica retroactivamente el ciclo de aprendizaje sobre los 39,764 sorteos ya en BD:

```
GENESIS = BACKFILL(snapshots) + REPLAY(PPS) + LEARN(cognitive) + DETECT(champion)
            ↓                    ↓             ↓                 ↓
         8 algos SQL          rank history   cognitive_weights  pps_state mature
```

Después de Genesis, el sistema arranca CON memoria operacional, NO desde cero.

---



---

## ÍNDICE

1. [Mapa del sistema](#1-mapa-del-sistema)
2. [Flujo de predicción](#2-flujo-de-predicción)
3. [Flujo de feedback / aprendizaje](#3-flujo-de-feedback--aprendizaje)
4. [Mapa de base de datos](#4-mapa-de-base-de-datos)
5. [Auditoría de algoritmos](#5-auditoría-de-algoritmos)
6. [Mapa de dependencias frontend → API](#6-mapa-de-dependencias-frontend--api)
7. [Bugs conocidos y estado](#7-bugs-conocidos-y-estado)
8. [Diagnóstico: AccuracyView 0.00%](#8-diagnóstico-accuracyview-000)
9. [Decisiones arquitectónicas: qué cortar](#9-decisiones-arquitectónicas-qué-cortar)

---

## 1. Mapa del sistema

```
┌─────────────────────────────────────────────────────────────────────────┐
│  CAPA EXTERNA                                                           │
│  ball-monitor (scraper FL Lottery)                                      │
│  ↓ webhook POST /api/ingest                                             │
└──────────────────────────┬──────────────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────────────┐
│  SERVIDOR EXPRESS (src/server/index.ts)                                 │
│  Port: 3001 (VPS) / 3001 (local)                                        │
│  ├── /api/agent/*         → agentRouter.ts                              │
│  ├── /api/backtest-ctrl/* → backtestControlRouter.ts                    │
│  ├── /api/ingest          → ingestRouter.ts                             │
│  ├── /api/sse             → sseRouter.ts                                │
│  └── /health              → healthRouter.ts                             │
└──────────────────────────┬──────────────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────────────┐
│  SERVICIOS CORE (BullMQ workers, Redis)                                 │
│                                                                         │
│  AgentScheduler ──────────────────────────────────────────────────────  │
│  (BullMQ: hitdash-agent queue)                                          │
│  Cron: pick3-midday 14:30 UTC | pick3-evening 21:30 UTC                 │
│        pick4-midday 14:35 UTC | pick4-evening 21:35 UTC                 │
│  └── worker → HitdashAgent.run()                                        │
│                                                                         │
│  IngestionWorker ─────────────────────────────────────────────────────  │
│  (BullMQ: hitdash-ingestion queue)                                      │
│  Safety net: 17:30 UTC + 02:30 UTC                                      │
│  Primary: webhook POST /api/ingest → triggerManual()                    │
│  └── worker → runIngestion() → feedbackProcessor.enqueue()              │
│                                                                         │
│  PostDrawProcessor ───────────────────────────────────────────────────  │
│  (BullMQ: hitdash-feedback queue)                                       │
│  └── worker → process() → 8 fases de aprendizaje                       │
└──────────────────────────┬──────────────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────────────┐
│  BASE DE DATOS                                                          │
│  ├── BALLBOT_DATABASE_URL (Render, READ-ONLY)                           │
│  │   └── public.draws   ← fuente de verdad de sorteos                  │
│  └── AGENT_DATABASE_URL  (VPS, READ-WRITE)                             │
│      └── hitdash.*       ← todas las tablas del agente                 │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Flujo de predicción

```
AgentScheduler (cron 14:30 UTC)
  │
  ▼
HitdashAgent.run(game_type, draw_type, draw_date)
  │
  ├── StrategyLifecycleManager.getActiveStrategies()
  │   → hitdash.dynamic_strategies (WHERE lifecycle_status IN 'active','consolidated')
  │
  ├── AnalysisEngine.analyzePairs(game_type, draw_type, half='du'|'ab'|'cd')
  │   │
  │   ├── PPSService.loadPPS() → hitdash.pps_state
  │   │   (PPS[algo] = EMA(101−rank_ganador, α=0.15) aprendido sorteo a sorteo)
  │   │
  │   ├── CognitiveLearner weights → hitdash.cognitive_algo_weights
  │   │
  │   ├── adaptive_weights → hitdash.adaptive_weights (legacy layer)
  │   │
  │   ├── AlgorithmHealthMonitor.getHealth() → hitdash.algo_rank_history
  │   │   (DISABLED: hit_rate < baseline×1.10 sostenido)
  │   │   (DEGRADED: hit_rate < baseline, weight × 0.5)
  │   │
  │   ├── AlgorithmDiversityAnalyzer.analyze()
  │   │   (Jaccard > 0.65 → cluster dividido por K)
  │   │
  │   ├── 23 algoritmos en paralelo (Promise.allSettled):
  │   │   LAYER 1 — Estadísticos clásicos:
  │   │     frequency, gap_analysis, hot_cold, pairs_correlation,
  │   │     fibonacci_pisano, streak, position, moving_averages
  │   │   LAYER 2 — Ballbot clones (DB-backed):
  │   │     bayesian_score, transition_follow, markov_order2,
  │   │     calendar_pattern, decade_family, max_per_week_day
  │   │   LAYER 3 — Predictivos avanzados:
  │   │     pair_return_cycle, sum_pattern_filter, double_triple,
  │   │     cross_draw_correlation, trend_momentum
  │   │   LAYER 4 — Absorción Ballbot:
  │   │     est_individuales, cycle_detector, terminal_analysis,
  │   │     mirror_complement
  │   │
  │   ├── Consensus: Σ(score_normalizado × weight_efectivo) / Σ(weight)
  │   │   weight_efectivo = cognitiveWeight × (0.1 + PPS/100 × 1.9) / diversityDivisor
  │   │
  │   ├── PPSService.computeOptimalN() → optimal_n (min N donde ROI ≥ 1%)
  │   │   (fallback: CognitiveLearner N si PPS < 3 sorteos)
  │   │
  │   └── PPSService.persistSnapshot() → hitdash.algo_prediction_snapshot
  │       (scores por par por algo — necesarios para post-draw learning)
  │
  ├── PairRecommender.recommend(analysis, topNOverride)
  │   → { pairs: string[], tiers: {must,cover,watch}, confidence, has_edge }
  │
  ├── INSERT hitdash.pair_recommendations
  │   (game_type, draw_type, draw_date, half, pairs, optimal_n, hit=NULL)
  │
  ├── CartonGenerator (legacy carton fallback)
  │
  └── TelegramNotifier.notifyPairs() → Telegram bot
```

---

## 3. Flujo de feedback / aprendizaje

```
ball-monitor detecta sorteo nuevo
  │
  ▼
POST /api/ingest
  │
  ▼
IngestionWorker.runIngestion()
  ├── INSERT hitdash.ingested_results (draw_key, p1-p4, draw_date, game_type, draw_type)
  └── PostDrawProcessor.enqueue({ draw_id, game_type, draw_type, draw_date, actual_digits })
          │
          ▼
      PostDrawProcessor.process()
          │
          ├── FASE A: updateLivePairHits()
          │   ├── UPDATE hitdash.pair_recommendations
          │   │   SET hit=true/false, actual_pair, hit_at_rank
          │   │   WHERE game_type=$1 AND draw_type=$2 AND draw_date=$3 AND hit IS NULL
          │   └── UPDATE hitdash.backtest_points_v2 SET hit_pair=true WHERE ...
          │
          ├── FASE B: updatePPSPostDraw() — EL APRENDIZAJE REAL
          │   └── PPSService.processPostDraw(game_type, draw_type, draw_date, half, winning_pair)
          │       ├── Lee hitdash.algo_prediction_snapshot (scores del día)
          │       ├── Calcula rank_of_winner por algoritmo
          │       ├── PPS_new = α × (101 − rank) + (1−α) × PPS_old
          │       │   (α=0.30 si sample_count<30, α=0.15 si ≥30)
          │       ├── UPDATE hitdash.pps_state
          │       └── INSERT hitdash.algo_rank_history
          │
          ├── FASE C: updateLiveAdaptiveWeights() + updateLiveAdaptiveTopN() (LEGACY)
          │
          ├── FASE D: Comparación cartones legacy (solo si existen)
          │
          ├── FASE E: DriftDetector.detect() → applyDriftWeightReduction() si p<0.05
          │
          ├── FASE F: Accuracy alert si hit_rate < 5% en últimos 30d
          │
          ├── FASE G: AutoLearningLoop.processDrawResult() [background]
          │   └── anomaly detection → hypothesis generation → micro-strategies
          │
          └── FASE H: HelixSentinel.evaluate() [background]
              └── proactive alerts → Telegram
```

**CICLO COMPLETO DE APRENDIZAJE (por sorteo):**
```
Predicción (t)     → algo_prediction_snapshot (scores por par)
Post-sorteo (t+1)  → pps_state actualizado (α-EMA del rank real)
Predicción (t+1)   → loadPPS() → pesos adaptativos frescos → mejor ranking
```

---

## 4. Mapa de base de datos

### hitdash schema — 18 tablas funcionales

```
┌─────────────────────────────────────────────────────────────────────────┐
│ DATOS BASE (fuente de verdad local)                                     │
├─────────────────────────────────────────────────────────────────────────┤
│ ingested_results         │ 13,859 rows │ Copia local de sorteos FL      │
│   draw_key (unique)      │             │ p1-p4, draw_date, game_type    │
│   ORIGEN: public.draws   │             │ POBLADO: migration 018 + IW    │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ MOTOR-Σ (aprendizaje PPS)                                               │
├─────────────────────────────────────────────────────────────────────────┤
│ pps_state                │ ~138 rows   │ PPS actual por algo/combo      │
│   algo_name, game_type,  │             │ (23 algos × 6 combos max)      │
│   draw_type, half, pps,  │             │ POBLADO: processPostDraw()      │
│   sample_count           │             │                                 │
│                          │             │                                 │
│ algo_prediction_snapshot │ ~N rows     │ Scores por par por algo por día│
│   game_type, draw_type,  │             │ ESCRITO: persistSnapshot()      │
│   draw_date, half,       │             │ LEÍDO: processPostDraw()        │
│   algo_name, pair_scores │             │                                 │
│                          │             │                                 │
│ algo_rank_history        │ ~N rows     │ Historial EMA de ranks          │
│   rank_of_winner, pps_*  │             │ ESCRITO: processPostDraw()      │
│   draw_date              │             │ LEÍDO: computeOptimalN()        │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ PREDICCIONES VIVAS                                                      │
├─────────────────────────────────────────────────────────────────────────┤
│ pair_recommendations     │ ~N rows     │ Predicciones + hit/miss        │
│   game_type, draw_type,  │             │ hit IS NULL = pendiente         │
│   draw_date, half,       │             │ hit=true = par ganador en lista │
│   pairs TEXT[],          │             │ ESCRITO: HitdashAgent           │
│   hit BOOLEAN,           │             │ ACTUALIZADO: PostDrawProcessor  │
│   hit_at_rank INT,       │             │                                 │
│   optimal_n INT          │             │                                 │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ BACKTEST                                                                │
├─────────────────────────────────────────────────────────────────────────┤
│ backtest_results_v2      │ ~N rows     │ Métricas por estrategia         │
│   strategy_name, mode,   │             │ kelly, wilson, precision@K      │
│   half, hit_rate,        │             │ ESCRITO: PairBacktestEngine      │
│   expected_rank, sharpe  │             │ LEÍDO: computeCognitiveN()      │
│                          │             │                                 │
│ backtest_points_v2       │ ~N rows     │ Puntos de evaluación por sorteo │
│   backtest_id, eval_date,│             │ ACTUALIZADO: updateLivePairHits │
│   top_pairs, hit_pair    │             │                                 │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ APRENDIZAJE COGNITIVO                                                   │
├─────────────────────────────────────────────────────────────────────────┤
│ cognitive_algo_weights   │ ~N rows     │ Pesos optimizados histórico     │
│   algo_name, game_type,  │             │ ESCRITO: CognitiveLearner        │
│   draw_type, half,       │             │ LEÍDO: AnalysisEngine            │
│   learned_weight         │             │                                 │
│                          │             │                                 │
│ adaptive_weights         │ ~N rows     │ Pesos legacy (compatibilidad)   │
│   strategy, game_type,   │             │ FALLBACK de PPS                  │
│   mode, weight, top_n    │             │                                 │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ AGENTE AUTÓNOMO                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│ agent_sessions           │ audit log   │ Cada ciclo del agente           │
│ proactive_alerts         │ alert queue │ Drift, anomaly, PPS alerts      │
│ dynamic_strategies       │ lifecycle   │ Micro-estrategias autónomas     │
│ agentic_hypotheses       │ research    │ Hipótesis generadas             │
│ rag_knowledge            │ embeddings  │ Conocimiento narrativo          │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ LEGACY (vacíos/sin uso activo)                                          │
├─────────────────────────────────────────────────────────────────────────┤
│ feedback_loop            │ VACÍO       │ Solo sistema de cartones legacy │
│ carton_generations       │ parcial     │ Sistema pre-pair-mode           │
│ strategy_registry        │ parcial     │ Nombres legacy                  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Auditoría de algoritmos

### Contrato de cada algoritmo: `runPairs(game_type, draw_type, half, period) → Record<string, number>`
Retorna: 100 pares "00"-"99" con scores [0, ∞) normalizados internamente.

```
╔══════════════════════════════════════════════════════════════════════════════════════════╗
║ ALGORITMO              │ CAPA │ BASE EMPÍRICA        │ PESO BASE │ ESTADO │ ACCIÓN      ║
╠══════════════════════════════════════════════════════════════════════════════════════════╣
║ frequency              │  1   │ Alta (siempre válida) │   0.60    │ KEEP   │ Foundation ║
║ hot_cold               │  1   │ Media (ventana 7d)    │   0.55    │ KEEP   │ Foundation ║
║ position               │  1   │ Media (chi²)          │   0.55    │ KEEP   │ Foundation ║
║ calendar_pattern       │  1   │ ALTA χ²=18.47 DOW ✓  │   1.00    │ KEEP ★ │ Core       ║
║ gap_analysis           │  1   │ BAJA (fallacia)       │   0.55    │ CAP★   │ Cap=3x     ║
║ markov_order2          │  2   │ BAJA autocorr≈0       │   0.30    │ REDUCE │ Low weight ║
║ transition_follow      │  2   │ BAJA autocorr≈0       │   0.35    │ REDUCE │ Low weight ║
║ bayesian_score         │  2   │ Media (multi-factor)  │   0.70    │ KEEP   │ Ensemble   ║
║ decade_family          │  2   │ Media (momentum)      │   0.65    │ KEEP   │ Momentum   ║
║ max_per_week_day       │  2   │ Media (DOW bucket)    │   0.65    │ KEEP   │ Calendar   ║
║ moving_averages        │  1   │ Media (trend)         │   0.55    │ KEEP   │ Trend      ║
║ trend_momentum         │  4   │ Media (EMA/SMA)       │   0.65    │ KEEP   │ Trend      ║
║ sum_pattern_filter     │  3   │ Media (distribución)  │   0.65    │ KEEP   │ Filter     ║
║ double_triple_detect.  │  3   │ Media (patrón)        │   0.60    │ KEEP   │ Pattern    ║
║ pair_return_cycle      │  3   │ Baja-Media             │   0.55    │ WATCH  │ Unproven   ║
║ cross_draw_corr.       │  3   │ BAJA autocorr≈0       │   0.30    │ REDUCE │ Cluster w/ ║
║                        │      │                       │           │        │ markov_2   ║
║ est_individuales       │  5   │ Media (calor+deuda)   │   0.65    │ KEEP   │ Hybrid     ║
║ streak                 │  1   │ Baja (paradoja)       │   0.45    │ WATCH  │ Low conf   ║
║ pairs_correlation      │  1   │ Baja-Media             │   0.50    │ WATCH  │ Weak sig   ║
║ fibonacci_pisano       │  1   │ MUY BAJA (numerology) │   0.40    │ ELIM ★ │ No basis   ║
║ cycle_detector         │  6   │ MUY BAJA (cycles)     │   0.25    │ ELIM ★ │ No basis   ║
║ terminal_analysis      │  6   │ Baja (dígito final)   │   0.50    │ WATCH  │ Weak       ║
║ mirror_complement      │  6   │ MUY BAJA (numerology) │   0.55    │ ELIM ★ │ No basis   ║
╚══════════════════════════════════════════════════════════════════════════════════════════╝

LEYENDA:
★ ELIM = eliminar de consensus (3 algoritmos): fibonacci_pisano, cycle_detector, mirror_complement
★ CAP  = mantener con GAMBLER_FALLACY_CAP ya aplicado (gap_analysis)
```

### Redundancy clusters confirmados (Jaccard > 0.65):
- `[cross_draw, markov_order2]` → dividir por 2 (ya implementado via diversity penalty)

### Qué ELIMINAR definitivamente (3 algoritmos):
1. **fibonacci_pisano** — Secuencias de Fibonacci no tienen relación con RNG certificado de FL Lottery. Peso base 0.40 (más bajo de los 23). PPS convergerá a < 20 inevitablemente.
2. **cycle_detector** — "Ciclos" en datos independientes son artefactos estadísticos. No hay mecanismo generativo. Peso base 0.25.
3. **mirror_complement** — Simetría de dígitos (complementarios, espejos) sin base en el proceso de sorteo real. Peso base 0.55 pero sin fundamento.

**Reducción: 23 → 20 algoritmos. El consensus se vuelve más limpio y los 3 slots liberados reducen ruido.**

---

## 6. Mapa de dependencias frontend → API

```
Vista                  │ Composable              │ Endpoint              │ Tabla(s)
───────────────────────┼─────────────────────────┼───────────────────────┼──────────────────────
DashboardView          │ useHelixBrain,           │ /api/agent/status     │ agent_sessions
                       │ useAgentStatus           │ /api/agent/pps        │ pps_state
                       │                          │ /api/agent/algo-div.  │ algo_prediction_snap.
                       │                          │ /api/agent/algo-health│ algo_rank_history
                       │                          │ /api/agent/diagnostics│ múltiples
───────────────────────┼─────────────────────────┼───────────────────────┼──────────────────────
AccuracyView           │ useAccuracy              │ /api/agent/accuracy   │ pair_recommendations
                       │                          │                       │ (hit IS NOT NULL)
───────────────────────┼─────────────────────────┼───────────────────────┼──────────────────────
AlertsView             │ useAlerts                │ /api/agent/alerts     │ proactive_alerts
───────────────────────┼─────────────────────────┼───────────────────────┼──────────────────────
StrategyTrackingView   │ useStrategyTracking,     │ /api/agent/strategies │ dynamic_strategies
                       │ useBacktestV2            │ /api/agent/backtest-v2│ backtest_results_v2
                       │                          │ /api/agent/algo-health│ algo_rank_history
───────────────────────┼─────────────────────────┼───────────────────────┼──────────────────────
AnomalyView            │ useStrategies            │ /api/agent/anomalies  │ agentic_hypotheses
                       │                          │ /api/agent/strategies │ dynamic_strategies
───────────────────────┼─────────────────────────┼───────────────────────┼──────────────────────
RetrospectiveView      │ (inline)                 │ /api/agent/retro      │ algo_prediction_snap.
                       │                          │ /api/agent/backfill   │ (SSE progress)
───────────────────────┼─────────────────────────┼───────────────────────┼──────────────────────
BacktestControlView    │ useBacktestControl       │ /api/backtest-ctrl/*  │ backtest_results_v2
───────────────────────┼─────────────────────────┼───────────────────────┼──────────────────────
CartonesView           │ useCartones              │ /api/agent/cartones   │ pair_recommendations
                       │                          │                       │ (latest prediction)
```

---

## 7. Bugs conocidos y estado

| ID   | Descripción                                        | Estado      | Archivo(s)                         |
|------|----------------------------------------------------|-------------|-------------------------------------|
| F01  | draw_date NULL en ingested_results                 | REFUTADO ✅  | migration 018 fue innecesaria       |
| F02  | AccuracyView 0.00% (accuracy endpoint vacío)       | PARCIAL ⚠️  | Ver sección 8 abajo                |
| F04  | Miss streak = 60 en StrategyTracking               | CONFIRMADO  | backtest_points_v2 solo pre-existing|
| F05  | 97 alertas de drift acumuladas                     | FIJO ✅      | PostDrawProcessor cooldown 6h       |
| F06  | RetrospectiveValidator tabla incorrecta            | FIJO ✅      | algo_prediction_snapshot            |
| NEW1 | PPS todos < 50 (autocorr≈0 refuta markov/cross)    | ESPERADO    | Es la señal honesta del sistema     |
| NEW2 | fibonacci_pisano/cycle_detector/mirror sin basis   | ACTION      | Eliminar de consensus (ver §9)      |
| NEW3 | feedback_loop VACÍO permanente                    | LEGACY      | Solo cartones legacy, no pair-mode  |
| NEW4 | LLM validation desactivada (USE_LLM_VALIDATION)   | CORRECTO ✅  | HitdashAgent circular feedback      |
| NEW5 | draw_date "dynamic" en AgentScheduler boot         | FIJO ✅      | ANO-06: calculado en worker time    |

---

## 8. Diagnóstico: AccuracyView 0.00%

### Cadena de datos:
```
HitdashAgent → INSERT pair_recommendations (hit=NULL)
                                    ↓
IngestionWorker → feedbackProcessor.enqueue()
                                    ↓
PostDrawProcessor FASE A → UPDATE pair_recommendations SET hit=true/false
                                    ↓
/api/agent/accuracy → SELECT ... WHERE hit IS NOT NULL → data.rows
                                    ↓
AccuracyView → avg_accuracy = Σ(avg_accuracy) / days
```

### Hipótesis ordenadas por probabilidad:

**H1 (más probable): Sistema recién desplegado, pocas predicciones resueltas**
- El sistema genera predicciones desde hace días/semanas
- PostDrawProcessor resuelve hits via draw_date matching
- Si `pair_recommendations` tiene pocas filas con `hit IS NOT NULL`, el query retorna poco o nada
- **Solución**: mostrar también `total_pending` para distinguir "sin datos" de "0% accuracy"

**H2: draw_date mismatch entre predicción e ingesta**
- HitdashAgent usa `nextDrawDate(draw_type)` = la fecha del próximo sorteo
- IngestionWorker usa `20${yy}-${mm}-${dd}` parseando el campo `date` de ballbot
- Si el formato de fecha no coincide exactamente → `WHERE draw_date = $3` no encuentra filas
- **Diagnóstico**: `SELECT DISTINCT draw_date FROM pair_recommendations LIMIT 10`

**H3: hit rate genuinamente 0%**
- Todos los sorteos evaluados no tuvieron el par ganador en la lista top-N
- Con N=15 la probabilidad teórica es 15%. Con datos reales y algoritmos sin edge es posible tener malas rachas.
- **Diagnóstico**: `SELECT COUNT(*), SUM(CASE WHEN hit THEN 1 ELSE 0 END) FROM pair_recommendations WHERE hit IS NOT NULL`

### Fix implementado:
El endpoint `/api/agent/accuracy` ahora incluye `total_pending` en la respuesta.
AccuracyView muestra el estado explícitamente: "X evaluadas / Y pendientes".

---

## 9. Decisiones arquitectónicas: qué cortar

### CORTAR INMEDIATO (sin valor, añaden ruido):

**1. fibonacci_pisano** (src/agent/analysis/algorithms/FibonacciResonancePro.ts + FibonacciPisano.ts)
- Razón: secuencias de Fibonacci en números aleatorios certificados = numerología
- Impacto: eliminar 1 algoritmo, reducir tiempo de análisis ~40ms

**2. cycle_detector** (src/agent/analysis/algorithms/CycleDetector.ts)
- Razón: "ciclos" son artefactos de la Ley de los Grandes Números en series finitas
- Impacto: eliminar 1 algoritmo

**3. mirror_complement** (src/agent/analysis/algorithms/MirrorComplement.ts)
- Razón: simetría de complementarios (09↔90, 37↔73) sin evidencia generativa
- Impacto: eliminar 1 algoritmo

### REDUCIR PESO (mantener en consensus pero con señal reducida):

**4. markov_order2** (weight: 0.80→0.30)
- Razón: autocorrelación ≈ 0 refuta dependencia serial
- Ya implementado en ALGORITHM_WEIGHTS

**5. cross_draw_correlation** (weight: 0.70→0.30)
- Razón: cluster redundante con markov_order2 (Jaccard > 0.65)
- Ya implementado

**6. transition_follow** (weight: 0.85→0.35)
- Razón: Markov orden-1, misma base que markov_order2
- Ya implementado

### MANTENER TODOS LOS DEMÁS:
Los otros 17 algoritmos tienen bases empíricas razonables o complementan el consensus.
El PPS aprenderá a downweightear los que no predicen bien sin necesidad de eliminarlos.

### SIMPLIFICAR FEEDBACK (HIGH PRIORITY):

**Eliminar capas legacy de compatibilidad:**
- `feedback_loop` tabla: VACÍA permanentemente → DROP TABLE en próxima migración
- `strategy_registry` tabla: solo usada por updateLiveAdaptiveWeights() legacy
- `adaptive_weights` tabla: puede coexistir como fallback pero no necesita mantenimiento activo

**El futuro del sistema es:**
```
PPS (live EMA) + CognitiveLearner (historical) = único sistema de pesos
adaptive_weights = mantenido solo para compatibilidad, no escribir más a él
```

---

## CONCLUSIÓN EJECUTIVA

El sistema HELIX está **arquitectónicamente correcto** pero con:
1. **3 algoritmos sin base empírica** → eliminar (fibonacci, cycle, mirror)
2. **AccuracyView sin datos suficientes** → agregar diagnóstico de pending
3. **Loop de feedback funcional** pero con delay: predicción → ingesta → resolución puede tomar horas
4. **PPS honestamente bajo** porque autocorr≈0 — NO es un bug, es la realidad de la lotería
5. **CalendarPattern (DOW χ²=18.47)** es el único algoritmo con evidencia estadística sólida

**La señal más importante: el sistema NO tiene edge estadístico demostrado todavía.**
`is_profitable = false` en todos los combos = honestidad del motor, no fallo.
El edge emergerá (o no) a medida que PPS acumule historial real y los algoritmos empíricos se validen.
