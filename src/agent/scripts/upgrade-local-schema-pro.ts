
import pkg from 'pg';
const { Pool } = pkg;
const pool = new Pool({ connectionString: process.env.AGENT_DATABASE_URL });

async function upgrade() {
  const sql = `
    ALTER TABLE hitdash.ingested_results ADD COLUMN IF NOT EXISTS p1 integer;
    ALTER TABLE hitdash.ingested_results ADD COLUMN IF NOT EXISTS p2 integer;
    ALTER TABLE hitdash.ingested_results ADD COLUMN IF NOT EXISTS p3 integer;
    ALTER TABLE hitdash.ingested_results ADD COLUMN IF NOT EXISTS p4 integer;
    ALTER TABLE hitdash.ingested_results ADD COLUMN IF NOT EXISTS draw_date date;
    ALTER TABLE hitdash.ingested_results ADD COLUMN IF NOT EXISTS game_type text;
    ALTER TABLE hitdash.ingested_results ADD COLUMN IF NOT EXISTS draw_type text;
    CREATE INDEX IF NOT EXISTS idx_ingested_results_lookup ON hitdash.ingested_results(game_type, draw_type, draw_date DESC);
  `;
  try {
    await pool.query(sql);
    console.log('✅ Local schema upgraded to x10 PRO standard');
  } catch (e) {
    console.error('❌ Upgrade failed:', e);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

upgrade();
