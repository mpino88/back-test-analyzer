// ═══════════════════════════════════════════════════════════════
// HITDASH — StatisticalEdgeValidator v1.0.0
//
// F1 VALIDATION — Responde la pregunta fundamental:
//   "¿Tiene el sistema edge estadístico real vs azar?"
//
// METODOLOGÍA:
//   Usa algo_rank_history (generado por Genesis Bootstrap) para:
//   1. Calcular hit_rate@N per (algo, game_type, draw_type, half)
//   2. Test binomial one-sided: H0: hit_rate = N/100 (azar puro)
//   3. Wilson 95% CI para estimación conservadora del edge
//   4. ROI esperado con payout=$50, apuesta=$1
//
// BASELINE:
//   - 100 pares posibles (00-99) rankeados por cada algoritmo
//   - Baseline@N = N/100 (distribución uniforme = sin edge)
//   - hit_rate@15 baseline = 15%
//   - Break-even@N=15 con payout $50: hit_rate ≥ 30%
//
// VEREDICTOS:
//   EDGE      → Wilson lower > baseline (edge confirmado al 95%)
//   NOISE     → No supera baseline con significancia estadística
//   HARMFUL   → z < -1.96 (significativamente por debajo del azar)
//
// CHAMPION MODE IMPLICATION:
//   Con max hit_rate@15 observado de 16.82% (decade_family, pick4/midday/cd),
//   Champion Mode (threshold=30%) NUNCA puede dispararse en datos reales.
//   Los "champions" de Genesis fueron falsos positivos de muestras pequeñas.
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';

const logger = pino({ name: 'StatisticalEdgeValidator' });

// ── Constantes del modelo de negocio ──────────────────────────
const TOTAL_PAIRS    = 100;            // pares 00-99 = espacio completo
const PAYOUT         = 50;            // Florida Pick3 Front/Back Pair: $50/$1
const CI_Z           = 1.96;          // z para 95% CI (two-tailed)
const Z_SIGNIFICANT  = 1.645;         // one-sided 95% threshold

const BASELINE_N: Record<number, number> = {
  1:  1  / TOTAL_PAIRS,   // 1%
  5:  5  / TOTAL_PAIRS,   // 5%
  10: 10 / TOTAL_PAIRS,   // 10%
  15: 15 / TOTAL_PAIRS,   // 15%
};

// ── Tipos públicos ─────────────────────────────────────────────
export interface AlgoEdgePoint {
  algo_name:      string;
  game_type:      string;
  draw_type:      string;
  half:           string;
  sample_size:    number;
  // Hit rates observed (0–1)
  hr_n1:          number;
  hr_n5:          number;
  hr_n10:         number;
  hr_n15:         number;
  // Z-scores vs baseline (one-sided)
  z_n1:           number;
  z_n5:           number;
  z_n15:          number;
  // Wilson 95% CI for hr_n15
  wilson_lower:   number;
  wilson_upper:   number;
  // Practical
  roi_n1:         number;   // hr_n1 * 50/1 − 1
  roi_n5:         number;   // hr_n5 * 50/5 − 1
  roi_n15:        number;   // hr_n15 * 50/15 − 1
  // Verdicts
  has_edge_n15:   boolean;  // wilson_lower > baseline@15 (statistically confirmed)
  is_profitable:  boolean;  // best ROI ≥ 1%
  verdict:        'EDGE' | 'NOISE' | 'HARMFUL';
  verdict_note:   string;
}

export interface AlgoEdgeAggregate {
  algo_name:      string;
  total_n:        number;
  hr_n1:          number;
  hr_n5:          number;
  hr_n15:         number;
  z_n15:          number;
  p_value_n15:    number;   // P(Z ≥ z) under H0 — one-sided
  wilson_lower:   number;
  roi_n15:        number;
  has_edge:       boolean;
  verdict:        'EDGE' | 'NOISE' | 'HARMFUL';
  rank:           number;
}

export interface EdgeValidationReport {
  generated_at:        string;
  total_records:       number;
  combos_analyzed:     number;
  // Summary counts
  algos_with_edge:     number;   // wilson_lower > baseline@15
  algos_noise:         number;
  algos_harmful:       number;
  // Practical
  any_profitable:      boolean;
  best_roi_n15:        number;
  // Champion Mode implications
  champion_threshold:  number;   // 0.30
  max_observed_hr15:   number;   // highest actual hit_rate@15 seen
  champion_feasible:   boolean;  // max_observed_hr15 ≥ 0.30
  // Recommendation
  recommendation:      string;
  // Detailed results
  by_algo_combo:       AlgoEdgePoint[];
  by_algo_aggregate:   AlgoEdgeAggregate[];
}

