/**
 * ══════════════════════════════════════════════════════════════
 * PROTOCOLO APEX: TABULA RASA v2.0
 * Script de purga cognitiva absoluta.
 *
 * FIX v2: Cada TRUNCATE es una transacción independiente.
 * Si una tabla no existe — se salta silenciosamente sin abortar.
 *
 * DESTRUYE (Datos derivados / "Memoria Cognitiva"):
 *   - hitdash.agent_jobs
 *   - hitdash.backtest_results + backtest_points
 *   - hitdash.backtest_results_v2 + backtest_points_v2
 *   - hitdash.progressive_results
 *   - hitdash.adaptive_weights
 *   - hitdash.proactive_alerts
 *   - hitdash.pair_recommendations
 *   - Redis: FLUSHALL
 *   - ingested_results: purga SOLO fechas anómalas (>2030 o <2000)
 *
 * PRESERVA (Ground Truth / Realidad Histórica):
 *   - hitdash.ingested_results — solo sorteos 2000-2030
 *   - hitdash.strategy_registry
 * ══════════════════════════════════════════════════════════════
 */
import { Pool } from 'pg';
import Redis from 'ioredis';

const DB_URL    = process.env['AGENT_DATABASE_URL'];
const REDIS_URL = process.env['REDIS_URL'];

if (!DB_URL)   { console.error('❌ AGENT_DATABASE_URL no definida'); process.exit(1); }
if (!REDIS_URL){ console.error('❌ REDIS_URL no definida');          process.exit(1); }

const pool  = new Pool({ connectionString: DB_URL });
const redis = new Redis(REDIS_URL);

// ─── Orden: los hijos (FK) van ANTES que los padres ──────────────────────────
const COGNITIVE_TABLES = [
  'hitdash.pair_recommendations',
  'hitdash.backtest_points_v2',
  'hitdash.backtest_results_v2',
  'hitdash.backtest_points',
  'hitdash.backtest_results',
  'hitdash.progressive_results',
  'hitdash.proactive_alerts',
  'hitdash.adaptive_weights',
  'hitdash.agent_jobs',
];

async function truncateTable(pool: Pool, table: string): Promise<'ok' | 'skip' | 'error'> {
  const client = await pool.connect();
  try {
    await client.query(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`);
    return 'ok';
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('does not exist')) return 'skip';
    console.error(`  ❌ Error en ${table}: ${msg}`);
    return 'error';
  } finally {
    client.release();
  }
}

async function run() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  HITDASH — TABULA RASA v2 — Purga Cognitiva APEX    ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  const client = await pool.connect();

  // ── 1. Purgar fechas anómalas en ingested_results ────────────────────────
  try {
    const { rowCount } = await client.query(`
      DELETE FROM hitdash.ingested_results
      WHERE draw_date < '2000-01-01'::date
         OR draw_date > '2030-12-31'::date
    `);
    console.log(`🧹 Fechas anómalas eliminadas de ingested_results: ${rowCount} filas`);

    const { rows: truth } = await client.query(`
      SELECT COUNT(*) AS total,
             MIN(draw_date) AS oldest,
             MAX(draw_date) AS newest
      FROM hitdash.ingested_results
    `);
    const t = truth[0];
    const oldestStr = t.oldest ? new Date(t.oldest).toISOString().slice(0, 10) : 'N/A';
    const newestStr = t.newest ? new Date(t.newest).toISOString().slice(0, 10) : 'N/A';
    console.log(`✅ GROUND TRUTH: ${t.total} sorteos reales (${oldestStr} → ${newestStr})\n`);
  } catch(e) {
    console.error('❌ Error limpiando ingested_results:', e);
  } finally {
    client.release();
  }

  // ── 2. Purgar tablas cognitivas (transacciones independientes) ────────────
  console.log('📋 Purgando capa cognitiva en PostgreSQL...');
  let errors = 0;
  for (const table of COGNITIVE_TABLES) {
    const result = await truncateTable(pool, table);
    if      (result === 'ok')    console.log(`  🗑  Purgado:  ${table}`);
    else if (result === 'skip')  console.log(`  ⚠️  No existe: ${table}`);
    else                         errors++;
  }

  if (errors > 0) {
    console.error(`\n❌ ${errors} tablas fallaron. Revisa los logs anteriores.`);
    await pool.end(); await redis.quit(); process.exit(1);
  }

  // ── 3. Re-seed adaptive_weights desde strategy_registry (tabla base) ──────
  const seedClient = await pool.connect();
  try {
    const { rowCount: seeded } = await seedClient.query(`
      INSERT INTO hitdash.adaptive_weights
        (strategy, game_type, mode, weight, top_n, hit_rate_history)
      SELECT
        sr.name,
        g.game_type,
        m.mode,
        1.0,
        15,
        '[]'::jsonb
      FROM hitdash.strategy_registry sr
      CROSS JOIN (VALUES ('pick3'),('pick4')) AS g(game_type)
      CROSS JOIN (VALUES ('midday'),('evening'),('combined')) AS m(mode)
      ON CONFLICT DO NOTHING
    `);
    console.log(`\n✅ Adaptive Weights re-seeded: ${seeded} entradas vírgenes.`);
  } catch(e) {
    console.error('❌ Error re-seeding adaptive_weights:', e);
  } finally {
    seedClient.release();
  }

  // ── 4. Redis FLUSHALL ─────────────────────────────────────────────────────
  try {
    const redisOk = await redis.flushall();
    console.log(`✅ Redis purgado: ${redisOk}`);
  } catch(e) {
    console.error('❌ Error flushing Redis:', e);
  }

  await pool.end();
  await redis.quit();

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  TABULA RASA COMPLETADA — Motor en estado GÉNESIS   ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');
}

run();
