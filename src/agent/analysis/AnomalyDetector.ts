// ═══════════════════════════════════════════════════════════════
// HELIX — AnomalyDetector v1.0.0
//
// Detecta anomalías estadísticas EXPLOTABLES en la distribución
// real de sorteos. Distinto a DriftDetector (que detecta cambio
// estructural de largo plazo), AnomalyDetector busca ventanas cortas
// donde la distribución muestra desviaciones significativas que
// pueden convertirse en hipótesis de predicción.
//
// Tipos de anomalía detectados:
//   positional_digit_bias   → dígito en posición con z > 2.0
//   pair_absence_streak     → par ausente estadísticamente demasiado
//   pair_overrepresentation → par sobre-frecuente en ventana corta
//   cross_position_coupling → co-ocurrencia anómala entre posiciones
//   day_of_week_bias        → sesgo por día de semana (chi-square)
//
// Reutiliza gammaLn / regGammaLower / chiSquarePValue de DriftDetector
// (copiadas aquí como funciones puras independientes para no crear
//  dependencias de módulo circular).
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import { randomUUID } from 'node:crypto';
import type { GameType, DrawType } from '../types/agent.types.js';
import type { PairHalf } from '../types/analysis.types.js';

const logger = pino({ name: 'AnomalyDetector' });

// ─── Windows a escanear ────────────────────────────────────────
const SCAN_WINDOWS = [7, 14, 21, 30, 45] as const;
const MIN_Z_POSITIONAL  = 2.0;   // umbral z-score para dígitos posicionales
const MIN_Z_ABSENCE     = 2.5;   // umbral z-score para rachas de ausencia
const MAX_P_DOW         = 0.10;  // significancia máxima para día-de-semana
const MAX_P_PAIR_DIST   = 0.05;  // para chi-square de pares

// ─── Tipos exportados ──────────────────────────────────────────
export type AnomalyType =
  | 'positional_digit_bias'
  | 'pair_absence_streak'
  | 'pair_overrepresentation'
  | 'cross_position_coupling'
  | 'day_of_week_bias';

export interface AnomalySignal {
  id:              string;
  type:            AnomalyType;
  game_type:       GameType;
  draw_type:       DrawType;
  position?:       'p1' | 'p2' | 'p3' | 'p4';
  value:           string;      // dígito "7", par "37", DoW "MON"
  z_score:         number;
  p_value:         number;
  window:          number;
  direction:       'over' | 'under';
  confidence:      number;      // 1 - p_value (normalizado 0–1)
  detected_at:     Date;
  raw_count:       number;
  expected_count:  number;
}

export interface AnomalyReport {
  game_type:            GameType;
  draw_type:            DrawType;
  generated_at:         Date;
  signals:              AnomalySignal[];
  windows_scanned:      number[];
  total_draws_analyzed: number;
  scan_duration_ms:     number;
}

// ─── Fila de sorteo (ingested_results) ────────────────────────
interface DrawRow {
  draw_date: string;
  draw_dow:  number;  // 0=Sun..6=Sat (extraído del draw_date)
  p1: number; p2: number; p3: number; p4: number;
}

// ═══════════════════════════════════════════════════════════════
// Funciones estadísticas (independientes de DriftDetector)
// ═══════════════════════════════════════════════════════════════
function gammaLn(x: number): number {
  const p = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  let sum = 0.99999999999980993;
  for (let i = 0; i < p.length; i++) sum += p[i]! / (x + i + 1);
  const t = x + p.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(sum);
}

function regGammaLower(a: number, x: number): number {
  if (x <= 0) return 0;
  let term = 1.0 / a;
  let sum = term;
  for (let n = 1; n <= 300; n++) {
    term *= x / (a + n);
    sum += term;
    if (Math.abs(term) < 1e-12 * Math.abs(sum)) break;
  }
  return Math.exp(-x + a * Math.log(x) - gammaLn(a)) * sum;
}

