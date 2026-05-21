# HELIX — STATE REPORT 2026-05-21 (v2 post Route A)

> **Autoaprendizaje adaptativo autónomo didáctico** — el sistema ahora prueba edge con rigor estadístico y reporta la verdad sin maquillaje.

---

## TL;DR (lo que cualquier inversor o CTO debe saber en 30 segundos)

- Sistema deployado (commit `3715638`), healthy, auditable
- **422 tests estadísticos rigurosos · 0 sobreviven Bonferroni · 0 replican en holdout**
- 13 familias de hipótesis exploradas, ninguna detecta edge
- Wilson 95% CI INCLUYE baseline 15% en TODOS los algoritmos sobre todos los combos
- "32% APEX win rate" anterior era contaminación de v1 (eliminada en migración 034)
- **Infraestructura para descubrir edge funciona** — solo no hay edge que descubrir
- Camino forward: pivote vertical (B) o reposicionamiento honesto (C) — Ruta A AGOTADA

---

## ESTADO TÉCNICO LIVE

```
Deploy:      864a23c (2026-05-21 20:37 UTC, 1m11s pipeline)
Container:   hitdash-server, healthy, port 3005
Database:    PostgreSQL hitdash, 35 migraciones aplicadas
Redis:       healthy, 0-1ms latency
DB latency:  4ms
Uptime:      stable
```

### Tablas clave (post Tabula Rasa v2)

| Tabla | Filas | Estado |
|-------|-------|--------|
| ingested_results | 39,788 | IMMUTABLE truth (lottery draws desde 1988) |
| algo_prediction_snapshot | 230,427 | Pair_scores per algo per draw (últimos 365d regenerados clean) |
| algo_rank_history | 230,322 | Ranks post-dedupe (migración 031 eliminó 311k duplicados) |
| edge_discovery_runs | 4 | Cada ejecución con verdict auditable |
| edge_hypothesis_tests | 561+ | Tests individuales con p-value, Bonferroni, effect size |
| helix_retrospective_runs | 10,449 | Walk-forward sin future leakage |
| helix_retrospective_summary | 6 | Por combo: hit_rate, Wilson CI, edge_multiplier |
| thompson_state | populating | Bayesian Beta posteriors, recomputa post-draw |
| conformal_calibration | 1+ | Three-way temporal split persistido |

---

## ROUTE A — EXPLORACIÓN QUIRÚRGICA (39 tests, Bonferroni α=0.00128)

**0/39 significativos · 0 candidatos · 0 replican en holdout**

Por familia (todas no significativas):

| Familia | Tests | Min p-value | Mejor effect | Veredicto |
|---------|-------|-------------|--------------|-----------|
| pair_autocorrelation (lag-1/2/7/14/30) | 20 | 0.066 | r=0.016 | Sin memoria en índice del par |
| sum_of_digits | 4 | 0.101 | 0.003 | **Máquina ES físicamente justa** |
| month_seasonal | 2 | 0.132 | V=0.090 | Sin estacionalidad |
| within_draw_adjacency | 5 | 0.159 | V=0.023 | **Posiciones SON independientes** |
| day_of_month | 2 | 0.161 | V=0.085 | Sin bias por día del mes |
| pair_antisymmetry | 2 | 0.276 | φ=0.01 | **Orden de dígitos NO importa** |
| higher_order_markov | 4 | 1.00 | ≈0 | Pares t independientes de pares previos |

**Interpretación honesta**: la lotería de Florida es matemáticamente impredecible en TODAS las dimensiones que hemos podido medir. Esto cementa lo que la teoría de Kolmogorov-Chaitin predice para máquinas aleatorias bien diseñadas.

---

## RESULTADO ESTADÍSTICO ACUMULADO

**422 tests rigurosos a lo largo de 4 ejecuciones**:

| Ejecución | Tests | Significativos post-Bonferroni | Replican holdout |
|-----------|-------|--------------------------------|------------------|
| Edge Discovery v1 (365d) | 187 | 0 (solo diversity = redundancia) | N/A |
| Edge Discovery v2 (5y) | 187 | 0 algo_edge significativos | N/A |
| DeepDive (9 candidatos, max data) | 9 | 0/9 sobreviven | N/A |
| Route A (7 familias nuevas) | 39 | 0/39 | 0/0 |
| **TOTAL** | **422** | **0** | **0** |

