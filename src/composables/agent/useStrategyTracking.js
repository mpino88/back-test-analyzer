// ═══════════════════════════════════════════════════════════════
// HITDASH — useStrategyTracking v2.1
// Fetches strategy tracking data + computes projections + cognitive analysis
//
// E4 FIX (2026-05-18): Eliminados aliases fantasma del catálogo:
//   • momentum_ema   — alias legacy de moving_avg_signal
//   • apex_adaptive  — meta-alias eliminado en v2.4
//   • consensus_top  — meta-strategy sin implementación real
// RANDOM_BASELINE corregido 0.10 → 0.15 (baseline real de pares@N=15).
// computeCollectiveIntelligence: apex reemplazado por 'leader' (top performer).
// ═══════════════════════════════════════════════════════════════

import { ref, computed, watch } from 'vue';
import { apiGet } from '../../utils/apiClient.js';

// ─── Strategy metadata ──────────────────────────────────────────
export const STRATEGY_META = {
  gap_overdue_focus:   { icon: '⏰', color: '#f59e0b', label: 'Gap Overdue',    category: 'momentum',   optimalTopN: [10, 14] },
  streak_reversal:     { icon: '🔄', color: '#f87171', label: 'Streak Reversal', category: 'reversal',   optimalTopN: [8,  12] },
  // momentum_ema removed (E4 FIX 2026-05-18) — legacy alias of moving_avg_signal
  hot_cold_weighted:   { icon: '🌡', color: '#22d3ee', label: 'Hot / Cold',     category: 'momentum',   optimalTopN: [12, 18] },
  moving_avg_signal:   { icon: '📈', color: '#60a5fa', label: 'Moving Avg',     category: 'trend',      optimalTopN: [15, 20] },
  frequency_rank:      { icon: '📊', color: '#4ade80', label: 'Frecuencia',     category: 'baseline',   optimalTopN: [15, 20] },
  position_bias:       { icon: '🎯', color: '#a3e635', label: 'Pos. Bias',      category: 'structural', optimalTopN: [20, 30] },
  pair_correlation:    { icon: '🔗', color: '#f472b6', label: 'Correlación',    category: 'structural', optimalTopN: [20, 30] },
  // FIX T2-I (2026-05-18): fibonacci_pisano removed — eliminated v2.4
  // Strategies del catálogo v2 añadidas para completitud frontend:
  bayesian_score:      { icon: '🧠', color: '#a78bfa', label: 'Bayesian',       category: 'multi',      optimalTopN: [12, 18] },
  transition_follow:   { icon: '➡️', color: '#fb923c', label: 'Transition',     category: 'markov',     optimalTopN: [12, 18] },
  markov_order2:       { icon: '🔗', color: '#f87171', label: 'Markov-2',       category: 'markov',     optimalTopN: [12, 18] },
  calendar_pattern:    { icon: '📅', color: '#fbbf24', label: 'Calendar',       category: 'temporal',   optimalTopN: [15, 20] },
  decade_family:       { icon: '🔢', color: '#4ade80', label: 'Decade',         category: 'family',     optimalTopN: [15, 20] },
  max_per_weekday:     { icon: '📆', color: '#fcd34d', label: 'Max DOW',        category: 'temporal',   optimalTopN: [15, 20] },
  pair_return_cycle:   { icon: '🔄', color: '#60a5fa', label: 'Return Cycle',   category: 'cyclic',     optimalTopN: [10, 15] },
  sum_pattern_filter:  { icon: '➕', color: '#22d3ee', label: 'Sum Filter',     category: 'structural', optimalTopN: [15, 20] },
  double_triple_detector:{ icon: '🎰', color: '#f472b6', label: 'Doubles',      category: 'regime',     optimalTopN: [18, 25] },
  cross_draw_correlation:{ icon: '🌐', color: '#a3e635', label: 'Cross-Draw',   category: 'cross',      optimalTopN: [15, 20] },
  trend_momentum:      { icon: '🚀', color: '#f59e0b', label: 'Trend Pro',      category: 'momentum',   optimalTopN: [12, 18] },
  trend_momentum_sweet:{ icon: '🍯', color: '#fb923c', label: 'Sweet Spot',     category: 'momentum',   optimalTopN: [12, 15] },
  est_individuales:    { icon: '🔥', color: '#ef4444', label: 'Hot Digits',     category: 'digit',      optimalTopN: [15, 20] },
  terminal_analysis:   { icon: '🎯', color: '#22d3ee', label: 'Terminal',       category: 'digit',      optimalTopN: [15, 20] },
  // apex_adaptive removed (E4 FIX 2026-05-18) — meta-alias, no individual algo
  // consensus_top removed (E4 FIX 2026-05-18) — meta-strategy, not in canonical catalog
};