function chiSquarePValue(chi2: number, df: number): number {
  if (chi2 <= 0) return 1;
  return Math.max(0, Math.min(1, 1 - regGammaLower(df / 2, chi2 / 2)));
}

/** Z-score de proporción observada vs esperada con n muestras */
function proportionZ(observed: number, total: number, expected_p: number): number {
  if (total === 0) return 0;
  const obs_p = observed / total;
  const std = Math.sqrt(expected_p * (1 - expected_p) / total);
  if (std === 0) return 0;
  return (obs_p - expected_p) / std;
}

/** P-value unilateral (dos colas) de z-score */
function zToPValue(z: number): number {
  const absZ = Math.abs(z);
  // Approximation of the normal CDF tail
  const t = 1 / (1 + 0.2316419 * absZ);
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const pTail = (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * absZ * absZ) * poly;
  return Math.min(1, 2 * pTail); // dos colas
}

// ═══════════════════════════════════════════════════════════════
// AnomalyDetector
// ═══════════════════════════════════════════════════════════════
export class AnomalyDetector {
  constructor(private readonly pool: Pool) {}

  // ─── Método principal ────────────────────────────────────────
  async detect(
    game_type: GameType,
    draw_type: DrawType,
    half:      PairHalf = 'du'
  ): Promise<AnomalyReport> {
    const t0 = Date.now();

    // Cargar sorteos (máx ventana = 60 para tener histórico suficiente vs 45)
    const draws = await this.loadDraws(game_type, draw_type, 120);
    if (draws.length < 30) {
      return {
        game_type, draw_type,
        generated_at:         new Date(),
        signals:              [],
        windows_scanned:      [],
        total_draws_analyzed: draws.length,
        scan_duration_ms:     Date.now() - t0,
      };
    }

    const rawSignals: AnomalySignal[] = [];

    for (const W of SCAN_WINDOWS) {
      const recentDraws = draws.slice(0, W);          // más recientes primero
      const allDraws    = draws;                       // historial completo

      // 1. Z-score por dígito en cada posición
      rawSignals.push(...this.detectPositionalBias(recentDraws, allDraws, game_type, draw_type, W));

      // 2. Rachas de ausencia de pares
      rawSignals.push(...this.detectAbsenceStreaks(recentDraws, allDraws, game_type, draw_type, half, W));

      // 3. Over-representación de pares (comprobación rápida)
      rawSignals.push(...this.detectPairOverRep(recentDraws, allDraws, game_type, draw_type, half, W));

      // 4. Co-ocurrencia cross-posición
      if (game_type === 'pick4' && W >= 21) {
        rawSignals.push(...this.detectCrossPositionCoupling(recentDraws, allDraws, game_type, draw_type, W));
      }
    }

    // 5. Sesgo por día de semana (usa todos los datos, no ventana)
    rawSignals.push(...this.detectDayOfWeekBias(draws, game_type, draw_type, half));

    // Deduplicar: mismo (type, value, position) → conservar la de mayor |z_score|
    const deduped = this.deduplicateSignals(rawSignals);

    logger.info({
      game_type, draw_type,
      signals:  deduped.length,
      duration: Date.now() - t0,
    }, 'AnomalyDetector: escaneo completado');

    return {
      game_type, draw_type,
      generated_at:         new Date(),
      signals:              deduped.sort((a, b) => b.confidence - a.confidence),
      windows_scanned:      [...SCAN_WINDOWS],
      total_draws_analyzed: draws.length,
      scan_duration_ms:     Date.now() - t0,
    };
  }