13 familias de hipótesis exploradas:
- algo_edge, autocorrelation (digit), dow_bias, pair_persistence
- drift_ks, diversity, sum_of_digits, within_draw_adjacency
- higher_order_markov, day_of_month, month_seasonal
- pair_antisymmetry, pair_autocorrelation (índice)

---

## RESULTADO ESTADÍSTICO DEFINITIVO

### Edge Discovery #2 (5 años window, Bonferroni α=2.67e-4)

**187 tests · 1 significativo · pero ese 1 era "diversity" (mide redundancia, no edge predictivo)**

Por familia:
- `algo_edge` (126 tests): 0 significativos, min p=0.012
- `autocorrelation` (48 tests): 0 significativos, min p=0.009
- `dow_bias` (6 tests): 0 significativos, **min p=0.57 → calendar_pattern es ruido puro**
- `pair_persistence` (4 tests): 0 significativos
- `drift_ks` (2 tests): 0 significativos
- `diversity` (1 test): 1 sig pero no es edge

### DeepDive sobre 9 candidatos pre-especificados (Bonferroni α=0.0056)

**0/9 sobreviven con data máxima**:

| Candidato | Original p (n=365) | Deep p (n=1825+) | Effect collapsed? |
|-----------|--------------------|--------------------|---|
| moving_averages pick4 evening cd | 0.006 (h=0.125) | 0.052 (h=0.037) | **3.4× shrink** |
| decade_family pick4 evening ab | 0.008 (h=0.121) | 0.308 (h=0.012) | **10× shrink** |
| autocorr p2 lag-7 pick3 midday | 0.009 (r=0.061) | 0.068 (r=0.022) | **2.8× shrink** |
| streak pick4 midday ab | 0.020 | 0.061 | **2.9× shrink** |
| autocorr p3 lag-7 pick3 evening | 0.048 (r=0.046) | 0.971 (r=0.0003) | **NULL — era ruido puro** |

**Lección estadística**: las señales con n=365 eran varianza por muestra pequeña. Con n=1825 (5×), los effect sizes colapsaron al rango del ruido. La estadística no miente.

### Walk-forward retrospective limpio

10,449 predicciones, 6 combos, 365 días post-tabula-rasa:

| Combo | n | Hit rate | Wilson CI 95% | Edge x | Veredicto |
|-------|---|----------|---------------|--------|-----------|
| pick3 evening du | 1,741 | 14.93% | 13.34–16.69 | 0.996 | Sin edge |
| pick3 midday du | 1,742 | 15.04% | 13.44–16.80 | 1.003 | Sin edge |
| pick4 evening ab | 1,741 | 16.03% | 14.38–17.82 | 1.068 | CI incluye baseline |
| pick4 evening cd | 1,741 | 15.74% | 14.10–17.52 | 1.049 | CI incluye baseline |
| pick4 midday ab | 1,742 | 14.64% | 13.06–16.38 | 0.976 | Sin edge |
| pick4 midday cd | 1,742 | 14.58% | 13.00–16.32 | 0.972 | Sin edge |

**Mediana de rank del ganador en consenso: 51-52 de 100** — exactamente el centro estadístico esperado bajo aleatoriedad pura.

---

## INFRAESTRUCTURA CONSTRUIDA (lo que SÍ funciona)

### Servicios autónomos
- **EdgeDiscoveryEngine** (740 LOC, 6 familias de tests, Bonferroni-honest)
- **HelixRetrospectiveSimulator** (walk-forward sin future leakage)
- **SnapshotBackfillService** (regenera point-in-time correcto)
- **ThompsonSampler** (Beta posteriors con sampleBeta exacto en edge cases)
- **ConformalPredictor** (three-way temporal split, exchangeability preservada)
- **AlgorithmHealthMonitor** (killswitch + degrade tuneado post-dedupe)

