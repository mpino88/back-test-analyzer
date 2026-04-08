// ═══════════════════════════════════════════════════════════════
// HITDASH — BacktestEngine v1.0.0
// Simulación histórica profunda por estrategia
//
// Enfoque pick3:
//   - Centena (p1) + Decena (p2) como métricas principales
//   - Hasta 60 combinaciones generadas por punto de evaluación
//   - "Centena Plus": recomendación de alto valor para centena (p1 top-1)
//   - Modo continuo: midday | evening | combined (sin separar)
//
// Metodología sliding window in-memory:
//   1. Fetch todos los sorteos históricos (1 query)
//   2. Deslizar ventana de entrenamiento de N draws
//   3. Por cada punto, aplicar lógica de la estrategia
//   4. Generar 60 combos (2 centena × 3 decena × 10 unidades)
//   5. Registrar hit/miss y agregar stats
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';

const logger = pino({ name: 'BacktestEngine' });

// ─── Types ────────────────────────────────────────────────────
export type BacktestMode = 'midday' | 'evening' | 'combined';

export interface BacktestConfig {
  game_type:          'pick3';      // pick4 futuro
  mode:               BacktestMode;
  max_combos:         number;       // max 60
  train_window_draws: number;       // draws de entrenamiento (default 90)
  eval_step:          number;       // evaluar cada N draws (default 7)
  min_train_draws:    number;       // mínimo para generar predicción (default 30)
  top_p1_count:       number;       // centena candidates (default 2)
  top_p2_count:       number;       // decena candidates (default 3)
}

export interface DrawEntry {
  p1:         number;
  p2:         number;
  p3:         number;
  draw_date:  string;   // YYYY-MM-DD
  created_at: Date;
}

interface RankedDigit {
  digit: number;
  score: number;
}

interface EvalPoint {
  draw_index:       number;
  eval_date:        string;
  top_p1:           number[];
  top_p2:           number[];
  centena_plus:     number;          // alto valor centena
  combinations:     string[];        // muestra de hasta 10
  all_combos_set:   Set<string>;     // set completo para lookup O(1)
  actual_p1:        number;
  actual_p2:        number;
  actual_p3:        number;
  actual_number:    string;
  hit_combination:  boolean;
  hit_both:         boolean;
  hit_centena:      boolean;
  hit_decena:       boolean;
  hit_centena_plus: boolean;
}

export interface BacktestSummary {
  strategy_name:        string;
  game_type:            'pick3';
  mode:                 BacktestMode;
  config:               BacktestConfig;
  total_evaluation_pts: number;
  hits_combination:     number;
  hits_both:            number;
  hits_centena:         number;
  hits_decena:          number;
  centena_plus_hits:    number;
  effectiveness_pct:    number;  // hits_combination / total
  both_accuracy:        number;  // hits_both / total
  centena_accuracy:     number;  // hits_centena / total
  decena_accuracy:      number;  // hits_decena / total
  centena_plus_accuracy:number;  // centena_plus_hits / total
  date_from:            string;
  date_to:              string;
  run_duration_ms:      number;
  points:               EvalPoint[];  // todos los puntos (para insights)
}

// ─── Estrategias disponibles ──────────────────────────────────
export type StrategyName =
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
  | 'apex_adaptive';

// Pesos adaptativos cargados desde DB para apex_adaptive
export interface AdaptiveWeights {
  [strategy: string]: number;
}

// Definición de estrategia: función que rankea dígitos por posición
type RankFn = (draws: DrawEntry[], pos: 'p1' | 'p2') => RankedDigit[];

// ─── Implementaciones de estrategias ─────────────────────────

// 1. frequency_rank — frecuencia relativa pura
const frequencyRank: RankFn = (draws, pos) => {
  const counts = new Array(10).fill(0) as number[];
  for (const d of draws) counts[d[pos]]!++;
  const total = draws.length || 1;
  return counts
    .map((c, digit) => ({ digit, score: c / total }))
    .sort((a, b) => b.score - a.score);
};

// 2. hot_cold_weighted — z-score 7d vs ventana completa
const hotColdWeighted: RankFn = (draws, pos) => {
  if (draws.length === 0) return frequencyRank(draws, pos);
  const now = draws[draws.length - 1]!.created_at;
  const cutoff7d = new Date(now.getTime() - 7 * 86_400_000);
  const recent = draws.filter(d => d.created_at >= cutoff7d);

  const n90 = draws.length;
  const n7  = recent.length || 1;

  const counts90 = new Array(10).fill(0) as number[];
  const counts7  = new Array(10).fill(0) as number[];
  for (const d of draws)   counts90[d[pos]]!++;
  for (const d of recent)  counts7[d[pos]]!++;

  return counts90.map((c, digit) => {
    const freq90 = c / n90;
    const freq7  = counts7[digit]! / n7;
    const stdDev = Math.sqrt((freq90 * (1 - freq90)) / n7) || 0.001;
    const z = (freq7 - freq90) / stdDev;
    // Sigmoid z → [0,1] para scoring positivo
    const score = 1 / (1 + Math.exp(-z));
    return { digit, score };
  }).sort((a, b) => b.score - a.score);
};

