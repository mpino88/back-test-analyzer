import { Pool } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const agentPool = new Pool({ connectionString: process.env.AGENT_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const ballbotPool = new Pool({ connectionString: process.env.BALLBOT_DATABASE_URL });
  
  try {
    const wmResult = await agentPool.query(`SELECT MAX(ingested_at) AS last_at_raw, MAX(ingested_at)::text AS last_at_text FROM hitdash.ingested_results`);
    console.log('HITDASH WM:', wmResult.rows[0]);

    if (wmResult.rows[0].last_at_text) {
      const drawResult = await ballbotPool.query(`
        SELECT game, period, date, created_at, created_at > $1 as is_newer
        FROM public.draws
        ORDER BY created_at DESC
        LIMIT 5
      `, [wmResult.rows[0].last_at_text]);
      console.log('BALLBOT DRAWS:');
      console.table(drawResult.rows);
    }
  } catch (e) {
    console.error(e);
  } finally {
    await agentPool.end();
    await ballbotPool.end();
  }
}
main();