### Endpoints públicos
```
POST /api/agent/edge-discovery/run         # autonomous discovery
POST /api/agent/edge-discovery/deep-dive   # confirmation testing
GET  /api/agent/edge-discovery/report
GET  /api/agent/edge-discovery/list
POST /api/agent/retrospective/helix-v2/run-all
GET  /api/agent/retrospective/helix-v2/summary
GET  /api/agent/retrospective/helix-v2/timeseries
POST /api/agent/snapshot-backfill          # max 730d window
```

### UI
- `/agent/truth` — **TruthView**: dashboard honesto sin maquillaje
- `/agent/brain` — BrainView: Thompson UCB + conformal coverage
- `/agent/dashboard` — Cerebro F1 panel dual pick3+pick4
- `/agent/retrospective` — Walk-forward results

### CI/CD
- GitHub Actions: build → migrate → VACUUM → healthcheck → genesis backtest → edge discovery → walk-forward
- Deploy time: ~1m10s zero-downtime
- Auto-trigger Edge Discovery cada deploy

### Limpieza forense ejecutada
- Migración 031: 311,597 duplicados eliminados de algo_rank_history
- Migración 034: Tabula Rasa v2, 5.7 GB recuperados
- 45,945 snapshots de últimos 365d regenerados con algos clean
- Algoritmos fantasma (apex_adaptive, consensus_top, momentum_ema, fibonacci_pisano) eliminados del runtime

---

## RUTAS FORWARD (decisión pendiente)

### Ruta A — Investigación profunda algorítmica · ❌ AGOTADA (2026-05-21)
- ~~Re-derivar features con autocorrelación verificada~~ ✓ Probado lag-1/2/7/14/30, p>0.066
- ~~Combinatorias / interaction terms~~ ✓ within-draw adjacency probado, p>0.159
- ~~Mutual information per pair~~ ✓ higher_order_markov probado, p≈1.0
- **Stop criterion alcanzado**: 0/422 tests significativos post-Bonferroni
- **Veredicto**: con estos datos y estos algoritmos NO hay edge. Cualquier
  investigación adicional requeriría datos NUEVOS (microdatos físicos de
  la máquina, sensores, video frame-by-frame) — fuera del alcance.

### Ruta B — Pivote vertical
Aplicar la tecnología (Bayesian + Conformal + Hawkes) a dominios CON edge publicado:
- Sports betting líneas (Bayesian update funciona)
- Crypto microstructure (Hawkes publicado)
- Insurance claim clustering
- **Cost**: 3-6 meses, $300K

### Ruta C — Reposicionamiento honesto
- Truth Dashboard como diferenciador único
- Conformal coverage real como producto
- Pool/syndicate management
- Pricing: $20-50/mo B2C, $5K/mo B2B
- **Cost**: 6 semanas, $80K

**Mandato CEO**: ejecutar las 3 en paralelo según stages temporales.

---

## QUÉ DECIR A INVERSORES

### ❌ NO decir:
- "32% hit rate" / "APEX win rate"
- "2.14× edge sobre azar"
- "Sistema demostró edge"
- "Calendar pattern funciona"
- "Algoritmos batten al azar"

### ✅ SÍ decir:
- "Hemos construido el primer motor de loto con prueba estadística rigurosa"
- "Tras 187 tests con corrección Bonferroni, **ningún algoritmo individual** supera al azar — esto es honestidad, no fracaso"
- "El valor está en la **transparencia matemática**: nadie más en el mercado reporta p-values"
- "La cobertura conformal del 80% es **teorema demostrado**, no marketing"
- "Pivote a sports betting / crypto donde el edge ESTÁ publicado academically"

---

## RESPONSABILIDAD FIDUCIARIA

Este documento existe porque la verdad le importa más que la valoración. Cualquier ronda de inversión que ocurra basada en métricas v1 contaminadas tiene riesgo legal y reputacional. El sistema AHORA puede defender cada número con auditoría estadística reproducible.

El `commit 864a23c` y este reporte son la línea de salida desde la cual cualquier afirmación futura debe respaldarse con re-ejecución de Edge Discovery.

---

*Compilado por: Yaniel Rodriguez (CEO Bliss Systems LLC) + Claude Opus 4.7*
*Fecha: 2026-05-21 20:40 UTC*
*Última verificación: `helix-v2-deploy-20260521T184102` retrospective + `edge-v2-5y` discovery*
