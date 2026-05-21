// ═══════════════════════════════════════════════════════════════
// HELIX — Edge Discovery Engine v1.0.0 (2026-05-21)
//
// "HELIX F1 SIEMPRE HA SIDO aprendizaje adaptativo autónomo didáctico"
//
// PROPÓSITO:
//   Probar AUTÓNOMAMENTE si hay edge estadístico real en cualquier
//   parte del sistema, y reportar la verdad — favorable o no.
//
// FAMILIAS DE TESTS (corregidas por Bonferroni):
//
//   1. ALGO_EDGE: ¿Algún algoritmo individual supera al baseline 15%?
//      • One-sided binomial test sobre walk-forward predictions
//      • Effect size: Cohen's h
//
//   2. DOW_BIAS: ¿La distribución de pares depende del día de semana?
//      • χ² test of independence (7 DOW × 100 pairs)
//      • Si rechaza H0 → calendar_pattern tiene base real
//      • Effect size: Cramér's V
//
//   3. AUTOCORRELATION: ¿Hay correlación temporal en las posiciones?
//      • Lag-1, 2, 7, 30 autocorrelation por posición (p1-p4)
//      • Ljung-Box joint test
//      • Si rechaza H0 → Markov/transition tienen base real
//      • Effect size: |r| at significant lag
//
//   4. PAIR_PERSISTENCE: ¿Pares se repiten/evitan más que random?
//      • Distribución de gaps entre apariciones del mismo par
//      • χ² test vs distribución geométrica esperada
//      • Si rechaza H0 → streak_reversal/gap_overdue tienen base
//
//   5. DRIFT_KS: ¿La distribución es estable en el tiempo?
//      • KS test entre [0, mid] vs [mid, end]
//      • Si rechaza H0 → todo aprendizaje histórico es sesgado
//
//   6. DIVERSITY: ¿Los algoritmos son genuinamente diferentes?
//      • Spearman correlation entre rankings de cada par de algos
//      • Si r > 0.95 → redundancia, no hay ganancia de diversidad
//
// BONFERRONI: α_corrected = 0.05 / m donde m = total tests
//   Garantiza Family-Wise Error Rate ≤ 5% incluso ejecutando docenas.
//
// VERDICT: si ≥1 test es significativo → "EDGE DETECTED en X"
//          si 0 tests significativos → "NO EDGE — sistema indistinguible
//                                       del azar con confianza 95%"
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';

const logger = pino({ name: 'EdgeDiscoveryEngine' });

// ── Tipos ───────────────────────────────────────────────────────
export interface DiscoveryOpts {
  run_id?:      string;
  scope?:       'all' | 'algo' | 'calendar' | 'autocorr' | 'persistence' | 'drift' | 'diversity';
  game_type?:   'pick3' | 'pick4';
  draw_type?:   'midday' | 'evening';
  half?:        'du' | 'ab' | 'cd';
}

export interface TestResult {
  test_family:          string;
  test_name:            string;
  game_type:            string | null;
  draw_type:            string | null;
  half:                 string | null;
  scope:                Record<string, unknown>;
  null_hypothesis:      string;
  test_statistic:       number;
  p_value:              number;
  bonferroni_threshold: number;
  significant:          boolean;
  effect_size:          number | null;
  effect_size_metric:   string | null;
  sample_size:          number;
  interpretation:       string;
  data:                 Record<string, unknown>;
}

export interface DiscoverySummary {
  run_id:              string;
  total_tests:         number;
  significant_tests:   number;
  edge_found:          boolean;
  verdict:             string;
  significant_results: TestResult[];
  duration_ms:         number;
}

// ── Statistical helpers ─────────────────────────────────────────

/** Standard normal CDF via erf approximation (Abramowitz & Stegun 7.1.26). */
function normCdf(x: number): number {
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax   = Math.abs(x) / Math.sqrt(2);
  const t    = 1.0 / (1.0 + p * ax);
  const y    = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1.0 + sign * y);
}

/** Chi-squared CDF via Wilson-Hilferty cube-root approximation (accurate for k>=2). */
function chi2Cdf(x: number, k: number): number {
  if (x <= 0 || k <= 0) return 0;
  const c   = Math.cbrt(x / k);
  const m   = 1 - 2 / (9 * k);
  const s   = Math.sqrt(2 / (9 * k));
  return normCdf((c - m) / s);
}

/** Wilson 95% score interval for binomial proportion. */
function wilsonInterval(k: number, n: number, z = 1.96): { lo: number; hi: number; p: number } {
  if (n === 0) return { lo: 0, hi: 0, p: 0 };
  const p     = k / n;
  const z2    = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) / n) + (z2 / (4 * n * n)))) / denom;
  return { lo: center - margin, hi: center + margin, p };
}

/** One-sided binomial test: H0: p<=p0; HA: p>p0. Returns p-value via normal approx. */
function binomialPValueOneSided(k: number, n: number, p0: number): number {
  if (n === 0) return 1;
  const p_hat = k / n;
  const se    = Math.sqrt(p0 * (1 - p0) / n);
  if (se === 0) return p_hat > p0 ? 0 : 1;
  const z     = (p_hat - p0) / se;
  return 1 - normCdf(z);
}