// 3. gap_overdue_focus — mayor tiempo sin aparecer relativo al promedio
const gapOverdueFocus: RankFn = (draws, pos) => {
  if (draws.length === 0) return frequencyRank(draws, pos);
  const lastSeen = new Map<number, number>();  // digit → draw_index of last occurrence
  for (let i = 0; i < draws.length; i++) {
    lastSeen.set(draws[i]![pos], i);
  }
  const total = draws.length;

  // gap_actual = draws since last seen; avg_gap = total / frequency
  return Array.from({ length: 10 }, (_, digit) => {
    const lastIdx = lastSeen.get(digit);
    const gapActual = lastIdx === undefined ? total : (total - 1 - lastIdx);
    const freq = draws.filter(d => d[pos] === digit).length;
    const avgGap = freq > 0 ? total / freq : total;
    const overdueScore = gapActual / (avgGap || 1);
    return { digit, score: overdueScore };
  }).sort((a, b) => b.score - a.score);
};

// 4. moving_avg_signal — SMA-7 > SMA-14 golden cross
const movingAvgSignal: RankFn = (draws, pos) => {
  if (draws.length < 14) return frequencyRank(draws, pos);
  return Array.from({ length: 10 }, (_, digit) => {
    const series = draws.map(d => d[pos] === digit ? 1 : 0) as number[];
    const sma7  = series.slice(-7).reduce((a, b) => a + b, 0) / 7;
    const sma14 = series.slice(-14).reduce((a, b) => a + b, 0) / 14;
    // Crossover detected: SMA7 cruzó SMA14 en últimas 3 sesiones
    const prev7  = series.slice(-10, -3).reduce((a, b) => a + b, 0) / 7;
    const prev14 = series.slice(-17, -3).reduce((a, b) => a + b, 0) / 14;
    const crossover = sma7 >= sma14 && prev7 < prev14;
    const score = sma7 > sma14 ? (crossover ? 0.95 : 0.75) : (sma7 > 0 ? 0.35 : 0.1);
    return { digit, score };
  }).sort((a, b) => b.score - a.score);
};

// 5. streak_reversal — racha de ausencia más larga → próximo a aparecer
const streakReversal: RankFn = (draws, pos) => {
  if (draws.length === 0) return frequencyRank(draws, pos);
  return Array.from({ length: 10 }, (_, digit) => {
    // Calcular racha actual de ausencia
    let currentAbsence = 0;
    for (let i = draws.length - 1; i >= 0; i--) {
      if (draws[i]![pos] === digit) break;
      currentAbsence++;
    }
    // Media y desviación de rachas históricas
    const absenceLengths: number[] = [];
    let streak = 0;
    for (const d of draws) {
      if (d[pos] !== digit) {
        streak++;
      } else {
        if (streak > 0) absenceLengths.push(streak);
        streak = 0;
      }
    }
    const mean = absenceLengths.length > 0
      ? absenceLengths.reduce((a, b) => a + b, 0) / absenceLengths.length
      : draws.length;
    const variance = absenceLengths.reduce((a, b) => a + (b - mean) ** 2, 0) / (absenceLengths.length || 1);
    const std = Math.sqrt(variance) || 1;
    // Score: más alta la racha actual relativa a media+2σ, más probable la reversión
    const score = Math.min(2, currentAbsence / (mean + 2 * std));
    return { digit, score };
  }).sort((a, b) => b.score - a.score);
};

// 6. position_bias — desviación sobre frecuencia esperada (10%)
const positionBias: RankFn = (draws, pos) => {
  const counts = new Array(10).fill(0) as number[];
  for (const d of draws) counts[d[pos]]!++;
  const total = draws.length || 1;
  const expected = 0.1;
  return counts
    .map((c, digit) => ({ digit, score: Math.max(0, c / total - expected) + 0.01 }))
    .sort((a, b) => b.score - a.score);
};

