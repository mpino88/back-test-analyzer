
const { Pool } = require('pg');

const ballbotPool = new Pool({ 
  connectionString: process.env.BALLBOT_DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
const agentPool = new Pool({ connectionString: process.env.AGENT_DATABASE_URL });

async function backfill() {
  console.log('🚀 Iniciando Backfill X10 ULTRA (Batched)...');
  try {
    const { rows: draws } = await ballbotPool.query('SELECT game, period, date, numbers, created_at FROM public.draws ORDER BY created_at DESC');
    console.log(`📊 Draws: ${draws.length}`);

    const BATCH_SIZE = 500;
    for (let i = 0; i < draws.length; i += BATCH_SIZE) {
      const batch = draws.slice(i, i + BATCH_SIZE);
      
      const keys = [], p1s = [], p2s = [], p3s = [], p4s = [], dates = [], gtypes = [], dtypes = [];
      
      for (const row of batch) {
        const parts = row.numbers.split(',').map(n => parseInt(n.trim(), 10));
        keys.push(`${row.game}:${row.period}:${row.date}`);
        p1s.push(parts[0] ?? 0);
        p2s.push(parts[1] ?? 0);
        p3s.push(parts[2] ?? 0);
        p4s.push(parts[3] !== undefined ? parts[3] : null);
        
        const gameType = row.game === 'p3' ? 'pick3' : 'pick4';
        const drawType = row.period === 'm' ? 'midday' : 'evening';
        const [mm, dd, yy] = row.date.split('/');
        
        dates.push(`20${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`);
        gtypes.push(gameType);
        dtypes.push(drawType);
      }

      await agentPool.query(`
        INSERT INTO hitdash.ingested_results (
          draw_key, p1, p2, p3, p4, draw_date, game_type, draw_type
        )
        SELECT 
          u.dkey, u.p1, u.p2, u.p3, u.p4, u.ddate::date, u.gtype::text, u.dtype::text
        FROM UNNEST($1::text[], $2::int[], $3::int[], $4::int[], $5::int[], $6::text[], $7::text[], $8::text[])
        AS u(dkey, p1, p2, p3, p4, ddate, gtype, dtype)
        ON CONFLICT (draw_key) DO UPDATE SET
          p1 = EXCLUDED.p1,
          p2 = EXCLUDED.p2,
          p3 = EXCLUDED.p3,
          p4 = EXCLUDED.p4,
          draw_date = EXCLUDED.draw_date,
          game_type = EXCLUDED.game_type,
          draw_type = EXCLUDED.draw_type
      `, [keys, p1s, p2s, p3s, p4s, dates, gtypes, dtypes]);

      console.log(`📦 Batch ${i / BATCH_SIZE + 1} completado (${i + batch.length}/${draws.length})`);
    }
    console.log('✅ Backfill ULTRA completado.');
  } catch (e) {
    console.error('❌ Error:', e);
  } finally {
    await ballbotPool.end();
    await agentPool.end();
  }
}

backfill();
