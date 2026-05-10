// ═══════════════════════════════════════════════════════════════
// HELIX — DigitAnalyzer v1.0.0  (Pick3 específico)
//
// PROBLEMA RAÍZ: Pick3 analiza pares DU (100 opciones → baseline 15%).
// Con señal estadísticamente débil y solo 30 sorteos recientes, el
// consenso de 20 algoritmos no supera el azar.
//
// SOLUCIÓN: Analizar D (decena) y U (unidad) INDIVIDUALMENTE.
//   • 10 opciones por posición → signal 10x más concentrada
//   • Si recomendamos top-3 decenas Y top-3 unidades:
//     baseline por dígito = 30%  (vs 15% por par)
//     combinación D∧U esperada:  up to 9 pares candidatos
//   • Z-score de 10 opciones con 30 draws → mucho más estable
//
// Integración con AnomalyDetector:
//   Si hay AnomalySignal de tipo 'positional_digit_bias' para p2 o p3,
//   ese dígito recibe un bonus de +0.15 en su score final.
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { DrawType } from '../types/agent.types.js';
import type { AnomalySignal } from './AnomalyDetector.js';

const logger = pino({ name: 'DigitAnalyzer' });

// ─── Tipos ────────────────────────────────────────────────────
export interface DigitSignalResult {
  digit:          number;           // 0-9
  position:       'decena' | 'unidad';   // p2 o p3 de Pick3
  score:          number;           // score normalizado [0,1]
  confidence:     number;           // Wilson lower bound [0,1]
  freq_30d:       number;           // frecuencia observada últimos 30
  freq_90d:       number;           // frecuencia histórica últimos 90
  z_score:        number;
  gap_score:      number;           // cuánto lleva sin aparecer vs su media
  anomaly_bonus:  boolean;          // si tiene señal de anomalía activa
  anomaly_basis?: string;           // descripción de la señal aplicada
}

export interface DigitRecommendation {
  draw_type:       DrawType;
  generated_at:    Date;
  decena:          DigitSignalResult[];   // 10 dígitos para p2, ordenados score DESC
  unidad:          DigitSignalResult[];   // 10 dígitos para p3, ordenados score DESC
  top_decenas:     number[];             // top-3: [2, 7, 4]
  top_unidades:    number[];             // top-3: [8, 1, 5]
  combined_pairs:  string[];             // producto cartesiano top-3×top-3 = 9 pares
  centena_hint:    number | null;        // p1 con mayor frecuencia (informativo)
  anomaly_signals_applied: string[];     // qué señales influyeron
}

// ─── Wilson Lower Bound ───────────────────────────────────────
// Intervalo de confianza para proporciones pequeñas (menos sesgo que freq cruda)
function wilsonLower(hits: number, n: number, z: number = 1.96): number {
  if (n === 0) return 0;
  const p_hat = hits / n;
  const denom = 1 + (z * z) / n;
  const center = p_hat + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p_hat * (1 - p_hat) + (z * z) / (4 * n)) / n);
  return Math.max(0, (center - spread) / denom);
}

export class DigitAnalyzer {
  constructor(private readonly pool: Pool) {}