// ─── Cognitive brain per strategy ───────────────────────────────
export const STRATEGY_BRAIN = {
  gap_overdue_focus: {
    what: 'Detecta pares cuya ausencia supera su intervalo histórico promedio',
    how:  'gap_score(XY) = draws_since_last(XY) / avg_gap(XY)  →  rankear desc',
    optimal: 'Después de rachas largas de ausencia — sorteos con alta dispersión',
    weak:    'Pares con alta frecuencia que acaban de aparecer parecen "sobredebidos" sin serlo',
    dataNeeds: 'Historial completo de posiciones por sorteo',
    learningNote: 'Top-N se reduce cuando la tasa de gap hits supera el 20%',
  },
  streak_reversal: {
    what: 'Identifica pares en racha de ausencia inusualmente larga (candidatos a reversión)',
    how:  'score(XY) = abs_streak(XY) / (mean_gap + 2σ_gap)  →  candidatos > 1.0',
    optimal: 'Mercados con alta autocorrelación negativa — un par rara vez aparece dos veces seguidas',
    weak:    'Si hay un par "de moda" (tendencia real), penaliza falsamente su ausencia',
    dataNeeds: 'Últimos 90 sorteos para calcular media y desviación estándar de gaps',
    learningNote: 'Peso EMA disminuye cuando reversiones no se materializan en 5 sorteos',
  },
  // momentum_ema removed (E4 FIX 2026-05-18) — alias legacy
  hot_cold_weighted: {
    what: 'Clasifica pares como "hot" (alta frecuencia reciente) vs "cold" (baja frecuencia)',
    how:  'sigmoid(z-score) donde z = (freq_7d − freq_90d_expected) / std_90d',
    optimal: 'Cuando hay clusters de aparición — ciertos pares tienen burst de actividad',
    weak:    'En regímenes estacionarios da señales ruidosas; los hot/cold rotan sin beneficio real',
    dataNeeds: '7 días de historia reciente + 90 días para baseline',
    learningNote: 'Si precision@15 cae < 10% durante 3 ciclos, weight se penaliza en 20%',
  },
  moving_avg_signal: {
    what: 'Usa el cruce SMA-7/SMA-14 como señal de entrada en un par',
    how:  'Serie binaria 0/1 por par → SMA-7 > SMA-14 → señal positiva',
    optimal: 'Mercados tendenciales donde un par muestra actividad creciente sostenida',
    weak:    'Produce whipsaws en mercados laterales; lag inherente de la MA',
    dataNeeds: '30 sorteos mínimo; óptimo con 60+',
    learningNote: 'Señal más confiable cuando el cruce tiene > 3 sorteos de confirmación',
  },
  frequency_rank: {
    what: 'Baseline estadístico puro: frecuencia absoluta de cada par en el período',
    how:  'score(XY) = count(XY) / total_sorteos  →  rankear desc',
    optimal: 'Siempre útil como sanity check; lo mejor en períodos de >200 sorteos',
    weak:    'Ignora recencia — un par puede tener alta frecuencia histórica pero estar "frío"',
    dataNeeds: 'Período configurable (default 90 días)',
    learningNote: 'El baseline de 10% aleatorio se supera cuando top-N = 15 y hitRate > 14%',
  },
  position_bias: {
    what: 'Detecta si ciertos pares aparecen más de lo esperado por posición (no uniforme)',
    how:  'bias(XY) = P_observada(XY) − 1/100  →  rankear por desviación positiva',
    optimal: 'Juegos con sesgos estructurales en la distribución de resultados',
    weak:    'Requiere muestra grande (>500) para que la desviación sea estadísticamente significativa',
    dataNeeds: 'Mínimo 100 sorteos; confiable con 300+',
    learningNote: 'Bajo volumen de datos → esta estrategia requiere top_n alto (≥20)',
  },
  pair_correlation: {
    what: 'Mide la correlación conjunta real entre las dos posiciones que forman el par',
    how:  'corr(XY) = P(p2=X, p3=Y) / (P(p2=X) × P(p3=Y)) − 1  →  independencia = 0',
    optimal: 'Cuando las posiciones de un juego NO son independientes entre sí',
    weak:    'Si las posiciones son verdaderamente independientes, el score siempre es ≈0',
    dataNeeds: '200+ sorteos para estimación robusta de probabilidades conjuntas',
    learningNote: 'Estrategia complementaria — alta correlación con frequency_rank',
  },
  // apex_adaptive removed (E4 FIX 2026-05-18) — meta-alias, no individual algo
  // consensus_top removed (E4 FIX 2026-05-18) — meta-strategy sin catalog entry
};