// 7. pair_correlation — co-ocurrencia real p1↔p2 con correlation ratio
// Score = Σ_d' [ P(pos=d, other=d') / (P(pos=d) × P(other=d')) ] promediado
// Detecta pares con dependencia estadística real, no solo frecuencia marginal
const pairCorrelation: RankFn = (draws, pos) => {
  if (draws.length === 0) return frequencyRank(draws, pos);
  const otherPos: 'p1' | 'p2' = pos === 'p1' ? 'p2' : 'p1';
  const total = draws.length;

  // Frecuencias marginales
  const marginalPos   = new Array(10).fill(0) as number[];
  const marginalOther = new Array(10).fill(0) as number[];
  // Frecuencias conjuntas: joint[d][d'] = count(pos=d AND other=d')
  const joint: number[][] = Array.from({ length: 10 }, () => new Array(10).fill(0) as number[]);

  for (const d of draws) {
    const vPos   = d[pos];
    const vOther = d[otherPos];
    marginalPos[vPos]!++;
    marginalOther[vOther]!++;
    joint[vPos]![vOther]!++;
  }

  return Array.from({ length: 10 }, (_, digit) => {
    const pD = marginalPos[digit]! / total;
    if (pD === 0) return { digit, score: 0 };

    // Promedio de correlation_ratio con cada dígito d' en la otra posición
    let sumRatio = 0;
    let countPairs = 0;
    for (let dOther = 0; dOther <= 9; dOther++) {
      const pOther = marginalOther[dOther]! / total;
      if (pOther === 0) continue;
      const pJoint = joint[digit]![dOther]! / total;
      const ratio  = pJoint / (pD * pOther);   // 1.0 = independencia
      sumRatio += ratio;
      countPairs++;
    }
    const avgRatio = countPairs > 0 ? sumRatio / countPairs : 1;
    // Score positivo cuando avg_ratio > 1 (correlación por encima de independencia)
    return { digit, score: Math.max(0, avgRatio - 1) };
  }).sort((a, b) => b.score - a.score);
};

// 8. fibonacci_pisano — alineación con periodo de Pisano mod 10 = 60
// alignment_score = phase_freq / general_freq (draws en la misma fase del ciclo de 60)
const fibonacciPisano: RankFn = (draws, pos) => {
  if (draws.length === 0) return frequencyRank(draws, pos);
  const currentIndex = draws.length % 60;  // fase actual en la ventana

  const generalCount = new Array(10).fill(0) as number[];
  const phaseCount   = new Array(10).fill(0) as number[];
  let phaseTotal = 0;

  draws.forEach((d, idx) => {
    const v = d[pos];
    generalCount[v]! += 1;
    if (idx % 60 === currentIndex) {
      phaseCount[v]! += 1;
      phaseTotal++;
    }
  });

  const total = draws.length;
  return Array.from({ length: 10 }, (_, digit) => {
    const generalFreq = total > 0 ? generalCount[digit]! / total : 0;
    const phaseFreq   = phaseTotal > 0 ? phaseCount[digit]! / phaseTotal : 0;
    // alignment_score: cuánto más frecuente es el dígito en esta fase vs. su media
    const alignment   = generalFreq > 0 ? phaseFreq / generalFreq : 0;
    return { digit, score: alignment };
  }).sort((a, b) => b.score - a.score);
};

// 9. momentum_ema — EMA multi-ventana con decay exponencial
// Combina frecuencias en ventanas [3,7,14,30] ponderadas por α^k (reciente pesa más)
// Captura el "momentum" real: un dígito que aparece consistentemente en los últimos días
const momentumEma: RankFn = (draws, pos) => {
  if (draws.length < 3) return frequencyRank(draws, pos);
  const WINDOWS = [3, 7, 14, 30] as const;
  const ALPHA = 0.85;  // decay: ventana 3d tiene peso 1.0, 7d=0.85, 14d=0.72, 30d=0.61

  return Array.from({ length: 10 }, (_, digit) => {
    let score = 0;
    WINDOWS.forEach((w, k) => {
      const slice = draws.slice(-w);
      const freq = slice.length > 0
        ? slice.filter(d => d[pos] === digit).length / slice.length
        : 0;
      score += freq * Math.pow(ALPHA, k);
    });
    return { digit, score };
  }).sort((a, b) => b.score - a.score);
};

// ─── Factory para apex_adaptive con pesos dinámicos ───────────
// Crea un RankFn usando pesos cargados desde adaptive_weights en DB
// Los pesos se recalculan en cada ciclo de backtest/post-sorteo vía EMA
function createApexAdaptive(weights: AdaptiveWeights): RankFn {
  return (draws, pos) => {
    // Estrategias base con sus pesos por defecto × factor adaptativo de DB
    const strategies: [RankFn, string, number][] = [
      [frequencyRank,   'frequency_rank',    1.0],
      [momentumEma,     'momentum_ema',      0.95],
      [gapOverdueFocus, 'gap_overdue_focus', 0.9],
      [hotColdWeighted, 'hot_cold_weighted', 0.85],
      [positionBias,    'position_bias',     0.8],
      [pairCorrelation, 'pair_correlation',  0.75],
      [movingAvgSignal, 'moving_avg_signal', 0.7],
      [streakReversal,  'streak_reversal',   0.65],
      [fibonacciPisano, 'fibonacci_pisano',  0.6],
    ];

    const scores = new Array(10).fill(0) as number[];
    let totalWeight = 0;

    for (const [fn, name, baseWeight] of strategies) {
      // Factor adaptativo: si la estrategia tuvo buen historial, su peso sube
      const adaptiveFactor = weights[name] ?? 1.0;
      const effectiveWeight = baseWeight * adaptiveFactor;
      const ranked = fn(draws, pos);
      const maxS = ranked[0]?.score || 1;
      for (const { digit, score } of ranked) {
        scores[digit]! += (score / (maxS || 1)) * effectiveWeight;
      }
      totalWeight += effectiveWeight;
    }

    return scores
      .map((s, digit) => ({ digit, score: s / totalWeight }))
      .sort((a, b) => b.score - a.score);
  };
}

