// ═══════════════════════════════════════════════════════════════
// HELIX — RegimeMonitor v1.0 (2026-05-15)
//
// Detecta cambios de régimen comparando hit_rate de pair_recommendations
// en dos ventanas: corta (últimos 7d) vs larga (últimos 30d).
//
// CASOS DE USO:
//   - Régimen ESTABLE       (recent_rate / global_rate ∈ [0.7, 1.3])
//   - Régimen CALIENTE      (recent > global × 1.3) → algo cambió a favor
//   - Régimen FRÍO          (recent < global × 0.7) → cambió en contra
//   - REGRESIÓN CRÍTICA     (recent_rate < 5% y total ≥ 10)
//
// El monitor NO actúa — solo reporta. El Agent decide qué hacer:
//   - HelixSentinel puede emitir alerta Telegram
//   - DriftDetector puede confirmar drift estadístico
//   - Champion Mode puede rotar el algoritmo dominante
//
// Diferencia con DriftDetector: aquí miramos hit_rate REAL del motor,
// no la distribución de dígitos. Es más directo: ¿estamos acertando o no?
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';

const logger = pino({ name: 'RegimeMonitor' });

export type Regime = 'stable' | 'hot' | 'cold' | 'critical' | 'insufficient_data';

export interface RegimeReport {
  game_type:        string;
  draw_type:        string;
  regime:           Regime;
  recent_hit_rate:  number;     // ventana corta (7d)
  global_hit_rate:  number;     // ventana larga (30d)
  recent_total:     number;
  global_total:     number;
  ratio:            number;     // recent / global
  trend:            'improving' | 'declining' | 'stable';
  consecutive_misses: number;   // racha actual desde la última hit
  recommendation:   string;
  detected_at:      string;
}

export class RegimeMonitor {
  constructor(private readonly pool: Pool) {}

  async analyze(
    game_type: 'pick3' | 'pick4',
    draw_type: 'midday' | 'evening',
    recentDays: number = 7,
    globalDays: number = 30
  ): Promise<RegimeReport> {
    const now = new Date().toISOString();

    // Cargar predicciones resueltas en ventana global
    const { rows } = await this.pool.query<{
      day: string; hit: boolean; created_at: string;
    }>(
      `SELECT draw_date::text AS day, hit, created_at::text
       FROM hitdash.pair_recommendations
       WHERE game_type = $1 AND draw_type = $2
         AND hit IS NOT NULL
         AND created_at >= now() - ($3 || ' days')::interval
       ORDER BY created_at DESC`,
      [game_type, draw_type, globalDays]
    ).catch(() => ({ rows: [] as Array<{ day: string; hit: boolean; created_at: string }> }));

    if (rows.length < 5) {
      return this.empty(game_type, draw_type, now, rows.length);
    }

    // Particionar en ventanas
    const recentCutoff = new Date(Date.now() - recentDays * 86400000);
    const recent = rows.filter(r => new Date(r.created_at) >= recentCutoff);
    const global = rows;

    const recent_hits  = recent.filter(r => r.hit).length;
    const recent_total = recent.length;
    const global_hits  = global.filter(r => r.hit).length;
    const global_total = global.length;

    const recent_rate = recent_total > 0 ? recent_hits / recent_total : 0;
    const global_rate = global_total > 0 ? global_hits / global_total : 0;
    const ratio = global_rate > 0 ? recent_rate / global_rate : 0;

    // ─── Racha de misses consecutivos (desde el más reciente) ──────
    let consecutive_misses = 0;
    for (const r of rows) {
      if (r.hit === false) consecutive_misses++;
      else break;
    }

    // ─── Clasificación de régimen ───────────────────────────────────
    let regime: Regime;
    let recommendation: string;

    if (recent_total < 5) {
      regime = 'insufficient_data';
      recommendation = `Solo ${recent_total} predicciones recientes — esperar más data antes de evaluar`;
    } else if (recent_rate < 0.05 && recent_total >= 10) {
      regime = 'critical';
      recommendation = `🚨 CRÍTICO: ${(recent_rate * 100).toFixed(1)}% hit rate en últimos ${recent_total} sorteos. Considerar reset PPS o rotación de algoritmos.`;
    } else if (ratio < 0.7) {
      regime = 'cold';
      recommendation = `❄️ Régimen frío: hit_rate cayó ${((1 - ratio) * 100).toFixed(0)}% vs promedio. Champion Mode debe rotar si detecta algo emergente.`;
    } else if (ratio > 1.3) {
      regime = 'hot';
      recommendation = `🔥 Régimen caliente: hit_rate subió ${((ratio - 1) * 100).toFixed(0)}% vs promedio. Mantener configuración actual.`;
    } else {
      regime = 'stable';
      recommendation = `Régimen estable. Sistema dentro de rango esperado.`;
    }

    // ─── Tendencia (recent vs older within global window) ──────────
    let trend: 'improving' | 'declining' | 'stable' = 'stable';
    if (ratio > 1.1)      trend = 'improving';
    else if (ratio < 0.9) trend = 'declining';

    const report: RegimeReport = {
      game_type, draw_type, regime,
      recent_hit_rate: +recent_rate.toFixed(4),
      global_hit_rate: +global_rate.toFixed(4),
      recent_total, global_total,
      ratio: +ratio.toFixed(3),
      trend, consecutive_misses,
      recommendation,
      detected_at: now,
    };

    logger.info(
      {
        ...report,
        regime_color: regime === 'critical' ? '🚨' : regime === 'cold' ? '❄️' : regime === 'hot' ? '🔥' : '✅',
      },
      `RegimeMonitor: ${game_type} ${draw_type} → ${regime}`
    );

    return report;
  }

