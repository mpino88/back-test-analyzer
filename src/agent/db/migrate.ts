// ═══════════════════════════════════════════════════════════════
// HITDASH — Migration runner (idempotente)
// Ejecutar: npm run migrate
//
// Usa hitdash.schema_migrations para registrar migraciones aplicadas.
// Solo corre migraciones nuevas — nunca re-ejecuta las ya aplicadas.
// CRÍTICO: evita DROP TABLE en despliegues sucesivos (protege datos).
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
  '010_extend_alert_types.sql',
  '011_fix_ingested_results_schema.sql',
  '012_agentic_strategies.sql',
];

async function migrate(): Promise<void> {
  const pool = new Pool({ connectionString: process.env['AGENT_DATABASE_URL'] });
  const client = await pool.connect();

  try {
    // ── Crear tracking table si no existe (siempre seguro) ──────
    await client.query(`
      CREATE TABLE IF NOT EXISTS hitdash.schema_migrations (
        filename    TEXT        PRIMARY KEY,
        applied_at  TIMESTAMPTZ DEFAULT now()
      )
    `);

    // ── Leer migraciones ya aplicadas ────────────────────────────
    const { rows } = await client.query<{ filename: string }>(
      `SELECT filename FROM hitdash.schema_migrations`
    );
    const applied = new Set(rows.map(r => r.filename));

    // ── Ejecutar solo las pendientes ─────────────────────────────
    let ran = 0;
    for (const file of MIGRATIONS) {
      if (applied.has(file)) {
        console.log(`⏭️  ${file} — ya aplicada, saltando`);
        continue;
      }

      console.log(`🔄 Ejecutando migración: ${file}`);
      const sqlPath = join(__dirname, 'migrations', file);
      const sql = readFileSync(sqlPath, 'utf-8');

      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          `INSERT INTO hitdash.schema_migrations (filename) VALUES ($1)`,
          [file]
        );
        await client.query('COMMIT');
        console.log(`✅ ${file} completado`);
        ran++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`❌ Error en ${file}:`, err);
        process.exit(1);
      }
    }

    if (ran === 0) {
      console.log('✅ Schema actualizado — ninguna migración pendiente');
    } else {
      console.log(`✅ ${ran} migración(es) aplicada(s)`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