// 10. consensus_top — promedio ponderado de todas las estrategias (pesos fijos)
const consensusTop: RankFn = (draws, pos) => {
  const strategies: [RankFn, number][] = [
    [frequencyRank,    1.0],
    [momentumEma,      0.95],
    [gapOverdueFocus,  0.9],
    [hotColdWeighted,  0.85],
    [positionBias,     0.8],
    [pairCorrelation,  0.75],
    [movingAvgSignal,  0.7],
    [streakReversal,   0.65],
    [fibonacciPisano,  0.6],
  ];

  const scores = new Array(10).fill(0) as number[];
  let totalWeight = 0;
  for (const [fn, weight] of strategies) {
    const ranked = fn(draws, pos);
    const maxS = ranked[0]?.score || 1;
    for (const { digit, score } of ranked) {
      scores[digit]! += (score / (maxS || 1)) * weight;
    }
    totalWeight += weight;
  }
  return scores
    .map((s, digit) => ({ digit, score: s / totalWeight }))
    .sort((a, b) => b.score - a.score);
};

// Mapa de estrategias puras (sin DB)
// apex_adaptive usa pesos neutros aquí; runStrategy() lo reemplaza con pesos reales de DB
const STRATEGY_FNS: Record<StrategyName, RankFn> = {
  frequency_rank:    frequencyRank,
  hot_cold_weighted: hotColdWeighted,
  gap_overdue_focus: gapOverdueFocus,
  moving_avg_signal: movingAvgSignal,
  momentum_ema:      momentumEma,
  streak_reversal:   streakReversal,
  position_bias:     positionBias,
  pair_correlation:  pairCorrelation,
  fibonacci_pisano:  fibonacciPisano,
  consensus_top:     consensusTop,
  apex_adaptive:     createApexAdaptive({}),  // fallback con pesos neutros
};

// ─── Generador de combinaciones ───────────────────────────────
function generateCombinations(
  topP1: number[],
  topP2: number[],
  maxCombos: number
): { allSet: Set<string>; sample: string[] } {
  const allSet = new Set<string>();
  // Iterar en orden: p1[0]+p2[0], p1[0]+p2[1], ...
  for (const p1 of topP1) {
    for (const p2 of topP2) {
      for (let p3 = 0; p3 <= 9; p3++) {
        const combo = `${p1}${p2}${p3}`;
        allSet.add(combo);
        if (allSet.size >= maxCombos) break;
      }
      if (allSet.size >= maxCombos) break;
    }
    if (allSet.size >= maxCombos) break;
  }
  const sample = [...allSet].slice(0, 10);
  return { allSet, sample };
}

// ─── BacktestEngine ───────────────────────────────────────────
export class BacktestEngine {
  constructor(
    private readonly ballbotPool: Pool,
    private readonly agentPool:   Pool
  ) {}

  // ─── Fetch histórico completo ──────────────────────────────
  private async fetchHistory(
    mode: BacktestMode
  ): Promise<DrawEntry[]> {
    const periodFilter = mode === 'combined' ? null : (mode === 'midday' ? 'm' : 'e');

    const { rows } = await this.ballbotPool.query<{
      p1: string; p2: string; p3: string;
      draw_date: string;
      created_at: Date;
    }>(
      `SELECT
         split_part(numbers, ',', 1) AS p1,
         split_part(numbers, ',', 2) AS p2,
         split_part(numbers, ',', 3) AS p3,
         to_char(created_at::date, 'YYYY-MM-DD') AS draw_date,
         created_at
       FROM public.draws
       WHERE game = 'p3'
         AND ($1::text IS NULL OR period = $1)
       ORDER BY created_at ASC`,
      [periodFilter]
    );

    return rows.map(r => ({
      p1:         parseInt(r.p1, 10),
      p2:         parseInt(r.p2, 10),
      p3:         parseInt(r.p3, 10),
      draw_date:  r.draw_date,
      created_at: new Date(r.created_at),
    }));
  }