// ── Helper: Wilson score CI (one proportion) ──────────────────
function wilsonCI(hits: number, n: number, z = CI_Z): { lower: number; upper: number } {
  if (n === 0) return { lower: 0, upper: 1 };
  const p   = hits / n;
  const z2  = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const spread = (z / denom) * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
  return {
    lower: Math.max(0, +(center - spread).toFixed(6)),
    upper: Math.min(1, +(center + spread).toFixed(6)),
  };
}

// ── Helper: z-score and one-sided p-value ────────────────────
function zScoreAndPValue(hits: number, n: number, p0: number): { z: number; p: number } {
  if (n === 0) return { z: 0, p: 0.5 };
  const observed = hits / n;
  const stdErr   = Math.sqrt(p0 * (1 - p0) / n);
  const z        = stdErr > 0 ? (observed - p0) / stdErr : 0;
  // Approximate one-sided p-value P(Z ≥ z) using error function
  const pValue   = +(0.5 * erfc(z / Math.SQRT2)).toFixed(6);
  return { z: +z.toFixed(3), p: pValue };
}

// erf and erfc approximations (Abramowitz & Stegun 7.1.26)
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const val = 1 - poly * Math.exp(-x * x);
  return x >= 0 ? val : -val;
}
function erfc(x: number): number { return 1 - erf(x); }

// ── StatisticalEdgeValidator ──────────────────────────────────
export class StatisticalEdgeValidator {
  constructor(private readonly pool: Pool) {}