  // ─── Método principal ────────────────────────────────────────
  async analyzeDigits(
    draw_type:      DrawType,
    anomalySignals: AnomalySignal[] = []
  ): Promise<DigitRecommendation> {
    // Cargar sorteos Pick3 (90 para historial, 30 para reciente)
    const { rows: allRows } = await this.pool.query<{
      draw_date: string; p1: number; p2: number; p3: number;
    }>(
      `SELECT draw_date::text, p1, p2, p3
       FROM hitdash.ingested_results
       WHERE game_type = 'pick3' AND draw_type = $1
       ORDER BY draw_date DESC
       LIMIT 90`,
      [draw_type]
    );

    if (allRows.length < 15) {
      logger.warn({ draw_type, n: allRows.length }, 'DigitAnalyzer: datos insuficientes');
      return this.emptyRecommendation(draw_type);
    }

    const rows = allRows.map(r => ({
      draw_date: r.draw_date,
      p1: Number(r.p1), p2: Number(r.p2), p3: Number(r.p3),
    }));

    const recent30 = rows.slice(0, 30);
    const all90    = rows;

    // Señales de anomalía por posición/dígito (para bonus)
    const anomalyMap = this.buildAnomalyMap(anomalySignals);

    // Analizar decena (p2) y unidad (p3)
    const decenaResults = this.analyzePosition(recent30, all90, 'p2', 'decena', anomalyMap);
    const unidadResults = this.analyzePosition(recent30, all90, 'p3', 'unidad', anomalyMap);

    // Centena (p1) — informativo, no se recomienda
    const centenaHint = this.topDigit(recent30, 'p1');

    // Top-3 por posición
    const top3Dec = decenaResults.slice(0, 3).map(r => r.digit);
    const top3Uni = unidadResults.slice(0, 3).map(r => r.digit);

    // Producto cartesiano → 9 pares candidatos (formato "DU")
    const combined: string[] = [];
    for (const d of top3Dec) {
      for (const u of top3Uni) {
        combined.push(`${d}${u}`);
      }
    }

    const appliedSignals = [
      ...decenaResults.filter(r => r.anomaly_bonus).map(r => r.anomaly_basis ?? ''),
      ...unidadResults.filter(r => r.anomaly_bonus).map(r => r.anomaly_basis ?? ''),
    ].filter(Boolean);

    logger.info({
      draw_type,
      top_decenas: top3Dec,
      top_unidades: top3Uni,
      combined_pairs: combined.length,
      anomaly_signals_applied: appliedSignals.length,
    }, 'DigitAnalyzer: análisis completado');

    return {
      draw_type,
      generated_at:    new Date(),
      decena:          decenaResults,
      unidad:          unidadResults,
      top_decenas:     top3Dec,
      top_unidades:    top3Uni,
      combined_pairs:  combined,
      centena_hint:    centenaHint,
      anomaly_signals_applied: appliedSignals,
    };
  }

