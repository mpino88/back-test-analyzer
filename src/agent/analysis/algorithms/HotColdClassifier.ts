// ═══════════════════════════════════════════════════════════════
// HITDASH — HotColdClassifier v1.0.0
// Z-score binomial 7d vs 90d por posición — peso 0.85
// Hot: z > 1.5 | Warm: 0.5–1.5 | Neutral: ±0.5 | Cool: -1.5–-0.5 | Cold: < -1.5
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType, LotteryDigits } from '../../types/agent.types.js';
import { toDbGame, toDbPeriod, DRAWS_CTE_ALL } from '../ballbotAdapter.js';
import type {
  HotColdResult,
  HotColdEntry,
  HotColdLabel,
  AnalysisPeriod,
  Position,
  PairHalf,
} from '../../types/analysis.types.js';

const logger = pino({ name: 'HotColdClassifier' });

const POSITIONS: Record<GameType, Position[]> = {
  pick3: ['p1', 'p2', 'p3'],
  pick4: ['p1', 'p2', 'p3', 'p4'],
};

function zLabel(z: number): HotColdLabel {
  if (z > 1.5) return 'Hot';
  if (z > 0.5) return 'Warm';
  if (z >= -0.5) return 'Neutral';
  if (z >= -1.5) return 'Cool';
  return 'Cold';
}

// Binomial z-score: (observed_count - expected) / sqrt(expected * (1 - p))
// where expected = n * 0.10, p = 0.10
function binomialZ(count: number, n: number): number {
  if (n === 0) return 0;
  const expected = n * 0.1;
  const stdDev = Math.sqrt(n * 0.1 * 0.9);
  return stdDev > 0 ? (count - expected) / stdDev : 0;
}

export class HotColdClassifier {
  constructor(private readonly pool: Pool) {}

  async run(
    game_type: GameType,
    draw_type: DrawType,
    _period: AnalysisPeriod = 90
  ): Promise<HotColdResult> {
    const start = Date.now();
    const positions = POSITIONS[game_type];

    // Fetch draws for both 7d and 90d windows in one query
    const { rows } = await this.pool.query<{ draw_date: Date; digits: LotteryDigits }>(
      `${DRAWS_CTE_ALL}
       SELECT draw_date, digits FROM lottery_results
       WHERE created_at >= now() - interval '90 days'
       ORDER BY draw_date DESC`,
      [toDbGame(game_type), toDbPeriod(draw_type)]
    );

    const cutoff7d = new Date(Date.now() - 7 * 86_400_000);

    const rows7d = rows.filter(r => new Date(r.draw_date) >= cutoff7d);
    const rows90d = rows;

    const n7  = rows7d.length;
    const n90 = rows90d.length;

    const by_position: Record<Position, HotColdEntry[]> = {} as Record<Position, HotColdEntry[]>;

    for (const pos of positions) {
      const entries: HotColdEntry[] = [];

      for (let d = 0; d <= 9; d++) {
        const count7  = rows7d.filter(r => (r.digits as Record<string, number>)[pos] === d).length;
        const count90 = rows90d.filter(r => (r.digits as Record<string, number>)[pos] === d).length;

        const z7  = +binomialZ(count7, n7).toFixed(3);
        const z90 = +binomialZ(count90, n90).toFixed(3);

        const label7d  = zLabel(z7);
        const label90d = zLabel(z90);

        entries.push({
          digit: d,
          position: pos,
          z_score_7d:  z7,
          z_score_90d: z90,
          label_7d:  label7d,
          label_90d: label90d,
          // trend_change: hot/warm in 7d but neutral/cool/cold in 90d (or vice versa)
          trend_change:
            (label7d === 'Hot' || label7d === 'Warm') !==
            (label90d === 'Hot' || label90d === 'Warm'),
        });
      }

      entries.sort((a, b) => b.z_score_7d - a.z_score_7d);
      by_position[pos] = entries;
    }

    const hotSummary = positions
      .map(p => {
        const hot = by_position[p]!.filter(e => e.label_7d === 'Hot' || e.label_7d === 'Warm')
          .map(e => `${e.digit}(${e.label_7d})`)
          .join(',');
        return hot ? `${p.toUpperCase()}:[${hot}]` : null;
      })
      .filter(Boolean)
      .join(' ');

    logger.info({ game_type, draw_type, n7d: n7, n90d: n90 }, 'HotColdClassifier completado');

    return {
      algorithm_name: 'hot_cold',
      algorithm_version: '1.0.0',
      game_type,
      period: 90,
      input_params: { game_type, draw_type, window_7d: n7, window_90d: n90 },
      output_data: { by_position },
      output_summary: `HotCold ${game_type} ${draw_type} (7d n=${n7}, 90d n=${n90}): ${hotSummary || 'no signals'}`.slice(0, 500),
      execution_ms: Date.now() - start,
    };
  }

  // ─── Pair mode (v2) ─────────────────────────────────────────────
  async runPairs(
    game_type: GameType,
    draw_type: DrawType,
    half: PairHalf,
    _period: AnalysisPeriod = 90
  ): Promise<Record<string, number>> {
    const [posA, posB] = half === 'du' ? ['p2', 'p3'] : half === 'ab' ? ['p1', 'p2'] : ['p3', 'p4'];

    const { rows } = await this.pool.query<{ draw_date: Date; digits: LotteryDigits }>(
      `${DRAWS_CTE_ALL}
       SELECT draw_date, digits FROM lottery_results ORDER BY draw_date DESC`,
      [toDbGame(game_type), toDbPeriod(draw_type)]
    );

    const cutoff7d = new Date(Date.now() - 7 * 86_400_000);
    const rows7d = rows.filter(r => new Date(r.draw_date) >= cutoff7d);
    const n7 = rows7d.length;
    const n90 = rows.length;

    const counts7: Record<string, number> = {};
    const counts90: Record<string, number> = {};

    for (const row of rows) {
      const d = row.digits as Record<string, number | undefined>;
      const a = d[posA!], b = d[posB!];
      if (a !== undefined && b !== undefined) {
        const key = `${a}${b}`;
        counts90[key] = (counts90[key] ?? 0) + 1;
      }
    }
    for (const row of rows7d) {
      const d = row.digits as Record<string, number | undefined>;
      const a = d[posA!], b = d[posB!];
      if (a !== undefined && b !== undefined) {
        const key = `${a}${b}`;
        counts7[key] = (counts7[key] ?? 0) + 1;
      }
    }

    // Binomial z-score for pairs (expected = n * 0.01)
    const pExp = 0.01;
    function pairZ(count: number, n: number): number {
      if (n === 0) return 0;
      const std = Math.sqrt(n * pExp * (1 - pExp));
      return std > 0 ? (count - n * pExp) / std : 0;
    }
    // Sigmoid [0, 1]
    function sigmoid(z: number): number { return 1 / (1 + Math.exp(-z)); }

    const scores: Record<string, number> = {};
    for (let x = 0; x <= 9; x++) {
      for (let y = 0; y <= 9; y++) {
        const key = `${x}${y}`;
        const z7  = pairZ(counts7[key]  ?? 0, n7);
        const z90 = pairZ(counts90[key] ?? 0, n90);
        scores[key] = sigmoid(0.6 * z7 + 0.4 * z90);
      }
    }
    return scores;
  }
}
