// ═══════════════════════════════════════════════════════════════
// HITDASH — RAGService v2.0
// Embedder intercambiable: gemini-embedding-001 por defecto
// Rate limiting: 50 RPM (token bucket)
// Idempotencia: ON CONFLICT (source, category) DO UPDATE
// ═══════════════════════════════════════════════════════════════

import { GoogleGenAI } from '@google/genai';
import type { Pool } from 'pg';
import pino from 'pino';
import type { RagResult, StoreKnowledgeInput, RagCategory } from '../types/agent.types.js';
import type { TelegramNotifier } from './TelegramNotifier.js';

export type EmbedderFn = (text: string) => Promise<number[]>;

const logger = pino({ name: 'RAGService' });

// Token bucket para rate limiting (50 RPM = 1 token cada 1200ms)
class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRateMs: number;

  constructor(maxTokens: number, refillRateMs: number) {
    this.maxTokens = maxTokens;
    this.refillRateMs = refillRateMs;
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  async consume(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const refills = Math.floor(elapsed / this.refillRateMs);
    if (refills > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + refills);
      this.lastRefill = now;
    }
    if (this.tokens <= 0) {
      const waitMs = this.refillRateMs - (now - this.lastRefill);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      this.tokens = 1;
    }
    this.tokens--;
  }
}

export class RAGService {
  private readonly pool: Pool;
  private readonly embedder: EmbedderFn;
  private readonly bucket: TokenBucket;
  private notifier: TelegramNotifier | null = null;
  private fallbackActive = false; // dedup — only notify once per degradation event

  constructor(pool: Pool, embedder?: EmbedderFn) {
    this.pool = pool;
    this.bucket = new TokenBucket(50, 1200); // 50 RPM
    this.embedder = embedder ?? this.defaultEmbedder.bind(this);
  }

  /** Inject TelegramNotifier — fires notifyEmbeddingFallback when Gemini degrades */
  setNotifier(notifier: TelegramNotifier): void {
    this.notifier = notifier;
    logger.info('RAGService: TelegramNotifier vinculado');
  }

  private async defaultEmbedder(text: string): Promise<number[]> {
    const apiKey = process.env['GEMINI_API_KEY'];
    if (!apiKey) throw new Error('GEMINI_API_KEY no configurada');

    const ai = new GoogleGenAI({ apiKey });
    const result = await ai.models.embedContent({
      model: 'gemini-embedding-001',
      contents: text,
    });

    const values = result.embeddings?.[0]?.values;
    if (!values || values.length !== 3072) {
      throw new Error(`Embedding inválido: dimensiones recibidas ${values?.length ?? 0}, esperadas 3072`);
    }
    return values;
  }

