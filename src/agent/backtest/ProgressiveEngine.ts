// ═══════════════════════════════════════════════════════════════
// HITDASH — ProgressiveEngine
// Motor de análisis progresivo portado desde Ballbot power-ball.
// Sin dependencias de grammy/Telegram. Lee draws desde Ballbot DB.
//
// Reproduce exactamente la lógica de progressive.ts:
//   · Racha pre-acierto (Welford online)
//   · Intervalo medio ± σ con histograma de 10 buckets
//   · Tendencia reciente (ventana 50 sorteos)
//   · Transición H→H / M→H
//   · Best DOW / Best Month
//   · currentMisses vs avgPreMiss+σ → señal "¿Jugar hoy?"
//
// Estrategias implementadas internamente (sin import de Ballbot):
//   1. freq_analysis   — frecuencia absoluta de pares 00-99
//   2. gap_due         — factor de deuda (brecha actual / brecha promedio)
//   3. streak_analysis — números en racha de ausencia > media + σ
//   4. trend_momentum  — EMA multi-ventana [7,14,30] con decay 0.85
//   5. hot_cold        — z-score 7d vs 90d
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';

const logger = pino({ name: 'ProgressiveEngine' });

// ── Tipos portados de Ballbot ──────────────────────────────────
export type MapSource = 'p3' | 'p4';
export type Period    = 'm' | 'e';
export type DateDrawsMap = Record<string, { m?: number[]; e?: number[] }>;

export interface ProgressiveContext {
  mapSource: MapSource;
  period:    Period;
  topN?:     number;
}

export interface SubsetConditions {
  bestDows:       Array<{ label: string; hitRate: number }>;
  bestMonths:     Array<{ label: string; hitRate: number }>;
  avgInterval:    number;
  stdInterval:    number;
  peakBand:       string;
  p25:            number;
  p75:            number;
  avgPreMiss:     number;
  stdPreMiss:     number;
  maxPreMiss:     number;
  currentMisses:  number;
  hitAfterHit:    number;
  hitAfterMiss:   number;
  recentHitRate:  number;
  recentDelta:    number;
  trend:          'up' | 'down' | 'stable';
  // ── Señal de acción (nueva — no está en Ballbot) ──────────────
  playSignal:     'PLAY' | 'WAIT' | 'ALERT';
  playReason:     string;
}

export interface ProgressiveSubset {
  strategyId:  string;
  label:       string;
  hits:        number;
  misses:      number;
  skipped:     number;
  hitRate:     number;
  conditions:  SubsetConditions;
}

export interface ProgressiveResult {
  topSubsets:     ProgressiveSubset[];
  context:        ProgressiveContext;
  startDate:      string;
  endDate:        string;
  datesAnalyzed:  number;
  totalInRange:   number;
  topN:           number;
  strategyCount:  number;
  generatedAt:    string;
}

// ── Constantes ─────────────────────────────────────────────────
const DOW_LABELS   = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'] as const;
const MONTH_LABELS = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'] as const;
const INTERVAL_BUCKETS = 10;
const BUCKET_WIDTH     = 5;
const BUCKET_LABELS    = ['1-5','6-10','11-15','16-20','21-25','26-30','31-35','36-40','41-45','46+'] as const;
const BUCKET_MIDPOINTS = [3, 8, 13, 18, 23, 28, 33, 38, 43, 48];
const RECENT_WINDOW    = 50;
const MAX_DATES        = 2500;

function intervalBucket(interval: number): number {
  return Math.min(Math.floor((interval - 1) / BUCKET_WIDTH), INTERVAL_BUCKETS - 1);
}

// ── Extracción de pares (igual que twoDigitNumbers de Ballbot) ─
function twoDigitNumbers(draw: number[], mapSource: MapSource): number[] {
  if (mapSource === 'p3') {
    if (draw.length < 3) return [];
    return [draw[1]! * 10 + draw[2]!];
  } else {
    if (draw.length < 4) return [];
    return [draw[0]! * 10 + draw[1]!, draw[2]! * 10 + draw[3]!];
  }
}