  // ─── Detección 1: Z-score posicional ─────────────────────────
  private detectPositionalBias(
    recent:   DrawRow[],
    all:      DrawRow[],
    game_type: GameType,
    draw_type: DrawType,
    window:   number
  ): AnomalySignal[] {
    const positions = game_type === 'pick3'
      ? (['p1','p2','p3'] as const)
      : (['p1','p2','p3','p4'] as const);
    const signals: AnomalySignal[] = [];
    const expected_p = 1 / 10; // distribución uniforme 0-9

    for (const pos of positions) {
      // Frecuencia histórica por dígito (baseline)
      const histCount: Record<number, number> = {};
      for (const row of all) {
        const d = row[pos]; histCount[d] = (histCount[d] ?? 0) + 1;
      }
      const histTotal = all.length;

      // Frecuencia reciente
      const recCount: Record<number, number> = {};
      for (const row of recent) {
        const d = row[pos]; recCount[d] = (recCount[d] ?? 0) + 1;
      }

      for (let d = 0; d <= 9; d++) {
        const obs = recCount[d] ?? 0;
        // Usar baseline histórico real en vez de uniforme si disponible
        const hist_p = histTotal > 0 ? (histCount[d] ?? 0) / histTotal : expected_p;
        const z = proportionZ(obs, window, hist_p);
        if (Math.abs(z) < MIN_Z_POSITIONAL) continue;

        const p = zToPValue(z);
        signals.push({
          id:             randomUUID(),
          type:           'positional_digit_bias',
          game_type, draw_type,
          position:       pos,
          value:          String(d),
          z_score:        +z.toFixed(3),
          p_value:        +p.toFixed(4),
          window,
          direction:      z > 0 ? 'over' : 'under',
          confidence:     +(1 - p).toFixed(4),
          detected_at:    new Date(),
          raw_count:      obs,
          expected_count: +(hist_p * window).toFixed(2),
        });
      }
    }
    return signals;
  }

  // ─── Detección 2: Rachas de ausencia de pares ────────────────
  private detectAbsenceStreaks(
    recent:    DrawRow[],
    all:       DrawRow[],
    game_type: GameType,
    draw_type: DrawType,
    half:      PairHalf,
    window:    number
  ): AnomalySignal[] {
    if (all.length < 30) return [];
    const extractPair = this.getPairExtractor(half);
    const signals: AnomalySignal[] = [];

    // Calcular gaps históricos por par
    const lastSeen: Record<string, number> = {};   // índice del último sorteo (0=más reciente)
    const gaps:     Record<string, number[]> = {};

    // all está ordenado reciente→antiguo
    for (let i = 0; i < all.length; i++) {
      const p = extractPair(all[i]!);
      if (lastSeen[p] !== undefined) {
        const gap = i - lastSeen[p]!;
        if (!gaps[p]) gaps[p] = [];
        gaps[p]!.push(gap);
      }
      lastSeen[p] = i;
    }

    // Para cada par que aparece en el rango histórico, calcular z de ausencia actual
    for (let x = 0; x <= 9; x++) {
      for (let y = 0; y <= 9; y++) {
        const pair = `${x}${y}`;
        const pairGaps = gaps[pair];
        if (!pairGaps || pairGaps.length < 5) continue;

        const mean = pairGaps.reduce((a, b) => a + b, 0) / pairGaps.length;
        const variance = pairGaps.reduce((s, g) => s + (g - mean) ** 2, 0) / pairGaps.length;
        const std = Math.sqrt(variance);
        if (std === 0) continue;

        // ¿Cuánto tiempo lleva sin aparecer?
        const currentGap = lastSeen[pair] !== undefined ? lastSeen[pair]! : all.length;
        const z = (currentGap - mean) / std;

        if (Math.abs(z) < MIN_Z_ABSENCE) continue;

        const p = zToPValue(z);
        signals.push({
          id:             randomUUID(),
          type:           z > 0 ? 'pair_absence_streak' : 'pair_overrepresentation',
          game_type, draw_type,
          value:          pair,
          z_score:        +z.toFixed(3),
          p_value:        +p.toFixed(4),
          window,
          direction:      z > 0 ? 'under' : 'over',
          confidence:     +(1 - p).toFixed(4),
          detected_at:    new Date(),
          raw_count:      currentGap,
          expected_count: +mean.toFixed(1),
        });
      }
    }
    return signals;
  }