  // ─── Cargar pesos adaptativos desde DB ────────────────────
  async loadAdaptiveWeights(game_type: string, mode: string): Promise<AdaptiveWeights> {
    const { rows } = await this.agentPool.query<{ strategy: string; weight: number }>(
      `SELECT strategy, weight FROM hitdash.adaptive_weights
       WHERE game_type = $1 AND mode = $2`,
      [game_type, mode]
    );
    const weights: AdaptiveWeights = {};
    for (const row of rows) {
      weights[row.strategy] = Number(row.weight);
    }
    return weights;
  }

  // ─── Persistir/actualizar pesos adaptativos via EMA ───────
  async updateAdaptiveWeights(
    summaries: BacktestSummary[],
    game_type: string,
    mode: string
  ): Promise<void> {
    const EMA_ALPHA = 0.25;

    for (const s of summaries) {
      if (s.strategy_name === 'apex_adaptive' || s.strategy_name === 'consensus_top') continue;

      // Normalizar both_accuracy como factor relativo al random baseline (10% centena + 10% decena)
      // Un both_accuracy = 0.01 es random; 0.06 es 6× mejor
      const rawPerf = s.both_accuracy / 0.01;  // ratio sobre baseline
      const clampedPerf = Math.max(0.5, Math.min(2.0, rawPerf));  // clamped [0.5, 2.0]

      await this.agentPool.query(
        `INSERT INTO hitdash.adaptive_weights (strategy, game_type, mode, weight, sample_size)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (strategy, game_type, mode)
         DO UPDATE SET
           weight      = $4 * ${EMA_ALPHA} + hitdash.adaptive_weights.weight * ${1 - EMA_ALPHA},
           sample_size = hitdash.adaptive_weights.sample_size + $5,
           updated_at  = now()`,
        [s.strategy_name, game_type, mode, clampedPerf, s.total_evaluation_pts]
      );
    }

    logger.info({ strategies: summaries.length, game_type, mode }, 'Pesos adaptativos actualizados');
  }

  // ─── Ejecutar backtest de UNA estrategia ──────────────────
  async runStrategy(
    strategyName: StrategyName,
    config: BacktestConfig
  ): Promise<BacktestSummary> {
    const globalStart = Date.now();
    logger.info({ strategy: strategyName, mode: config.mode }, 'BacktestEngine: iniciando simulación');

    // apex_adaptive carga pesos reales de DB; el resto usa STRATEGY_FNS estático
    let rankFn: RankFn;
    if (strategyName === 'apex_adaptive') {
      const weights = await this.loadAdaptiveWeights(config.game_type, config.mode);
      rankFn = createApexAdaptive(weights);
      logger.info({ strategy: 'apex_adaptive', weights }, 'Pesos adaptativos cargados desde DB');
    } else {
      rankFn = STRATEGY_FNS[strategyName];
    }
    if (!rankFn) throw new Error(`Estrategia desconocida: ${strategyName}`);

    // 1. Fetch todos los draws de una vez
    const allDraws = await this.fetchHistory(config.mode);
    if (allDraws.length < config.min_train_draws + config.eval_step) {
      throw new Error(`Datos insuficientes: ${allDraws.length} draws, mínimo ${config.min_train_draws}`);
    }

    logger.info({ strategy: strategyName, total_draws: allDraws.length }, 'Historial cargado');

    // 2. Sliding window evaluation
    const points: EvalPoint[] = [];

    // Empezar desde min_train_draws, evaluar cada eval_step draws
    for (
      let i = config.min_train_draws;
      i < allDraws.length;
      i += config.eval_step
    ) {
      const testDraw = allDraws[i]!;
      const trainDraws = allDraws.slice(
        Math.max(0, i - config.train_window_draws),
        i
      );

      // 3. Rankear dígitos por posición usando la estrategia
      const rankedP1 = rankFn(trainDraws, 'p1');
      const rankedP2 = rankFn(trainDraws, 'p2');

      const topP1 = rankedP1.slice(0, config.top_p1_count).map(r => r.digit);
      const topP2 = rankedP2.slice(0, config.top_p2_count).map(r => r.digit);
      const centenaPlus = rankedP1[0]?.digit ?? topP1[0]!;

      // 4. Generar combinaciones (2 centena × 3 decena × 10 = 60)
      const { allSet, sample } = generateCombinations(topP1, topP2, config.max_combos);

      // 5. Evaluar contra resultado real
      const actualNumber = `${testDraw.p1}${testDraw.p2}${testDraw.p3}`;
      const hitCombination  = allSet.has(actualNumber);
      const hitCentena      = topP1.includes(testDraw.p1);
      const hitDecena       = topP2.includes(testDraw.p2);
      const hitBoth         = hitCentena && hitDecena;
      const hitCentenaPlus  = centenaPlus === testDraw.p1;

      points.push({
        draw_index:       i,
        eval_date:        testDraw.draw_date,
        top_p1:           topP1,
        top_p2:           topP2,
        centena_plus:     centenaPlus,
        combinations:     sample,
        all_combos_set:   allSet,
        actual_p1:        testDraw.p1,
        actual_p2:        testDraw.p2,
        actual_p3:        testDraw.p3,
        actual_number:    actualNumber,
        hit_combination:  hitCombination,
        hit_both:         hitBoth,
        hit_centena:      hitCentena,
        hit_decena:       hitDecena,
        hit_centena_plus: hitCentenaPlus,
      });
    }

    // 6. Agregar stats
    const total              = points.length;
    const hitsCombination    = points.filter(p => p.hit_combination).length;
    const hitsBoth           = points.filter(p => p.hit_both).length;
    const hitsCentena        = points.filter(p => p.hit_centena).length;
    const hitsDecena         = points.filter(p => p.hit_decena).length;
    const centenaPlushits    = points.filter(p => p.hit_centena_plus).length;

    const effectivenessPct   = total > 0 ? +(hitsCombination  / total).toFixed(4) : 0;
    const bothAccuracy       = total > 0 ? +(hitsBoth         / total).toFixed(4) : 0;
    const centenaAccuracy    = total > 0 ? +(hitsCentena      / total).toFixed(4) : 0;
    const decenaAccuracy     = total > 0 ? +(hitsDecena       / total).toFixed(4) : 0;
    const centenaPlusAcc     = total > 0 ? +(centenaPlushits  / total).toFixed(4) : 0;

    const runDurationMs = Date.now() - globalStart;

    logger.info({
      strategy:           strategyName,
      mode:               config.mode,
      total_pts:          total,
      hits_combination:   hitsCombination,
      hits_both:          hitsBoth,
      effectiveness_pct:  effectivenessPct,
      both_accuracy:      bothAccuracy,
      centena_plus_acc:   centenaPlusAcc,
      duration_ms:        runDurationMs,
    }, 'BacktestEngine: simulación completada');

    const summary: BacktestSummary = {
      strategy_name:         strategyName,
      game_type:             'pick3',
      mode:                  config.mode,
      config,
      total_evaluation_pts:  total,
      hits_combination:      hitsCombination,
      hits_both:             hitsBoth,
      hits_centena:          hitsCentena,
      hits_decena:           hitsDecena,
      centena_plus_hits:     centenaPlushits,
      effectiveness_pct:     effectivenessPct,
      both_accuracy:         bothAccuracy,
      centena_accuracy:      centenaAccuracy,
      decena_accuracy:       decenaAccuracy,
      centena_plus_accuracy: centenaPlusAcc,
      date_from:             allDraws[config.min_train_draws]?.draw_date ?? '',
      date_to:               allDraws[allDraws.length - 1]?.draw_date ?? '',
      run_duration_ms:       runDurationMs,
      points,
    };

    return summary;
  }