// ── Fecha MM/DD/YY → Date ──────────────────────────────────────
function mmddyyToDate(key: string): Date | null {
  const m = key.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (!m) return null;
  let yy = parseInt(m[3]!, 10);
  yy = yy >= 50 ? 1900 + yy : 2000 + yy;
  const d = new Date(yy, parseInt(m[1]!, 10) - 1, parseInt(m[2]!, 10));
  return isNaN(d.getTime()) ? null : d;
}

// ── Ordenar fechas cronológicamente ────────────────────────────
function sortedDateKeys(map: DateDrawsMap, period: Period, mapSource: MapSource): string[] {
  const minLen = mapSource === 'p4' ? 4 : 3;
  return Object.keys(map)
    .filter(k => {
      const draw = map[k]?.[period];
      return draw != null && draw.length >= minLen;
    })
    .map(k => ({ k, t: mmddyyToDate(k)?.getTime() ?? 0 }))
    .sort((a, b) => a.t - b.t)
    .map(x => x.k);
}

// ═══════════════════════════════════════════════════════════════
// ESTRATEGIAS INTERNAS (getCandidates puro — no usan DB)
// ═══════════════════════════════════════════════════════════════

type CandFn = (ctx: ProgressiveContext, map: DateDrawsMap, topN: number) => number[];

// 1. Frecuencia absoluta
const freqAnalysis: CandFn = (ctx, map, topN) => {
  const dates = sortedDateKeys(map, ctx.period, ctx.mapSource);
  const counts = new Array<number>(100).fill(0);
  for (const d of dates) {
    for (const n of twoDigitNumbers(map[d]![ctx.period]!, ctx.mapSource)) {
      if (n >= 0 && n < 100) counts[n]!++;
    }
  }
  return counts
    .map((c, i) => ({ n: i, c }))
    .sort((a, b) => b.c - a.c)
    .slice(0, topN)
    .map(x => x.n);
};

// 2. Gap Due (números debidos)
const gapDue: CandFn = (ctx, map, topN) => {
  const dates = sortedDateKeys(map, ctx.period, ctx.mapSource);
  const lastSeen  = new Array<number>(100).fill(-1);   // índice de última aparición
  const gapSums   = new Array<number>(100).fill(0);
  const gapCounts = new Array<number>(100).fill(0);

  for (let i = 0; i < dates.length; i++) {
    for (const n of twoDigitNumbers(map[dates[i]!]![ctx.period]!, ctx.mapSource)) {
      if (n < 0 || n >= 100) continue;
      if (lastSeen[n]! >= 0) {
        gapSums[n]! += i - lastSeen[n]!;
        gapCounts[n]!++;
      }
      lastSeen[n] = i;
    }
  }

  const last = dates.length - 1;
  const stats = Array.from({ length: 100 }, (_, n) => {
    const avgGap = gapCounts[n]! > 0 ? gapSums[n]! / gapCounts[n]! : 999;
    const curGap = lastSeen[n]! >= 0 ? last - lastSeen[n]! : last;
    return { n, due: curGap / Math.max(avgGap, 1) };
  });

  return stats.sort((a, b) => b.due - a.due).slice(0, topN).map(x => x.n);
};

// 3. Streak Reversal (ausencias > media + σ)
const streakReversal: CandFn = (ctx, map, topN) => {
  const dates = sortedDateKeys(map, ctx.period, ctx.mapSource);
  const lastSeen = new Array<number>(100).fill(-1);
  const gaps: number[][] = Array.from({ length: 100 }, () => []);

  for (let i = 0; i < dates.length; i++) {
    for (const n of twoDigitNumbers(map[dates[i]!]![ctx.period]!, ctx.mapSource)) {
      if (n < 0 || n >= 100) continue;
      if (lastSeen[n]! >= 0) gaps[n]!.push(i - lastSeen[n]!);
      lastSeen[n] = i;
    }
  }

  const last = dates.length - 1;
  const stats = Array.from({ length: 100 }, (_, n) => {
    const g = gaps[n]!;
    const mean = g.length > 0 ? g.reduce((a, b) => a + b, 0) / g.length : 0;
    const std  = g.length > 1
      ? Math.sqrt(g.reduce((a, b) => a + (b - mean) ** 2, 0) / g.length)
      : 0;
    const cur  = lastSeen[n]! >= 0 ? last - lastSeen[n]! : last;
    const score = (mean + std) > 0 ? cur / (mean + std) : 0;
    return { n, score };
  });

  return stats.sort((a, b) => b.score - a.score).slice(0, topN).map(x => x.n);
};

