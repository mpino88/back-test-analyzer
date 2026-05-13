// ═══════════════════════════════════════════════════════════════
// HITDASH — BallbotAdapter
// Normaliza el schema real de Ballbot (public.draws) al formato
// interno esperado por los 8 algoritmos.
//
// Schema real Ballbot:
//   game   : 'p3' | 'p4'
//   period : 'm' | 'e'
//   numbers: '9,8,5'  (CSV string)
//   date   : '03/22/26' (MM/DD/YY)
//   created_at: timestamptz
// ═══════════════════════════════════════════════════════════════

import type { GameType, DrawType } from '../types/agent.types.js';

export function toDbGame(game_type: GameType): string {
  return game_type; // Se guardan como 'pick3' o 'pick4'
}

export function toDbPeriod(draw_type: DrawType): string {
  return draw_type; // Se guardan como 'midday' o 'evening'
}

/**
 * ═══ x10 PRO OPTIMIZATION ═══
 * CTE que lee de la base de datos LOCAL (hitdash.ingested_results)
 * con dígitos ya parseados. Elimina la latencia de red externa y el split_part cost.
 *
 * buildDrawsCTE(as_of_date?) — versión point-in-time para backfill histórico.
 * Sin as_of_date: comportamiento actual (CURRENT_DATE).
 * Con as_of_date: filtra draw_date < as_of_date (solo datos disponibles en esa fecha).
 */
export function buildDrawsCTE(as_of_date?: string): string {
  if (as_of_date) {
    return `
WITH lottery_results AS (
  SELECT
    draw_date,
    jsonb_build_object('p1', p1, 'p2', p2, 'p3', p3, 'p4', p4) AS digits
  FROM hitdash.ingested_results
  WHERE game_type = $1
    AND draw_type = $2
    AND draw_date >= '${as_of_date}'::date - ($3 || ' days')::interval
    AND draw_date <  '${as_of_date}'::date
)`;
  }
  return `
WITH lottery_results AS (
  SELECT
    draw_date,
    jsonb_build_object('p1', p1, 'p2', p2, 'p3', p3, 'p4', p4) AS digits
  FROM hitdash.ingested_results
  WHERE game_type = $1
    AND draw_type = $2
    AND draw_date >= CURRENT_DATE - ($3 || ' days')::interval
)`;
}

/** Backward-compatible constant — usa CURRENT_DATE */
export const DRAWS_CTE = buildDrawsCTE();

export const DRAWS_CTE_ALL = `
WITH lottery_results AS (
  SELECT
    draw_date,
    jsonb_build_object(
      'p1', p1,
      'p2', p2,
      'p3', p3,
      'p4', p4
    ) AS digits
  FROM hitdash.ingested_results
  WHERE game_type = $1
    AND draw_type = $2
    AND draw_date >= CURRENT_DATE - interval '1095 days'
)`;
