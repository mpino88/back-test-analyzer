// ═══════════════════════════════════════════════════════════════
// HELIX — Surgical Route A Explorer v1.0.0 (2026-05-21)
//
// Tras Edge Discovery v2 confirmar 0 algos significativos, EXPLORAR
// dimensiones NO testeadas con metodología rigurosa:
//   1. Sum-of-digits distribution (sesgo físico de máquina)
//   2. Within-draw adjacency (¿p2 condiciona p1?)
//   3. Higher-order Markov lag-2 (cadenas condicionales)
//   4. Day-of-month bias (no solo DOW que ya descartamos)
//   5. Month/seasonal
//   6. Pair anti-symmetry (P("23") vs P("32"))
//   7. Pair-level autocorrelation (índice 0-99, no posición digit)
//
// METODOLOGÍA QUIRÚRGICA:
//   • Train/Test split 80/20 temporal (sin shuffle)
//   • Test corre primero en train data
//   • Si pasa Bonferroni en train → VALIDAR en holdout
//   • Solo replicates_in_holdout=true cuenta como edge real
//
// Esto sigue best practice estadística:
//   "Cross-validation prevents p-hacking" (Wasserstein 2016)
//   "Pre-registered analysis" (Munafò 2017)
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';

const logger = pino({ name: 'SurgicalRouteAExplorer' });

// ── Statistical helpers (re-imports from EdgeDiscoveryEngine semantics) ──
function normCdf(x: number): number {
  const a1 =  0.254829592, a2 = -0.284496736, a3 =  1.421413741;
  const a4 = -1.453152027, a5 =  1.061405429, p  =  0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * ax);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1.0 + sign * y);
}

function chi2Cdf(x: number, k: number): number {
  if (x <= 0 || k <= 0) return 0;
  const c = Math.cbrt(x / k);
  const m = 1 - 2 / (9 * k);
  const s = Math.sqrt(2 / (9 * k));
  return normCdf((c - m) / s);
}

function binomialPValueTwoSided(k: number, n: number, p0: number): number {
  if (n === 0) return 1;
  const p_hat = k / n;
  const se = Math.sqrt(p0 * (1 - p0) / n);
  if (se === 0) return 1;
  const z = (p_hat - p0) / se;
  return 2 * (1 - normCdf(Math.abs(z)));
}

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
    dx += ex * ex;
    dy += ey * ey;
  }
  const denom = Math.sqrt(dx * dy);
  return denom === 0 ? 0 : num / denom;
}

// ── Pick3 sum-of-digits expected PMF (3 dice U[0,9] convolved) ──
function pick3SumPMF(): number[] {
  const out = new Array(28).fill(0);
  for (let a = 0; a <= 9; a++)
    for (let b = 0; b <= 9; b++)
      for (let c = 0; c <= 9; c++)
        out[a + b + c]! += 1;
  return out.map(c => c / 1000);
}

function pick4SumPMF(): number[] {
  const out = new Array(37).fill(0);
  for (let a = 0; a <= 9; a++)
    for (let b = 0; b <= 9; b++)
      for (let c = 0; c <= 9; c++)
        for (let d = 0; d <= 9; d++)
          out[a + b + c + d]! += 1;
  return out.map(c => c / 10000);
}

const PICK3_SUM_PMF = pick3SumPMF();
const PICK4_SUM_PMF = pick4SumPMF();

// ── Types ───────────────────────────────────────────────────────
export interface TestResult {
  feature_family:        string;
  test_name:             string;
  game_type:             string | null;
  draw_type:             string | null;
  scope:                 Record<string, unknown>;
  null_hypothesis:       string;
  test_statistic:        number;
  p_value:               number;
  bonferroni_threshold:  number;
  significant:           boolean;
  effect_size:           number | null;
  effect_size_metric:    string | null;
  sample_size:           number;
  train_p_value:         number | null;
  test_p_value:          number | null;
  replicates_in_holdout: boolean | null;
  interpretation:        string;
  data:                  Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────
// ENGINE
// ─────────────────────────────────────────────────────────────────
export class SurgicalRouteAExplorer {
  constructor(private readonly pool: Pool) {}

