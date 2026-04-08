// ═══════════════════════════════════════════════════════════════
// HITDASH — Migration runner
// Ejecutar: npm run migrate
// ═══════════════════════════════════════════════════════════════

import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATIONS = [
  '001_hitdash_schema.sql',
  '002_ingested_results_text_key.sql',
  '003_backtest_results.sql',
  '004_add_fibonacci_pisano.sql',
  '005_adaptive_weights.sql',
  '006_pair_redesign.sql',
  '007_precision_metrics.sql',
  '008_progressive_results.sql',
  '009_pair_recommendations.sql',
];

async function migrate(): Promise<void> {
  const pool = new Pool({ connectionString: process.env['AGENT_DATABASE_URL'] });

  for (const file of MIGRATIONS) {
    console.log(`🔄 Ejecutando migración: ${file}`);
    const sqlPath = join(__dirname, 'migrations', file);
    const sql = readFileSync(sqlPath, 'utf-8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      console.log(`✅ ${file} completado`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`❌ Error en ${file}:`, err);
      process.exit(1);
    } finally {
      client.release();
    }
  }

  await pool.end();
  console.log('✅ Todas las migraciones completadas');
}

migrate();