  // ─── Detección 3: Over-representación de pares ───────────────
  private detectPairOverRep(
    recent:    DrawRow[],
    all:       DrawRow[],
    game_type: GameType,
    draw_type: DrawType,
    half:      PairHalf,
    window:    number
  ): AnomalySignal[] {
    if (recent.length < 7) return [];
    const extractPair = this.getPairExtractor(half);
    const signals: AnomalySignal[] = [];
    const expected_p = 1 / 100;

    // Contar en reciente y en historial
    const recCount: Record<string, number> = {};
    const allCount: Record<string, number> = {};
    for (const row of recent) { const p = extractPair(row); recCount[p] = (recCount[p] ?? 0) + 1; }
    for (const row of all)    { const p = extractPair(row); allCount[p] = (allCount[p] ?? 0) + 1; }

    for (const [pair, cnt] of Object.entries(recCount)) {
      if (cnt < 2) continue;  // mínimo 2 apariciones para señal
      const hist_p = allCount[pair] ? allCount[pair]! / all.length : expected_p;
      const z = proportionZ(cnt, window, hist_p);
      if (z < 2.0) continue;

      const p = zToPValue(z);
      signals.push({
        id:             randomUUID(),
        type:           'pair_overrepresentation',
        game_type, draw_type,
        value:          pair,
        z_score:        +z.toFixed(3),
        p_value:        +p.toFixed(4),
        window,
        direction:      'over',
        confidence:     +(1 - p).toFixed(4),
        detected_at:    new Date(),
        raw_count:      cnt,
        expected_count: +(hist_p * window).toFixed(2),
      });
    }
    return signals;
  }

  // ─── Detección 4: Co-ocurrencia cross-posición (Pick4) ───────
  private detectCrossPositionCoupling(
    recent:    DrawRow[],
    all:       DrawRow[],
    game_type: GameType,
    draw_type: DrawType,
    window:    number
  ): AnomalySignal[] {
    // Detecta si p1 y p3 (o p2 y p4) tienen co-ocurrencia anómala
    const signals: AnomalySignal[] = [];
    // Pares de posiciones a examinar: (p1,p3) y (p2,p4)
    const pairs = [['p1','p3'], ['p2','p4']] as const;

    for (const [posA, posB] of pairs) {
      // Contar co-ocurrencias en reciente
      const coCounts: Record<string, number> = {};
      for (const row of recent) {
        const key = `${row[posA]}-${row[posB]}`;
        coCounts[key] = (coCounts[key] ?? 0) + 1;
      }
      // Baseline esperado en historial
      const histCoCounts: Record<string, number> = {};
      for (const row of all) {
        const key = `${row[posA]}-${row[posB]}`;
        histCoCounts[key] = (histCoCounts[key] ?? 0) + 1;
      }

      for (const [combo, cnt] of Object.entries(coCounts)) {
        if (cnt < 2) continue;
        const hist_p = histCoCounts[combo] ? histCoCounts[combo]! / all.length : 1/100;
        const z = proportionZ(cnt, window, hist_p);
        if (z < 2.5) continue;

        const p = zToPValue(z);
        signals.push({
          id:             randomUUID(),
          type:           'cross_position_coupling',
          game_type, draw_type,
          position:       posA,
          value:          combo,  // "3-7" significa p1=3, p3=7
          z_score:        +z.toFixed(3),
          p_value:        +p.toFixed(4),
          window,
          direction:      'over',
          confidence:     +(1 - p).toFixed(4),
          detected_at:    new Date(),
          raw_count:      cnt,
          expected_count: +(hist_p * window).toFixed(2),
        });
      }
    }
    return signals;
  }