  // ─── Análisis de una posición (p2 o p3) ──────────────────────
  private analyzePosition(
    recent30: Array<{ p1: number; p2: number; p3: number }>,
    all90:    Array<{ p1: number; p2: number; p3: number }>,
    posKey:   'p2' | 'p3',
    label:    'decena' | 'unidad',
    anomalyMap: Map<string, AnomalySignal>
  ): DigitSignalResult[] {
    const n30 = recent30.length;
    const n90 = all90.length;

    // Contar frecuencias
    const count30: number[] = new Array(10).fill(0);
    const count90: number[] = new Array(10).fill(0);

    for (const row of recent30) count30[row[posKey]]! += 1;
    for (const row of all90)    count90[row[posKey]]! += 1;

    // Gap (sorteos desde la última aparición)
    const lastSeen: number[] = new Array(10).fill(n90); // default: nunca visto
    for (let i = 0; i < all90.length; i++) {
      const d = all90[i]![posKey];
      if (lastSeen[d] === n90) lastSeen[d] = i; // primera vez que lo vemos
    }

    // Media y std de gaps históricos por dígito
    const gapMeans: number[] = new Array(10).fill(n90 / 10);
    const gapStds:  number[] = new Array(10).fill(n90 / 10);

    for (let d = 0; d <= 9; d++) {
      const gaps: number[] = [];
      let prev: number | null = null;
      for (let i = 0; i < all90.length; i++) {
        if (all90[i]![posKey] === d) {
          if (prev !== null) gaps.push(i - prev);
          prev = i;
        }
      }
      if (gaps.length >= 3) {
        const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        const std  = Math.sqrt(gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length);
        gapMeans[d] = mean;
        gapStds[d]  = std > 0 ? std : 1;
      }
    }

    const results: DigitSignalResult[] = [];

    for (let d = 0; d <= 9; d++) {
      const freq30 = count30[d]! / n30;
      const freq90 = count90[d]! / n90;
      const expected = 1 / 10;

      // Z-score vs distribución uniforme (más conservador)
      const std_est = Math.sqrt(expected * (1 - expected) / n30);
      const z_score = std_est > 0 ? (freq30 - expected) / std_est : 0;

      // Gap score: normalizado [0,1] donde 1 = muy sobredebido
      const currentGap = lastSeen[d] ?? n90;
      const gapZ = gapStds[d]! > 0 ? (currentGap - gapMeans[d]!) / gapStds[d]! : 0;
      const gap_score = Math.max(0, Math.min(1, (gapZ + 3) / 6)); // normalizar z a [0,1]

      // Wilson lower bound sobre 30 sorteos
      const confidence = wilsonLower(count30[d]!, n30);

      // Bonus si hay señal de anomalía activa para este dígito/posición
      const anomalyKey = `positional_digit_bias|${d}|${posKey === 'p2' ? 'p2' : 'p3'}`;
      const anomalySignal = anomalyMap.get(anomalyKey);

      // Score combinado: 40% freq histórica + 30% z_score reciente + 30% gap
      const freq90_rank = freq90;
      const z_norm    = Math.max(0, Math.min(1, (z_score + 3) / 6));
      let score = 0.40 * freq90_rank * 10 + 0.30 * z_norm + 0.30 * gap_score;

      // Bonus anomalía
      if (anomalySignal && anomalySignal.direction === 'over') {
        score = Math.min(1, score + 0.15);
      }
      // Penalizar sobre-representación (si ya salió demasiado, evitar)
      if (anomalySignal && anomalySignal.direction === 'under') {
        score = Math.max(0, score - 0.10);
      }

      results.push({
        digit:         d,
        position:      label,
        score:         +score.toFixed(4),
        confidence:    +confidence.toFixed(4),
        freq_30d:      +freq30.toFixed(4),
        freq_90d:      +freq90.toFixed(4),
        z_score:       +z_score.toFixed(3),
        gap_score:     +gap_score.toFixed(3),
        anomaly_bonus: !!anomalySignal,
        anomaly_basis: anomalySignal
          ? `${anomalySignal.type} z=${anomalySignal.z_score} p=${anomalySignal.p_value}`
          : undefined,
      });
    }

    return results.sort((a, b) => b.score - a.score);
  }

  // ─── Top dígito en posición (para centena hint) ───────────────
  private topDigit(
    rows:   Array<{ p1: number; p2: number; p3: number }>,
    posKey: 'p1' | 'p2' | 'p3'
  ): number {
    const count = new Array(10).fill(0);
    for (const row of rows) count[row[posKey]]! += 1;
    return count.indexOf(Math.max(...count));
  }

  // ─── Mapa de anomalías por (type|digit|position) ──────────────
  private buildAnomalyMap(signals: AnomalySignal[]): Map<string, AnomalySignal> {
    const map = new Map<string, AnomalySignal>();
    for (const s of signals) {
      if (s.type !== 'positional_digit_bias') continue;
      if (!s.position) continue;
      const key = `${s.type}|${s.value}|${s.position}`;
      const existing = map.get(key);
      if (!existing || Math.abs(s.z_score) > Math.abs(existing.z_score)) {
        map.set(key, s);
      }
    }
    return map;
  }

  // ─── Recomendación vacía (datos insuficientes) ────────────────
  private emptyRecommendation(draw_type: DrawType): DigitRecommendation {
    const emptyDigits: DigitSignalResult[] = Array.from({ length: 10 }, (_, d) => ({
      digit: d, position: 'decena',
      score: 0.1, confidence: 0, freq_30d: 0.1, freq_90d: 0.1,
      z_score: 0, gap_score: 0.5, anomaly_bonus: false,
    }));
    return {
      draw_type, generated_at: new Date(),
      decena: emptyDigits,
      unidad: emptyDigits.map(r => ({ ...r, position: 'unidad' })),
      top_decenas:     [0, 1, 2],
      top_unidades:    [0, 1, 2],
      combined_pairs:  ['00','01','02','10','11','12','20','21','22'],
      centena_hint:    null,
      anomaly_signals_applied: [],
    };
  }
}
