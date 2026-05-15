// ═══════════════════════════════════════════════════════════════
// HITDASH — Migration runner v2.0 (auto-descubrimiento + verificación)
// Ejecutar: npm run migrate
//
// v2.0 (2026-05-14):
//   • Auto-descubrimiento — escanea el directorio migrations/ en lugar
//     de un array hardcoded. Cero riesgo de olvidar registrar un archivo
//     nuevo (root cause del deploy fail de migration 019).
//   • Verificación post-migration — chequea que applied_count + pending_count
//     == filesystem_count antes de retornar exit 0.
//   • Bloqueo si hay desviación de orden — los nombres deben sortear
//     correctamente (NNN_descripcion.sql).
//   • Reporte estructurado al stdout para parseable en CI.
//
// Usa hitdash.schema_migrations para registrar migraciones aplicadas.
// Solo corre migraciones nuevas — nunca re-ejecuta las ya aplicadas.
// CRÍTICO: evita DROP TABLE en despliegues sucesivos (protege datos).
// ═══════════════════════════════════════════════════════════════

import { Pool } from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Auto-descubrimiento de migraciones ───────────────────────────
// Lee el directorio migrations/ y devuelve los .sql ordenados por nombre.
// Regla: NNN_descripcion.sql (donde NNN es 3 dígitos zero-padded).
// El sort lexicográfico funciona correctamente porque NNN está en orden.
function discoverMigrations(): string[] {
  const migrationsDir = join(__dirname, 'migrations');
  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();  // 001_, 002_, ..., 999_

  // ── Validar formato NNN_*.sql ────────────────────────────────────
  const SHAPE = /^\d{3}_[a-z0-9_]+\.sql$/i;
  const malformed = files.filter(f => !SHAPE.test(f));
  if (malformed.length > 0) {
    console.error(`❌ Migraciones con nombre inválido (esperado NNN_descripcion.sql):`);
    for (const f of malformed) console.error(`   - ${f}`);
    process.exit(1);
  }

  // ── Validar continuidad numérica (sin huecos en la secuencia) ────
  const numbers = files.map(f => parseInt(f.slice(0, 3), 10));
  for (let i = 0; i < numbers.length; i++) {
    if (numbers[i] !== i + 1) {
      console.error(`❌ Hueco en secuencia de migraciones. Esperado ${String(i + 1).padStart(3, '0')}, encontrado: ${files[i]}`);
      process.exit(1);
    }
  }

  return files;
}

async function migrate(): Promise<void> {
  const MIGRATIONS = discoverMigrations();
  console.log(`📋 Migraciones descubiertas en filesystem: ${MIGRATIONS.length}`);

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
      `SELECT filename FROM hitdash.schema_migrations ORDER BY filename`
    );
    const applied = new Set(rows.map(r => r.filename));

    // ── Detectar migraciones aplicadas que ya no están en filesystem
    // (alerta defensiva — alguien borró un archivo SQL ya aplicado)
    const filesystemSet = new Set(MIGRATIONS);
    const orphans = [...applied].filter(f => !filesystemSet.has(f));
    if (orphans.length > 0) {
      console.warn(`⚠️  Migraciones aplicadas pero faltan en filesystem (no fatal, solo aviso):`);
      for (const o of orphans) console.warn(`   - ${o}`);
    }

    // ── Ejecutar solo las pendientes ─────────────────────────────
    const pending = MIGRATIONS.filter(f => !applied.has(f));
    console.log(`📊 Estado: ${applied.size} aplicadas | ${pending.length} pendientes`);

    let ran = 0;
    for (const file of pending) {
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

    // ── VERIFICACIÓN POST-MIGRATION ───────────────────────────────
    // Asegura que cuando el deploy termina, applied_count == filesystem_count.
    // Sin esto, una migración silenciosamente skipped pasaría desapercibida.
    const { rows: finalRows } = await client.query<{ filename: string }>(
      `SELECT filename FROM hitdash.schema_migrations ORDER BY filename`
    );
    const finalApplied = new Set(finalRows.map(r => r.filename));
    const stillMissing = MIGRATIONS.filter(f => !finalApplied.has(f));

    if (stillMissing.length > 0) {
      console.error(`❌ POST-CHECK FALLÓ: ${stillMissing.length} migraciones quedaron sin aplicar:`);
      for (const m of stillMissing) console.error(`   - ${m}`);
      process.exit(1);
    }

    if (ran === 0) {
      console.log('✅ Schema actualizado — ninguna migración pendiente');
    } else {
      console.log(`✅ ${ran} migración(es) aplicada(s) · ${finalApplied.size}/${MIGRATIONS.length} en sync`);
    }

    // ── Reporte estructurado (machine-parseable para CI) ─────────
    console.log(JSON.stringify({
      event: 'migration_complete',
      filesystem_count: MIGRATIONS.length,
      applied_count:    finalApplied.size,
      ran_this_session: ran,
      orphans:          orphans.length,
      in_sync:          stillMissing.length === 0,
    }));
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