  // ════════════════════════════════════════════════════════════
  // VALIDACIÓN COMPLETA — ejecutar sobre todos los datos disponibles
  // ════════════════════════════════════════════════════════════
  async validate(filters?: {
    game_type?: string;
    draw_type?: string;
    half?: string;
    algo_name?: string;
  }): Promise<EdgeValidationReport> {

    logger.info({ filters }, 'StatisticalEdgeValidator: iniciando validación');

    // ── 1. Cargar datos agregados desde algo_rank_history ────────
    const whereClauses: string[] = ["algo_name != 'fibonacci_resonance'"];
    const params: string[] = [];
    let paramIdx = 1;

    if (filters?.game_type) { whereClauses.push(`game_type = $${paramIdx++}`); params.push(filters.game_type); }
    if (filters?.draw_type) { whereClauses.push(`draw_type = $${paramIdx++}`); params.push(filters.draw_type); }
    if (filters?.half)      { whereClauses.push(`half = $${paramIdx++}`);      params.push(filters.half); }
    if (filters?.algo_name) { whereClauses.push(`algo_name = $${paramIdx++}`); params.push(filters.algo_name); }

    const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const { rows } = await this.pool.query<{
      algo_name: string; game_type: string; draw_type: string; half: string;
      n: string; h1: string; h5: string; h10: string; h15: string;
    }>(`
      SELECT
        algo_name, game_type, draw_type, half,
        COUNT(*)                                                            AS n,
        SUM(CASE WHEN rank_of_winner <= 1  THEN 1 ELSE 0 END)::text        AS h1,
        SUM(CASE WHEN rank_of_winner <= 5  THEN 1 ELSE 0 END)::text        AS h5,
        SUM(CASE WHEN rank_of_winner <= 10 THEN 1 ELSE 0 END)::text        AS h10,
        SUM(CASE WHEN rank_of_winner <= 15 THEN 1 ELSE 0 END)::text        AS h15
      FROM hitdash.algo_rank_history
      ${whereSQL}
      GROUP BY algo_name, game_type, draw_type, half
      ORDER BY algo_name, game_type, draw_type, half
    `, params);

    if (rows.length === 0) {
      return this._emptyReport();
    }

    // ── 2. Computar estadísticas por combo ─────────────────────
    const byCombo: AlgoEdgePoint[] = rows.map(r => {
      const n   = Number(r.n);
      const h1  = Number(r.h1);
      const h5  = Number(r.h5);
      const h10 = Number(r.h10);
      const h15 = Number(r.h15);

      const hr1  = n > 0 ? h1  / n : 0;
      const hr5  = n > 0 ? h5  / n : 0;
      const hr15 = n > 0 ? h15 / n : 0;

      const { z: z1  } = zScoreAndPValue(h1,  n, BASELINE_N[1]!);
      const { z: z5  } = zScoreAndPValue(h5,  n, BASELINE_N[5]!);
      const { z: z15 } = zScoreAndPValue(h15, n, BASELINE_N[15]!);

      const wilson = wilsonCI(h15, n);

      const roi1  = +(hr1  * PAYOUT / 1  - 1).toFixed(4);
      const roi5  = +(hr5  * PAYOUT / 5  - 1).toFixed(4);
      const roi15 = +(hr15 * PAYOUT / 15 - 1).toFixed(4);

      const hasEdge = wilson.lower > BASELINE_N[15]!;
      const profitable = Math.max(roi1, roi5, roi15) >= 0.01;

      let verdict: 'EDGE' | 'NOISE' | 'HARMFUL';
      let note: string;

      if (z15 < -Z_SIGNIFICANT) {
        verdict = 'HARMFUL';
        note    = `Significativamente por debajo del azar (z=${z15.toFixed(2)})`;
      } else if (hasEdge) {
        verdict = 'EDGE';
        note    = `Edge confirmado: Wilson 95% CI lower=${(wilson.lower * 100).toFixed(2)}% > baseline 15%`;
      } else {
        verdict = 'NOISE';
        note    = `Sin edge significativo vs baseline (z=${z15.toFixed(2)})`;
      }

      return {
        algo_name:     r.algo_name,
        game_type:     r.game_type,
        draw_type:     r.draw_type,
        half:          r.half,
        sample_size:   n,
        hr_n1:         +hr1.toFixed(5),
        hr_n5:         +hr5.toFixed(5),
        hr_n10:        n > 0 ? +(h10 / n).toFixed(5) : 0,
        hr_n15:        +hr15.toFixed(5),
        z_n1:          z1,
        z_n5:          z5,
        z_n15:         z15,
        wilson_lower:  wilson.lower,
        wilson_upper:  wilson.upper,
        roi_n1:        roi1,
        roi_n5:        roi5,
        roi_n15:       roi15,
        has_edge_n15:  hasEdge,
        is_profitable: profitable,
        verdict,
        verdict_note:  note,
      };
    });

    // ── 3. Agregar por algoritmo (todos los combos sumados) ────
    const aggMap = new Map<string, { n: number; h1: number; h5: number; h15: number }>();
    for (const r of rows) {
      const key = r.algo_name;
      const cur = aggMap.get(key) ?? { n: 0, h1: 0, h5: 0, h15: 0 };
      cur.n  += Number(r.n);
      cur.h1  += Number(r.h1);
      cur.h5  += Number(r.h5);
      cur.h15 += Number(r.h15);
      aggMap.set(key, cur);
    }

    const byAlgo: AlgoEdgeAggregate[] = Array.from(aggMap.entries())
      .map(([algo, d]) => {
        const hr15 = d.n > 0 ? d.h15 / d.n : 0;
        const { z, p } = zScoreAndPValue(d.h15, d.n, BASELINE_N[15]!);
        const wilson   = wilsonCI(d.h15, d.n);
        const hasEdge  = wilson.lower > BASELINE_N[15]!;
        const roi15    = +(hr15 * PAYOUT / 15 - 1).toFixed(4);

        let verdict: 'EDGE' | 'NOISE' | 'HARMFUL';
        if (z < -Z_SIGNIFICANT)  verdict = 'HARMFUL';
        else if (hasEdge)         verdict = 'EDGE';
        else                      verdict = 'NOISE';

        return {
          algo_name:    algo,
          total_n:      d.n,
          hr_n1:        d.n > 0 ? +(d.h1  / d.n).toFixed(5) : 0,
          hr_n5:        d.n > 0 ? +(d.h5  / d.n).toFixed(5) : 0,
          hr_n15:       +hr15.toFixed(5),
          z_n15:        z,
          p_value_n15:  p,
          wilson_lower: wilson.lower,
          roi_n15:      roi15,
          has_edge:     hasEdge,
          verdict,
          rank:         0, // filled below
        };
      })
      .sort((a, b) => b.z_n15 - a.z_n15);

    byAlgo.forEach((a, i) => { a.rank = i + 1; });

    // ── 4. Métricas resumen ────────────────────────────────────
    const edgeAlgos    = byAlgo.filter(a => a.verdict === 'EDGE');
    const noiseAlgos   = byAlgo.filter(a => a.verdict === 'NOISE');
    const harmfulAlgos = byAlgo.filter(a => a.verdict === 'HARMFUL');

    const maxHr15 = Math.max(...byAlgo.map(a => a.hr_n15));
    const bestRoi = Math.max(...byCombo.map(p => Math.max(p.roi_n1, p.roi_n5, p.roi_n15)));

    const championThreshold = 0.30;
    const championFeasible  = maxHr15 >= championThreshold;

    // Determinar recomendación
    let recommendation: string;
    if (edgeAlgos.length === 0) {
      recommendation = 'SISTEMA SIN EDGE: Ningún algoritmo supera el baseline con 95% de confianza. Revisar fundamentalmente los algoritmos.';
    } else if (!championFeasible) {
      recommendation = `EDGE ESTADÍSTICO CONFIRMADO (${edgeAlgos.length} algos) pero INSUFICIENTE para rentabilidad. ` +
        `Max hit_rate@15=${(maxHr15*100).toFixed(2)}% vs 30% requerido para break-even. ` +
        `Estrategia: (1) reducir N a 5 para mejor ROI, (2) desactivar algos HARMFUL, (3) Champion Mode irrelevante hasta alcanzar 30%.`;
    } else {
      recommendation = `EDGE CONFIRMADO Y RENTABLE: ${edgeAlgos.length} algos tienen edge, Champion Mode factible (${(maxHr15*100).toFixed(2)}% ≥ 30%).`;
    }

    // ── 5. Persistir resumen en DB (tabla opcional) ────────────
    try {
      await this._persistReport(byAlgo);
    } catch (err) {
      logger.warn({ err: String(err) }, 'StatisticalEdgeValidator: no se pudo persistir en DB (non-fatal)');
    }

    return {
      generated_at:       new Date().toISOString(),
      total_records:      rows.reduce((s, r) => s + Number(r.n), 0),
      combos_analyzed:    rows.length,
      algos_with_edge:    edgeAlgos.length,
      algos_noise:        noiseAlgos.length,
      algos_harmful:      harmfulAlgos.length,
      any_profitable:     bestRoi >= 0.01,
      best_roi_n15:       Math.max(...byAlgo.map(a => a.roi_n15)),
      champion_threshold: championThreshold,
      max_observed_hr15:  +maxHr15.toFixed(5),
      champion_feasible:  championFeasible,
      recommendation,
      by_algo_combo:      byCombo,
      by_algo_aggregate:  byAlgo,
    };
  }