  // ─── Persistir resultados en DB ────────────────────────────
  async persistSummary(summary: BacktestSummary): Promise<string> {
    // Upsert en backtest_results
    const result = await this.agentPool.query<{ id: string }>(
      `INSERT INTO hitdash.backtest_results
         (strategy_name, game_type, mode,
          max_combos, train_window_draws, eval_step_draws,
          total_evaluation_pts,
          hits_combination, hits_both, hits_centena, hits_decena, centena_plus_hits,
          effectiveness_pct, both_accuracy, centena_accuracy, decena_accuracy,
          centena_plus_accuracy,
          date_from, date_to, run_duration_ms, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,now())
       ON CONFLICT (strategy_name, game_type, mode) DO UPDATE SET
         max_combos            = EXCLUDED.max_combos,
         train_window_draws    = EXCLUDED.train_window_draws,
         eval_step_draws       = EXCLUDED.eval_step_draws,
         total_evaluation_pts  = EXCLUDED.total_evaluation_pts,
         hits_combination      = EXCLUDED.hits_combination,
         hits_both             = EXCLUDED.hits_both,
         hits_centena          = EXCLUDED.hits_centena,
         hits_decena           = EXCLUDED.hits_decena,
         centena_plus_hits     = EXCLUDED.centena_plus_hits,
         effectiveness_pct     = EXCLUDED.effectiveness_pct,
         both_accuracy         = EXCLUDED.both_accuracy,
         centena_accuracy      = EXCLUDED.centena_accuracy,
         decena_accuracy       = EXCLUDED.decena_accuracy,
         centena_plus_accuracy = EXCLUDED.centena_plus_accuracy,
         date_from             = EXCLUDED.date_from,
         date_to               = EXCLUDED.date_to,
         run_duration_ms       = EXCLUDED.run_duration_ms,
         updated_at            = now()
       RETURNING id`,
      [
        summary.strategy_name,
        summary.game_type,
        summary.mode,
        summary.config.max_combos,
        summary.config.train_window_draws,
        summary.config.eval_step,
        summary.total_evaluation_pts,
        summary.hits_combination,
        summary.hits_both,
        summary.hits_centena,
        summary.hits_decena,
        summary.centena_plus_hits,
        summary.effectiveness_pct,
        summary.both_accuracy,
        summary.centena_accuracy,
        summary.decena_accuracy,
        summary.centena_plus_accuracy,
        summary.date_from,
        summary.date_to,
        summary.run_duration_ms,
      ]
    );

    const backtestId = result.rows[0]!.id;

    // Persistir puntos individuales solo los que tienen hits (análisis de patrones)
    // Limitar a 1000 puntos para no saturar DB
    const hitPoints = summary.points.filter(p => p.hit_both || p.hit_combination);
    const pointsToStore = hitPoints.slice(0, 500);

    for (const pt of pointsToStore) {
      await this.agentPool.query(
        `INSERT INTO hitdash.backtest_points
           (backtest_id, eval_date, draw_index,
            top_p1, top_p2, centena_plus, combinations,
            actual_p1, actual_p2, actual_p3, actual_number,
            hit_combination, hit_both, hit_centena, hit_decena, hit_centena_plus)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT DO NOTHING`,
        [
          backtestId,
          pt.eval_date,
          pt.draw_index,
          pt.top_p1,
          pt.top_p2,
          pt.centena_plus,
          pt.combinations,
          pt.actual_p1,
          pt.actual_p2,
          pt.actual_p3,
          pt.actual_number,
          pt.hit_combination,
          pt.hit_both,
          pt.hit_centena,
          pt.hit_decena,
          pt.hit_centena_plus,
        ]
      );
    }

    return backtestId;
  }