// 4. Momentum EMA multi-ventana [7,14,30] α=0.85
const momentumEma: CandFn = (ctx, map, topN) => {
  const dates  = sortedDateKeys(map, ctx.period, ctx.mapSource);
  const ALPHA  = 0.85;
  const WINS   = [7, 14, 30];
  const scores = new Array<number>(100).fill(0);

  for (const n of Array.from({ length: 100 }, (_, i) => i)) {
    for (const win of WINS) {
      const slice = dates.slice(-win);
      let ema = 0;
      for (let i = 0; i < slice.length; i++) {
        const present = twoDigitNumbers(map[slice[i]!]![ctx.period]!, ctx.mapSource).includes(n) ? 1 : 0;
        ema = i === 0 ? present : ALPHA * ema + (1 - ALPHA) * present;
      }
      scores[n]! += ema;
    }
  }
  return scores
    .map((s, i) => ({ n: i, s }))
    .sort((a, b) => b.s - a.s)
    .slice(0, topN)
    .map(x => x.n);
};

// 5. Hot/Cold z-score 7d vs 90d
const hotCold: CandFn = (ctx, map, topN) => {
  const dates   = sortedDateKeys(map, ctx.period, ctx.mapSource);
  const full    = dates;
  const recent  = dates.slice(-7);
  const period90 = dates.slice(-90);

  const count = (subset: string[], n: number) =>
    subset.filter(d => twoDigitNumbers(map[d]![ctx.period]!, ctx.mapSource).includes(n)).length;

  const stats = Array.from({ length: 100 }, (_, n) => {
    const f90   = period90.length > 0 ? count(period90, n) / period90.length : 0;
    const f7    = recent.length   > 0 ? count(recent,   n) / recent.length   : 0;
    const mean  = full.length > 0 ? count(full, n) / full.length : 0.01;
    const std   = Math.sqrt(mean * (1 - mean) / Math.max(full.length, 1));
    const z     = std > 0 ? (f7 - f90) / std : 0;
    return { n, z };
  });

  return stats.sort((a, b) => b.z - a.z).slice(0, topN).map(x => x.n);
};

// Registro de estrategias
const STRATEGIES: Array<{ id: string; label: string; fn: CandFn }> = [
  { id: 'freq_analysis',  label: 'Frecuencia Absoluta', fn: freqAnalysis  },
  { id: 'gap_due',        label: 'Números Debidos',     fn: gapDue        },
  { id: 'streak_reversal',label: 'Streak Reversal',     fn: streakReversal },
  { id: 'momentum_ema',   label: 'Momentum EMA',        fn: momentumEma   },
  { id: 'hot_cold',       label: 'Hot/Cold Z-Score',    fn: hotCold       },
];