// E4 FIX: baseline correcto para pares (00-99) con N=15 = 15/100 = 15%
// El 10% anterior era incorrecto (sería válido solo para N=10/100 pares).
const RANDOM_BASELINE = 0.15;

// ─── Math helpers ───────────────────────────────────────────────
function linearRegression(values) {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: values[0] ?? 0 };
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX  += i;
    sumY  += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  const slope     = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

function stdDev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length);
}

function clamp(v, min = 0, max = 1) {
  return Math.max(min, Math.min(max, v));
}

function projectNext(history, steps = 3) {
  if (history.length === 0) return { values: [], upper: [], lower: [] };
  const recent = history.slice(-8);
  const { slope, intercept } = linearRegression(recent);
  const sigma = stdDev(recent);
  const n = recent.length;
  const values = [], upper = [], lower = [];
  for (let i = 0; i < steps; i++) {
    const v = clamp(intercept + slope * (n + i));
    values.push(v);
    upper.push(clamp(v + sigma));
    lower.push(clamp(v - sigma));
  }
  return { values, upper, lower };
}

function computeTrend(history) {
  if (history.length < 3) return { direction: 'stable', delta: 0, label: '→' };
  const recent = history.slice(-3);
  const { slope } = linearRegression(recent);
  if (slope >  0.015) return { direction: 'up',   delta: slope, label: '↗' };
  if (slope < -0.015) return { direction: 'down', delta: slope, label: '↘' };
  return { direction: 'stable', delta: slope, label: '→' };
}

function signalStrength(hitRate, weight, topN) {
  const hitScore    = clamp((hitRate - RANDOM_BASELINE) / (0.35 - RANDOM_BASELINE)) * 60;
  const weightScore = clamp((weight - 0.5) / 1.5) * 25;
  const precBonus   = clamp(1 - (topN - 8) / 42) * 15;
  return Math.round(hitScore + weightScore + precBonus);
}

// ─── NEW: Learning velocity — rate of change in hit rate (per cycle) ──
function computeLearningVelocity(history) {
  if (history.length < 4) return { velocity: 0, label: 'sin datos', color: '#475569' };
  const { slope } = linearRegression(history.slice(-6));
  const vel = slope * 100; // in percentage points per cycle
  if (vel >  0.8) return { velocity: vel, label: `+${vel.toFixed(1)}%/ciclo`, color: '#22c55e' };
  if (vel < -0.8) return { velocity: vel, label: `${vel.toFixed(1)}%/ciclo`,  color: '#f87171' };
  return { velocity: vel, label: 'estable',  color: '#f59e0b' };
}

// ─── NEW: Adaptive health score — how well the strategy is tuned ──
function computeAdaptiveHealth(weight, topN, hitRate, optimalTopN) {
  const weightHealth = weight >= 0.9 && weight <= 1.8 ? 1 : weight < 0.9 ? weight / 0.9 : 1.8 / weight;
  const [optMin, optMax] = optimalTopN;
  const topNHealth = topN >= optMin && topN <= optMax ? 1 : topN < optMin
    ? topN / optMin
    : optMax / topN;
  const hitHealth = clamp((hitRate - RANDOM_BASELINE) / 0.15);
  return Math.round((weightHealth * 0.35 + topNHealth * 0.25 + hitHealth * 0.40) * 100);
}

