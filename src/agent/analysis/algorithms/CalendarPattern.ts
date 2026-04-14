// ═══════════════════════════════════════════════════════════════
// HITDASH — CalendarPattern v1.0.0
// Clonación quirúrgica de ballbot/calendar_pattern
//
// 4 dimensiones temporales para el próximo sorteo estimado:
//   DoW × Mes   (peso 0.40)
//   DoW solo    (peso 0.30)
//   Mes solo    (peso 0.20)
//   Día del mes (peso 0.10)
//
// Próxima fecha estimada = MAX(draw_date) + 1 día
//
// Fuente: hitdash.ingested_results
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType } from '../../types/agent.types.js';
import { DRAWS_CTE_ALL } from '../ballbotAdapter.js';
import type { AnalysisPeriod, PairHalf, CalendarPatternResult } from '../../types/analysis.types.js';

const logger = pino({ name: 'CalendarPattern' });

// Dimension weights
const W_DOW_MONTH = 0.40;
const W_DOW       = 0.30;
const W_MONTH     = 0.20;
const W_DOM       = 0.10;

function extractPair(
  p1: number, p2: number, p3: number, p4: number, half: PairHalf
): string {
  if (half === 'ab') return `${p1}${p2}`;
  if (half === 'cd') return `${p3}${p4}`;
  return `${p2}${p3}`; // 'du'
}

export class CalendarPattern {
  constructor(private readonly pool: Pool) {}

  async run(
    game_type: GameType,
    draw_type: DrawType,
    period: AnalysisPeriod = 90
  ): Promise<CalendarPatternResult> {
    const start  = Date.now();
    const scores = await this.runPairs(game_type, draw_type, 'du', period);
    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const topPairs = sorted.slice(0, 20).map(([pair, score]) => ({ pair, score, dow_hits: 0, month_hits: 0 }));

    return {
      algorithm_name:    'calendar_pattern',
      algorithm_version: '1.0.0',
      game_type,
      period,
      input_params: { game_type, draw_type },
      output_data:  { target_dow: 0, target_month: 0, top_pairs: topPairs },
      output_summary: `CalendarPattern top-3: ${sorted.slice(0, 3).map(([p]) => p).join(', ')}`,
      execution_ms: Date.now() - start,
    };
  }

  async runPairs(
    game_type: GameType,
    draw_type: DrawType,
    half: PairHalf,
    _period: AnalysisPeriod = 90
  ): Promise<Record<string, number>> {
    const start = Date.now();

    const { rows } = await this.pool.query<{
      p1: number; p2: number; p3: number; p4: number;
      draw_date: string;
    }>(
      `${DRAWS_CTE_ALL}
       SELECT (digits->>'p1')::int AS p1, (digits->>'p2')::int AS p2,
              (digits->>'p3')::int AS p3, (digits->>'p4')::int AS p4,
              draw_date::text
       FROM lottery_results
       ORDER BY draw_date ASC`,
      [game_type, draw_type]
    );

    const total = rows.length;
    if (total < 5) {
      const flat: Record<string, number> = {};
      for (let x = 0; x <= 9; x++) for (let y = 0; y <= 9; y++) flat[`${x}${y}`] = 0;
      return flat;
    }

    // Estimate next draw date = last date + 1 day
    const lastDateStr = rows[rows.length - 1]!.draw_date.substring(0, 10);
    const nextDate    = new Date(lastDateStr);
    nextDate.setDate(nextDate.getDate() + 1);

    const targetDow   = nextDate.getDay();           // 0=Sun…6=Sat
    const targetMonth = nextDate.getMonth() + 1;     // 1-12
    const targetDom   = nextDate.getDate();           // 1-31

    // ── Accumulate counts per dimension per pair ─────────────────────────
    // dim1: dow×month key → counts per pair
    // dim2: dow → counts per pair
    // dim3: month → counts per pair
    // dim4: dom → counts per pair

    const dim1: Map<string, Record<string, number>> = new Map();
    const dim2: Map<number, Record<string, number>> = new Map();
    const dim3: Map<number, Record<string, number>> = new Map();
    const dim4: Map<number, Record<string, number>> = new Map();

    function addCount(dim: Map<number | string, Record<string, number>>, key: number | string, pair: string): void {
      if (!dim.has(key)) dim.set(key, {});
      const bucket = dim.get(key)!;
      bucket[pair] = (bucket[pair] ?? 0) + 1;
    }

    for (const r of rows) {
      const d       = new Date(r.draw_date.substring(0, 10));
      const dow     = d.getDay();
      const month   = d.getMonth() + 1;
      const dom     = d.getDate();
      const pair    = extractPair(r.p1, r.p2, r.p3, r.p4, half);
      const dm_key  = `${dow}_${month}`;

      addCount(dim1, dm_key, pair);
      addCount(dim2, dow,    pair);
      addCount(dim3, month,  pair);
      addCount(dim4, dom,    pair);
    }

    // ── Build raw score per pair ─────────────────────────────────────────
    function bucketScore(dim: Map<number | string, Record<string, number>>, key: number | string, pair: string): number {
      const bucket = dim.get(key) ?? {};
      const pairCnt = bucket[pair] ?? 0;
      const total   = Object.values(bucket).reduce((s, v) => s + v, 0);
      return total > 0 ? pairCnt / total : 0;
    }

    const raw: Record<string, number> = {};
    for (let x = 0; x <= 9; x++) {
      for (let y = 0; y <= 9; y++) {
        const p = `${x}${y}`;
        const dm_key = `${targetDow}_${targetMonth}`;
        const s1 = bucketScore(dim1, dm_key,     p);
        const s2 = bucketScore(dim2, targetDow,   p);
        const s3 = bucketScore(dim3, targetMonth, p);
        const s4 = bucketScore(dim4, targetDom,   p);
        raw[p] = W_DOW_MONTH * s1 + W_DOW * s2 + W_MONTH * s3 + W_DOM * s4;
      }
    }

    // Normalize to [0, 1]
    const maxRaw = Math.max(...Object.values(raw), 1e-9);
    const scores: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) scores[k] = v / maxRaw;

    logger.debug({ game_type, draw_type, half, target_dow: targetDow, target_month: targetMonth, elapsed_ms: Date.now() - start }, 'CalendarPattern.runPairs done');
    return scores;
  }
}