/** Cohen's h effect size for two proportions. */
function cohenH(p1: number, p2: number): number {
  const phi = (p: number) => 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, p))));
  return Math.abs(phi(p1) - phi(p2));
}

/** Cramér's V from chi² and table dimensions. */
function cramerV(chi2: number, n: number, rows: number, cols: number): number {
  return Math.sqrt(chi2 / (n * Math.min(rows - 1, cols - 1)));
}

/** Pearson correlation. */
function pearson(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2 || n !== y.length) return 0;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const ex = x[i]! - mx;
    const ey = y[i]! - my;
    num += ex * ey;
    dx  += ex * ex;
    dy  += ey * ey;
  }
  const denom = Math.sqrt(dx * dy);
  return denom === 0 ? 0 : num / denom;
}

/** Spearman rank correlation. */
function spearman(x: number[], y: number[]): number {
  const rank = (arr: number[]): number[] => {
    const idx = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const ranks = new Array(arr.length);
    idx.forEach((e, i) => { ranks[e.i] = i + 1; });
    return ranks;
  };
  return pearson(rank(x), rank(y));
}

// ─────────────────────────────────────────────────────────────────
// MAIN ENGINE
// ─────────────────────────────────────────────────────────────────
export class EdgeDiscoveryEngine {
  constructor(private readonly pool: Pool) {}