// ─── NEW: Compute hit streak stats from timeline ─────────────────
function computeStreakStats(timeline) {
  if (!timeline?.length) return { currentStreak: 0, streakType: 'none', longestHit: 0, longestMiss: 0, recentHitRate: 0 };
  let currentStreak = 1, streakType = timeline.at(-1)?.hit ? 'hit' : 'miss';
  let longestHit = 0, longestMiss = 0, cur = 1;
  let curType = timeline[0]?.hit ? 'hit' : 'miss';

  for (let i = 1; i < timeline.length; i++) {
    const type = timeline[i].hit ? 'hit' : 'miss';
    if (type === curType) cur++;
    else { cur = 1; curType = type; }
    if (type === 'hit')  longestHit  = Math.max(longestHit,  cur);
    if (type === 'miss') longestMiss = Math.max(longestMiss, cur);
  }

  // current streak from end
  currentStreak = 1;
  for (let i = timeline.length - 2; i >= 0; i--) {
    const type = timeline[i].hit ? 'hit' : 'miss';
    if (type === streakType) currentStreak++;
    else break;
  }

  const last20 = timeline.slice(-20);
  const recentHitRate = last20.filter(p => p.hit).length / (last20.length || 1);

  return { currentStreak, streakType, longestHit, longestMiss, recentHitRate };
}

// ─── Collective intelligence — how strategies agree ──────────────
// E4 FIX (2026-05-18): eliminados apex_adaptive/consensus_top filtros.
// 'leader' reemplaza 'apex' — el algo con mayor hit_rate real en la ventana.
export function computeCollectiveIntelligence(strategies) {
  if (!strategies?.length) return null;
  // Todos son canónicos ahora — sin meta-aliases que filtrar
  const base = strategies.filter(s => s.hit_rate != null || s.win_rate != null);
  if (!base.length) return null;

  const hitRates = base.map(s => s.hit_rate ?? s.win_rate ?? 0);
  const weights  = base.map(s => s.weight ?? 1);
  const mean = hitRates.reduce((a, b) => a + b, 0) / hitRates.length;
  const sd   = stdDev(hitRates);

  // Weighted consensus
  const totalW = weights.reduce((a, b) => a + b, 0);
  const weightedMean = hitRates.reduce((sum, r, i) => sum + r * weights[i], 0) / (totalW || 1);

  // Divergence: how spread out are the strategies?
  const divergenceScore = clamp(sd / 0.15) * 100; // 0=all agree, 100=max spread

  // Top 3 performers
  const sorted = [...base].sort((a, b) => (b.hit_rate ?? 0) - (a.hit_rate ?? 0));
  const top3 = sorted.slice(0, 3);

  // Leader: algo con mayor hit_rate actual (reemplaza concepto apex_adaptive)
  const leader = sorted[0] ?? null;
  const leaderRate = leader?.hit_rate ?? leader?.win_rate ?? 0;
  const leaderVsConsensus = (leaderRate - weightedMean) * 100;

  // Cuántos algos superan el baseline 15% (vs azar puro)
  const aboveBaseline = base.filter(s => (s.hit_rate ?? 0) > RANDOM_BASELINE).length;

  return {
    mean,
    weightedMean,
    stdDev: sd,
    divergenceScore: Math.round(divergenceScore),
    top3,
    leaderName:          leader?.name ?? null,
    leaderRate,
    leaderVsConsensus:   +leaderVsConsensus.toFixed(2),
    aboveBaseline,
    totalStrategies:     base.length,
    learningActive:      strategies.some(s => (s.hit_rate_history?.length ?? 0) >= 3),
  };
}

import { useBacktestControl } from './useBacktestControl.js';

