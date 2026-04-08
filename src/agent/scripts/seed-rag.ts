// ═══════════════════════════════════════════════════════════════
// HITDASH — Seed RAG Inicial v2.0
// Importa últimos 365 días de lottery_results de Ballbot
// IDEMPOTENTE: ON CONFLICT (source, category) DO UPDATE
// Batch de 5 por llamada — delay 1200ms para respetar 50 RPM
// Ejecutar: npm run seed
// ═══════════════════════════════════════════════════════════════

import { Pool } from 'pg';
import { RAGService } from '../services/RAGService.js';
import type { LotteryDigits } from '../types/agent.types.js';

interface LotteryRow {
  id: string;
  game_type: string;
  draw_type: string;
  draw_date: Date;
  digits: LotteryDigits;
}

// Barra de progreso simple en consola
function renderProgress(current: number, total: number, label: string): void {
  const pct = Math.round((current / total) * 100);
  const filled = Math.round(pct / 2);
  const bar = '█'.repeat(filled) + '░'.repeat(50 - filled);
  process.stdout.write(`\r[${bar}] ${pct}% | ${current}/${total} ${label}   `);
}

async function main(): Promise<void> {
  const ballbotPool = new Pool({ connectionString: process.env['BALLBOT_DATABASE_URL'] });
  const agentPool = new Pool({ connectionString: process.env['AGENT_DATABASE_URL'] });
  const ragService = new RAGService(agentPool);

  console.log('\n🚀 HITDASH — Seed RAG Inicial');
  console.log('══════════════════════════════════════');

  // 1. Obtener todos los lottery_results de los últimos 365 días
  const { rows: allResults } = await ballbotPool.query<LotteryRow>(
    `SELECT id, game_type, draw_type, draw_date, digits
     FROM public.lottery_results
     WHERE draw_date >= now() - interval '365 days'
     ORDER BY draw_date ASC`
  );

  if (allResults.length === 0) {
    console.log('⚠️  No hay resultados en los últimos 365 días. Verifica BALLBOT_DATABASE_URL.');
    process.exit(1);
  }

  console.log(`📊 Total resultados encontrados: ${allResults.length}`);

  // 2. Filtrar cuáles ya están en ingested_results (idempotencia)
  const existingIds = await agentPool.query<{ lottery_result_id: string }>(
    `SELECT lottery_result_id::text FROM hitdash.ingested_results`
  );
  const alreadyIngested = new Set(existingIds.rows.map(r => r.lottery_result_id));
  const pending = allResults.filter(r => !alreadyIngested.has(r.id));

  console.log(`✅ Ya ingestados: ${alreadyIngested.size}`);
  console.log(`⏳ Pendientes:    ${pending.length}`);

  if (pending.length === 0) {
    console.log('\n✨ Nada que procesar — seed ya completado anteriormente.');
    process.exit(0);
  }

  const BATCH = 5;
  const DELAY_MS = 1200;
  let processed = 0;
  let errors = 0;
  const startTime = Date.now();

  console.log(`\n⚡ Procesando en batches de ${BATCH} con ${DELAY_MS}ms entre requests...\n`);

  // 3. Procesar en batches
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);

    for (const row of batch) {
      try {
        const digits = row.digits as LotteryDigits;
        const gameType = row.game_type;
        const drawDate = new Date(row.draw_date).toISOString().split('T')[0];

        const posText = gameType === 'pick3'
          ? `P1=${digits.p1} P2=${digits.p2} P3=${digits.p3}`
          : `P1=${digits.p1} P2=${digits.p2} P3=${digits.p3} P4=${digits.p4}`;

        const content = `${gameType.toUpperCase()} ${row.draw_type} ${drawDate}: ${posText}`;
        const source = `lottery_result:${row.id}`;

        const ragId = await ragService.storeKnowledge({
          content,
          category: 'pattern',
          source,
          confidence: 0.9,
          metadata: { game_type: gameType, draw_type: row.draw_type, draw_date: drawDate, digits },
        });

        // Marcar como ingestado
        await agentPool.query(
          `INSERT INTO hitdash.ingested_results (lottery_result_id, rag_knowledge_id)
           VALUES ($1, $2)
           ON CONFLICT (lottery_result_id) DO NOTHING`,
          [row.id, ragId]
        );

        processed++;
      } catch (err) {
        errors++;
        console.error(`\n❌ Error en resultado ${row.id}:`, err instanceof Error ? err.message : err);
      }
    }

    renderProgress(processed + errors, pending.length, 'procesados');

    // Delay entre batches para respetar rate limits de Gemini Embedding
    if (i + BATCH < pending.length) {
      await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n\n══════════════════════════════════════`);
  console.log(`✅ Seed completado en ${duration}s`);
  console.log(`   Nuevos:  ${processed}`);
  console.log(`   Errores: ${errors}`);
  console.log(`   Total RAG: ${alreadyIngested.size + processed} registros`);

  await ballbotPool.end();
  await agentPool.end();
}

main().catch(err => {
  console.error('Error fatal en seed:', err);
  process.exit(1);
});
