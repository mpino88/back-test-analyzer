// ═══════════════════════════════════════════════════════════════
// HITDASH — LearningEmbedder v1.0.0
// Persiste feedback en feedback_loop + rag_knowledge (category=learning)
// Idempotente: UNIQUE(carton_id, draw_id) en feedback_loop
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import { RAGService } from '../services/RAGService.js';
import type { ComparisonResult } from './ResultComparator.js';

const logger = pino({ name: 'LearningEmbedder' });

export class LearningEmbedder {
  constructor(
    private readonly agentPool: Pool,
    private readonly ragService: RAGService
  ) {}

  // ─── Persistir un resultado de comparación ───────────────────
  async embed(result: ComparisonResult): Promise<string | null> {
    const {
      carton_id, draw_id, predicted, actual,
      hits_exact, hits_partial, accuracy_score, learning_notes,
    } = result;

    // ─── 1. Persistir en feedback_loop (idempotente) ─────────────
    const existing = await this.agentPool.query<{ id: string }>(
      `SELECT id FROM hitdash.feedback_loop WHERE carton_id = $1 AND draw_id = $2`,
      [carton_id, draw_id]
    );

    if (existing.rows.length > 0) {
      logger.info({ carton_id, draw_id }, 'LearningEmbedder: feedback ya existe — skip');
      return existing.rows[0]!.id;
    }

    // Actualizar result_status en carton_generations
    const resultStatus =
      hits_exact > 0 ? 'hit' :
      hits_partial >= 2 ? 'partial' : 'miss';

    await this.agentPool.query(
      `UPDATE hitdash.carton_generations
       SET result_status = $2, draw_id = $3
       WHERE id = $1`,
      [carton_id, resultStatus, draw_id]
    );

    // ─── 2. Generar embedding del learning_notes ─────────────────
    // ═══ BN-13 FIX: Embeddear TODOS los resultados (hit, partial, miss) ═══
    // Los misses son aprendizaje negativo igual de valioso: enseñan al agente
    // qué patrones NO funcionan y con qué confianza evitarlos.
    let ragKnowledgeId: string | null = null;

    try {
      // Confianza ponderada por resultado: hit=alta, partial=media, miss=baja
      const ragConfidence =
        hits_exact > 0 ? accuracy_score :
        hits_partial >= 2 ? accuracy_score * 0.6 :
        0.20; // miss: confianza mínima pero registrado

      ragKnowledgeId = await this.ragService.storeKnowledge({
        content: learning_notes,
        category: 'learning',
        source: `feedback:${carton_id}:${draw_id}`,
        confidence: ragConfidence,
        metadata: {
          carton_id,
          draw_id,
          hits_exact,
          hits_partial,
          result_status: resultStatus,
          is_negative_example: resultStatus === 'miss',
        },
      });
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'LearningEmbedder: error generando embedding — guardando sin vector'
      );
    }

    // ─── 3. Insertar en feedback_loop ────────────────────────────
    const feedbackResult = await this.agentPool.query<{ id: string }>(
      `INSERT INTO hitdash.feedback_loop
         (carton_id, draw_id, predicted, actual,
          hits_exact, hits_partial, accuracy_score, learning_notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (carton_id, draw_id) DO NOTHING
       RETURNING id`,
      [
        carton_id,
        draw_id,
        JSON.stringify(predicted),
        JSON.stringify(actual),
        hits_exact,
        hits_partial,
        accuracy_score,
        learning_notes,
      ]
    );

    const feedbackId = feedbackResult.rows[0]?.id ?? null;

    logger.info(
      { feedback_id: feedbackId, carton_id, result_status: resultStatus, rag_id: ragKnowledgeId },
      'LearningEmbedder: feedback persistido'
    );

    return feedbackId;
  }

  // ─── Persistir múltiples resultados ──────────────────────────
  async embedMany(results: ComparisonResult[]): Promise<{ embedded: number; skipped: number }> {
    let embedded = 0;
    let skipped = 0;

    for (const result of results) {
      const id = await this.embed(result);
      if (id) embedded++;
      else skipped++;
    }

    logger.info({ embedded, skipped }, 'LearningEmbedder: batch completado');
    return { embedded, skipped };
  }

  // ─── Stats de accuracy recientes ─────────────────────────────
  async getRecentAccuracy(days = 30): Promise<{
    avg_accuracy: number;
    total_cartones: number;
    hit_rate: number;
  }> {
    const result = await this.agentPool.query<{
      avg_accuracy: number;
      total_cartones: string;
      hit_count: string;
    }>(
      `SELECT
         ROUND(AVG(accuracy_score)::numeric, 4)::float AS avg_accuracy,
         COUNT(*)::text AS total_cartones,
         SUM(CASE WHEN hits_exact > 0 THEN 1 ELSE 0 END)::text AS hit_count
       FROM hitdash.feedback_loop
       WHERE learned_at >= now() - ($1 || ' days')::interval`,
      [days]
    );

    const row = result.rows[0];
    const total = parseInt(row?.total_cartones ?? '0', 10);
    const hits  = parseInt(row?.hit_count ?? '0', 10);

    return {
      avg_accuracy: row?.avg_accuracy ?? 0,
      total_cartones: total,
      hit_rate: total > 0 ? +(hits / total).toFixed(4) : 0,
    };
  }
}