// ─── Composable ──────────────────────────────────────────────────
export function useStrategyTracking() {
  const strategies   = ref([]);
  const loading      = ref(false);
  const error        = ref(null);
  const generatedAt  = ref(null);
  
  // Usamos el contexto centralizado APEX
  const { gameType, mode, setGameType, setMode } = useBacktestControl();

  async function fetch() {
    loading.value = true;
    error.value   = null;
    try {
      const data = await apiGet(
        `/api/agent/backtest/v2/tracking?game_type=${gameType.value}&mode=${mode.value}`
      );
      generatedAt.value = data.generated_at;

      strategies.value = data.strategies.map(s => {
        const meta    = STRATEGY_META[s.name] ?? { icon: '🔵', color: '#94a3b8', label: s.name, category: 'other', optimalTopN: [15, 20] };
        const history = (s.hit_rate_history ?? []).map(Number);
        const weight  = Number(s.weight ?? 1);
        const hitRate = Number(s.hit_rate ?? s.win_rate ?? 0);
        const topN    = Number(s.top_n ?? 15);
        const brain   = STRATEGY_BRAIN[s.name] ?? null;
        const trend   = computeTrend(history);
        const proj    = projectNext(history, 3);
        const strength = signalStrength(hitRate, weight, topN);
        const velocity = computeLearningVelocity(history);
        const adaptiveHealth = computeAdaptiveHealth(weight, topN, hitRate, meta.optimalTopN);
        const streakStats = computeStreakStats(s.timeline ?? []);

        let displayHistory = history;
        if (displayHistory.length === 0 && s.timeline?.length >= 10) {
          const windowSize = 10;
          for (let i = windowSize; i <= s.timeline.length; i++) {
            const w = s.timeline.slice(i - windowSize, i);
            displayHistory = [...displayHistory, w.filter(p => p.hit).length / windowSize];
          }
        }

        return {
          ...s,
          ...meta,
          weight,
          hit_rate: hitRate,
          top_n: topN,
          history,
          brain,
          trend,
          projection: proj,
          strength,
          velocity,
          adaptiveHealth,
          streakStats,
          hit_rate_display: displayHistory,
          // E4 FIX: isApex obsoleto — ningún algo canónico es apex_adaptive
          isApex: false,
        };
      });
    } catch (e) {
      error.value = e.message;
    } finally {
      loading.value = false;
    }
  }

  watch([gameType, mode], () => fetch());

  const ranked = computed(() =>
    [...strategies.value].sort((a, b) => (b.hit_rate ?? b.win_rate) - (a.hit_rate ?? a.win_rate))
  );

  // E4 FIX: best = simplemente el top-ranked (ya no hay meta-aliases que filtrar)
  const best = computed(() => ranked.value[0] ?? null);

  // E4 FIX: 'apex' renombrado a 'leader' — el algo con mayor hit_rate real.
  // Mantenemos 'apex' como alias de compatibilidad para no romper templates existentes.
  const leader = computed(() => ranked.value[0] ?? null);
  const apex   = leader; // alias de compatibilidad

  const collective = computed(() => computeCollectiveIntelligence(strategies.value));

  const chartDatasets = computed(() => {
    return strategies.value
      .filter(s => s.hit_rate_display?.length > 0)
      .map(s => {
        const hist = s.hit_rate_display ?? [];
        const proj = s.projection?.values ?? [];
        const allPts = [
          ...hist.map(v => ({ y: +(v * 100).toFixed(1), projected: false })),
          ...proj.map(v => ({ y: +(v * 100).toFixed(1), projected: true })),
        ].map((pt, i) => ({ ...pt, x: i }));
        return {
          label:       s.label,
          data:        allPts.map(p => p.y),
          borderColor: s.color,
          backgroundColor: s.color + '18',
          borderWidth: 1.5,
          tension:     0.4,
          pointRadius: allPts.map(p => p.projected ? 3 : 0),
          pointStyle:  allPts.map(p => p.projected ? 'triangle' : 'circle'),
          segment: {
            borderDash: (ctx) => ctx.p0DataIndex >= hist.length - 1 ? [5, 4] : undefined,
          },
          fill: false,
        };
      });
  });

  return {
    strategies, ranked, best, leader, apex, collective,
    loading, error, generatedAt,
    gameType, mode, setGameType, setMode,
    chartDatasets,
    fetch,
    RANDOM_BASELINE,
  };
}