  /** Analiza los 4 combos principales y reporta resumen */
  async analyzeAll(): Promise<{
    overall_regime: Regime;
    critical_combos: string[];
    cold_combos:     string[];
    hot_combos:      string[];
    reports:         RegimeReport[];
  }> {
    const combos: Array<{ game_type: 'pick3' | 'pick4'; draw_type: 'midday' | 'evening' }> = [
      { game_type: 'pick3', draw_type: 'midday' },
      { game_type: 'pick3', draw_type: 'evening' },
      { game_type: 'pick4', draw_type: 'midday' },
      { game_type: 'pick4', draw_type: 'evening' },
    ];

    const reports = await Promise.all(combos.map(c => this.analyze(c.game_type, c.draw_type)));

    const critical_combos = reports.filter(r => r.regime === 'critical').map(r => `${r.game_type}/${r.draw_type}`);
    const cold_combos     = reports.filter(r => r.regime === 'cold').map(r => `${r.game_type}/${r.draw_type}`);
    const hot_combos      = reports.filter(r => r.regime === 'hot').map(r => `${r.game_type}/${r.draw_type}`);

    // Régimen global = peor de los 4 (más crítico)
    let overall_regime: Regime = 'stable';
    if (critical_combos.length > 0)      overall_regime = 'critical';
    else if (cold_combos.length >= 2)    overall_regime = 'cold';
    else if (hot_combos.length >= 2)     overall_regime = 'hot';
    else if (reports.every(r => r.regime === 'insufficient_data')) overall_regime = 'insufficient_data';

    return { overall_regime, critical_combos, cold_combos, hot_combos, reports };
  }

  private empty(game_type: string, draw_type: string, ts: string, count: number): RegimeReport {
    return {
      game_type, draw_type,
      regime:          'insufficient_data',
      recent_hit_rate: 0,
      global_hit_rate: 0,
      recent_total:    count,
      global_total:    count,
      ratio:           0,
      trend:           'stable',
      consecutive_misses: 0,
      recommendation:  `Solo ${count} predicciones resueltas. Necesita ≥ 5 para evaluar régimen.`,
      detected_at:     ts,
    };
  }
}
