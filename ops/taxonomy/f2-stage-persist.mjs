import { writeF2StageRows } from './f2-stage-rows.mjs';
// The original T03 writer remains isolated; no production bypass flags.
export async function stageF2Payload(pool, payload) {
  if (process.env.F2_IMPORT_SCOPE !== 'ISOLATED_POSTGRES18_ONLY' || process.env.NODE_ENV !== 'test')
    throw new Error('F2_PRODUCTION_LOAD_FORBIDDEN');
  const client=await pool.connect(); let begun=false;
  try {
    const v=await client.query("SELECT current_database() AS db,current_setting('server_version_num')::integer AS version");
    if(v.rows[0]?.db!=='radar_fiscal_test'||v.rows[0]?.version<180000) throw new Error('F2_PG18_ISOLATION_REQUIRED');
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE'); begun=true;
    await client.query('SELECT pg_advisory_xact_lock(2026, 20303)');
    const result=await writeF2StageRows(client,payload);
    await client.query('COMMIT'); begun=false;
    return result;
  } catch(error) {if(begun)await client.query('ROLLBACK');throw error;}
  finally {client.release();}
}