  // ─── Actualizar win_rate en strategy_registry via EMA ──────
  async updateStrategyWinRate(
    strategyName: string,
    summary: BacktestSummary
  ): Promise<void> {
    const EMA_ALPHA = 0.2;  // más reactivo en backtest que en live (0.1)

    const row = await this.agentPool.query<{ win_rate: number; total_tests: number }>(
      `SELECT win_rate, total_tests FROM hitdash.strategy_registry WHERE name = $1`,
      [strategyName]
    );
    if (row.rows.length === 0) return;

    const prev = row.rows[0]!;
    // Usar both_accuracy como win_rate del backtest (centena + decena correctas)
    const newWinRate = +(
      EMA_ALPHA * summary.both_accuracy + (1 - EMA_ALPHA) * prev.win_rate
    ).toFixed(4);

    await this.agentPool.query(
      `UPDATE hitdash.strategy_registry
       SET win_rate       = $2,
           total_tests    = total_tests + $3,
           last_evaluated = now(),
           updated_at     = now()
       WHERE name = $1`,
      [strategyName, newWinRate, summary.total_evaluation_pts]
    );

    logger.info(
      {
        strategy:     strategyName,
        prev_wr:      prev.win_rate,
        new_wr:       newWinRate,
        both_acc:     summary.both_accuracy,
        centena_plus: summary.centena_plus_accuracy,
      },
      'Strategy win_rate actualizado desde backtest'
    );
  }

  // ─── Ejecutar todas las estrategias ───────────────────────
  async runAll(
    mode: BacktestMode,
    configOverrides?: Partial<BacktestConfig>
  ): Promise<BacktestSummary[]> {
    const config: BacktestConfig = {
      game_type:          'pick3',
      mode,
      max_combos:         60,
      train_window_draws: 90,
      eval_step:          7,
      min_train_draws:    30,
      top_p1_count:       2,
      top_p2_count:       3,
      ...configOverrides,
    };

    // Estrategias base primero (sin apex_adaptive que depende de sus resultados)
    const baseStrategies: StrategyName[] = [
      'frequency_rank',
      'hot_cold_weighted',
      'gap_overdue_focus',
      'moving_avg_signal',
      'momentum_ema',
      'streak_reversal',
      'position_bias',
      'pair_correlation',
      'fibonacci_pisano',
      'consensus_top',
    ];

    const summaries: BacktestSummary[] = [];

    for (const name of baseStrategies) {
      try {
        const summary = await this.runStrategy(name, { ...config, mode });
        const backtestId = await this.persistSummary(summary);
        await this.updateStrategyWinRate(name, summary);
        logger.info(
          { strategy: name, id: backtestId, eff: summary.effectiveness_pct, both: summary.both_accuracy },
          'BacktestEngine: estrategia completada y persistida'
        );
        summaries.push(summary);
      } catch (err) {
        logger.error(
          { strategy: name, error: err instanceof Error ? err.message : String(err) },
          'BacktestEngine: estrategia fallida — continuando con la siguiente'
        );
      }
    }

    // Actualizar pesos adaptativos con los resultados de las estrategias base
    await this.updateAdaptiveWeights(summaries, config.game_type, mode);

    // Ejecutar apex_adaptive DESPUÉS para que use los pesos recién calculados
    try {
      const apexSummary = await this.runStrategy('apex_adaptive', { ...config, mode });
      const apexId = await this.persistSummary(apexSummary);
      await this.updateStrategyWinRate('apex_adaptive', apexSummary);
      logger.info(
        { strategy: 'apex_adaptive', id: apexId, eff: apexSummary.effectiveness_pct, both: apexSummary.both_accuracy },
        'BacktestEngine: apex_adaptive completado con pesos adaptativos'
      );
      summaries.push(apexSummary);
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'apex_adaptive fallido');
    }

