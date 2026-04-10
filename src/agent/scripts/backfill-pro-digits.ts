
import pkg from 'pg';
const { Pool } = pkg;

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

const ballbotPool = new Pool({ 
  connectionString: process.env.BALLBOT_DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
const agentPool = new Pool({ connectionString: process.env.AGENT_DATABASE_URL });

async function backfill() {
  console.log('🚀 Iniciando Backfill Pro: Sincronizando dígitos estructurados...');
  
  try {
    const { rows: draws } = await ballbotPool.query(`
      SELECT game, period, date, numbers, created_at 
      FROM public.draws 
      ORDER BY created_at DESC
    `);
    
    console.log(`📊 Encontrados ${draws.length} sorteos en Ballbot.`);

    let count = 0;
    for (const row of draws) {
      try {
        const parts = row.numbers.split(',').map(n => parseInt(n.trim(), 10));
        const p1 = parts[0] ?? 0;
        const p2 = parts[1] ?? 0;
        const p3 = parts[2] ?? 0;
        const p4 = parts[3] !== undefined ? parts[3] : null;
        
        const gameType = row.game === 'p3' ? 'pick3' : 'pick4';
        const drawType = row.period === 'm' ? 'midday' : 'evening';
        const [mm, dd, yy] = row.date.split('/');
        const drawDate = `20${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
        const drawKey = `${row.game}:${row.period}:${row.date}`;

        const res = await agentPool.query(`
          UPDATE hitdash.ingested_results 
          SET p1 = $1, p2 = $2, p3 = $3, p4 = $4,
              draw_date = $5, game_type = $6, draw_type = $7
          WHERE draw_key = $8
          RETURNING draw_key
        `, [p1, p2, p3, p4, drawDate, gameType, drawType, drawKey]);

        if (res.rowCount > 0) {
          count++;
          if (count % 100 === 0) console.log(` Sincronizados ${count} sorteos...`);
        }
      } catch (innerErr) {
        console.error(`Error en fila ${row.date}:`, innerErr.message);
      }
    }
    
    console.log(`✅ Backfill x10 PRO completado. ${count} sorteos actualizados localmente.`);
  } catch (e) {
    console.error('❌ Error crítico en backfill:', e);
  } finally {
    await ballbotPool.end();
    await agentPool.end();
  }
}

backfill();