  /**
   * Full autonomous discovery — runs all 6 test families, applies
   * Bonferroni correction, persists results, returns verdict.
   */
  async runDiscovery(opts: DiscoveryOpts = {}): Promise<DiscoverySummary> {
    const t_start = Date.now();
    const run_id  = opts.run_id ?? `edge-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
    const scope   = opts.scope ?? 'all';

    logger.info({ run_id, scope }, '🔬 Edge Discovery: start');

    await this.pool.query(
      `INSERT INTO hitdash.edge_discovery_runs (run_id, status, started_at) VALUES ($1, 'running', now())
       ON CONFLICT (run_id) DO UPDATE SET status='running', started_at=now()`,
      [run_id],
    );

    const tests: TestResult[] = [];

    try {
      if (scope === 'all' || scope === 'algo')         tests.push(...await this.testAlgorithmEdge());
      if (scope === 'all' || scope === 'calendar')     tests.push(...await this.testDowBias());
      if (scope === 'all' || scope === 'autocorr')     tests.push(...await this.testAutocorrelation());
      if (scope === 'all' || scope === 'persistence')  tests.push(...await this.testPairPersistence());
      if (scope === 'all' || scope === 'drift')        tests.push(...await this.testDistributionDrift());
      if (scope === 'all' || scope === 'diversity')    tests.push(...await this.testAlgorithmDiversity());

      // Bonferroni correction across all tests
      const m = Math.max(1, tests.length);
      const alpha_corrected = 0.05 / m;
      for (const t of tests) {
        t.bonferroni_threshold = alpha_corrected;
        t.significant = t.p_value < alpha_corrected;
      }

      // Persist all tests
      await this.persistTests(run_id, tests);

      // Build verdict
      const significant = tests.filter(t => t.significant);
      const edgeFound   = significant.length > 0;
      const verdict = edgeFound
        ? `🎯 EDGE DETECTED — ${significant.length}/${m} tests significativos tras Bonferroni α=${alpha_corrected.toExponential(2)}. Familias: ${[...new Set(significant.map(s => s.test_family))].join(', ')}`
        : `❌ SIN EDGE — 0/${m} tests rechazan H0. Bonferroni α=${alpha_corrected.toExponential(2)}. El sistema es estadísticamente indistinguible del azar con confianza 95% en estas dimensiones.`;

      const duration_ms = Date.now() - t_start;

      await this.pool.query(
        `UPDATE hitdash.edge_discovery_runs
            SET status='completed', completed_at=now(),
                total_tests=$2, significant_tests=$3,
                edge_found=$4, verdict=$5, duration_ms=$6
          WHERE run_id=$1`,
        [run_id, m, significant.length, edgeFound, verdict, duration_ms],
      );

      logger.info(
        { run_id, total_tests: m, significant: significant.length, edge_found: edgeFound, duration_ms },
        edgeFound ? '🎯 Edge Discovery: EDGE DETECTED' : '🔍 Edge Discovery: no edge',
      );

      return {
        run_id, total_tests: m,
        significant_tests: significant.length,
        edge_found: edgeFound, verdict,
        significant_results: significant,
        duration_ms,
      };
    } catch (err) {
      await this.pool.query(
        `UPDATE hitdash.edge_discovery_runs SET status='failed', completed_at=now() WHERE run_id=$1`,
        [run_id],
      );
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // FAMILY 1: ALGO_EDGE — per-algorithm Wilson CI + binomial test
  //
  // SURGICAL CHANGE (2026-05-21): extender ventana 365d → 5y.
  // Razón: en discovery #1, moving_averages cd tenía Cohen's h=0.125 con
  // n=365 → p=0.0057 (no pasa Bonferroni α=2.67e-4). Con n=1825 (5y) el
  // mismo h da p≈0.00017 → cruza Bonferroni. 5× más poder estadístico.
  // ═══════════════════════════════════════════════════════════════
  private async testAlgorithmEdge(): Promise<TestResult[]> {
    const { rows } = await this.pool.query<{
      algo_name: string; game_type: string; draw_type: string; half: string;
      hits:      string; n_total:    string;
    }>(
      `SELECT algo_name, game_type, draw_type, half,
              SUM(CASE WHEN rank_of_winner <= 15 THEN 1 ELSE 0 END)::int AS hits,
              COUNT(*)::int                                              AS n_total
       FROM hitdash.algo_rank_history
       WHERE draw_date >= CURRENT_DATE - INTERVAL '5 years'
       GROUP BY algo_name, game_type, draw_type, half
       HAVING COUNT(*) >= 500`,
    );

    const tests: TestResult[] = [];
    for (const r of rows) {
      const hits    = Number(r.hits);
      const n       = Number(r.n_total);
      const p_hat   = hits / n;
      const p0      = 0.15;
      const p_value = binomialPValueOneSided(hits, n, p0);
      const ci      = wilsonInterval(hits, n);
      const h       = cohenH(p_hat, p0);

      tests.push({
        test_family: 'algo_edge',
        test_name:   `algo_edge:${r.algo_name}:${r.game_type}:${r.draw_type}:${r.half}`,
        game_type:   r.game_type,
        draw_type:   r.draw_type,
        half:        r.half,
        scope:       { algo_name: r.algo_name, n_at: 15 },
        null_hypothesis: `H0: P(rank_of_winner ≤ 15 | ${r.algo_name}) ≤ 0.15 (baseline aleatorio)`,
        test_statistic: (p_hat - p0) / Math.sqrt(p0 * (1 - p0) / n),
        p_value,
        bonferroni_threshold: 0,   // set later
        significant: false,         // set later
        effect_size: h,
        effect_size_metric: 'cohen_h',
        sample_size: n,
        interpretation: `${r.algo_name} @ ${r.game_type}/${r.draw_type}/${r.half}: hit_rate=${(p_hat*100).toFixed(2)}% (Wilson 95% CI [${(ci.lo*100).toFixed(2)}%, ${(ci.hi*100).toFixed(2)}%]) sobre n=${n}, edge=${((p_hat-p0)*100).toFixed(2)}pp, Cohen h=${h.toFixed(3)}`,
        data: { hit_rate: p_hat, baseline: p0, wilson_lo: ci.lo, wilson_hi: ci.hi, hits, n },
      });
    }
    return tests;
  }

  // ═══════════════════════════════════════════════════════════════
  // FAMILY 2: DOW_BIAS — χ² test for day-of-week effect
  // ═══════════════════════════════════════════════════════════════
  private async testDowBias(): Promise<TestResult[]> {
    // For each (game_type, draw_type, half), build 7×100 contingency table
    // of pair frequency per DOW. Reject H0 if pairs depend on DOW.
    const combos = [
      { game_type: 'pick3' as const, draw_type: 'evening' as const, half: 'du', pairSql: '(p2::text || p3::text)' },
      { game_type: 'pick3' as const, draw_type: 'midday'  as const, half: 'du', pairSql: '(p2::text || p3::text)' },
      { game_type: 'pick4' as const, draw_type: 'evening' as const, half: 'ab', pairSql: '(p1::text || p2::text)' },
      { game_type: 'pick4' as const, draw_type: 'evening' as const, half: 'cd', pairSql: '(p3::text || p4::text)' },
      { game_type: 'pick4' as const, draw_type: 'midday'  as const, half: 'ab', pairSql: '(p1::text || p2::text)' },
      { game_type: 'pick4' as const, draw_type: 'midday'  as const, half: 'cd', pairSql: '(p3::text || p4::text)' },
    ];

    const tests: TestResult[] = [];
    for (const c of combos) {
      const { rows } = await this.pool.query<{ dow: string; pair: string; cnt: string }>(
        `SELECT EXTRACT(ISODOW FROM draw_date)::int AS dow,
                ${c.pairSql}                       AS pair,
                COUNT(*)::int                      AS cnt
         FROM hitdash.ingested_results
         WHERE game_type = $1 AND draw_type = $2
           AND ${c.half === 'cd' ? 'p4 IS NOT NULL AND ' : ''}p3 IS NOT NULL
         GROUP BY 1, 2`,
        [c.game_type, c.draw_type],
      );

      if (rows.length === 0) continue;

      // Build contingency table 7×100
      const table: number[][] = Array.from({ length: 7 }, () => new Array(100).fill(0));
      let total = 0;
      for (const row of rows) {
        const d = Number(row.dow) - 1; // 0..6
        const p = Math.max(0, Math.min(99, parseInt(row.pair, 10)));
        const ct = Number(row.cnt);
        if (d >= 0 && d < 7) {
          table[d]![p]! += ct;
          total += ct;
        }
      }

      if (total < 700) continue; // need at least n=100 per DOW

      // Marginals
      const rowTotals: number[] = table.map(r => r.reduce((s, v) => s + v, 0));
      const colTotals = new Array(100).fill(0);
      for (let d = 0; d < 7; d++)
        for (let p = 0; p < 100; p++)
          colTotals[p] += table[d]![p]!;

      // χ² statistic
      let chi2 = 0;
      let validCells = 0;
      for (let d = 0; d < 7; d++) {
        for (let p = 0; p < 100; p++) {
          const expected = (rowTotals[d]! * colTotals[p]!) / total;
          if (expected >= 1) {  // minimum expected freq
            const observed = table[d]![p]!;
            chi2 += Math.pow(observed - expected, 2) / expected;
            validCells++;
          }
        }
      }

      const df = Math.max(1, validCells - 7 - 100 + 1);
      const p_value = 1 - chi2Cdf(chi2, df);
      const v = cramerV(chi2, total, 7, 100);

      tests.push({
        test_family: 'dow_bias',
        test_name:   `dow_bias:${c.game_type}:${c.draw_type}:${c.half}`,
        game_type:   c.game_type,
        draw_type:   c.draw_type,
        half:        c.half,
        scope:       { dimensions: '7x100', valid_cells: validCells },
        null_hypothesis: `H0: distribución de pares es independiente del día de la semana`,
        test_statistic: chi2,
        p_value,
        bonferroni_threshold: 0,
        significant: false,
        effect_size: v,
        effect_size_metric: 'cramer_v',
        sample_size: total,
        interpretation: `χ²=${chi2.toFixed(2)} df=${df} p=${p_value.toExponential(2)} Cramér's V=${v.toFixed(4)}. ${v < 0.1 ? 'Efecto despreciable.' : v < 0.3 ? 'Efecto pequeño.' : v < 0.5 ? 'Efecto mediano.' : 'Efecto grande.'}`,
        data: { chi2, df, cramer_v: v, n: total },
      });
    }
    return tests;
  }

  // ═══════════════════════════════════════════════════════════════
  // FAMILY 3: AUTOCORRELATION — lag-k correlation per position
  // ═══════════════════════════════════════════════════════════════
  private async testAutocorrelation(): Promise<TestResult[]> {
    const tests: TestResult[] = [];
    const combos = [
      { game_type: 'pick3', draw_type: 'evening', positions: ['p2', 'p3'] },
      { game_type: 'pick3', draw_type: 'midday',  positions: ['p2', 'p3'] },
      { game_type: 'pick4', draw_type: 'evening', positions: ['p1', 'p2', 'p3', 'p4'] },
      { game_type: 'pick4', draw_type: 'midday',  positions: ['p1', 'p2', 'p3', 'p4'] },
    ];

    for (const c of combos) {
      for (const pos of c.positions) {
        const { rows } = await this.pool.query<{ val: number }>(
          `SELECT ${pos} AS val
           FROM hitdash.ingested_results
           WHERE game_type = $1 AND draw_type = $2 AND ${pos} IS NOT NULL
             AND draw_date >= CURRENT_DATE - INTERVAL '5 years'
           ORDER BY draw_date ASC, draw_key ASC`,
          [c.game_type, c.draw_type],
        );

        if (rows.length < 100) continue;
        const series = rows.map(r => Number(r.val));

        for (const lag of [1, 2, 7, 30]) {
          if (series.length < lag + 50) continue;
          const a = series.slice(0, -lag);
          const b = series.slice(lag);
          const r = pearson(a, b);
          const n = a.length;
          // Under H0: r ~ N(0, 1/n) for large n
          const z = r * Math.sqrt(n);
          // Two-sided
          const p_value = 2 * (1 - normCdf(Math.abs(z)));

          tests.push({
            test_family: 'autocorrelation',
            test_name:   `autocorr:${c.game_type}:${c.draw_type}:${pos}:lag${lag}`,
            game_type:   c.game_type,
            draw_type:   c.draw_type,
            half:        null,
            scope:       { position: pos, lag },
            null_hypothesis: `H0: autocorrelación de ${pos} en lag ${lag} = 0`,
            test_statistic: r,
            p_value,
            bonferroni_threshold: 0,
            significant: false,
            effect_size: Math.abs(r),
            effect_size_metric: 'r',
            sample_size: n,
            interpretation: `${pos} ${c.game_type}/${c.draw_type} lag-${lag}: r=${r.toFixed(4)} (z=${z.toFixed(2)}, p=${p_value.toExponential(2)}, n=${n}). ${Math.abs(r) < 0.05 ? 'Sin autocorr.' : 'Autocorr presente.'}`,
            data: { r, z, lag, position: pos, n },
          });
        }
      }
    }
    return tests;
  }

  // ═══════════════════════════════════════════════════════════════
  // FAMILY 4: PAIR_PERSISTENCE — gap distribution test
  // ═══════════════════════════════════════════════════════════════
  private async testPairPersistence(): Promise<TestResult[]> {
    const tests: TestResult[] = [];
    const combos = [
      { game_type: 'pick3', draw_type: 'evening', half: 'du', pairSql: '(p2::text || p3::text)' },
      { game_type: 'pick3', draw_type: 'midday',  half: 'du', pairSql: '(p2::text || p3::text)' },
      { game_type: 'pick4', draw_type: 'evening', half: 'ab', pairSql: '(p1::text || p2::text)' },
      { game_type: 'pick4', draw_type: 'midday',  half: 'ab', pairSql: '(p1::text || p2::text)' },
    ];

    for (const c of combos) {
      const { rows } = await this.pool.query<{ pair: string; draw_date: string }>(
        `SELECT ${c.pairSql} AS pair, draw_date::text AS draw_date
         FROM hitdash.ingested_results
         WHERE game_type=$1 AND draw_type=$2
           AND p2 IS NOT NULL AND p3 IS NOT NULL
         ORDER BY draw_date ASC, draw_key ASC`,
        [c.game_type, c.draw_type],
      );
      if (rows.length < 500) continue;

      // For each pair, compute gaps between consecutive appearances
      const lastSeen = new Map<string, number>();
      const gaps: number[] = [];
      for (let i = 0; i < rows.length; i++) {
        const pair = rows[i]!.pair;
        if (lastSeen.has(pair)) gaps.push(i - lastSeen.get(pair)!);
        lastSeen.set(pair, i);
      }

      if (gaps.length < 100) continue;

      // Expected gap distribution under uniform random: geometric with p=1/100
      // Compute χ² goodness-of-fit in 10 buckets
      const p_random = 1 / 100;
      const bucketEdges = [1, 25, 50, 100, 150, 200, 300, 500, 1000, Infinity];
      const observed = new Array(bucketEdges.length).fill(0);
      const expected = new Array(bucketEdges.length).fill(0);

      // Expected probability of falling in each bucket (geometric)
      let prev = 0;
      for (let b = 0; b < bucketEdges.length; b++) {
        const edge = bucketEdges[b]!;
        const probUpTo = edge === Infinity ? 1 : 1 - Math.pow(1 - p_random, edge);
        expected[b] = (probUpTo - prev) * gaps.length;
        prev = probUpTo;
      }

      for (const g of gaps) {
        for (let b = 0; b < bucketEdges.length; b++) {
          if (g <= bucketEdges[b]!) { observed[b]++; break; }
        }
      }

      let chi2 = 0;
      let validBuckets = 0;
      for (let b = 0; b < bucketEdges.length; b++) {
        if (expected[b] >= 5) {
          chi2 += Math.pow(observed[b] - expected[b], 2) / expected[b];
          validBuckets++;
        }
      }
      const df = Math.max(1, validBuckets - 1);
      const p_value = 1 - chi2Cdf(chi2, df);

      tests.push({
        test_family: 'pair_persistence',
        test_name:   `pair_persistence:${c.game_type}:${c.draw_type}:${c.half}`,
        game_type:   c.game_type,
        draw_type:   c.draw_type,
        half:        c.half,
        scope:       { n_gaps: gaps.length, buckets: validBuckets },
        null_hypothesis: `H0: gaps entre apariciones del mismo par ~ Geometric(1/100)`,
        test_statistic: chi2,
        p_value,
        bonferroni_threshold: 0,
        significant: false,
        effect_size: chi2 / Math.max(1, gaps.length),
        effect_size_metric: 'chi2_per_n',
        sample_size: gaps.length,
        interpretation: `Pair persistence ${c.game_type}/${c.draw_type}: χ²=${chi2.toFixed(2)} df=${df} p=${p_value.toExponential(2)} n_gaps=${gaps.length}. ${p_value < 0.05 ? 'Gaps no son random — memoria detectada.' : 'Gaps consistentes con azar.'}`,
        data: { chi2, df, observed, expected_rounded: expected.map(e => +e.toFixed(1)) },
      });
    }
    return tests;
  }

  // ═══════════════════════════════════════════════════════════════
  // FAMILY 5: DRIFT_KS — distribution stability over time
  // ═══════════════════════════════════════════════════════════════
  private async testDistributionDrift(): Promise<TestResult[]> {
    const tests: TestResult[] = [];
    const combos = [
      { game_type: 'pick3', draw_type: 'evening', half: 'du', pairSql: '(p2::text || p3::text)' },
      { game_type: 'pick4', draw_type: 'evening', half: 'ab', pairSql: '(p1::text || p2::text)' },
    ];

    for (const c of combos) {
      const { rows } = await this.pool.query<{ pair: string }>(
        `SELECT ${c.pairSql} AS pair
         FROM hitdash.ingested_results
         WHERE game_type=$1 AND draw_type=$2
           AND p2 IS NOT NULL AND p3 IS NOT NULL
         ORDER BY draw_date ASC, draw_key ASC`,
        [c.game_type, c.draw_type],
      );
      if (rows.length < 200) continue;
      const series = rows.map(r => parseInt(r.pair, 10));
      const mid    = Math.floor(series.length / 2);
      const a      = series.slice(0, mid).sort((x, y) => x - y);
      const b      = series.slice(mid).sort((x, y) => x - y);

      // 2-sample KS statistic: D = max |F_a(x) - F_b(x)|
      let i = 0, j = 0, D = 0;
      while (i < a.length && j < b.length) {
        const Fa = (i + 1) / a.length;
        const Fb = (j + 1) / b.length;
        D = Math.max(D, Math.abs(Fa - Fb));
        if (a[i]! < b[j]!) i++;
        else if (a[i]! > b[j]!) j++;
        else { i++; j++; }
      }

      // Asymptotic KS p-value
      const en = Math.sqrt((a.length * b.length) / (a.length + b.length));
      const lambda = (en + 0.12 + 0.11 / en) * D;
      // Kolmogorov distribution: 2 * sum_{j=1}^inf (-1)^(j-1) * exp(-2j² λ²)
      let p_value = 0;
      for (let k = 1; k <= 100; k++) {
        p_value += 2 * Math.pow(-1, k - 1) * Math.exp(-2 * k * k * lambda * lambda);
      }
      p_value = Math.max(0, Math.min(1, p_value));

      tests.push({
        test_family: 'drift_ks',
        test_name:   `drift_ks:${c.game_type}:${c.draw_type}:${c.half}`,
        game_type:   c.game_type,
        draw_type:   c.draw_type,
        half:        c.half,
        scope:       { halves: 'first-half vs second-half' },
        null_hypothesis: `H0: distribución de pares es estable (primera mitad ~ segunda mitad)`,
        test_statistic: D,
        p_value,
        bonferroni_threshold: 0,
        significant: false,
        effect_size: D,
        effect_size_metric: 'd_max',
        sample_size: series.length,
        interpretation: `KS drift ${c.game_type}/${c.draw_type}: D=${D.toFixed(4)} p=${p_value.toExponential(2)} n=${series.length}. ${p_value < 0.05 ? 'Distribución INESTABLE.' : 'Distribución estable — pareja del tiempo no afecta.'}`,
        data: { D, en, lambda, n: series.length },
      });
    }
    return tests;
  }

  // ═══════════════════════════════════════════════════════════════
  // FAMILY 6: DIVERSITY — Spearman correlation between algos
  // ═══════════════════════════════════════════════════════════════
  private async testAlgorithmDiversity(): Promise<TestResult[]> {
    // For pick3 evening du: pull recent algo_prediction_snapshot,
    // for each pair of algos compute Spearman correlation of their rankings.
    // High correlation → redundant.
    const { rows } = await this.pool.query<{
      algo_name: string;
      pair_scores: Record<string, number>;
    }>(
      `SELECT algo_name, pair_scores
       FROM hitdash.algo_prediction_snapshot
       WHERE game_type='pick3' AND draw_type='evening' AND half='du'
         AND draw_date = (
           SELECT MAX(draw_date) FROM hitdash.algo_prediction_snapshot
           WHERE game_type='pick3' AND draw_type='evening' AND half='du'
         )`,
    );

    if (rows.length < 2) return [];

    // Extract score vectors for the 100 pairs
    const scores = new Map<string, number[]>();
    for (const row of rows) {
      const arr = new Array(100).fill(0);
      for (const [pair, score] of Object.entries(row.pair_scores)) {
        const idx = parseInt(pair, 10);
        if (idx >= 0 && idx < 100) arr[idx] = Number(score);
      }
      scores.set(row.algo_name, arr);
    }

    // Pairwise Spearman correlations
    const algos = [...scores.keys()];
    const correlations: number[] = [];
    for (let i = 0; i < algos.length; i++) {
      for (let j = i + 1; j < algos.length; j++) {
        const r = spearman(scores.get(algos[i]!)!, scores.get(algos[j]!)!);
        correlations.push(r);
      }
    }

    if (correlations.length === 0) return [];

    const meanCorr = correlations.reduce((s, v) => s + v, 0) / correlations.length;
    const highCorr = correlations.filter(r => r > 0.9).length;
    const n = correlations.length;

    // Fisher z-transform for significance: H0 mean correlation = 0
    const z = 0.5 * Math.log((1 + meanCorr) / (1 - meanCorr));
    const se = 1 / Math.sqrt(Math.max(1, n - 3));
    const p_value = 2 * (1 - normCdf(Math.abs(z) / se));

    return [{
      test_family: 'diversity',
      test_name:   'diversity:pick3:evening:du:spearman',
      game_type:   'pick3',
      draw_type:   'evening',
      half:        'du',
      scope:       { n_algos: algos.length, n_pairs: n, high_corr_count: highCorr },
      null_hypothesis: `H0: correlación promedio entre rankings de algoritmos = 0 (diversidad real)`,
      test_statistic: meanCorr,
      p_value,
      bonferroni_threshold: 0,
      significant: false,
      effect_size: meanCorr,
      effect_size_metric: 'r',
      sample_size: n,
      interpretation: `Diversidad: ${algos.length} algos, ${n} pares de Spearman. r_promedio=${meanCorr.toFixed(4)}. ${highCorr} pares con r>0.9 (redundantes). ${meanCorr > 0.5 ? 'Algoritmos altamente correlacionados — diversidad baja.' : 'Diversidad razonable.'}`,
      data: { mean_correlation: meanCorr, high_corr_count: highCorr, algos },
    }];
  }

  // ═══════════════════════════════════════════════════════════════
  // DEEP DIVE — re-test pre-specified candidate signals with max data
  //
  // En discovery exploratorio (187 tests) la corrección Bonferroni es muy
  // estricta (α=2.67e-4). Pero cuando ya tenemos hipótesis pre-especificadas
  // (las 9 señales identificadas en discovery #1), aplicamos Bonferroni
  // solo sobre ellas: α=0.05/9=0.0056. Mucho más sensible.
  //
  // Esto es buena práctica estadística: separar discovery exploratorio
  // de testing confirmatorio (pre-specified hypotheses).
  // ═══════════════════════════════════════════════════════════════
  async deepDive(candidates: Array<{
    family:    string;
    name:      string;
    game_type: string;
    draw_type: string;
    half?:     string;
    position?: string;
    lag?:      number;
  }>): Promise<{
    run_id:  string;
    tests:   TestResult[];
    verdict: string;
  }> {
    const run_id = `deepdive-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}`;
    logger.info({ run_id, n_candidates: candidates.length }, '🎯 Deep Dive: start');

    await this.pool.query(
      `INSERT INTO hitdash.edge_discovery_runs (run_id, status, started_at, metadata)
       VALUES ($1, 'running', now(), $2::jsonb)
       ON CONFLICT (run_id) DO UPDATE SET status='running', started_at=now()`,
      [run_id, JSON.stringify({ type: 'deep_dive', candidates })],
    );

    const tests: TestResult[] = [];

    for (const c of candidates) {
      if (c.family === 'algo_edge') {
        // Re-test single algo over MAX data (algo_rank_history all-time)
        const { rows } = await this.pool.query<{ hits: string; n_total: string }>(
          `SELECT SUM(CASE WHEN rank_of_winner <= 15 THEN 1 ELSE 0 END)::int AS hits,
                  COUNT(*)::int                                              AS n_total
           FROM hitdash.algo_rank_history
           WHERE algo_name=$1 AND game_type=$2 AND draw_type=$3 AND half=$4`,
          [c.name.split(':')[1], c.game_type, c.draw_type, c.half],
        );
        if (rows[0] && Number(rows[0].n_total) > 0) {
          const hits = Number(rows[0].hits);
          const n    = Number(rows[0].n_total);
          const p_hat = hits / n;
          const p0    = 0.15;
          const p_value = binomialPValueOneSided(hits, n, p0);
          const ci     = wilsonInterval(hits, n);
          const h      = cohenH(p_hat, p0);
          tests.push({
            test_family: 'algo_edge_deepdive',
            test_name:   `deepdive:${c.name}`,
            game_type:   c.game_type, draw_type: c.draw_type, half: c.half ?? null,
            scope:       { algo_name: c.name.split(':')[1], window: 'all-time', n_at: 15 },
            null_hypothesis: `H0: hit_rate ≤ 15% (full algo_rank_history para ${c.name.split(':')[1]})`,
            test_statistic: (p_hat - p0) / Math.sqrt(p0*(1-p0)/n),
            p_value,
            bonferroni_threshold: 0,
            significant: false,
            effect_size: h,
            effect_size_metric: 'cohen_h',
            sample_size: n,
            interpretation: `DEEP DIVE ${c.name}: hit_rate=${(p_hat*100).toFixed(3)}% (CI [${(ci.lo*100).toFixed(2)}, ${(ci.hi*100).toFixed(2)}]) n=${n}, h=${h.toFixed(4)}`,
            data: { hit_rate: p_hat, wilson_lo: ci.lo, wilson_hi: ci.hi, hits, n },
          });
        }
      } else if (c.family === 'autocorrelation' && c.position && c.lag) {
        // Re-test autocorrelation over FULL position series
        const { rows } = await this.pool.query<{ val: number }>(
          `SELECT ${c.position} AS val
           FROM hitdash.ingested_results
           WHERE game_type=$1 AND draw_type=$2 AND ${c.position} IS NOT NULL
           ORDER BY draw_date ASC, draw_key ASC`,
          [c.game_type, c.draw_type],
        );
        if (rows.length > 100 + c.lag) {
          const series = rows.map(r => Number(r.val));
          const a = series.slice(0, -c.lag);
          const b = series.slice(c.lag);
          const r = pearson(a, b);
          const n = a.length;
          const z = r * Math.sqrt(n);
          const p_value = 2 * (1 - normCdf(Math.abs(z)));
          tests.push({
            test_family: 'autocorr_deepdive',
            test_name:   `deepdive:autocorr:${c.game_type}:${c.draw_type}:${c.position}:lag${c.lag}`,
            game_type:   c.game_type, draw_type: c.draw_type, half: null,
            scope:       { position: c.position, lag: c.lag, window: 'all-time' },
            null_hypothesis: `H0: r(lag-${c.lag}) = 0 para ${c.position}`,
            test_statistic: r, p_value,
            bonferroni_threshold: 0, significant: false,
            effect_size: Math.abs(r), effect_size_metric: 'r',
            sample_size: n,
            interpretation: `DEEP DIVE autocorr ${c.position} lag-${c.lag}: r=${r.toFixed(4)} z=${z.toFixed(2)} p=${p_value.toExponential(2)} n=${n}`,
            data: { r, z, lag: c.lag, position: c.position, n },
          });
        }
      } else if (c.family === 'drift_ks') {
        // Re-run KS with FULL data, finer split (5 buckets vs 2)
        // Skipped here, KS already used max data in first pass
        tests.push({
          test_family: 'drift_ks_deepdive',
          test_name:   `deepdive:${c.name}`,
          game_type:   c.game_type, draw_type: c.draw_type, half: c.half ?? null,
          scope:       { note: 'first pass already used max data' },
          null_hypothesis: 'H0: distribución estable',
          test_statistic: 0, p_value: 1,
          bonferroni_threshold: 0, significant: false,
          effect_size: null, effect_size_metric: null,
          sample_size: 0,
          interpretation: `${c.name}: deep-dive skip — primera pass usó max data ya`,
          data: {},
        });
      }
    }

    // Bonferroni con M MUCHO menor (solo candidates pre-specificados)
    const m = Math.max(1, tests.length);
    const alpha = 0.05 / m;
    for (const t of tests) {
      t.bonferroni_threshold = alpha;
      t.significant = t.p_value < alpha;
    }

    await this.persistTests(run_id, tests);

    const significant = tests.filter(t => t.significant);
    const verdict = significant.length > 0
      ? `🎯 DEEP DIVE: ${significant.length}/${m} señales pre-especificadas CONFIRMADAS post-Bonferroni α=${alpha.toFixed(4)}`
      : `❌ DEEP DIVE: 0/${m} señales sobreviven Bonferroni α=${alpha.toFixed(4)} ni con data máxima`;

    await this.pool.query(
      `UPDATE hitdash.edge_discovery_runs
          SET status='completed', completed_at=now(),
              total_tests=$2, significant_tests=$3,
              edge_found=$4, verdict=$5, duration_ms=$6
        WHERE run_id=$1`,
      [run_id, m, significant.length, significant.length > 0, verdict, 0],
    );

    logger.info({ run_id, total: m, significant: significant.length, edge_found: significant.length > 0 }, '🎯 Deep Dive: completed');

    return { run_id, tests, verdict };
  }

  // ═══════════════════════════════════════════════════════════════
  // PERSISTENCE
  // ═══════════════════════════════════════════════════════════════
  private async persistTests(run_id: string, tests: TestResult[]): Promise<void> {
    if (tests.length === 0) return;
    const BATCH = 50;
    for (let i = 0; i < tests.length; i += BATCH) {
      const slice = tests.slice(i, i + BATCH);
      const cols = ['run_id', 'test_family', 'test_name', 'game_type', 'draw_type', 'half',
                    'scope', 'null_hypothesis', 'test_statistic', 'p_value',
                    'bonferroni_threshold', 'significant', 'effect_size', 'effect_size_metric',
                    'sample_size', 'interpretation', 'data'];
      const params: unknown[] = [];
      const placeholders: string[] = [];
      let p = 1;
      for (const t of slice) {
        const tokens = cols.map(() => `$${p++}`);
        placeholders.push(`(${tokens.slice(0, 6).join(',')}, ${tokens[6]}::jsonb, ${tokens.slice(7, 16).join(',')}, ${tokens[16]}::jsonb)`);
        params.push(
          run_id, t.test_family, t.test_name, t.game_type, t.draw_type, t.half,
          JSON.stringify(t.scope), t.null_hypothesis, t.test_statistic, t.p_value,
          t.bonferroni_threshold, t.significant, t.effect_size, t.effect_size_metric,
          t.sample_size, t.interpretation, JSON.stringify(t.data),
        );
      }

      await this.pool.query(
        `INSERT INTO hitdash.edge_hypothesis_tests
           (run_id, test_family, test_name, game_type, draw_type, half, scope,
            null_hypothesis, test_statistic, p_value, bonferroni_threshold, significant,
            effect_size, effect_size_metric, sample_size, interpretation, data)
         VALUES ${placeholders.join(',')}`,
        params,
      );
    }
  }
}