// ═══════════════════════════════════════════════════════════════
// PLAY SIGNAL — decide PLAY / WAIT / ALERT
// Combina currentMisses, avgPreMiss, peakBand, trend, kelly
// ═══════════════════════════════════════════════════════════════
function computePlaySignal(
  c: Omit<SubsetConditions, 'playSignal' | 'playReason'>,
  hitRate: number,
  kellyFraction?: number
): { playSignal: 'PLAY' | 'WAIT' | 'ALERT'; playReason: string } {
  const threshold = c.avgPreMiss + c.stdPreMiss;

  // ALERT: racha actual supera máximo histórico
  if (c.currentMisses > c.maxPreMiss && c.maxPreMiss > 0) {
    return {
      playSignal: 'ALERT',
      playReason: `Racha actual (${c.currentMisses}) supera el máximo histórico (${c.maxPreMiss}). Anomalía estadística — revisar.`,
    };
  }

  // PLAY: racha actual ≥ avg+σ pre-acierto (zona de rebote) + trend no es "down"
  if (c.currentMisses >= threshold && c.trend !== 'down') {
    const kelly = kellyFraction != null && kellyFraction > 0
      ? ` Kelly: ${(kellyFraction * 100).toFixed(1)}% cobertura óptima.`
      : '';
    return {
      playSignal: 'PLAY',
      playReason: `Racha (${c.currentMisses}) ≥ avg+σ (${Math.round(threshold)}). Zona de rebote estadístico. Trend: ${c.trend}.${kelly}`,
    };
  }

  // PLAY: tendencia fuertemente al alza + hitAfterMiss favorable
  if (c.trend === 'up' && c.recentDelta >= 5 && c.hitAfterMiss > hitRate * 1.2) {
    return {
      playSignal: 'PLAY',
      playReason: `Tendencia +${c.recentDelta.toFixed(1)}pp y P(hit|miss)=${(c.hitAfterMiss * 100).toFixed(1)}% superior a hit rate global.`,
    };
  }

  // WAIT: racha aún baja y trend estable/bajo
  return {
    playSignal: 'WAIT',
    playReason: `Racha actual (${c.currentMisses}) < umbral (${Math.round(threshold)}). Esperar más fallos para mayor probabilidad de rebote.`,
  };
}

// ═══════════════════════════════════════════════════════════════
// PROGRESSIVE ENGINE — clase principal
// ═══════════════════════════════════════════════════════════════
export class ProgressiveEngine {
  constructor(private readonly ballbotPool: Pool) {}

  // ── Construir DateDrawsMap desde Ballbot DB ──────────────────
  async buildDateDrawsMap(
    mapSource: MapSource,
    startDate: Date,
    endDate: Date
  ): Promise<DateDrawsMap> {
    const game = mapSource === 'p3' ? 'p3' : 'p4';

    const { rows } = await this.ballbotPool.query<{
      date: string; period: string; numbers: string;
    }>(
      `SELECT
         to_char(created_at::date, 'MM/DD/YY') AS date,
         period,
         numbers
       FROM public.draws
       WHERE game = $1
         AND created_at::date BETWEEN $2 AND $3
       ORDER BY created_at ASC`,
      [game, startDate, endDate]
    );

    const map: DateDrawsMap = {};
    for (const row of rows) {
      const digits = row.numbers.split(',').map(Number);
      if (!map[row.date]) map[row.date] = {};
      const p = row.period as 'm' | 'e';
      if (p === 'm' || p === 'e') map[row.date]![p] = digits;
    }

    return map;
  }

