// ═══════════════════════════════════════════════════════════════
// HITDASH — PairBacktestEngine v1.0.0
//
// Objeto de predicción: 100 pares ordenados (00–99)
//   Pick3 → half='du' (decena=p2 + unidad=p3)
//   Pick4 → half='ab' (p1+p2) | half='cd' (p3+p4), independientes
//
// Cada estrategia es PairRankFn = (draws, half) => RankedPair[100]
// Hit = par real ∈ top-N recomendados (N adaptativo, default 15)
// Centena Plus = top-1 de p1 por frecuencia (bonus, solo pick3)
//
// Adaptive Top-N:
//   - Si hit_rate > 20% en 3 runs → N -= 2 (más preciso)
//   - Si hit_rate < 10% en algún run → N += 3 (más cobertura)
//   - Rango: [3, 50]
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';

import type { DrawEntry, BacktestMode } from './BacktestEngine.js';
import type { PairHalf, RankedPair, PairEvalPoint, PairBacktestSummary, PairPrecisionMetrics } from '../types/analysis.types.js';
import type { AdaptiveWeights } from './BacktestEngine.js';

const logger = pino({ name: 'PairBacktestEngine' });

// ─── Adaptive Top-N ──────────────────────────────────────────
const DEFAULT_TOP_N = 15;
const MAX_TOP_N     = 50;
const MIN_TOP_N     = 3;

interface TopNState {
  current_top_n:    number;
  hit_rate_history: number[];  // últimos 10 hit rates
}

function updateTopN(state: TopNState, newHitRate: number): TopNState {
  const history = [...state.hit_rate_history, newHitRate].slice(-10);
  let top_n = state.current_top_n;

  if (history.length >= 3) {
    const last3 = history.slice(-3);
    if (last3.every(r => r > 0.20)) {
      top_n = Math.max(MIN_TOP_N, top_n - 2);   // más preciso
    } else if (last3.some(r => r < 0.10)) {
      top_n = Math.min(MAX_TOP_N, top_n + 3);   // más cobertura
    }
  }
  return { current_top_n: top_n, hit_rate_history: history };
}

// ─── Config ───────────────────────────────────────────────────
export interface PairBacktestConfig {
  game_type:          'pick3' | 'pick4';
  mode:               BacktestMode;
  half:               PairHalf;
  train_window_draws: number;   // default 90
  eval_step:          number;   // default 7
  min_train_draws:    number;   // default 30
  top_n:              number;   // default 15
  date_from?:         string;   // YYYY-MM-DD — filtra histórico desde esta fecha
  date_to?:           string;   // YYYY-MM-DD — filtra histórico hasta esta fecha
  strategy_filter?:   string[]; // subconjunto de estrategias a correr (vacío = todas)
  on_progress?:       (done: number, total: number, strategy: string) => void;
}

export type PairStrategyName =
  | 'frequency_rank'
  | 'hot_cold_weighted'
  | 'gap_overdue_focus'
  | 'moving_avg_signal'
  | 'momentum_ema'
  | 'streak_reversal'
  | 'position_bias'
  | 'pair_correlation'
  | 'fibonacci_pisano'
  | 'consensus_top'
  | 'apex_adaptive'
  // ─── Ballbot Clones ───────────────────────────────────────────
  | 'bayesian_score'
  | 'transition_follow'
  | 'markov_order2'
  | 'calendar_pattern'
  | 'decade_family'
  | 'max_per_weekday';

// Función base de estrategia de pares
type PairRankFn = (draws: DrawEntry[], half: PairHalf) => RankedPair[];

// ─── Helper: extraer par de un draw ─────────────────────────
function extractPair(d: DrawEntry, half: PairHalf): string {
  if (half === 'du') return `${d.p2}${d.p3}`;
  if (half === 'ab') return `${d.p1}${d.p2}`;
  // cd — p4 puede ser undefined en pick3; caller garantiza pick4
  return `${d.p3}${(d as DrawEntry & { p4?: number }).p4 ?? 0}`;
}

// ─── Iterar 100 pares ────────────────────────────────────────
function allPairs(): string[] {
  const pairs: string[] = [];
  for (let x = 0; x <= 9; x++)
    for (let y = 0; y <= 9; y++)
      pairs.push(`${x}${y}`);
  return pairs;
}

const ALL_PAIRS = allPairs();

// ═══════════════════════════════════════════════════════════════
// MÓDULO DE PRECISIÓN MATEMÁTICA — 15 métricas cognitivas
// ═══════════════════════════════════════════════════════════════

// ─── 1. Wilson Score Confidence Interval (95%) ──────────────────
// Más robusto que el intervalo normal para tasas pequeñas (n < 200)
// Fórmula: (p̂ + z²/2n ± z√(p̂(1-p̂)/n + z²/4n²)) / (1 + z²/n)
function wilsonCI(hits: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p   = hits / n;
  const z2  = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

// ─── 2. Cohen's h — effect size vs baseline ─────────────────────
// Mide la magnitud del efecto: ¿cuánto mejor que random?
// h = 2·arcsin(√p) − 2·arcsin(√p₀)
// |h|: <0.2=negligible, 0.2–0.5=small, 0.5–0.8=medium, >0.8=large
function cohensH(hitRate: number, baseline = 0.10): number {
  return 2 * Math.asin(Math.sqrt(hitRate)) - 2 * Math.asin(Math.sqrt(baseline));
}

// ─── 3. Binomial p-value (one-tailed: hit_rate > baseline) ─────
// P(X >= hits | n, p0=0.10) via normal approximation (CLT)
// Para n >= 30 la aproximación normal es válida
function binomialPValue(hits: number, n: number, baseline = 0.10): number {
  if (n === 0) return 1;
  const mean = n * baseline;
  const std  = Math.sqrt(n * baseline * (1 - baseline));
  if (std === 0) return hits > mean ? 0 : 1;
  // z-score con corrección de continuidad de Yates
  const z = (hits - 0.5 - mean) / std;
  // Φ(z) via erf approximation — one-tailed upper
  return 1 - normalCDF(z);
}

// CDF de distribución normal estándar via approximation de Abramowitz & Stegun
function normalCDF(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const phi = 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * z * z) * poly;
  return z >= 0 ? phi : 1 - phi;
}

// ─── 4. Mean Reciprocal Rank ────────────────────────────────────
// MRR = (1/N) · Σ(1/rank_i) donde rank_i = posición del par real (1=top)
// MRR → 1.0 significa el par real siempre queda en top-1
// MRR → 0.01 significa siempre en último lugar
function meanReciprocalRank(reciprocals: number[]): number {
  if (reciprocals.length === 0) return 0;
  return reciprocals.reduce((a, b) => a + b, 0) / reciprocals.length;
}

// ─── 5. Brier Score (calibración) ───────────────────────────────
// BS = (1/N) · Σ(score_predicho_para_par_real − outcome)²
// outcome = 1 si hit, 0 si miss
// score debe estar en [0,1] (normalizado)
// BS=0 es perfecto, BS=0.25 es equivalente a predecir 50% siempre
function brierScore(scoredOutcomes: Array<{ score: number; hit: boolean }>): number {
  if (scoredOutcomes.length === 0) return 0.25;
  const sum = scoredOutcomes.reduce((acc, { score, hit }) => {
    const diff = score - (hit ? 1 : 0);
    return acc + diff * diff;
  }, 0);
  return +(sum / scoredOutcomes.length).toFixed(4);
}

// ─── 6. Precision@K ─────────────────────────────────────────────
// P@K = fracción de eval points donde el par real cae en top-K
function precisionAtK(ranks: number[], k: number): number {
  if (ranks.length === 0) return 0;
  return +(ranks.filter(r => r <= k).length / ranks.length).toFixed(4);
}

// ─── 7. Coeficiente de Variación (estabilidad) ──────────────────
// CV = std_dev / mean · 100%
// CV bajo = estrategia consistente, no volátil
// Calculado sobre ventanas rolling de hit_rate (10 sorteos cada una)
function coefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return +(Math.sqrt(variance) / mean).toFixed(4);
}