  async explore(): Promise<{
    run_id: string;
    tests: TestResult[];
    candidates_for_validation: number;
    edge_found: boolean;
    verdict: string;
  }> {
    const t_start = Date.now();
    const run_id  = `routea-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}`;

    logger.info({ run_id }, '🔬 Route A Explorer: start');

    await this.pool.query(
      `INSERT INTO hitdash.route_a_exploration_runs (run_id, status, started_at)
       VALUES ($1, 'running', now())
       ON CONFLICT (run_id) DO UPDATE SET status='running', started_at=now()`,
      [run_id],
    );

    const tests: TestResult[] = [];

    try {
      // 1. Sum-of-digits distribution
      tests.push(...await this.testSumOfDigits());
      // 2. Within-draw adjacency
      tests.push(...await this.testWithinDrawAdjacency());
      // 3. Higher-order Markov
      tests.push(...await this.testHigherOrderMarkov());
      // 4. Day-of-month
      tests.push(...await this.testDayOfMonth());
      // 5. Month/seasonal
      tests.push(...await this.testMonthSeasonal());
      // 6. Pair anti-symmetry
      tests.push(...await this.testPairAntiSymmetry());
      // 7. Pair-level autocorrelation
      tests.push(...await this.testPairAutocorrelation());

      // Bonferroni
      const m = Math.max(1, tests.length);
      const alpha = 0.05 / m;
      for (const t of tests) {
        t.bonferroni_threshold = alpha;
        t.significant = t.p_value < alpha;
      }

      // For tests that passed in train, validate in holdout
      const candidates = tests.filter(t => t.train_p_value !== null && t.train_p_value < alpha);
      for (const c of candidates) {
        if (c.test_p_value !== null) {
          c.replicates_in_holdout = c.test_p_value < 0.05; // standard threshold for replication
        }
      }

      await this.persistTests(run_id, tests);

      const significant = tests.filter(t => t.significant);
      const replicating = tests.filter(t => t.replicates_in_holdout === true);
      const edgeFound   = replicating.length > 0;

      const verdict = edgeFound
        ? `🎯 ROUTE A: ${replicating.length} señal(es) replican en holdout — EDGE REAL detectado en familias: ${[...new Set(replicating.map(r => r.feature_family))].join(', ')}`
        : significant.length > 0
          ? `⚠️  ROUTE A: ${significant.length}/${m} significativos en exploración, pero ${replicating.length} replicados en holdout. Posibles falsos positivos.`
          : `❌ ROUTE A: 0/${m} significativos tras Bonferroni α=${alpha.toExponential(2)}. Estas 7 dimensiones tampoco tienen edge demostrable.`;

      const duration_ms = Date.now() - t_start;

      await this.pool.query(
        `UPDATE hitdash.route_a_exploration_runs
            SET status='completed', completed_at=now(),
                total_tests=$2, significant_tests=$3,
                candidates_for_validation=$4, edge_found=$5,
                verdict=$6, duration_ms=$7
          WHERE run_id=$1`,
        [run_id, m, significant.length, candidates.length, edgeFound, verdict, duration_ms],
      );

      logger.info({
        run_id, total: m,
        significant: significant.length,
        replicating: replicating.length,
        duration_ms,
      }, edgeFound ? '🎯 Route A: EDGE DETECTED' : '🔍 Route A: no edge');

      return { run_id, tests, candidates_for_validation: candidates.length, edge_found: edgeFound, verdict };
    } catch (err) {
      await this.pool.query(
        `UPDATE hitdash.route_a_exploration_runs SET status='failed', completed_at=now() WHERE run_id=$1`,
        [run_id],
      );
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 1. SUM-OF-DIGITS DISTRIBUTION
  // χ² vs expected PMF from independent uniform digits
  // ═══════════════════════════════════════════════════════════════
  private async testSumOfDigits(): Promise<TestResult[]> {
    const tests: TestResult[] = [];
    for (const game of ['pick3', 'pick4'] as const) {
      for (const draw of ['midday', 'evening'] as const) {
        const sumCol = game === 'pick3' ? '(p1+p2+p3)' : '(p1+p2+p3+p4)';
        const filter = game === 'pick3' ? 'p1 IS NOT NULL AND p2 IS NOT NULL AND p3 IS NOT NULL'
                                        : 'p1 IS NOT NULL AND p2 IS NOT NULL AND p3 IS NOT NULL AND p4 IS NOT NULL';
        const { rows } = await this.pool.query<{ s: number; cnt: string }>(
          `SELECT ${sumCol} AS s, COUNT(*)::int AS cnt
           FROM hitdash.ingested_results
           WHERE game_type=$1 AND draw_type=$2 AND ${filter}
           GROUP BY 1 ORDER BY 1`,
          [game, draw],
        );
        if (rows.length === 0) continue;

        const expectedPMF = game === 'pick3' ? PICK3_SUM_PMF : PICK4_SUM_PMF;
        let total = 0;
        const observed = new Array(expectedPMF.length).fill(0);
        for (const r of rows) {
          if (r.s >= 0 && r.s < expectedPMF.length) {
            observed[r.s] = Number(r.cnt);
            total += observed[r.s];
          }
        }
        if (total < 100) continue;

        // Train/test split (80/20 temporal). Re-query with date ordering for split.
        const { rows: ordered } = await this.pool.query<{ s: number }>(
          `SELECT ${sumCol} AS s
           FROM hitdash.ingested_results
           WHERE game_type=$1 AND draw_type=$2 AND ${filter}
           ORDER BY draw_date ASC, draw_key ASC`,
          [game, draw],
        );
        const sums = ordered.map(r => Number(r.s));
        const trainN = Math.floor(sums.length * 0.8);
        const trainSums = sums.slice(0, trainN);
        const testSums  = sums.slice(trainN);

        const chi2OnSet = (data: number[]) => {
          const obs = new Array(expectedPMF.length).fill(0);
          for (const s of data) if (s >= 0 && s < expectedPMF.length) obs[s]++;
          let chi2 = 0, df = 0;
          for (let s = 0; s < expectedPMF.length; s++) {
            const exp = expectedPMF[s]! * data.length;
            if (exp >= 5) { chi2 += Math.pow(obs[s] - exp, 2) / exp; df++; }
          }
          return { chi2, df: Math.max(1, df - 1), p: 1 - chi2Cdf(chi2, Math.max(1, df - 1)) };
        };

        const full   = chi2OnSet(sums);
        const train  = chi2OnSet(trainSums);
        const test   = chi2OnSet(testSums);

        tests.push({
          feature_family: 'sum_of_digits',
          test_name:      `sum:${game}:${draw}`,
          game_type:      game, draw_type: draw,
          scope:          { n_buckets: expectedPMF.length, train_n: trainSums.length, test_n: testSums.length },
          null_hypothesis: `H0: sum-of-digits ~ convolución de uniformes (máquina justa)`,
          test_statistic: full.chi2, p_value: full.p,
          bonferroni_threshold: 0, significant: false,
          effect_size: full.chi2 / total, effect_size_metric: 'chi2_per_n',
          sample_size: total,
          train_p_value: train.p, test_p_value: test.p,
          replicates_in_holdout: null,
          interpretation: `Sum-of-digits ${game}/${draw}: χ²=${full.chi2.toFixed(2)} df=${full.df} p=${full.p.toExponential(2)} n=${total}. ${full.p < 0.01 ? 'Distribución posiblemente sesgada — máquina no perfectamente justa.' : 'Distribución consistente con convolución uniforme — máquina justa.'}`,
          data: { chi2_full: full.chi2, chi2_train: train.chi2, chi2_test: test.chi2 },
        });
      }
    }
    return tests;
  }

  // ═══════════════════════════════════════════════════════════════
  // 2. WITHIN-DRAW ADJACENCY
  // χ² independence test on (p_i, p_{i+1}) joint distribution
  // ═══════════════════════════════════════════════════════════════
  private async testWithinDrawAdjacency(): Promise<TestResult[]> {
    const tests: TestResult[] = [];
    const cases = [
      { game: 'pick3', a: 'p1', b: 'p2' },
      { game: 'pick3', a: 'p2', b: 'p3' },
      { game: 'pick4', a: 'p1', b: 'p2' },
      { game: 'pick4', a: 'p2', b: 'p3' },
      { game: 'pick4', a: 'p3', b: 'p4' },
    ];

    for (const c of cases) {
      const { rows } = await this.pool.query<{ a: number; b: number }>(
        `SELECT ${c.a} AS a, ${c.b} AS b
         FROM hitdash.ingested_results
         WHERE game_type=$1 AND ${c.a} IS NOT NULL AND ${c.b} IS NOT NULL
         ORDER BY draw_date ASC, draw_key ASC`,
        [c.game],
      );
      if (rows.length < 500) continue;

      const trainN = Math.floor(rows.length * 0.8);
      const trainRows = rows.slice(0, trainN);
      const testRows  = rows.slice(trainN);

      const chi2OnSet = (data: typeof rows) => {
        const table: number[][] = Array.from({ length: 10 }, () => new Array(10).fill(0));
        const rowSum = new Array(10).fill(0);
        const colSum = new Array(10).fill(0);
        for (const r of data) {
          const a = Number(r.a), b = Number(r.b);
          if (a >= 0 && a < 10 && b >= 0 && b < 10) {
            table[a]![b]!++;
            rowSum[a]!++;
            colSum[b]!++;
          }
        }
        const n = data.length;
        let chi2 = 0;
        for (let i = 0; i < 10; i++)
          for (let j = 0; j < 10; j++) {
            const exp = (rowSum[i]! * colSum[j]!) / n;
            if (exp >= 5) chi2 += Math.pow(table[i]![j]! - exp, 2) / exp;
          }
        const df = 81; // (10-1)(10-1)
        return { chi2, df, p: 1 - chi2Cdf(chi2, df), cramerV: Math.sqrt(chi2 / (n * 9)) };
      };

      const full  = chi2OnSet(rows);
      const train = chi2OnSet(trainRows);
      const test  = chi2OnSet(testRows);

      tests.push({
        feature_family: 'within_draw_adjacency',
        test_name:      `adjacency:${c.game}:${c.a}-${c.b}`,
        game_type:      c.game, draw_type: null,
        scope:          { positions: [c.a, c.b], df: 81 },
        null_hypothesis: `H0: ${c.a} y ${c.b} son independientes dentro del mismo sorteo`,
        test_statistic: full.chi2, p_value: full.p,
        bonferroni_threshold: 0, significant: false,
        effect_size: full.cramerV, effect_size_metric: 'cramer_v',
        sample_size: rows.length,
        train_p_value: train.p, test_p_value: test.p,
        replicates_in_holdout: null,
        interpretation: `Within-draw ${c.game} ${c.a}↔${c.b}: χ²=${full.chi2.toFixed(2)} p=${full.p.toExponential(2)} V=${full.cramerV.toFixed(4)} n=${rows.length}. ${full.p < 0.01 ? 'Dependencia detectada — posible bias físico.' : 'Independientes — random.'}`,
        data: { chi2_full: full.chi2, chi2_train: train.chi2, chi2_test: test.chi2 },
      });
    }
    return tests;
  }

  // ═══════════════════════════════════════════════════════════════
  // 3. HIGHER-ORDER MARKOV (lag-2 conditional on pair)
  // ═══════════════════════════════════════════════════════════════
  private async testHigherOrderMarkov(): Promise<TestResult[]> {
    const tests: TestResult[] = [];
    const cases = [
      { game: 'pick3', draw: 'evening', pairSql: '(p2*10 + p3)' },
      { game: 'pick3', draw: 'midday',  pairSql: '(p2*10 + p3)' },
      { game: 'pick4', draw: 'evening', pairSql: '(p1*10 + p2)' },
      { game: 'pick4', draw: 'evening', pairSql: '(p3*10 + p4)' },
    ];

    for (const c of cases) {
      const { rows } = await this.pool.query<{ pair: string }>(
        `SELECT ${c.pairSql} AS pair
         FROM hitdash.ingested_results
         WHERE game_type=$1 AND draw_type=$2 AND p2 IS NOT NULL AND p3 IS NOT NULL
           ${c.pairSql.includes('p4') ? 'AND p4 IS NOT NULL' : ''}
         ORDER BY draw_date ASC, draw_key ASC`,
        [c.game, c.draw],
      );
      if (rows.length < 200) continue;
      const pairs = rows.map(r => Number(r.pair));

      // Build 2nd-order transitions: P(pair_t | pair_{t-1}, pair_{t-2})
      // Compare to marginal P(pair_t). If significantly different, signal.
      // Use simpler test: χ² for whether 2nd-order transitions are uniform conditional on marginals.

      const marginalCount = new Array(100).fill(0);
      for (const p of pairs) if (p >= 0 && p < 100) marginalCount[p]++;
      const marginal = marginalCount.map(c => c / pairs.length);

      // Count transitions
      const trans = new Map<string, number>();
      for (let i = 2; i < pairs.length; i++) {
        const key = `${pairs[i-2]}-${pairs[i-1]}-${pairs[i]}`;
        trans.set(key, (trans.get(key) ?? 0) + 1);
      }

      // Chi² test: for each (t-2, t-1) bucket with >= 10 occurrences, compare
      // observed distribution of pair_t vs marginal.
      // Heavy: limit to most frequent (t-2, t-1) pairs.
      const prev2Count = new Map<string, number>();
      for (let i = 1; i < pairs.length; i++) {
        const k = `${pairs[i-1]}-${pairs[i]}`;
        prev2Count.set(k, (prev2Count.get(k) ?? 0) + 1);
      }

      // Aggregate: total chi² across most-common prev pairs (>= 30 occurrences)
      let totalChi2 = 0, df = 0;
      let testedBuckets = 0;
      for (const [prev2key, prev2count] of prev2Count) {
        if (prev2count < 30) continue;
        const observed = new Array(100).fill(0);
        const [p1, p2] = prev2key.split('-').map(Number);
        for (let i = 2; i < pairs.length; i++) {
          if (pairs[i-2] === p1 && pairs[i-1] === p2) observed[pairs[i]!]++;
        }
        for (let k = 0; k < 100; k++) {
          const exp = marginal[k]! * prev2count;
          if (exp >= 5) {
            totalChi2 += Math.pow(observed[k] - exp, 2) / exp;
            df++;
          }
        }
        testedBuckets++;
        if (testedBuckets >= 50) break; // limit compute
      }
      const dfEff = Math.max(1, df - testedBuckets * 100);
      const p_value = 1 - chi2Cdf(totalChi2, dfEff);

      tests.push({
        feature_family: 'higher_order_markov',
        test_name:      `markov2:${c.game}:${c.draw}:${c.pairSql.replace(/[()*+ ]/g,'')}`,
        game_type:      c.game, draw_type: c.draw,
        scope:          { lag: 2, tested_buckets: testedBuckets, total_pairs: pairs.length },
        null_hypothesis: `H0: P(par_t | par_{t-1}, par_{t-2}) = P(par_t)`,
        test_statistic: totalChi2, p_value,
        bonferroni_threshold: 0, significant: false,
        effect_size: testedBuckets > 0 ? totalChi2 / (testedBuckets * 100) : 0,
        effect_size_metric: 'chi2_per_cell',
        sample_size: pairs.length,
        train_p_value: null, test_p_value: null, replicates_in_holdout: null,
        interpretation: `2nd-order Markov ${c.game}/${c.draw}: χ²=${totalChi2.toFixed(0)} df=${dfEff} p=${p_value.toExponential(2)} buckets=${testedBuckets}. ${p_value < 0.01 ? 'Dependencia 2do orden detectada.' : 'Pair t es independiente de los previos.'}`,
        data: { chi2: totalChi2, df: dfEff, tested_buckets: testedBuckets },
      });
    }
    return tests;
  }

  // ═══════════════════════════════════════════════════════════════
  // 4. DAY-OF-MONTH BIAS
  // ═══════════════════════════════════════════════════════════════
  private async testDayOfMonth(): Promise<TestResult[]> {
    const tests: TestResult[] = [];
    const cases = [
      { game: 'pick3', draw: 'evening', pairSql: '(p2*10 + p3)' },
      { game: 'pick4', draw: 'evening', pairSql: '(p1*10 + p2)' },
    ];

    for (const c of cases) {
      const { rows } = await this.pool.query<{ dom: string; pair: string; cnt: string }>(
        `SELECT EXTRACT(DAY FROM draw_date)::int AS dom,
                ${c.pairSql} AS pair,
                COUNT(*)::int AS cnt
         FROM hitdash.ingested_results
         WHERE game_type=$1 AND draw_type=$2 AND p2 IS NOT NULL AND p3 IS NOT NULL
           ${c.pairSql.includes('p4') ? 'AND p4 IS NOT NULL' : ''}
         GROUP BY 1,2`,
        [c.game, c.draw],
      );
      if (rows.length === 0) continue;

      const table: number[][] = Array.from({ length: 31 }, () => new Array(100).fill(0));
      let total = 0;
      for (const r of rows) {
        const d = Number(r.dom) - 1;
        const p = parseInt(r.pair, 10);
        if (d >= 0 && d < 31 && p >= 0 && p < 100) {
          table[d]![p]! += Number(r.cnt);
          total += Number(r.cnt);
        }
      }
      if (total < 1000) continue;

      const rowSum = table.map(r => r.reduce((s, v) => s + v, 0));
      const colSum = new Array(100).fill(0);
      for (let d = 0; d < 31; d++) for (let p = 0; p < 100; p++) colSum[p] += table[d]![p]!;

      let chi2 = 0, validCells = 0;
      for (let d = 0; d < 31; d++) {
        for (let p = 0; p < 100; p++) {
          if (rowSum[d]! > 0 && colSum[p] > 0) {
            const exp = (rowSum[d]! * colSum[p]) / total;
            if (exp >= 1) {
              chi2 += Math.pow(table[d]![p]! - exp, 2) / exp;
              validCells++;
            }
          }
        }
      }
      const df = Math.max(1, validCells - 31 - 100 + 1);
      const p_value = 1 - chi2Cdf(chi2, df);
      const cramerV = Math.sqrt(chi2 / (total * Math.min(30, 99)));

      tests.push({
        feature_family: 'day_of_month',
        test_name:      `dom:${c.game}:${c.draw}`,
        game_type:      c.game, draw_type: c.draw,
        scope:          { df, valid_cells: validCells },
        null_hypothesis: `H0: distribución de pares independiente del día del mes`,
        test_statistic: chi2, p_value,
        bonferroni_threshold: 0, significant: false,
        effect_size: cramerV, effect_size_metric: 'cramer_v',
        sample_size: total,
        train_p_value: null, test_p_value: null, replicates_in_holdout: null,
        interpretation: `DOM bias ${c.game}/${c.draw}: χ²=${chi2.toFixed(0)} df=${df} p=${p_value.toExponential(2)} V=${cramerV.toFixed(4)} n=${total}. ${p_value < 0.01 ? 'Bias detectado.' : 'Sin bias por día del mes.'}`,
        data: { chi2, df, cramer_v: cramerV },
      });
    }
    return tests;
  }

  // ═══════════════════════════════════════════════════════════════
  // 5. MONTH/SEASONAL EFFECT
  // ═══════════════════════════════════════════════════════════════
  private async testMonthSeasonal(): Promise<TestResult[]> {
    const tests: TestResult[] = [];
    const cases = [
      { game: 'pick3', draw: 'evening', pairSql: '(p2*10 + p3)' },
      { game: 'pick4', draw: 'evening', pairSql: '(p1*10 + p2)' },
    ];

    for (const c of cases) {
      const { rows } = await this.pool.query<{ mon: string; pair: string; cnt: string }>(
        `SELECT EXTRACT(MONTH FROM draw_date)::int AS mon,
                ${c.pairSql} AS pair,
                COUNT(*)::int AS cnt
         FROM hitdash.ingested_results
         WHERE game_type=$1 AND draw_type=$2 AND p2 IS NOT NULL AND p3 IS NOT NULL
           ${c.pairSql.includes('p4') ? 'AND p4 IS NOT NULL' : ''}
         GROUP BY 1,2`,
        [c.game, c.draw],
      );
      if (rows.length === 0) continue;

      const table: number[][] = Array.from({ length: 12 }, () => new Array(100).fill(0));
      let total = 0;
      for (const r of rows) {
        const m = Number(r.mon) - 1;
        const p = parseInt(r.pair, 10);
        if (m >= 0 && m < 12 && p >= 0 && p < 100) {
          table[m]![p]! += Number(r.cnt);
          total += Number(r.cnt);
        }
      }
      if (total < 1200) continue;

      const rowSum = table.map(r => r.reduce((s, v) => s + v, 0));
      const colSum = new Array(100).fill(0);
      for (let m = 0; m < 12; m++) for (let p = 0; p < 100; p++) colSum[p] += table[m]![p]!;

      let chi2 = 0, validCells = 0;
      for (let m = 0; m < 12; m++) {
        for (let p = 0; p < 100; p++) {
          if (rowSum[m]! > 0 && colSum[p] > 0) {
            const exp = (rowSum[m]! * colSum[p]) / total;
            if (exp >= 1) { chi2 += Math.pow(table[m]![p]! - exp, 2) / exp; validCells++; }
          }
        }
      }
      const df = Math.max(1, validCells - 12 - 100 + 1);
      const p_value = 1 - chi2Cdf(chi2, df);
      const cramerV = Math.sqrt(chi2 / (total * Math.min(11, 99)));

      tests.push({
        feature_family: 'month_seasonal',
        test_name:      `month:${c.game}:${c.draw}`,
        game_type:      c.game, draw_type: c.draw,
        scope:          { df, valid_cells: validCells },
        null_hypothesis: `H0: distribución de pares independiente del mes`,
        test_statistic: chi2, p_value,
        bonferroni_threshold: 0, significant: false,
        effect_size: cramerV, effect_size_metric: 'cramer_v',
        sample_size: total,
        train_p_value: null, test_p_value: null, replicates_in_holdout: null,
        interpretation: `Month effect ${c.game}/${c.draw}: χ²=${chi2.toFixed(0)} p=${p_value.toExponential(2)} V=${cramerV.toFixed(4)} n=${total}. ${p_value < 0.01 ? 'Patrón estacional detectado.' : 'Sin estacionalidad.'}`,
        data: { chi2, df, cramer_v: cramerV },
      });
    }
    return tests;
  }

  // ═══════════════════════════════════════════════════════════════
  // 6. PAIR ANTI-SYMMETRY: P("23") vs P("32")
  // For each off-diagonal pair (i,j), test if count(ij) == count(ji)
  // ═══════════════════════════════════════════════════════════════
  private async testPairAntiSymmetry(): Promise<TestResult[]> {
    const tests: TestResult[] = [];
    const cases = [
      { game: 'pick3', draw: 'evening', pairSql: '(p2*10 + p3)' },
      { game: 'pick4', draw: 'evening', pairSql: '(p1*10 + p2)' },
    ];

    for (const c of cases) {
      const { rows } = await this.pool.query<{ pair: string; cnt: string }>(
        `SELECT ${c.pairSql} AS pair, COUNT(*)::int AS cnt
         FROM hitdash.ingested_results
         WHERE game_type=$1 AND draw_type=$2 AND p2 IS NOT NULL AND p3 IS NOT NULL
           ${c.pairSql.includes('p4') ? 'AND p4 IS NOT NULL' : ''}
         GROUP BY 1`,
        [c.game, c.draw],
      );
      if (rows.length === 0) continue;

      const counts = new Map<number, number>();
      let total = 0;
      for (const r of rows) {
        counts.set(parseInt(r.pair, 10), Number(r.cnt));
        total += Number(r.cnt);
      }

      // For each (i, j) with i < j, count "ij" vs "ji"
      // Aggregate chi² across all such pairs as test of symmetry
      let chi2 = 0;
      let testedPairs = 0;
      for (let i = 0; i < 10; i++) {
        for (let j = i + 1; j < 10; j++) {
          const ij = counts.get(i * 10 + j) ?? 0;
          const ji = counts.get(j * 10 + i) ?? 0;
          const sum = ij + ji;
          if (sum >= 10) {
            const exp = sum / 2;
            chi2 += Math.pow(ij - exp, 2) / exp + Math.pow(ji - exp, 2) / exp;
            testedPairs++;
          }
        }
      }
      const df = Math.max(1, testedPairs);
      const p_value = 1 - chi2Cdf(chi2, df);

      tests.push({
        feature_family: 'pair_antisymmetry',
        test_name:      `antisym:${c.game}:${c.draw}`,
        game_type:      c.game, draw_type: c.draw,
        scope:          { tested_pairs: testedPairs },
        null_hypothesis: `H0: para todo i≠j, P("ij") = P("ji")`,
        test_statistic: chi2, p_value,
        bonferroni_threshold: 0, significant: false,
        effect_size: testedPairs > 0 ? Math.sqrt(chi2 / total) : 0,
        effect_size_metric: 'phi',
        sample_size: total,
        train_p_value: null, test_p_value: null, replicates_in_holdout: null,
        interpretation: `Pair anti-symmetry ${c.game}/${c.draw}: χ²=${chi2.toFixed(2)} df=${df} p=${p_value.toExponential(2)} testedPairs=${testedPairs}. ${p_value < 0.01 ? 'Asimetría detectada — orden de dígitos importa.' : 'Simetría — orden no importa.'}`,
        data: { chi2, df, tested_pairs: testedPairs },
      });
    }
    return tests;
  }

  // ═══════════════════════════════════════════════════════════════
  // 7. PAIR-LEVEL AUTOCORRELATION (índice 0-99, no posición digit)
  // ═══════════════════════════════════════════════════════════════
  private async testPairAutocorrelation(): Promise<TestResult[]> {
    const tests: TestResult[] = [];
    const cases = [
      { game: 'pick3', draw: 'evening', pairSql: '(p2*10 + p3)' },
      { game: 'pick3', draw: 'midday',  pairSql: '(p2*10 + p3)' },
      { game: 'pick4', draw: 'evening', pairSql: '(p1*10 + p2)' },
      { game: 'pick4', draw: 'midday',  pairSql: '(p1*10 + p2)' },
    ];

    for (const c of cases) {
      const { rows } = await this.pool.query<{ pair: string }>(
        `SELECT ${c.pairSql} AS pair
         FROM hitdash.ingested_results
         WHERE game_type=$1 AND draw_type=$2 AND p2 IS NOT NULL AND p3 IS NOT NULL
         ORDER BY draw_date ASC, draw_key ASC`,
        [c.game, c.draw],
      );
      if (rows.length < 200) continue;
      const series = rows.map(r => parseInt(r.pair, 10));

      for (const lag of [1, 2, 7, 14, 30]) {
        if (series.length < lag + 100) continue;
        const a = series.slice(0, -lag);
        const b = series.slice(lag);
        const r = pearson(a, b);
        const n = a.length;
        const z = r * Math.sqrt(n);
        const p_value = 2 * (1 - normCdf(Math.abs(z)));

        tests.push({
          feature_family: 'pair_autocorrelation',
          test_name:      `pair_autocorr:${c.game}:${c.draw}:lag${lag}`,
          game_type:      c.game, draw_type: c.draw,
          scope:          { lag },
          null_hypothesis: `H0: r(lag-${lag}) = 0 sobre el índice del par`,
          test_statistic: r, p_value,
          bonferroni_threshold: 0, significant: false,
          effect_size: Math.abs(r), effect_size_metric: 'r',
          sample_size: n,
          train_p_value: null, test_p_value: null, replicates_in_holdout: null,
          interpretation: `Pair autocorr ${c.game}/${c.draw} lag-${lag}: r=${r.toFixed(4)} z=${z.toFixed(2)} p=${p_value.toExponential(2)} n=${n}. ${Math.abs(r) < 0.05 ? 'Sin autocorr.' : 'Posible autocorr.'}`,
          data: { r, z, lag, n },
        });
      }
    }
    return tests;
  }

  // ═══════════════════════════════════════════════════════════════
  // PERSISTENCE
  // ═══════════════════════════════════════════════════════════════
  private async persistTests(run_id: string, tests: TestResult[]): Promise<void> {
    if (tests.length === 0) return;
    const BATCH = 50;
    for (let i = 0; i < tests.length; i += BATCH) {
      const slice = tests.slice(i, i + BATCH);
      const cols = ['run_id', 'feature_family', 'test_name', 'game_type', 'draw_type', 'scope',
                    'null_hypothesis', 'test_statistic', 'p_value', 'bonferroni_threshold',
                    'significant', 'effect_size', 'effect_size_metric', 'sample_size',
                    'train_p_value', 'test_p_value', 'replicates_in_holdout',
                    'interpretation', 'data'];
      const params: unknown[] = [];
      const placeholders: string[] = [];
      let p = 1;
      for (const t of slice) {
        const tokens = cols.map(() => `$${p++}`);
        placeholders.push(`(${tokens.slice(0,5).join(',')}, ${tokens[5]}::jsonb, ${tokens.slice(6,18).join(',')}, ${tokens[18]}::jsonb)`);
        params.push(
          run_id, t.feature_family, t.test_name, t.game_type, t.draw_type,
          JSON.stringify(t.scope), t.null_hypothesis, t.test_statistic, t.p_value,
          t.bonferroni_threshold, t.significant, t.effect_size, t.effect_size_metric,
          t.sample_size, t.train_p_value, t.test_p_value, t.replicates_in_holdout,
          t.interpretation, JSON.stringify(t.data),
        );
      }
      await this.pool.query(
        `INSERT INTO hitdash.route_a_exploration_tests
           (run_id, feature_family, test_name, game_type, draw_type, scope,
            null_hypothesis, test_statistic, p_value, bonferroni_threshold,
            significant, effect_size, effect_size_metric, sample_size,
            train_p_value, test_p_value, replicates_in_holdout, interpretation, data)
         VALUES ${placeholders.join(',')}`,
        params,
      );
    }
  }
}