  // ─── Detección 5: Sesgo por día de semana ────────────────────
  private detectDayOfWeekBias(
    all:       DrawRow[],
    game_type: GameType,
    draw_type: DrawType,
    half:      PairHalf
  ): AnomalySignal[] {
    if (all.length < 60) return [];
    const extractPair = this.getPairExtractor(half);
    const signals: AnomalySignal[] = [];

    // Agrupar por DoW
    const byDow: Record<number, string[]> = {};
    for (const row of all) {
      const p = extractPair(row);
      if (!byDow[row.draw_dow]) byDow[row.draw_dow] = [];
      byDow[row.draw_dow]!.push(p);
    }

    // Para cada DoW con >= 20 sorteos, chi-square de distribución de pares
    for (const [dowStr, dowDraws] of Object.entries(byDow)) {
      if (dowDraws.length < 20) continue;

      const pairCounts: Record<string, number> = {};
      for (const p of dowDraws) pairCounts[p] = (pairCounts[p] ?? 0) + 1;

      // Chi-square: observado vs uniforme 1/100
      const expected = dowDraws.length / 100;
      let chi2 = 0;
      for (let x = 0; x <= 9; x++) {
        for (let y = 0; y <= 9; y++) {
          const obs = pairCounts[`${x}${y}`] ?? 0;
          chi2 += ((obs - expected) ** 2) / expected;
        }
      }
      const p_value = chiSquarePValue(chi2, 99);
      if (p_value >= MAX_P_DOW) continue;

      // Encontrar el par más sobre-representado ese día
      const topPair = Object.entries(pairCounts)
        .sort((a, b) => b[1] - a[1])[0];
      if (!topPair) continue;

      const z = proportionZ(topPair[1], dowDraws.length, 1/100);
      const dow = Number(dowStr);
      const dowNames = ['SUN','MON','TUE','WED','THU','FRI','SAT'];

      signals.push({
        id:             randomUUID(),
        type:           'day_of_week_bias',
        game_type, draw_type,
        value:          `${dowNames[dow] ?? dow}:${topPair[0]}`,
        z_score:        +z.toFixed(3),
        p_value:        +p_value.toFixed(4),
        window:         dowDraws.length,
        direction:      'over',
        confidence:     +(1 - p_value).toFixed(4),
        detected_at:    new Date(),
        raw_count:      topPair[1],
        expected_count: +expected.toFixed(2),
      });
    }
    return signals;
  }

  // ─── Deduplicación ────────────────────────────────────────────
  private deduplicateSignals(signals: AnomalySignal[]): AnomalySignal[] {
    // Agrupar por (type, value, position) → conservar la de mayor |z_score|
    const map = new Map<string, AnomalySignal>();
    for (const s of signals) {
      const key = `${s.type}|${s.value}|${s.position ?? ''}`;
      const existing = map.get(key);
      if (!existing || Math.abs(s.z_score) > Math.abs(existing.z_score)) {
        map.set(key, s);
      }
    }
    // Solo retornar señales con confianza >= 80% (p < 0.20) para reducir ruido
    return [...map.values()].filter(s => s.confidence >= 0.80);
  }

  // ─── Carga de sorteos ─────────────────────────────────────────
  private async loadDraws(
    game_type: GameType,
    draw_type: DrawType,
    limit:     number
  ): Promise<DrawRow[]> {
    const { rows } = await this.pool.query<{
      draw_date: string;
      p1: number; p2: number; p3: number; p4: number;
    }>(
      `SELECT draw_date::text, p1, p2, p3, p4
       FROM hitdash.ingested_results
       WHERE game_type = $1 AND draw_type = $2
       ORDER BY draw_date DESC
       LIMIT $3`,
      [game_type, draw_type, limit]
    );
    return rows.map(r => ({
      ...r,
      // Día de semana UTC (0=Dom, 6=Sáb)
      draw_dow: new Date(r.draw_date).getUTCDay(),
      p1: Number(r.p1), p2: Number(r.p2),
      p3: Number(r.p3), p4: Number(r.p4),
    }));
  }

  // ─── Extractor de par según half ─────────────────────────────
  private getPairExtractor(half: PairHalf): (row: DrawRow) => string {
    if (half === 'ab') return r => `${r.p1}${r.p2}`;
    if (half === 'cd') return r => `${r.p3}${r.p4}`;
    return r => `${r.p2}${r.p3}`; // 'du'
  }
}