// ─── 8. Sharpe Ratio (rendimiento ajustado por riesgo) ──────────
// Sharpe = (hit_rate − baseline) / std_rolling  clamped [-3, 3]
// baseline = topN/100 (probabilidad aleatoria real de acertar un par)
// std_min  = max(0.001, baseline*0.1) — evita explosión cuando todos los
//            rolling windows tienen el mismo hit_rate (Pick 4 eval sets chicos)
function sharpeRatio(hitRate: number, rollingRates: number[], topN: number): number {
  const baseline = topN / 100;           // P(random hit) = topN pairs / 100 total
  if (rollingRates.length < 2) return 0;
  const variance = rollingRates.reduce((sum, v) => sum + (v - hitRate) ** 2, 0) / rollingRates.length;
  const rawStd   = Math.sqrt(variance);
  const std      = Math.max(rawStd, Math.max(0.001, baseline * 0.10)); // floor prevents ÷0 explosion
  return +Math.max(-3, Math.min(3, (hitRate - baseline) / std)).toFixed(4);
}

// ─── 9. Max Miss Streak ─────────────────────────────────────────
// Mayor racha consecutiva de misses
// Relevante para usuario: ¿cuánto aguanta sin acertar?
function maxMissStreak(hits: boolean[]): number {
  let maxStreak = 0, current = 0;
  for (const h of hits) {
    if (!h) { current++; maxStreak = Math.max(maxStreak, current); }
    else current = 0;
  }
  return maxStreak;
}

// ─── 10. Autocorrelación de lag-1 ────────────────────────────────
// Mide si los hits/misses tienen memoria:
//   > 0: momentum (hit sigue a hit)
//   < 0: alternancia (hit sigue a miss)
//   ≈ 0: proceso aleatorio sin memoria
// Pearson correlation entre hit[i] y hit[i-1]
function autocorrLag1(hits: boolean[]): number {
  if (hits.length < 3) return 0;
  const x = hits.slice(0, -1).map(v => (v ? 1 : 0) as number);
  const y = hits.slice(1).map(v => (v ? 1 : 0) as number);
  const n = x.length;
  const meanX = (x as number[]).reduce((a, b) => a + b, 0) / n;
  const meanY = (y as number[]).reduce((a, b) => a + b, 0) / n;
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - meanX, dy = y[i]! - meanY;
    num  += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  return den === 0 ? 0 : +(num / den).toFixed(4);
}

// ─── 11. Kelly Criterion ─────────────────────────────────────────
// Fracción óptima del espacio de predicción a cubrir (top-N / 100)
// f* = (p·b − q) / b
// donde: p = hit_rate, q = 1 − hit_rate
//        b = payout = (100 / top_n) − 1  (cuánto ganas si aciertas)
// f* > 0 = hay edge positivo
// f* negativo → la estrategia no tiene edge suficiente
function kellyFraction(hitRate: number, topN: number): number {
  const q = 1 - hitRate;
  const b = (100 / topN) - 1;       // odds a favor: 100/N−1 a 1
  if (b <= 0) return 0;
  const f = (hitRate * b - q) / b;  // Kelly formula
  return +Math.max(0, Math.min(1, f)).toFixed(4);
}

// ─── 12. Rolling Hit Rates (para CV y Sharpe) ────────────────────
function rollingHitRates(hits: boolean[], windowSize = 10): number[] {
  if (hits.length < windowSize) return hits.length > 0 ? [hits.filter(Boolean).length / hits.length] : [];
  const rates: number[] = [];
  for (let i = windowSize; i <= hits.length; i++) {
    const w = hits.slice(i - windowSize, i);
    rates.push(w.filter(Boolean).length / windowSize);
  }
  return rates;
}

// ─── FUNCIÓN MAESTRA: computePrecisionMetrics ─────────────────────
// Recibe todos los eval points con sus scores y produce las 15 métricas
function computePrecisionMetrics(
  points: Array<{
    hit_pair:          boolean;
    actual_pair_rank:  number;
    actual_pair_score: number;
    reciprocal_rank:   number;
  }>,
  finalHitRate: number,
  finalTopN:    number
): PairPrecisionMetrics {
  const n     = points.length;
  const hits  = points.map(p => p.hit_pair);
  const ranks = points.map(p => p.actual_pair_rank);
  const recip = points.map(p => p.reciprocal_rank);
  const scores = points.map(p => ({ score: p.actual_pair_score, hit: p.hit_pair }));

  const rolling = rollingHitRates(hits, 10);

  const [wilsonL, wilsonU] = wilsonCI(hits.filter(Boolean).length, n);

  return {
    mrr:             +meanReciprocalRank(recip).toFixed(4),
    expected_rank:   n > 0 ? +(ranks.reduce((a, b) => a + b, 0) / n).toFixed(2) : 50,
    brier_score:     brierScore(scores),
    precision_at_3:  precisionAtK(ranks, 3),
    precision_at_5:  precisionAtK(ranks, 5),
    precision_at_10: precisionAtK(ranks, 10),
    wilson_lower:    +wilsonL.toFixed(4),
    wilson_upper:    +wilsonU.toFixed(4),
    cohens_h:        +cohensH(finalHitRate).toFixed(4),
    p_value:         +binomialPValue(hits.filter(Boolean).length, n).toFixed(6),
    cv_hit_rate:     coefficientOfVariation(rolling),
    sharpe:          sharpeRatio(finalHitRate, rolling, finalTopN),
    max_miss_streak: maxMissStreak(hits),
    autocorr_lag1:   autocorrLag1(hits),
    kelly_fraction:  kellyFraction(finalHitRate, finalTopN),
  };
}


