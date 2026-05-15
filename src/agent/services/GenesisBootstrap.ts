// ═══════════════════════════════════════════════════════════════
// HELIX — GenesisBootstrap v1.0 (2026-05-15)
//
// "Big Bang Cognitivo": detona el aprendizaje retroactivo completo
// usando los 39,764 sorteos históricos que YA tenemos en la BD.
//
// FILOSOFÍA:
//   En vez de esperar a que pasen N sorteos nuevos para que Champion Mode
//   tenga datos, replica el FUTURO desde el PASADO. Walk-forward estricto:
//   para cada sorteo histórico X, usamos solo data prior < X. Sin leakage.
//
// PIPELINE EN 4 ETAPAS (idempotente — re-ejecutable sin daño):
//
//   ETAPA 1 — SNAPSHOT BACKFILL (8 algos point-in-time SQL)
//     SnapshotBackfillService.backfillRange()
//     → algo_prediction_snapshot poblado para últimos N sorteos × 6 combos
//
//   ETAPA 2 — PPS REPLAY (apply post-draw learning retroactively)
//     PPSService.seedPPSFromReplay() para cada combo
//     → algo_rank_history se llena con ranks históricos reales
//     → pps_state se actualiza con sample_count alto (mature mode α=0.15)
//
//   ETAPA 3 — COGNITIVE LEARNER (optimal weights from full history)
//     CognitiveLearner.learnFromHistory() por combo
//     → cognitive_algo_weights con pesos optimizados
//
//   ETAPA 4 — CHAMPION DETECTION (immediate)
//     PPSService.detectChampion() para cada combo
//     → reporta si ya hay champion identificado
//
// RESULTADO:
//   Sistema arranca con PPS bootstrappeado, pesos optimizados, y posibles
//   champions detectados desde el primer ciclo del agente.
//   NO necesita esperar 20-30 sorteos para auto-calibrarse.
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import { SnapshotBackfillService } from './SnapshotBackfillService.js';
import { PPSService } from './PPSService.js';
import { CognitiveLearner } from '../learning/CognitiveLearner.js';

const logger = pino({ name: 'GenesisBootstrap' });

// 6 combos canónicos del sistema
const ALL_COMBOS: Array<{ game_type: 'pick3' | 'pick4'; draw_type: 'midday' | 'evening'; half: 'du' | 'ab' | 'cd' }> = [
  { game_type: 'pick3', draw_type: 'midday',  half: 'du' },
  { game_type: 'pick3', draw_type: 'evening', half: 'du' },
  { game_type: 'pick4', draw_type: 'midday',  half: 'ab' },
  { game_type: 'pick4', draw_type: 'midday',  half: 'cd' },
  { game_type: 'pick4', draw_type: 'evening', half: 'ab' },
  { game_type: 'pick4', draw_type: 'evening', half: 'cd' },
];

export interface GenesisProgress {
  stage:           1 | 2 | 3 | 4;
  stage_name:      string;
  combo:           string;
  status:          'starting' | 'running' | 'done' | 'error';
  details?:        string;
  progress_pct?:   number;
}

export interface GenesisComboReport {
  combo:                  string;
  // Stage 1
  snapshots_dates:        number;
  snapshots_skipped:      number;
  snapshots_total:        number;
  // Stage 2
  ranks_replayed:         number;
  algos_updated:          number;
  // Stage 3
  cognitive_weights_set:  number;
  cognitive_holdout_rate: number | null;
  // Stage 4
  champion:               { algo_name: string; rate: number; samples: number } | null;
  // Meta
  duration_ms:            number;
  errors:                 string[];
}

export interface GenesisReport {
  total_duration_ms:      number;
  combos:                 GenesisComboReport[];
  champions_detected:     Array<{ combo: string; champion: string; rate: number }>;
  global_summary: {
    total_snapshots:        number;
    total_ranks_replayed:   number;
    total_cognitive_runs:   number;
    total_champions:        number;
  };
}

export class GenesisBootstrap {
  private readonly backfill:  SnapshotBackfillService;
  private readonly pps:       PPSService;
  private readonly cognitive: CognitiveLearner;

  constructor(private readonly pool: Pool) {
    this.backfill  = new SnapshotBackfillService(pool);
    this.pps       = new PPSService(pool);
    this.cognitive = new CognitiveLearner(pool);
  }