    // Rebalance estrategias según nuevo win_rate
    await this.agentPool.query(
      `UPDATE hitdash.strategy_registry
       SET status = 'active', updated_at = now()
       WHERE status = 'testing' AND win_rate >= 0.12 AND total_tests >= 50`
    );
    await this.agentPool.query(
      `UPDATE hitdash.strategy_registry
       SET status = 'retired', updated_at = now()
       WHERE status IN ('testing','active') AND win_rate < 0.04 AND total_tests >= 50`
    );

    logger.info(
      { total: summaries.length, mode },
      'BacktestEngine: todas las estrategias completadas'
    );

    return summaries;
  }

  // ─── Obtener resumen guardado de DB ───────────────────────
  async getSummaries(mode?: BacktestMode): Promise<Record<string, unknown>[]> {
    const { rows } = await this.agentPool.query(
      `SELECT
         br.*,
         sr.description AS strategy_description,
         sr.status AS strategy_status
       FROM hitdash.backtest_results br
       LEFT JOIN hitdash.strategy_registry sr ON sr.name = br.strategy_name
       WHERE ($1::text IS NULL OR br.mode = $1)
       ORDER BY br.both_accuracy DESC, br.effectiveness_pct DESC`,
      [mode ?? null]
    );
    return rows;
  }

  // ─── Stats de un punto específico: centena_plus insights ──
  async getCentenaInsights(strategyName: string, mode: BacktestMode): Promise<{
    top_centena_digits: Array<{ digit: number; hit_rate: number; count: number }>;
    top_decena_digits:  Array<{ digit: number; hit_rate: number; count: number }>;
    best_combos:        Array<{ combo: string; appearances: number }>;
  }> {
    // Analizar puntos guardados para extraer patrones de centena/decena
    const { rows } = await this.agentPool.query<{
      top_p1: number[];
      top_p2: number[];
      actual_p1: number;
      actual_p2: number;
      hit_centena: boolean;
      hit_decena: boolean;
      actual_number: string;
    }>(
      `SELECT bp.top_p1, bp.top_p2, bp.actual_p1, bp.actual_p2,
              bp.hit_centena, bp.hit_decena, bp.actual_number
       FROM hitdash.backtest_points bp
       JOIN hitdash.backtest_results br ON br.id = bp.backtest_id
       WHERE br.strategy_name = $1 AND br.mode = $2
       LIMIT 2000`,
      [strategyName, mode]
    );

    // Acumular stats por dígito
    const centenaStats = new Map<number, { hits: number; total: number }>();
    const decenaStats  = new Map<number, { hits: number; total: number }>();
    const comboCount   = new Map<string, number>();

    for (const r of rows) {
      // Centena: contar hits del dígito recomendado
      for (const d of r.top_p1) {
        const prev = centenaStats.get(d) ?? { hits: 0, total: 0 };
        centenaStats.set(d, { hits: prev.hits + (r.actual_p1 === d ? 1 : 0), total: prev.total + 1 });
      }
      for (const d of r.top_p2) {
        const prev = decenaStats.get(d) ?? { hits: 0, total: 0 };
        decenaStats.set(d, { hits: prev.hits + (r.actual_p2 === d ? 1 : 0), total: prev.total + 1 });
      }
      comboCount.set(r.actual_number, (comboCount.get(r.actual_number) ?? 0) + 1);
    }

    const topCentena = Array.from(centenaStats.entries())
      .map(([digit, s]) => ({ digit, hit_rate: s.total > 0 ? +(s.hits / s.total).toFixed(3) : 0, count: s.total }))
      .sort((a, b) => b.hit_rate - a.hit_rate)
      .slice(0, 5);

    const topDecena = Array.from(decenaStats.entries())
      .map(([digit, s]) => ({ digit, hit_rate: s.total > 0 ? +(s.hits / s.total).toFixed(3) : 0, count: s.total }))
      .sort((a, b) => b.hit_rate - a.hit_rate)
      .slice(0, 5);

    const bestCombos = Array.from(comboCount.entries())
      .map(([combo, appearances]) => ({ combo, appearances }))
      .sort((a, b) => b.appearances - a.appearances)
      .slice(0, 10);

    return { top_centena_digits: topCentena, top_decena_digits: topDecena, best_combos: bestCombos };
  }
}