  // ─── Embedding pseudo-vectorial de emergencia ──────────────────
  // Activo cuando Gemini devuelve 403 / PERMISSION_DENIED.
  // Dimensiones: 3072 (compatible con pgvector schema).
  // Semántica: reducida pero estable — el mismo texto siempre genera el mismo vector.
  // El agente mantiene TODA su funcionalidad cognitiva; solo pierde precisión semántica.
  private pseudoEmbedding(text: string): number[] {
    const DIM = 3072;
    const vec = new Array<number>(DIM).fill(0);
    // Hash determinista: distribución uniforme por familia de caracteres
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      const slot = (code * 2654435761 + i * 1073676287) % DIM;
      vec[Math.abs(slot)] = (vec[Math.abs(slot)]! + Math.sin(code + i)) / 2;
    }
    // Normalizar a magnitud unitaria (igual que los embeddings reales)
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map(v => v / norm);
  }

  async embedText(text: string): Promise<number[]> {
    await this.bucket.consume();

    let lastError: Error | null = null;
    const delays = [1000, 2000, 4000];

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const embedding = await this.embedder(text);
        // Embedding real exitoso: si el fallback estaba activo, ya no lo está
        if (this.fallbackActive) {
          this.fallbackActive = false;
          logger.info('RAGService: Gemini Embedding recuperado — modo real restaurado');
        }
        logger.info({ attempt: attempt + 1, dims: embedding.length }, 'Embedding generado');
        return embedding;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const is403 = lastError.message.includes('403') || lastError.message.includes('PERMISSION_DENIED');

        if (is403) {
          logger.warn(
            { model: 'gemini-embedding-001', fix: 'Habilitar API en https://aistudio.google.com' },
            '⚠️  Gemini Embedding API sin permisos — activando modo fallback pseudo-vectorial'
          );
          // Notificar admin solo la primera vez (dedup)
          if (!this.fallbackActive && this.notifier) {
            this.fallbackActive = true;
            this.notifier.notifyEmbeddingFallback(
              '403 PERMISSION_DENIED — verificar API Key y facturación en Google AI Studio'
            ).catch(() => {});
          }
          return this.pseudoEmbedding(text);
        }

        logger.warn({ attempt: attempt + 1, error: lastError.message }, 'Error al generar embedding — reintentando');
        if (attempt < 2) {
          const jitter = Math.random() * 500;
          await new Promise(resolve => setTimeout(resolve, delays[attempt]! + jitter));
        }
      }
    }

    // 3 intentos agotados por error no-403
    logger.error({ error: lastError?.message }, '❌ Embedding fallido tras 3 intentos — activando pseudo-embedding');
    if (!this.fallbackActive && this.notifier) {
      this.fallbackActive = true;
      this.notifier.notifyEmbeddingFallback(
        lastError?.message ?? 'Error desconocido tras 3 reintentos'
      ).catch(() => {});
    }
    return this.pseudoEmbedding(text);
  }


  async storeKnowledge(input: StoreKnowledgeInput): Promise<string> {
    const { content, category, source, confidence = 0.5, metadata = {} } = input;

    const embedding = await this.embedText(content);
    const vectorLiteral = `[${embedding.join(',')}]`;

    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO hitdash.rag_knowledge
         (content, embedding, category, source, confidence, metadata)
       VALUES ($1, $2::vector, $3, $4, $5, $6)
       ON CONFLICT (source, category) DO UPDATE SET
         content    = EXCLUDED.content,
         embedding  = EXCLUDED.embedding,
         confidence = EXCLUDED.confidence,
         metadata   = EXCLUDED.metadata,
         updated_at = now()
       RETURNING id`,
      [content, vectorLiteral, category, source, confidence, JSON.stringify(metadata)]
    );

    const id = result.rows[0]!.id;
    logger.info({ id, source, category }, 'Conocimiento almacenado en RAG');
    return id;
  }

  async searchSimilar(
    query: string,
    topK: number = 10,
    category?: RagCategory,
    minSimilarity: number = 0.65
  ): Promise<RagResult[]> {
    const embedding = await this.embedText(query);
    return this.searchWithVector(embedding, topK, category, minSimilarity);
  }

  /**
   * BN-02 OPTIMIZATION: Allows searching with a pre-computed vector to avoid redundant embeddings.
   */
  async searchWithVector(
    embedding: number[],
    topK: number = 10,
    category?: RagCategory,
    minSimilarity: number = 0.65
  ): Promise<RagResult[]> {
    const vectorLiteral = `[${embedding.join(',')}]`;

    const result = await this.pool.query<RagResult & { similarity: number }>(
      `SELECT
         id, content, category, source, confidence, metadata,
         1 - (embedding <=> $1::vector) AS similarity
       FROM hitdash.rag_knowledge
       WHERE ($2::text IS NULL OR category = $2)
         AND 1 - (embedding <=> $1::vector) >= $3
       ORDER BY embedding <=> $1::vector
       LIMIT $4`,
      [vectorLiteral, category ?? null, minSimilarity, topK]
    );

    logger.info({ results: result.rows.length, category }, 'RAG vector search completado');
    return result.rows;
  }

  async deleteStale(olderThanDays: number): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM hitdash.rag_knowledge
       WHERE created_at < now() - ($1 || ' days')::interval
         AND category NOT IN ('strategy')`,  // nunca borrar estrategias
      [olderThanDays]
    );
    const count = result.rowCount ?? 0;
    logger.info({ count, olderThanDays }, 'RAG: registros obsoletos eliminados');
    return count;
  }

  async healthCheck(): Promise<{ count: number; oldestEntry: Date | null }> {
    const result = await this.pool.query<{ count: string; oldest: Date | null }>(
      `SELECT COUNT(*)::text AS count, MIN(created_at) AS oldest FROM hitdash.rag_knowledge`
    );
    return {
      count: parseInt(result.rows[0]!.count, 10),
      oldestEntry: result.rows[0]!.oldest,
    };
  }
}