  // ── Persistencia en algo_edge_report (si existe la tabla) ────
  private async _persistReport(byAlgo: AlgoEdgeAggregate[]): Promise<void> {
    // Tabla creada en migration 024 (opcional — si no existe, silenciamos)
    const tableExists = await this.pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'hitdash' AND table_name = 'algo_edge_report'
       ) AS exists`
    ).then(r => r.rows[0]?.exists ?? false).catch(() => false);

    if (!tableExists) return;

    for (const a of byAlgo) {
      await this.pool.query(
        `INSERT INTO hitdash.algo_edge_report
           (algo_name, total_n, hr_n15, z_n15, p_value_n15, wilson_lower, roi_n15, has_edge, verdict, computed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
         ON CONFLICT (algo_name) DO UPDATE SET
           total_n=$2, hr_n15=$3, z_n15=$4, p_value_n15=$5,
           wilson_lower=$6, roi_n15=$7, has_edge=$8, verdict=$9, computed_at=now()`,
        [a.algo_name, a.total_n, a.hr_n15, a.z_n15, a.p_value_n15,
         a.wilson_lower, a.roi_n15, a.has_edge, a.verdict]
      ).catch(() => undefined);
    }
  }

  private _emptyReport(): EdgeValidationReport {
    return {
      generated_at: new Date().toISOString(),
      total_records: 0, combos_analyzed: 0,
      algos_with_edge: 0, algos_noise: 0, algos_harmful: 0,
      any_profitable: false,
      best_roi_n15: -1,
      champion_threshold: 0.30,
      max_observed_hr15: 0,
      champion_feasible: false,
      recommendation: 'Sin datos en algo_rank_history. Ejecutar Genesis Bootstrap primero.',
      by_algo_combo: [], by_algo_aggregate: [],
    };
  }
}