  // ════════════════════════════════════════════════════════════════
  // Ejecuta el pipeline completo (idempotente)
  //
  // @param lookbackDays  Cuántos días hacia atrás procesar (default 365)
  // @param onProgress    Callback para SSE/UI con actualizaciones live
  // ════════════════════════════════════════════════════════════════
  async run(
    lookbackDays: number = 365,
    combos: typeof ALL_COMBOS = ALL_COMBOS,
    onProgress?: (p: GenesisProgress) => void
  ): Promise<GenesisReport> {
    const t0 = Date.now();
    const combosReports: GenesisComboReport[] = [];
    const champions: Array<{ combo: string; champion: string; rate: number }> = [];

    logger.info({ lookbackDays, combos: combos.length }, '🌱 Genesis Bootstrap iniciado');

    for (const combo of combos) {
      const comboLabel = `${combo.game_type}/${combo.draw_type}/${combo.half}`;
      const tCombo = Date.now();
      const errors: string[] = [];

      const report: GenesisComboReport = {
        combo: comboLabel,
        snapshots_dates: 0, snapshots_skipped: 0, snapshots_total: 0,
        ranks_replayed: 0, algos_updated: 0,
        cognitive_weights_set: 0, cognitive_holdout_rate: null,
        champion: null,
        duration_ms: 0,
        errors: [],
      };

      // ── ETAPA 1: Snapshot Backfill ─────────────────────────────────
      try {
        onProgress?.({ stage: 1, stage_name: 'Snapshot Backfill', combo: comboLabel, status: 'starting' });
        const summary = await this.backfill.backfillRange(
          combo.game_type, combo.draw_type, combo.half,
          lookbackDays, lookbackDays,
          (done, total, date) => {
            const pct = total > 0 ? Math.round((done / total) * 100) : 0;
            onProgress?.({
              stage: 1, stage_name: 'Snapshot Backfill', combo: comboLabel,
              status: 'running', details: `${done}/${total} (${date})`, progress_pct: pct,
            });
          }
        );
        report.snapshots_dates    = summary.dates_processed;
        report.snapshots_skipped  = summary.dates_skipped;
        report.snapshots_total    = summary.total_snapshots;
        onProgress?.({ stage: 1, stage_name: 'Snapshot Backfill', combo: comboLabel, status: 'done', details: `${summary.total_snapshots} snapshots` });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Stage1: ${msg}`);
        onProgress?.({ stage: 1, stage_name: 'Snapshot Backfill', combo: comboLabel, status: 'error', details: msg });
      }

      // ── ETAPA 2: PPS Replay (apply rank learning retroactively) ─────
      try {
        onProgress?.({ stage: 2, stage_name: 'PPS Replay', combo: comboLabel, status: 'starting' });
        // Calcular lookbackDraws desde lookbackDays (asumiendo 1 sorteo/día por turno)
        const lookbackDraws = lookbackDays;
        const replay = await this.pps.seedPPSFromReplay(combo.game_type, combo.draw_type, combo.half, lookbackDraws);
        report.ranks_replayed = replay.replayed;
        report.algos_updated  = replay.algos_updated;
        onProgress?.({ stage: 2, stage_name: 'PPS Replay', combo: comboLabel, status: 'done', details: `${replay.replayed} sorteos × ${replay.algos_updated} algos` });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Stage2: ${msg}`);
        onProgress?.({ stage: 2, stage_name: 'PPS Replay', combo: comboLabel, status: 'error', details: msg });
      }

      // ── ETAPA 3: Cognitive Learner (optimal weights) ────────────────
      try {
        onProgress?.({ stage: 3, stage_name: 'Cognitive Learner', combo: comboLabel, status: 'starting' });
        const cogReport = await this.cognitive.learnFromHistory(combo.game_type, combo.draw_type, combo.half);
        report.cognitive_weights_set  = cogReport.algos_updated ?? 0;
        report.cognitive_holdout_rate = cogReport.holdout_hit_rate ?? null;
        onProgress?.({
          stage: 3, stage_name: 'Cognitive Learner', combo: comboLabel, status: 'done',
          details: `${cogReport.algos_updated} algos · holdout ${((cogReport.holdout_hit_rate ?? 0) * 100).toFixed(1)}% · draws ${cogReport.draws_learned}`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Stage3: ${msg}`);
        onProgress?.({ stage: 3, stage_name: 'Cognitive Learner', combo: comboLabel, status: 'error', details: msg });
      }

      // ── ETAPA 4: Champion Detection ─────────────────────────────────
      try {
        onProgress?.({ stage: 4, stage_name: 'Champion Detection', combo: comboLabel, status: 'starting' });
        const champ = await this.pps.detectChampion(combo.game_type, combo.draw_type, combo.half, 30);
        if (champ) {
          report.champion = {
            algo_name: champ.algo_name,
            rate:      champ.rate,
            samples:   champ.total,
          };
          champions.push({ combo: comboLabel, champion: champ.algo_name, rate: champ.rate });
          onProgress?.({
            stage: 4, stage_name: 'Champion Detection', combo: comboLabel, status: 'done',
            details: `🏆 ${champ.algo_name} @ ${(champ.rate * 100).toFixed(1)}%`,
          });
        } else {
          onProgress?.({ stage: 4, stage_name: 'Champion Detection', combo: comboLabel, status: 'done', details: 'sin champion (consenso normal)' });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Stage4: ${msg}`);
        onProgress?.({ stage: 4, stage_name: 'Champion Detection', combo: comboLabel, status: 'error', details: msg });
      }

      report.duration_ms = Date.now() - tCombo;
      report.errors      = errors;
      combosReports.push(report);

      logger.info(
        {
          combo: comboLabel,
          snapshots: report.snapshots_total,
          ranks: report.ranks_replayed,
          champion: report.champion?.algo_name ?? 'none',
          duration_ms: report.duration_ms,
        },
        '✅ Genesis combo completado'
      );
    }

    const total_duration_ms = Date.now() - t0;
    const total_snapshots      = combosReports.reduce((s, r) => s + r.snapshots_total, 0);
    const total_ranks_replayed = combosReports.reduce((s, r) => s + r.ranks_replayed, 0);
    const total_cognitive_runs = combosReports.filter(r => r.cognitive_weights_set > 0).length;

    logger.info(
      { combos: combosReports.length, total_snapshots, total_ranks_replayed, champions: champions.length, total_duration_ms },
      '🌱 Genesis Bootstrap completado'
    );

    return {
      total_duration_ms,
      combos: combosReports,
      champions_detected: champions,
      global_summary: {
        total_snapshots,
        total_ranks_replayed,
        total_cognitive_runs,
        total_champions: champions.length,
      },
    };
  }
}