// ─── 1. frequency_rank ──────────────────────────────────────
const pairFrequencyRank: PairRankFn = (draws, half) => {
  const counts = new Map<string, number>(ALL_PAIRS.map(p => [p, 0]));
  for (const d of draws) {
    const p = extractPair(d, half);
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const total = draws.length || 1;
  return ALL_PAIRS.map(pair => ({ pair, score: (counts.get(pair) ?? 0) / total }))
    .sort((a, b) => b.score - a.score);
};

// ─── 2. hot_cold_weighted ────────────────────────────────────
const pairHotColdWeighted: PairRankFn = (draws, half) => {
  if (draws.length === 0) return pairFrequencyRank(draws, half);
  const now = draws[draws.length - 1]!.created_at;
  const cutoff7d = new Date(now.getTime() - 7 * 86_400_000);
  const recent = draws.filter(d => d.created_at >= cutoff7d);

  const n90 = draws.length;
  const n7  = recent.length || 1;

  const counts90 = new Map<string, number>(ALL_PAIRS.map(p => [p, 0]));
  const counts7  = new Map<string, number>(ALL_PAIRS.map(p => [p, 0]));

  for (const d of draws)  { const p = extractPair(d, half); counts90.set(p, (counts90.get(p) ?? 0) + 1); }
  for (const d of recent) { const p = extractPair(d, half); counts7.set(p,  (counts7.get(p)  ?? 0) + 1); }

  return ALL_PAIRS.map(pair => {
    const freq90 = (counts90.get(pair) ?? 0) / n90;
    const freq7  = (counts7.get(pair)  ?? 0) / n7;
    const std    = Math.sqrt((freq90 * (1 - freq90)) / n7) || 0.001;
    const z      = (freq7 - freq90) / std;
    const score  = 1 / (1 + Math.exp(-z));   // sigmoid
    return { pair, score };
  }).sort((a, b) => b.score - a.score);
};

// ─── 3. gap_overdue_focus ────────────────────────────────────
const pairGapOverdueFocus: PairRankFn = (draws, half) => {
  if (draws.length === 0) return pairFrequencyRank(draws, half);
  const total = draws.length;
  const lastSeen  = new Map<string, number>();
  const countMap  = new Map<string, number>(ALL_PAIRS.map(p => [p, 0]));

  draws.forEach((d, idx) => {
    const p = extractPair(d, half);
    lastSeen.set(p, idx);
    countMap.set(p, (countMap.get(p) ?? 0) + 1);
  });

  return ALL_PAIRS.map(pair => {
    const lastIdx   = lastSeen.get(pair);
    const gapActual = lastIdx === undefined ? total : (total - 1 - lastIdx);
    const cnt       = countMap.get(pair) ?? 0;
    const avgGap    = cnt > 0 ? total / cnt : total;
    return { pair, score: gapActual / (avgGap || 1) };
  }).sort((a, b) => b.score - a.score);
};

// ─── 4. moving_avg_signal ────────────────────────────────────
const pairMovingAvgSignal: PairRankFn = (draws, half) => {
  if (draws.length < 14) return pairFrequencyRank(draws, half);
  return ALL_PAIRS.map(pair => {
    const series = draws.map(d => extractPair(d, half) === pair ? 1 : 0);
    const sma7   = (series.slice(-7)      as number[]).reduce((a, b) => a + b, 0) / 7;
    const sma14  = (series.slice(-14)     as number[]).reduce((a, b) => a + b, 0) / 14;
    const prev7  = (series.slice(-10, -3) as number[]).reduce((a, b) => a + b, 0) / 7;
    const prev14 = (series.slice(-17, -3) as number[]).reduce((a, b) => a + b, 0) / 14;
    const crossover = sma7 >= sma14 && prev7 < prev14;
    const score  = sma7 > sma14 ? (crossover ? 0.95 : 0.75) : (sma7 > 0 ? 0.35 : 0.1);
    return { pair, score };
  }).sort((a, b) => b.score - a.score);
};

// ─── 5. momentum_ema ─────────────────────────────────────────
const pairMomentumEma: PairRankFn = (draws, half) => {
  if (draws.length < 3) return pairFrequencyRank(draws, half);
  const WINDOWS = [3, 7, 14, 30] as const;
  const ALPHA   = 0.85;

  return ALL_PAIRS.map(pair => {
    let score = 0;
    WINDOWS.forEach((w, k) => {
      const slice = draws.slice(-w);
      const freq  = slice.length > 0
        ? slice.filter(d => extractPair(d, half) === pair).length / slice.length
        : 0;
      score += freq * Math.pow(ALPHA, k);
    });
    return { pair, score };
  }).sort((a, b) => b.score - a.score);
};

// ─── 6. streak_reversal ─────────────────────────────────────
const pairStreakReversal: PairRankFn = (draws, half) => {
  if (draws.length === 0) return pairFrequencyRank(draws, half);
  return ALL_PAIRS.map(pair => {
    // Racha actual de ausencia
    let currentAbsence = 0;
    for (let i = draws.length - 1; i >= 0; i--) {
      if (extractPair(draws[i]!, half) === pair) break;
      currentAbsence++;
    }
    // Rachas históricas
    const absenceLengths: number[] = [];
    let streak = 0;
    for (const d of draws) {
      if (extractPair(d, half) !== pair) {
        streak++;
      } else {
        if (streak > 0) absenceLengths.push(streak);
        streak = 0;
      }
    }
    const mean     = absenceLengths.length > 0
      ? absenceLengths.reduce((a, b) => a + b, 0) / absenceLengths.length
      : draws.length;
    const variance = absenceLengths.reduce((a, b) => a + (b - mean) ** 2, 0) / (absenceLengths.length || 1);
    const std      = Math.sqrt(variance) || 1;
    return { pair, score: Math.min(2, currentAbsence / (mean + 2 * std)) };
  }).sort((a, b) => b.score - a.score);
};

// ─── 7. position_bias ────────────────────────────────────────
// observed_freq(XY) vs 0.01 (esperado = 1/100 para distribución uniforme)
const pairPositionBias: PairRankFn = (draws, half) => {
  const counts = new Map<string, number>(ALL_PAIRS.map(p => [p, 0]));
  for (const d of draws) {
    const p = extractPair(d, half);
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const total    = draws.length || 1;
  const expected = 0.01;  // 1/100
  return ALL_PAIRS.map(pair => ({
    pair,
    score: Math.max(0, (counts.get(pair) ?? 0) / total - expected) + 0.001,
  })).sort((a, b) => b.score - a.score);
};

// ─── 8. pair_correlation (verdadera correlación conjunta) ────
// score = P(X,Y) / (P(X_pos_a) × P(Y_pos_b)) − 1
// Positivo = el par aparece MÁS de lo que predice independencia
const pairCorrelation: PairRankFn = (draws, half) => {
  if (draws.length === 0) return pairFrequencyRank(draws, half);
  const total = draws.length;

  // Frecuencias marginales de cada dígito en cada sub-posición
  const margA = new Array(10).fill(0) as number[];  // primer dígito del par
  const margB = new Array(10).fill(0) as number[];  // segundo dígito del par
  const joint = new Map<string, number>(ALL_PAIRS.map(p => [p, 0]));

  for (const d of draws) {
    const pair = extractPair(d, half);
    const a    = parseInt(pair[0]!, 10);
    const b    = parseInt(pair[1]!, 10);
    margA[a]!++;
    margB[b]!++;
    joint.set(pair, (joint.get(pair) ?? 0) + 1);
  }

  return ALL_PAIRS.map(pair => {
    const a    = parseInt(pair[0]!, 10);
    const b    = parseInt(pair[1]!, 10);
    const pA   = margA[a]! / total;
    const pB   = margB[b]! / total;
    const pAB  = (joint.get(pair) ?? 0) / total;
    const denom = pA * pB;
    const ratio = denom > 0 ? pAB / denom : 0;
    return { pair, score: Math.max(0, ratio - 1) };
  }).sort((a, b) => b.score - a.score);
};

// ─── 9. fibonacci_pisano ─────────────────────────────────────
// phase_freq(XY) / general_freq(XY) donde phase = draws.length % 60
const pairFibonacciPisano: PairRankFn = (draws, half) => {
  if (draws.length === 0) return pairFrequencyRank(draws, half);
  const currentPhase = draws.length % 60;
  const total        = draws.length;

  const generalCount = new Map<string, number>(ALL_PAIRS.map(p => [p, 0]));
  const phaseCount   = new Map<string, number>(ALL_PAIRS.map(p => [p, 0]));
  let phaseTotal     = 0;

  draws.forEach((d, idx) => {
    const pair = extractPair(d, half);
    generalCount.set(pair, (generalCount.get(pair) ?? 0) + 1);
    if (idx % 60 === currentPhase) {
      phaseCount.set(pair, (phaseCount.get(pair) ?? 0) + 1);
      phaseTotal++;
    }
  });

  return ALL_PAIRS.map(pair => {
    const generalFreq = total > 0 ? (generalCount.get(pair) ?? 0) / total : 0;
    const phaseFreq   = phaseTotal > 0 ? (phaseCount.get(pair) ?? 0) / phaseTotal : 0;
    const alignment   = generalFreq > 0 ? phaseFreq / generalFreq : 0;
    return { pair, score: alignment };
  }).sort((a, b) => b.score - a.score);
};

// ═══════════════════════════════════════════════════════════════
// BALLBOT CLONES — 6 in-memory PairRankFn implementations
// Declaradas ANTES de BASE_STRATEGIES para evitar temporal dead zone.
// ═══════════════════════════════════════════════════════════════

// ─── 12. bayesian_score ──────────────────────────────────────
const pairBayesianScore: PairRankFn = (draws, half) => {
  if (draws.length < 5) return pairFrequencyRank(draws, half);
  const W_FREQ = 0.15, W_GAP = 0.20, W_MOM = 0.20, W_MARKOV = 0.20, W_STREAK = 0.10;
  const allPairs = draws.map(d => extractPair(d, half));
  const total    = allPairs.length;
  const recent30 = allPairs.slice(-Math.min(30, total));
  const recentTotal = recent30.length || 1;
  const freqCount: Record<string, number> = {};
  for (const p of allPairs) freqCount[p] = (freqCount[p] ?? 0) + 1;
  const maxFreq = Math.max(...Object.values(freqCount), 1);
  const lastSeen: Record<string, number> = {};
  const gapSum: Record<string, number> = {}; const gapCnt: Record<string, number> = {};
  for (let i = 0; i < allPairs.length; i++) {
    const p = allPairs[i]!;
    if (lastSeen[p] !== undefined) { const g = i - lastSeen[p]!; gapSum[p] = (gapSum[p] ?? 0) + g; gapCnt[p] = (gapCnt[p] ?? 0) + 1; }
    lastSeen[p] = i;
  }
  const currentGap: Record<string, number> = {};
  for (const [p, idx] of Object.entries(lastSeen)) currentGap[p] = total - 1 - idx;
  const recentCount: Record<string, number> = {};
  for (const p of recent30) recentCount[p] = (recentCount[p] ?? 0) + 1;
  const matrix = new Map<string, Map<string, number>>();
  for (let i = 0; i + 1 < allPairs.length; i++) {
    const from = allPairs[i]!, to = allPairs[i + 1]!;
    if (!matrix.has(from)) matrix.set(from, new Map());
    matrix.get(from)!.set(to, (matrix.get(from)!.get(to) ?? 0) + 1);
  }
  const markovScore: Record<string, number> = {};
  for (const prev of allPairs.slice(-5)) {
    const row = matrix.get(prev); if (!row) continue;
    const rowT = Array.from(row.values()).reduce((s, v) => s + v, 0);
    for (const [to, cnt] of row) markovScore[to] = Math.max(markovScore[to] ?? 0, cnt / rowT);
  }
  const maxMarkov = Math.max(...Object.values(markovScore), 1e-9);
  const run: Record<string, number> = {};
  const curStreak: Record<string, number> = {};
  const avgStreak: Record<string, number> = {};
  { const streakAcc: Record<string, number[]> = {};
    for (const p of allPairs) {
      for (const k of ALL_PAIRS) { if (k !== p) run[k] = (run[k] ?? 0) + 1; }
      if ((run[p] ?? 0) > 0) { streakAcc[p] = streakAcc[p] ?? []; streakAcc[p]!.push(run[p]!); }
      run[p] = 0;
    }
    for (const p of ALL_PAIRS) { curStreak[p] = run[p] ?? 0; const arr = streakAcc[p] ?? []; avgStreak[p] = arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : total; }
  }
  return ALL_PAIRS.map(p => {
    const s1 = (freqCount[p] ?? 0) / maxFreq;
    const avgG = gapCnt[p] ? (gapSum[p]! / gapCnt[p]!) : total;
    const s2 = Math.min(1, (currentGap[p] ?? total) / Math.max(avgG, 1) / 3);
    const gRate = (freqCount[p] ?? 0) / total; const rRate = (recentCount[p] ?? 0) / recentTotal;
    const s3 = gRate > 0 ? Math.min(1, (rRate / gRate) / 5) : 0;
    const s5 = (markovScore[p] ?? 0) / maxMarkov;
    const s6 = avgStreak[p]! > 0 ? Math.min(1, (curStreak[p] ?? 0) / avgStreak[p]! / 4) : 0;
    return { pair: p, score: W_FREQ*s1 + W_GAP*s2 + W_MOM*s3 + W_MARKOV*s5 + W_STREAK*s6 };
  }).sort((a, b) => b.score - a.score);
};

// ─── 13. transition_follow ───────────────────────────────────
const pairTransitionFollow: PairRankFn = (draws, half) => {
  if (draws.length < 3) return pairFrequencyRank(draws, half);
  const allPairs = draws.map(d => extractPair(d, half));
  const matrix = new Map<string, Map<string, number>>();
  for (let i = 0; i + 1 < allPairs.length; i++) {
    const from = allPairs[i]!, to = allPairs[i + 1]!;
    if (!matrix.has(from)) matrix.set(from, new Map());
    matrix.get(from)!.set(to, (matrix.get(from)!.get(to) ?? 0) + 1);
  }
  const votes: Record<string, number> = {};
  const last5 = allPairs.slice(-5);
  for (let lag = 0; lag < last5.length; lag++) {
    const row = matrix.get(last5[lag]!); if (!row) continue;
    const rowT = Array.from(row.values()).reduce((s, v) => s + v, 0);
    const rW = 1.0 - (0.6 * lag) / last5.length;
    Array.from(row.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6).forEach(([to, cnt]) => {
      votes[to] = (votes[to] ?? 0) + (cnt / rowT) * rW;
    });
  }
  const maxV = Math.max(...Object.values(votes), 1e-9);
  return ALL_PAIRS.map(p => ({ pair: p, score: (votes[p] ?? 0) / maxV })).sort((a, b) => b.score - a.score);
};

// ─── 14. markov_order2 ───────────────────────────────────────
const pairMarkovOrder2: PairRankFn = (draws, half) => {
  if (draws.length < 4) return pairFrequencyRank(draws, half);
  const allPairs = draws.map(d => extractPair(d, half));
  const table = new Map<string, Map<string, number>>();
  for (let i = 1; i + 1 < allPairs.length; i++) {
    const state = `${allPairs[i - 1]}_${allPairs[i]}`, to = allPairs[i + 1]!;
    if (!table.has(state)) table.set(state, new Map());
    table.get(state)!.set(to, (table.get(state)!.get(to) ?? 0) + 1);
  }
  const votes: Record<string, number> = {};
  const states: string[] = [];
  if (allPairs.length >= 2) states.push(`${allPairs[allPairs.length - 2]}_${allPairs[allPairs.length - 1]}`);
  if (allPairs.length >= 3) states.push(`${allPairs[allPairs.length - 3]}_${allPairs[allPairs.length - 2]}`);
  for (let si = 0; si < states.length; si++) {
    const row = table.get(states[si]!); if (!row) continue;
    const rowT = Array.from(row.values()).reduce((s, v) => s + v, 0);
    const rW = si === 0 ? 1.0 : 0.5;
    Array.from(row.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).forEach(([to, cnt]) => {
      votes[to] = (votes[to] ?? 0) + (cnt / rowT) * rW;
    });
  }
  const maxV = Math.max(...Object.values(votes), 1e-9);
  return ALL_PAIRS.map(p => ({ pair: p, score: (votes[p] ?? 0) / maxV })).sort((a, b) => b.score - a.score);
};

// ─── 15. calendar_pattern ────────────────────────────────────
const pairCalendarPattern: PairRankFn = (draws, half) => {
  if (draws.length < 5) return pairFrequencyRank(draws, half);
  const nextDate    = new Date(draws[draws.length - 1]!.created_at.getTime() + 86_400_000);
  const targetDow   = nextDate.getDay(), targetMonth = nextDate.getMonth() + 1, targetDom = nextDate.getDate();
  const dim1: Record<string, Record<string, number>> = {};
  const dim2: Record<number, Record<string, number>> = {};
  const dim3: Record<number, Record<string, number>> = {};
  const dim4: Record<number, Record<string, number>> = {};
  for (const d of draws) {
    const pair = extractPair(d, half);
    const dow = d.created_at.getDay(), month = d.created_at.getMonth() + 1, dom = d.created_at.getDate();
    const k1 = `${dow}_${month}`;
    dim1[k1] = dim1[k1] ?? {}; dim1[k1]![pair] = (dim1[k1]![pair] ?? 0) + 1;
    dim2[dow]   = dim2[dow]   ?? {}; dim2[dow]![pair]   = (dim2[dow]![pair]   ?? 0) + 1;
    dim3[month] = dim3[month] ?? {}; dim3[month]![pair] = (dim3[month]![pair] ?? 0) + 1;
    dim4[dom]   = dim4[dom]   ?? {}; dim4[dom]![pair]   = (dim4[dom]![pair]   ?? 0) + 1;
  }
  function bScore(bucket: Record<string, number> | undefined, p: string): number {
    if (!bucket) return 0; const t = Object.values(bucket).reduce((s, v) => s + v, 0);
    return t > 0 ? (bucket[p] ?? 0) / t : 0;
  }
  const raw: Record<string, number> = {};
  for (const p of ALL_PAIRS) {
    raw[p] = 0.40 * bScore(dim1[`${targetDow}_${targetMonth}`], p) + 0.30 * bScore(dim2[targetDow], p)
           + 0.20 * bScore(dim3[targetMonth], p) + 0.10 * bScore(dim4[targetDom], p);
  }
  const maxR = Math.max(...Object.values(raw), 1e-9);
  return ALL_PAIRS.map(p => ({ pair: p, score: raw[p]! / maxR })).sort((a, b) => b.score - a.score);
};

// ─── 16. decade_family ───────────────────────────────────────
const pairDecadeFamily: PairRankFn = (draws, half) => {
  if (draws.length < 5) return pairFrequencyRank(draws, half);
  const allPairs = draws.map(d => extractPair(d, half));
  const total = allPairs.length;
  const recent30 = allPairs.slice(-Math.min(30, total));
  const recentTotal = recent30.length || 1;
  const famTotal: number[] = new Array(10).fill(0) as number[];
  const famRecent: number[] = new Array(10).fill(0) as number[];
  const pairTotal: Record<string, number> = {};
  for (const p of allPairs) { famTotal[parseInt(p[0]!)]!++; pairTotal[p] = (pairTotal[p] ?? 0) + 1; }
  for (const p of recent30) famRecent[parseInt(p[0]!)]!++;
  const momentum = famTotal.map((t, i) => t > 0 ? (famRecent[i]! / recentTotal) / (t / total) : 0);
  const hot = momentum.map((m, i) => ({ m, i })).filter(o => o.m >= 1.0)
    .sort((a, b) => b.m - a.m).slice(0, 4).map(o => o.i);
  const active = hot.length > 0 ? hot : momentum.map((m, i) => ({ m, i })).sort((a, b) => b.m - a.m).slice(0, 4).map(o => o.i);
  const raw: Record<string, number> = {};
  for (const p of ALL_PAIRS) {
    const fam = parseInt(p[0]!);
    raw[p] = active.includes(fam) ? (momentum[fam] ?? 0) * ((pairTotal[p] ?? 0) / Math.max(famTotal[fam]!, 1)) : 0;
  }
  const maxR = Math.max(...Object.values(raw), 1e-9);
  return ALL_PAIRS.map(p => ({ pair: p, score: raw[p]! / maxR })).sort((a, b) => b.score - a.score);
};

// ─── 17. max_per_weekday ─────────────────────────────────────
const pairMaxPerWeekday: PairRankFn = (draws, half) => {
  if (draws.length < 5) return pairFrequencyRank(draws, half);
  const nextDate  = new Date(draws[draws.length - 1]!.created_at.getTime() + 86_400_000);
  const targetDow = nextDate.getDay();
  const bucket: Record<string, number> = {}; let bucketTotal = 0;
  for (const d of draws) {
    if (d.created_at.getDay() !== targetDow) continue;
    const p = extractPair(d, half); bucket[p] = (bucket[p] ?? 0) + 1; bucketTotal++;
  }
  if (bucketTotal === 0) return pairFrequencyRank(draws, half);
  const maxF = Math.max(...Object.values(bucket), 1e-9);
  return ALL_PAIRS.map(p => ({ pair: p, score: (bucket[p] ?? 0) / maxF })).sort((a, b) => b.score - a.score);
};

// ─── 10. consensus_top (pesos fijos) ─────────────────────────
const BASE_STRATEGIES: [PairRankFn, number][] = [
  [pairFrequencyRank,   1.0],
  [pairMomentumEma,     0.95],
  [pairGapOverdueFocus, 0.9],
  [pairHotColdWeighted, 0.85],
  [pairPositionBias,    0.8],
  [pairCorrelation,     0.75],
  [pairMovingAvgSignal, 0.7],
  [pairStreakReversal,  0.65],
  [pairFibonacciPisano, 0.6],
  // Ballbot Clones
  [pairBayesianScore,   1.1],
  [pairTransitionFollow,0.85],
  [pairMarkovOrder2,    0.80],
  [pairCalendarPattern, 0.70],
  [pairDecadeFamily,    0.75],
  [pairMaxPerWeekday,   0.55],
];

const pairConsensusTop: PairRankFn = (draws, half) => {
  const scores = new Map<string, number>(ALL_PAIRS.map(p => [p, 0]));
  let totalWeight = 0;

  for (const [fn, weight] of BASE_STRATEGIES) {
    const ranked = fn(draws, half);
    const maxS   = ranked[0]?.score || 1;
    for (const { pair, score } of ranked) {
      scores.set(pair, (scores.get(pair) ?? 0) + (score / (maxS || 1)) * weight);
    }
    totalWeight += weight;
  }

  return ALL_PAIRS.map(pair => ({
    pair,
    score: (scores.get(pair) ?? 0) / totalWeight,
  })).sort((a, b) => b.score - a.score);
};

// ─── 11. apex_adaptive (pesos adaptativos + factor top_n) ────
function createPairApexAdaptive(weights: AdaptiveWeights, topNMap: Record<string, number>): PairRankFn {
  return (draws, half) => {
    const scores = new Map<string, number>(ALL_PAIRS.map(p => [p, 0]));
    let totalWeight = 0;

    const strategies: [PairRankFn, string, number][] = [
      [pairFrequencyRank,   'frequency_rank',    1.0],
      [pairMomentumEma,     'momentum_ema',      0.95],
      [pairGapOverdueFocus, 'gap_overdue_focus', 0.9],
      [pairHotColdWeighted, 'hot_cold_weighted', 0.85],
      [pairPositionBias,    'position_bias',     0.8],
      [pairCorrelation,     'pair_correlation',  0.75],
      [pairMovingAvgSignal, 'moving_avg_signal', 0.7],
      [pairStreakReversal,  'streak_reversal',   0.65],
      [pairFibonacciPisano, 'fibonacci_pisano',  0.6],
      // Ballbot Clones
      [pairBayesianScore,   'bayesian_score',    1.1],
      [pairTransitionFollow,'transition_follow', 0.85],
      [pairMarkovOrder2,    'markov_order2',     0.80],
      [pairCalendarPattern, 'calendar_pattern',  0.70],
      [pairDecadeFamily,    'decade_family',     0.75],
      [pairMaxPerWeekday,   'max_per_weekday',   0.55],
    ];

    for (const [fn, name, baseWeight] of strategies) {
      const adaptiveFactor  = weights[name] ?? 1.0;
      // Bonus de precisión: si el top_n aprendido es menor → la estrategia es más precisa
      const topN            = topNMap[name] ?? DEFAULT_TOP_N;
      const precisionBonus  = DEFAULT_TOP_N / topN;  // ej: topN=10 → bonus=1.5
      const effectiveWeight = baseWeight * adaptiveFactor * Math.min(2.0, precisionBonus);

      const ranked = fn(draws, half);
      const maxS   = ranked[0]?.score || 1;
      for (const { pair, score } of ranked) {
        scores.set(pair, (scores.get(pair) ?? 0) + (score / (maxS || 1)) * effectiveWeight);
      }
      totalWeight += effectiveWeight;
    }

    return ALL_PAIRS.map(pair => ({
      pair,
      score: (scores.get(pair) ?? 0) / totalWeight,
    })).sort((a, b) => b.score - a.score);
  };
}

// ─── Mapa de estrategias ─────────────────────────────────────
const PAIR_STRATEGY_FNS: Record<Exclude<PairStrategyName, 'apex_adaptive'>, PairRankFn> = {
  frequency_rank:    pairFrequencyRank,
  hot_cold_weighted: pairHotColdWeighted,
  gap_overdue_focus: pairGapOverdueFocus,
  moving_avg_signal: pairMovingAvgSignal,
  momentum_ema:      pairMomentumEma,
  streak_reversal:   pairStreakReversal,
  position_bias:     pairPositionBias,
  pair_correlation:  pairCorrelation,
  fibonacci_pisano:  pairFibonacciPisano,
  consensus_top:     pairConsensusTop,
  // Ballbot Clones
  bayesian_score:    pairBayesianScore,
  transition_follow: pairTransitionFollow,
  markov_order2:     pairMarkovOrder2,
  calendar_pattern:  pairCalendarPattern,
  decade_family:     pairDecadeFamily,
  max_per_weekday:   pairMaxPerWeekday,
};

// ─── Hit detection para Pick 4 (cross-applicable) ────────────
// Par recomendado XY = hit si XY o YX aparece en AB o CD del resultado
function pick4PairHit(recommended: string[], actualAB: string, actualCD: string): boolean {
  const candidates = new Set<string>();
  for (const pair of recommended) {
    candidates.add(pair);
    candidates.add(`${pair[1]}${pair[0]}`);  // par invertido
  }
  return candidates.has(actualAB) || candidates.has(actualCD);
}

// ─── PairBacktestEngine ───────────────────────────────────────
export class PairBacktestEngine {
  constructor(
    private readonly agentPool: Pool
  ) {}

  // ─── Cargar top_n state desde DB ────────────────────────────
  async loadAdaptiveTopN(
    strategy: string,
    game_type: string,
    mode: string
  ): Promise<TopNState> {
    const { rows } = await this.agentPool.query<{
      top_n: number;
      hit_rate_history: number[];
    }>(
      `SELECT top_n, hit_rate_history FROM hitdash.adaptive_weights
       WHERE strategy = $1 AND game_type = $2 AND mode = $3`,
      [strategy, game_type, mode]
    );
    if (rows.length === 0) return { current_top_n: DEFAULT_TOP_N, hit_rate_history: [] };
    return {
      current_top_n:    rows[0]!.top_n,
      hit_rate_history: rows[0]!.hit_rate_history ?? [],
    };
  }

  // ─── Cargar pesos adaptativos ────────────────────────────────
  async loadAdaptiveWeights(game_type: string, mode: string): Promise<AdaptiveWeights> {
    const { rows } = await this.agentPool.query<{ strategy: string; weight: number }>(
      `SELECT strategy, weight FROM hitdash.adaptive_weights
       WHERE game_type = $1 AND mode = $2`,
      [game_type, mode]
    );
    const weights: AdaptiveWeights = {};
    for (const r of rows) weights[r.strategy] = Number(r.weight);
    return weights;
  }

  // ─── Cargar top_n de todas las estrategias ───────────────────
  async loadAllTopN(game_type: string, mode: string): Promise<Record<string, number>> {
    const { rows } = await this.agentPool.query<{ strategy: string; top_n: number }>(
      `SELECT strategy, top_n FROM hitdash.adaptive_weights
       WHERE game_type = $1 AND mode = $2`,
      [game_type, mode]
    );
    const out: Record<string, number> = {};
    for (const r of rows) out[r.strategy] = r.top_n;
    return out;
  }

  // ─── Fetch histórico ─────────────────────────────────────────
  // ═══ F03 FIX: Fuente única de datos — hitdash.ingested_results (local VPS)
  // Antes: consulta directa a Ballbot vía ballbotPool (red externa = latencia + inconsistencia).
  // AnalysisEngine ya usaba DRAWS_CTE desde ingested_results → dos fuentes para el mismo sistema.
  // Ahora: mismo pool, mismos datos → análisis y backtest son matemáticamente consistentes.
  private async fetchHistory(
    game_type: 'pick3' | 'pick4',
    mode: BacktestMode,
    date_from?: string,
    date_to?: string
  ): Promise<DrawEntry[]> {
    // 'combined' → sin filtro de draw_type; de lo contrario 'midday' | 'evening'
    const drawTypeFilter = mode === 'combined' ? null : mode;

    const { rows } = await this.agentPool.query<{
      p1: number; p2: number; p3: number; p4: number | null;
      draw_date: string;
    }>(
      `SELECT p1, p2, p3, p4,
              draw_date::text AS draw_date
       FROM hitdash.ingested_results
       WHERE game_type = $1
         AND ($2::text IS NULL OR draw_type = $2)
         AND ($3::date IS NULL OR draw_date >= $3::date)
         AND ($4::date IS NULL OR draw_date <= $4::date)
       ORDER BY draw_date ASC`,
      [game_type, drawTypeFilter, date_from ?? null, date_to ?? null]
    );

    return rows.map(r => ({
      p1:         r.p1,
      p2:         r.p2,
      p3:         r.p3,
      ...(r.p4 !== null ? { p4: r.p4 } : {}),
      draw_date:  r.draw_date,
      // created_at derivado de draw_date para algoritmos con ventana temporal (ej. pairHotColdWeighted)
      created_at: new Date(r.draw_date + 'T12:00:00Z'),
    }));
  }


  // ─── Ejecutar backtest de UNA estrategia ────────────────────
  async runStrategy(
    strategyName: PairStrategyName,
    config: PairBacktestConfig
  ): Promise<PairBacktestSummary> {
    const globalStart = Date.now();
    logger.info({ strategy: strategyName, mode: config.mode, half: config.half }, 'PairBacktest: iniciando');

    // Cargar estrategia (apex_adaptive carga pesos y top_n de DB)
    let rankFn: PairRankFn;
    if (strategyName === 'apex_adaptive') {
      const [weights, topNMap] = await Promise.all([
        this.loadAdaptiveWeights(config.game_type, config.mode),
        this.loadAllTopN(config.game_type, config.mode),
      ]);
      rankFn = createPairApexAdaptive(weights, topNMap);
      logger.info({ loaded_strategies: Object.keys(weights).length }, 'apex_adaptive: pesos cargados');
    } else {
      rankFn = PAIR_STRATEGY_FNS[strategyName];
      if (!rankFn) throw new Error(`Estrategia desconocida: ${strategyName}`);
    }

    // Cargar estado adaptativo de top_n
    const topNState = await this.loadAdaptiveTopN(strategyName, config.game_type, config.mode);
    let currentTopN = topNState.current_top_n;

    // Fetch histórico completo (una sola query, con filtro de fechas opcional)
    const allDraws = await this.fetchHistory(config.game_type, config.mode, config.date_from, config.date_to);
    if (allDraws.length < config.min_train_draws + config.eval_step) {
      throw new Error(`Datos insuficientes: ${allDraws.length} draws`);
    }

    logger.info({ strategy: strategyName, total_draws: allDraws.length, top_n: currentTopN }, 'Historial cargado');

    // ─── Sliding window ──────────────────────────────────────
    const points: PairEvalPoint[] = [];

    for (
      let i = config.min_train_draws;
      i < allDraws.length;
      i += config.eval_step
    ) {
      const testDraw  = allDraws[i]!;
      const trainDraws = allDraws.slice(Math.max(0, i - config.train_window_draws), i);

      // Rankear 100 pares (lista completa para métricas de precisión)
      const ranked   = rankFn(trainDraws, config.half);
      const topPairs = ranked.slice(0, currentTopN).map(r => r.pair);

      // Normalizar scores al rango [0,1] (dividir por el score máximo)
      const maxScore     = ranked[0]?.score ?? 1;
      const scoreNormMap = new Map(ranked.map((r, i) => [r.pair, {
        rank:  i + 1,
        score: maxScore > 0 ? r.score / maxScore : 0,
      }]));

      // Centena Plus (solo pick3 / half='du')
      let centenaPlus = 0;
      if (config.half === 'du') {
        const p1Counts = new Array(10).fill(0) as number[];
        for (const d of trainDraws) p1Counts[d.p1]!++;
        centenaPlus = p1Counts.indexOf(Math.max(...p1Counts));
      }

      // Hit detection
      let hitPair        = false;
      let hitCentenaPlus = false;

      if (config.game_type === 'pick3') {
        const actualPair = extractPair(testDraw, config.half);
        hitPair          = topPairs.includes(actualPair);
        if (config.half === 'du') hitCentenaPlus = centenaPlus === testDraw.p1;
      } else {
        // Pick4: cross-applicable
        const draw4 = testDraw as DrawEntry & { p4?: number };
        const actualAB = `${testDraw.p1}${testDraw.p2}`;
        const actualCD = `${testDraw.p3}${draw4.p4 ?? 0}`;
        hitPair = pick4PairHit(topPairs, actualAB, actualCD);
      }

      // ═══ ANO-07 FIX: Para Pick4, promediar métricas entre AB y CD
      // Antes: solo se medía el rank del par AB → estrategia que acierta via CD parecía miss.
      // Ahora: se obtiene rank+score de ambos halves y se promedia → métricas representativas.
      let actualPairRank  = 100;
      let actualPairScore = 0;
      let reciprocalRank  = 1/100;

      if (config.game_type === 'pick3') {
        const actualPairKey = extractPair(testDraw, config.half);
        const info = scoreNormMap.get(actualPairKey) ?? { rank: 100, score: 0 };
        actualPairRank  = info.rank;
        actualPairScore = +info.score.toFixed(4);
        reciprocalRank  = +(1 / info.rank).toFixed(4);
      } else {
        // Pick4: promediar rank y score entre AB y CD
        const draw4   = testDraw as DrawEntry & { p4?: number };
        const actualABKey = `${testDraw.p1}${testDraw.p2}`;
        const actualCDKey = `${testDraw.p3}${draw4.p4 ?? 0}`;
        const infoAB  = scoreNormMap.get(actualABKey) ?? { rank: 100, score: 0 };
        const infoCD  = scoreNormMap.get(actualCDKey) ?? { rank: 100, score: 0 };
        // Blend 50/50 entre AB y CD — representa la experiencia real del jugador
        actualPairRank  = Math.round((infoAB.rank  + infoCD.rank)  / 2);
        actualPairScore = +((infoAB.score + infoCD.score) / 2).toFixed(4);
        reciprocalRank  = +((1/infoAB.rank + 1/infoCD.rank) / 2).toFixed(4);
      }

      points.push({
        draw_index:        i,
        eval_date:         testDraw.draw_date,
        top_pairs:         topPairs,
        centena_plus:      centenaPlus,
        // actual_pair must be exactly 2 chars (VARCHAR(2))
        actual_pair:       config.game_type === 'pick3'
          ? extractPair(testDraw, config.half).slice(0, 2)
          : `${testDraw.p1}${testDraw.p2}`.slice(0, 2),  // AB como referencia visual
        hit_pair:          hitPair,
        hit_centena_plus:  hitCentenaPlus,
        top_n_used:        currentTopN,
        actual_pair_rank:  actualPairRank,
        actual_pair_score: actualPairScore,
        reciprocal_rank:   reciprocalRank,
      });
    }

    // ─── Agregar estadísticas ────────────────────────────────
    const total          = points.length;
    const hitsPair       = points.filter(p => p.hit_pair).length;
    const centenaHits    = points.filter(p => p.hit_centena_plus).length;
    const hitRate        = total > 0 ? +(hitsPair   / total).toFixed(4) : 0;
    const centenaAcc     = total > 0 ? +(centenaHits / total).toFixed(4) : 0;
    const avgTopN        = total > 0
      ? +(points.reduce((a, p) => a + p.top_n_used, 0) / total).toFixed(2)
      : currentTopN;

    const dateFrom = points[0]?.eval_date ?? '';
    const dateTo   = points[points.length - 1]?.eval_date ?? '';

    // ─── Calcular 15 métricas de precisión ──────────────────────
    const precision = computePrecisionMetrics(points, hitRate, currentTopN);

    logger.info(
      {
        strategy: strategyName, total, hits: hitsPair, hit_rate: hitRate, avg_top_n: avgTopN,
        mrr: precision.mrr, expected_rank: precision.expected_rank,
        brier: precision.brier_score, p_value: precision.p_value,
        cohens_h: precision.cohens_h, sharpe: precision.sharpe,
        kelly: precision.kelly_fraction,
      },
      'PairBacktest: simulación completada con métricas de precisión'
    );

    return {
      strategy_name:     strategyName,
      game_type:         config.game_type,
      mode:              config.mode,
      half:              config.half,
      total_eval_pts:    total,
      hits_pair:         hitsPair,
      centena_plus_hits: centenaHits,
      hit_rate:          hitRate,
      centena_plus_acc:  centenaAcc,
      avg_top_n:         avgTopN,
      final_top_n:       currentTopN,
      date_from:         dateFrom,
      date_to:           dateTo,
      run_duration_ms:   Date.now() - globalStart,
      points,
      precision,
    };
  }

  // ─── Persistir resumen en DB ─────────────────────────────────
  async persistSummary(summary: PairBacktestSummary): Promise<string> {
    const p = summary.precision;
    const { rows } = await this.agentPool.query<{ id: string }>(
      `INSERT INTO hitdash.backtest_results_v2
         (strategy_name, game_type, mode, half,
          train_window_draws, eval_step_draws, total_eval_pts,
          hits_pair, centena_plus_hits, hit_rate, centena_plus_acc,
          avg_top_n, final_top_n, date_from, date_to, run_duration_ms,
          mrr, expected_rank, brier_score,
          precision_at_3, precision_at_5, precision_at_10,
          wilson_lower, wilson_upper,
          cohens_h, p_value,
          cv_hit_rate, sharpe, max_miss_streak, autocorr_lag1, kelly_fraction)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
               $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)
       ON CONFLICT (strategy_name, game_type, mode, half)
       DO UPDATE SET
         total_eval_pts    = EXCLUDED.total_eval_pts,
         hits_pair         = EXCLUDED.hits_pair,
         centena_plus_hits = EXCLUDED.centena_plus_hits,
         hit_rate          = EXCLUDED.hit_rate,
         centena_plus_acc  = EXCLUDED.centena_plus_acc,
         avg_top_n         = EXCLUDED.avg_top_n,
         final_top_n       = EXCLUDED.final_top_n,
         date_from         = EXCLUDED.date_from,
         date_to           = EXCLUDED.date_to,
         run_duration_ms   = EXCLUDED.run_duration_ms,
         mrr               = EXCLUDED.mrr,
         expected_rank     = EXCLUDED.expected_rank,
         brier_score       = EXCLUDED.brier_score,
         precision_at_3    = EXCLUDED.precision_at_3,
         precision_at_5    = EXCLUDED.precision_at_5,
         precision_at_10   = EXCLUDED.precision_at_10,
         wilson_lower      = EXCLUDED.wilson_lower,
         wilson_upper      = EXCLUDED.wilson_upper,
         cohens_h          = EXCLUDED.cohens_h,
         p_value           = EXCLUDED.p_value,
         cv_hit_rate       = EXCLUDED.cv_hit_rate,
         sharpe            = EXCLUDED.sharpe,
         max_miss_streak   = EXCLUDED.max_miss_streak,
         autocorr_lag1     = EXCLUDED.autocorr_lag1,
         kelly_fraction    = EXCLUDED.kelly_fraction,
         updated_at        = now()
       RETURNING id`,
      [
        summary.strategy_name, summary.game_type, summary.mode, summary.half,
        90, 7, summary.total_eval_pts,
        summary.hits_pair, summary.centena_plus_hits,
        summary.hit_rate, summary.centena_plus_acc,
        summary.avg_top_n, summary.final_top_n,
        summary.date_from, summary.date_to, summary.run_duration_ms,
        p.mrr, p.expected_rank, p.brier_score,
        p.precision_at_3, p.precision_at_5, p.precision_at_10,
        p.wilson_lower, p.wilson_upper,
        p.cohens_h, p.p_value,
        p.cv_hit_rate, p.sharpe, p.max_miss_streak, p.autocorr_lag1, p.kelly_fraction,
      ]
    );

    const backtestId = rows[0]!.id;

    // Persistir todos los eval points (máx 1000) — incluye misses con rank/score
    const allPoints = summary.points.slice(0, 1000);
    for (const pt of allPoints) {
      await this.agentPool.query(
        `INSERT INTO hitdash.backtest_points_v2
           (backtest_id, eval_date, draw_index, top_pairs, centena_plus,
            actual_pair, hit_pair, hit_centena_plus, top_n_used,
            actual_pair_rank, actual_pair_score, reciprocal_rank)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT DO NOTHING`,
        [
          backtestId, pt.eval_date, pt.draw_index, pt.top_pairs, pt.centena_plus,
          pt.actual_pair, pt.hit_pair, pt.hit_centena_plus, pt.top_n_used,
          pt.actual_pair_rank, pt.actual_pair_score, pt.reciprocal_rank,
        ]
      );
    }

    return backtestId;
  }

  // ─── Actualizar win_rate en strategy_registry ────────────────
  async updateStrategyWinRate(strategyName: string, summary: PairBacktestSummary): Promise<void> {
    // ═══ F05 FIX: α=0.15 sincronizado con StrategyEvaluator (era 0.20)
    // Con dos alphas distintas, win_rate fluctuaba diferente según qué camino actualizaba:
    // backtest usaba 0.20 (más reactivo) vs live evaluation usaba 0.15 (más conservador).
    // Resultado: estrategias en flip-flop activa↔retirada entre ciclos. Ahora α=0.15 global.
    const EMA_ALPHA = 0.15;
    const row = await this.agentPool.query<{ win_rate: number }>(
      `SELECT win_rate FROM hitdash.strategy_registry WHERE name = $1`,
      [strategyName]
    );
    if (row.rows.length === 0) return;

    const prev       = row.rows[0]!.win_rate;
    const newWinRate = +(EMA_ALPHA * summary.hit_rate + (1 - EMA_ALPHA) * prev).toFixed(4);

    await this.agentPool.query(
      `UPDATE hitdash.strategy_registry
       SET win_rate = $2, total_tests = total_tests + $3,
           last_evaluated = now(), updated_at = now()
       WHERE name = $1`,
      [strategyName, newWinRate, summary.total_eval_pts]
    );

    logger.info(
      { strategy: strategyName, prev_wr: prev, new_wr: newWinRate, hit_rate: summary.hit_rate },
      'win_rate actualizado desde pair backtest'
    );
  }

  // ─── Actualizar adaptive top_n + seed weights desde backtest ────
  async updateAdaptiveTopN(
    summaries: PairBacktestSummary[],
    game_type: string,
    mode: string
  ): Promise<void> {
    // B1 FIX: Seed adaptive_weights.weight from backtest hit_rates.
    // Use relative scaling: weight = hit_rate / mean_hit_rate, clamped [0.5, 2.0].
    // This matches the PostDrawProcessor EMA formula's clampedFactor convention.
    const base = summaries.filter(s => s.strategy_name !== 'apex_adaptive');
    const meanHitRate = base.length > 0
      ? base.reduce((sum, s) => sum + s.hit_rate, 0) / base.length
      : 0.01;  // fallback: random baseline 1/100

    for (const s of summaries) {
      if (s.strategy_name === 'apex_adaptive') continue;
      const state    = await this.loadAdaptiveTopN(s.strategy_name, game_type, mode);
      const newState = updateTopN(state, s.hit_rate);

      // Relative weight: how much better than average is this strategy?
      const relativeWeight = meanHitRate > 0 ? s.hit_rate / meanHitRate : 1.0;
      const seedWeight = Math.max(0.5, Math.min(2.0, relativeWeight));

      await this.agentPool.query(
        `INSERT INTO hitdash.adaptive_weights (strategy, game_type, mode, top_n, hit_rate_history, weight, sample_size)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
         ON CONFLICT (strategy, game_type, mode)
         DO UPDATE SET
           top_n             = $4,
           hit_rate_history  = $5::jsonb,
           weight            = $6,
           sample_size       = GREATEST(hitdash.adaptive_weights.sample_size, $7),
           updated_at        = now()`,
        [
          s.strategy_name, game_type, mode,
          newState.current_top_n,
          JSON.stringify(newState.hit_rate_history),
          seedWeight,
          s.total_eval_pts,
        ]
      );

      logger.info(
        {
          strategy: s.strategy_name,
          old_n: state.current_top_n, new_n: newState.current_top_n,
          hit_rate: s.hit_rate, mean_hit_rate: meanHitRate, seed_weight: seedWeight,
        },
        'Adaptive top_n + weight actualizado desde backtest'
      );
    }
  }

  // ─── Ejecutar todas las estrategias ─────────────────────────
  async runAll(
    mode: BacktestMode,
    game_type: 'pick3' | 'pick4' = 'pick3',
    halfOverride?: PairHalf,
    configOverrides?: Partial<PairBacktestConfig>
  ): Promise<PairBacktestSummary[]> {
    // Pick3 → only 'du'. Pick4 → run 'ab' then 'cd' independently.
    const halves: PairHalf[] = game_type === 'pick4'
      ? (halfOverride ? [halfOverride] : ['ab', 'cd'])
      : ['du'];

    const allSummaries: PairBacktestSummary[] = [];
    for (const half of halves) {
      const partialSummaries = await this.runAllHalf(mode, game_type, half, configOverrides);
      allSummaries.push(...partialSummaries);
    }
    return allSummaries;
  }

  private async runAllHalf(
    mode: BacktestMode,
    game_type: 'pick3' | 'pick4',
    half: PairHalf,
    configOverrides?: Partial<PairBacktestConfig>
  ): Promise<PairBacktestSummary[]> {
    const config: PairBacktestConfig = {
      game_type,
      mode,
      half,
      train_window_draws: 90,
      eval_step:          7,
      min_train_draws:    30,
      top_n:              DEFAULT_TOP_N,
      ...configOverrides,
    };

    const ALL_BASE_STRATEGIES: Exclude<PairStrategyName, 'apex_adaptive'>[] = [
      'frequency_rank', 'hot_cold_weighted', 'gap_overdue_focus',
      'moving_avg_signal', 'momentum_ema', 'streak_reversal',
      'position_bias', 'pair_correlation', 'fibonacci_pisano', 'consensus_top',
      // Ballbot Clones
      'bayesian_score', 'transition_follow', 'markov_order2',
      'calendar_pattern', 'decade_family', 'max_per_weekday',
    ];

    // Aplicar filtro de estrategias si se especificó
    const baseStrategies = config.strategy_filter?.length
      ? ALL_BASE_STRATEGIES.filter(s => config.strategy_filter!.includes(s))
      : ALL_BASE_STRATEGIES;

    const summaries: PairBacktestSummary[] = [];
    let doneCount = 0;
    // +1 for apex_adaptive at the end
    const totalCount = baseStrategies.length + 1;

    for (const name of baseStrategies) {
      try {
        const summary = await this.runStrategy(name, config);
        const id      = await this.persistSummary(summary);
        await this.updateStrategyWinRate(name, summary);
        doneCount++;
        config.on_progress?.(doneCount, totalCount, name);
        logger.info({ strategy: name, id, hit_rate: summary.hit_rate, top_n: summary.final_top_n },
          'PairBacktest: estrategia completada');
        summaries.push(summary);
      } catch (err) {
        doneCount++;
        config.on_progress?.(doneCount, totalCount, `${name}(error)`);
        logger.error({ strategy: name, error: err instanceof Error ? err.message : String(err) },
          'PairBacktest: estrategia fallida — continuando');
      }
    }

    // Actualizar top_n adaptativos con resultados de estrategias base
    await this.updateAdaptiveTopN(summaries, game_type, mode);

    // Ejecutar apex_adaptive ÚLTIMO con pesos+top_n recién calculados
    try {
      const apexSummary = await this.runStrategy('apex_adaptive', config);
      const apexId      = await this.persistSummary(apexSummary);
      await this.updateStrategyWinRate('apex_adaptive', apexSummary);
      config.on_progress?.(totalCount, totalCount, 'apex_adaptive');
      logger.info({ id: apexId, hit_rate: apexSummary.hit_rate }, 'apex_adaptive completado');
      summaries.push(apexSummary);
    } catch (err) {
      config.on_progress?.(totalCount, totalCount, 'apex_adaptive(error)');
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'apex_adaptive fallido');
    }

    // Rebalance strategy_registry
    await this.agentPool.query(
      `UPDATE hitdash.strategy_registry SET status='active', updated_at=now()
       WHERE status='testing' AND win_rate >= 0.12 AND total_tests >= 50`
    );
    await this.agentPool.query(
      `UPDATE hitdash.strategy_registry SET status='retired', updated_at=now()
       WHERE status IN ('testing','active') AND win_rate < 0.04 AND total_tests >= 50`
    );

    logger.info({ total: summaries.length, mode, half }, 'PairBacktest: todas las estrategias completadas');
    return summaries;
  }

  // ─── Leer resúmenes de DB ────────────────────────────────────
  async getSummaries(mode?: BacktestMode, half?: PairHalf): Promise<Record<string, unknown>[]> {
    const { rows } = await this.agentPool.query(
      `SELECT
         br.*,
         sr.description AS strategy_description,
         sr.status AS strategy_status,
         aw.weight AS adaptive_weight,
         aw.top_n  AS adaptive_top_n
       FROM hitdash.backtest_results_v2 br
       LEFT JOIN hitdash.strategy_registry sr ON sr.name = br.strategy_name
       LEFT JOIN hitdash.adaptive_weights aw
         ON aw.strategy = br.strategy_name AND aw.game_type = br.game_type AND aw.mode = br.mode
       WHERE ($1::text IS NULL OR br.mode = $1)
         AND ($2::text IS NULL OR br.half = $2)
       ORDER BY br.hit_rate DESC`,
      [mode ?? null, half ?? null]
    );
    return rows;
  }
}