  // ── Motor principal ──────────────────────────────────────────
  async run(params: {
    startDate:   Date;
    endDate:     Date;
    mapSource:   MapSource;
    period:      Period;
    topN?:       number;
    strategyIds?: string[];      // subset de estrategias; omitir = todas
    kellyMap?:   Record<string, number>;  // kelly_fraction por estrategia (de v2)
    onProgress?: (pct: number) => void;
  }): Promise<ProgressiveResult> {
    const {
      startDate, endDate, mapSource, period,
      topN = 10,
      strategyIds,
      kellyMap = {},
      onProgress,
    } = params;

    const ctx: ProgressiveContext = { mapSource, period, topN };

    logger.info({ mapSource, period, topN }, 'ProgressiveEngine: construyendo mapa de sorteos');

    // Load full history (antes de startDate) para que las estrategias tengan contexto
    const fullStart = new Date('2000-01-01');
    const fullMap   = await this.buildDateDrawsMap(mapSource, fullStart, endDate);

    const allDates = Object.keys(fullMap)
      .map(k => ({ k, t: mmddyyToDate(k)?.getTime() ?? 0 }))
      .sort((a, b) => a.t - b.t)
      .map(x => x.k);

    const startT = startDate.getTime();
    const endT   = endDate.getTime();

    const validDates = allDates.filter(k => {
      const draw = fullMap[k]?.[period];
      return draw != null && draw.length >= (mapSource === 'p4' ? 4 : 3);
    });

    const datesInRange = validDates.filter(k => {
      const t = mmddyyToDate(k)?.getTime() ?? 0;
      return t >= startT && t <= endT;
    });

    const cutoffDates = datesInRange.slice(0, MAX_DATES);
    const totalDates  = cutoffDates.length;
    const totalInRange = datesInRange.length;

    const validIdx = new Map(validDates.map((d, i) => [d, i]));

    // Seleccionar estrategias
    const activeStrats = strategyIds?.length
      ? STRATEGIES.filter(s => strategyIds.includes(s.id))
      : STRATEGIES;

    const n = activeStrats.length;
    logger.info({ n, totalDates }, 'ProgressiveEngine: iniciando loop');

    // Typed arrays por estrategia
    const hitsArr        = new Uint32Array(n);
    const missesArr      = new Uint32Array(n);
    const skippedArr     = new Uint32Array(n);
    const hitsByDow      = new Uint16Array(n * 7);
    const totByDow       = new Uint16Array(n * 7);
    const hitsByMonth    = new Uint16Array(n * 12);
    const totByMonth     = new Uint16Array(n * 12);
    const lastHitIdx     = new Int32Array(n).fill(-1);
    const intervalCnt    = new Uint16Array(n);
    const intervalMean   = new Float64Array(n);
    const intervalM2     = new Float64Array(n);
    const intervalBkts   = new Uint16Array(n * INTERVAL_BUCKETS);
    const currentMissArr = new Uint16Array(n);
    const maxMissArr     = new Uint16Array(n);
    const preMissCnt     = new Uint16Array(n);
    const preMissMean    = new Float64Array(n);
    const preMissM2      = new Float64Array(n);
    const prevState      = new Uint8Array(n);
    const hitsAfterHit   = new Uint16Array(n);
    const totAfterHit    = new Uint16Array(n);
    const hitsAfterMiss  = new Uint16Array(n);
    const totAfterMiss   = new Uint16Array(n);
    const recentHits     = new Uint16Array(n);
    const recentTotal    = new Uint16Array(n);
    const recentStart    = Math.max(0, totalDates - RECENT_WINDOW);

    // Acumular historia para estrategias (mapa incremental)
    const incrementalMap: DateDrawsMap = {};
    let mapPtr = 0;
    // Pre-cargar todo lo anterior a startDate
    while (mapPtr < allDates.length) {
      const t = mmddyyToDate(allDates[mapPtr]!)?.getTime() ?? 0;
      if (t >= startT) break;
      incrementalMap[allDates[mapPtr]!] = fullMap[allDates[mapPtr]!]!;
      mapPtr++;
    }

    // ── Loop principal ───────────────────────────────────────────
    for (let dateIdx = 0; dateIdx < cutoffDates.length; dateIdx++) {
      const cutoffDate = cutoffDates[dateIdx]!;
      const cutoffT    = mmddyyToDate(cutoffDate)?.getTime() ?? 0;
      const isRecent   = dateIdx >= recentStart;

      // Avanzar mapa incremental
      while (mapPtr < allDates.length) {
        const t = mmddyyToDate(allDates[mapPtr]!)?.getTime() ?? 0;
        if (t > cutoffT) break;
        incrementalMap[allDates[mapPtr]!] = fullMap[allDates[mapPtr]!]!;
        mapPtr++;
      }

      // Sorteo siguiente real
      const nextDateStr = validDates[validIdx.get(cutoffDate)! + 1];
      if (!nextDateStr) { for (let i = 0; i < n; i++) skippedArr[i]!++; continue; }

      const nextDraw = fullMap[nextDateStr]?.[period];
      if (!nextDraw || nextDraw.length < (mapSource === 'p4' ? 4 : 3)) {
        for (let i = 0; i < n; i++) skippedArr[i]!++;
        continue;
      }

      const actuals = new Set(twoDigitNumbers(nextDraw, mapSource));
      if (actuals.size === 0) { for (let i = 0; i < n; i++) skippedArr[i]!++; continue; }

      const nextDt    = mmddyyToDate(nextDateStr);
      const nextDow   = nextDt ? nextDt.getDay()   : -1;
      const nextMonth = nextDt ? nextDt.getMonth() : -1;

      for (let i = 0; i < n; i++) {
        const strat = activeStrats[i]!;
        let cands: number[];
        try {
          cands = strat.fn(ctx, incrementalMap, topN);
        } catch {
          skippedArr[i]!++;
          continue;
        }
        if (!cands || cands.length === 0) { skippedArr[i]!++; continue; }

        const isHit = cands.slice(0, topN).some(c => actuals.has(c));

        if (isHit) {
          hitsArr[i]!++;
          if (nextDow >= 0)   { hitsByDow[i*7+nextDow]!++;  totByDow[i*7+nextDow]!++; }
          if (nextMonth >= 0) { hitsByMonth[i*12+nextMonth]!++; totByMonth[i*12+nextMonth]!++; }

          if (lastHitIdx[i]! >= 0) {
            const interval = dateIdx - lastHitIdx[i]!;
            const cnt = ++intervalCnt[i]!;
            const delta = interval - intervalMean[i]!;
            intervalMean[i]! += delta / cnt;
            intervalM2[i]! += delta * (interval - intervalMean[i]!);
            intervalBkts[i * INTERVAL_BUCKETS + intervalBucket(interval)]!++;
          }
          lastHitIdx[i] = dateIdx;

          const streak = currentMissArr[i]!;
          const cnt2 = ++preMissCnt[i]!;
          const d2 = streak - preMissMean[i]!;
          preMissMean[i]! += d2 / cnt2;
          preMissM2[i]! += d2 * (streak - preMissMean[i]!);
          currentMissArr[i] = 0;

          const ps = prevState[i]!;
          if (ps === 1) { hitsAfterHit[i]!++; totAfterHit[i]!++; }
          else if (ps === 2) { hitsAfterMiss[i]!++; totAfterMiss[i]!++; }
          prevState[i] = 1;
          if (isRecent) { recentHits[i]!++; recentTotal[i]!++; }

        } else {
          missesArr[i]!++;
          if (nextDow >= 0)   totByDow[i*7+nextDow]!++;
          if (nextMonth >= 0) totByMonth[i*12+nextMonth]!++;
          currentMissArr[i]!++;
          if (currentMissArr[i]! > maxMissArr[i]!) maxMissArr[i] = currentMissArr[i]!;
          const ps = prevState[i]!;
          if (ps === 1) totAfterHit[i]!++;
          else if (ps === 2) totAfterMiss[i]!++;
          prevState[i] = 2;
          if (isRecent) recentTotal[i]!++;
        }
      }

      if (onProgress && dateIdx % 50 === 0) {
        onProgress(Math.round((dateIdx / totalDates) * 100));
      }
    }

    // ── Construir condiciones y subsets ──────────────────────────
    const buildConds = (i: number, hitRate: number): SubsetConditions => {
      const dowRates = Array.from({ length: 7 }, (_, d) => ({
        label: DOW_LABELS[d]!,
        hitRate: totByDow[i*7+d]! >= 3 ? hitsByDow[i*7+d]! / totByDow[i*7+d]! : -1,
      })).filter(x => x.hitRate >= 0).sort((a, b) => b.hitRate - a.hitRate).slice(0, 2);

      const monthRates = Array.from({ length: 12 }, (_, m) => ({
        label: MONTH_LABELS[m]!,
        hitRate: totByMonth[i*12+m]! >= 2 ? hitsByMonth[i*12+m]! / totByMonth[i*12+m]! : -1,
      })).filter(x => x.hitRate >= 0).sort((a, b) => b.hitRate - a.hitRate).slice(0, 2);

      const iCnt = intervalCnt[i]!;
      const avgInterval = iCnt > 0 ? Math.round(intervalMean[i]!) : 0;
      const stdInterval = iCnt >= 2 ? Math.round(Math.sqrt(intervalM2[i]! / iCnt)) : 0;

      let peakBand = '', peakCount = 0, totalIntervals = 0;
      for (let b = 0; b < INTERVAL_BUCKETS; b++) {
        const c = intervalBkts[i * INTERVAL_BUCKETS + b]!;
        totalIntervals += c;
        if (c > peakCount) { peakCount = c; peakBand = BUCKET_LABELS[b]!; }
      }
      let p25 = 0, p75 = 0;
      if (totalIntervals > 0) {
        let cumul = 0; let p25Set = false;
        for (let b = 0; b < INTERVAL_BUCKETS; b++) {
          cumul += intervalBkts[i * INTERVAL_BUCKETS + b]!;
          if (!p25Set && cumul >= totalIntervals * 0.25) { p25 = BUCKET_MIDPOINTS[b]!; p25Set = true; }
          if (cumul >= totalIntervals * 0.75) { p75 = BUCKET_MIDPOINTS[b]!; break; }
        }
      }

      const pmCnt = preMissCnt[i]!;
      const avgPreMiss    = pmCnt > 0 ? Math.round(preMissMean[i]!) : 0;
      const stdPreMiss    = pmCnt >= 2 ? Math.round(Math.sqrt(preMissM2[i]! / pmCnt)) : 0;
      const maxPreMiss    = maxMissArr[i]!;
      const currentMisses = currentMissArr[i]!;

      const tAH = totAfterHit[i]!;
      const tAM = totAfterMiss[i]!;
      const hitAfterHit  = tAH > 0 ? hitsAfterHit[i]! / tAH : -1;
      const hitAfterMiss = tAM > 0 ? hitsAfterMiss[i]! / tAM : -1;

      const rTot = recentTotal[i]!;
      const recentHitRate = rTot >= 10 ? recentHits[i]! / rTot : -1;
      const recentDelta   = recentHitRate >= 0 ? (recentHitRate - hitRate) * 100 : 0;
      const trend: 'up' | 'down' | 'stable' =
        recentHitRate < 0 ? 'stable' :
        recentDelta >= 3  ? 'up'     :
        recentDelta <= -3 ? 'down'   : 'stable';

      const base = {
        bestDows: dowRates, bestMonths: monthRates,
        avgInterval, stdInterval, peakBand, p25, p75,
        avgPreMiss, stdPreMiss, maxPreMiss, currentMisses,
        hitAfterHit, hitAfterMiss,
        recentHitRate, recentDelta, trend,
      };

      const kelly = kellyMap[activeStrats[i]!.id];
      const { playSignal, playReason } = computePlaySignal(base, hitRate, kelly);

      return { ...base, playSignal, playReason };
    };

    const subsets: ProgressiveSubset[] = activeStrats.map((s, i) => {
      const tot     = hitsArr[i]! + missesArr[i]!;
      const hitRate = tot > 0 ? hitsArr[i]! / tot : 0;
      return {
        strategyId:  s.id,
        label:       s.label,
        hits:        hitsArr[i]!,
        misses:      missesArr[i]!,
        skipped:     skippedArr[i]!,
        hitRate,
        conditions:  buildConds(i, hitRate),
      };
    }).sort((a, b) => b.hitRate - a.hitRate);

    logger.info(
      { strategies: subsets.length, datesAnalyzed: totalDates },
      'ProgressiveEngine: análisis completado'
    );

    return {
      topSubsets:    subsets,
      context:       ctx,
      startDate:     cutoffDates[0]                ?? '',
      endDate:       cutoffDates[cutoffDates.length - 1] ?? '',
      datesAnalyzed: totalDates,
      totalInRange,
      topN,
      strategyCount: n,
      generatedAt:   new Date().toISOString(),
    };
  }
}
