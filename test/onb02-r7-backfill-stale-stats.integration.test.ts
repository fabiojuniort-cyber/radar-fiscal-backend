import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {Pool} from 'pg';
import {applyAuditBackfill,planAuditBackfill} from '../src/modules/audit/audit-backfill.js';

// ONB-02 R7 (tribusca-control#124): the PG18 timeout seen on radar-fiscal-backend#317 and #310 came from stale
// audit_log statistics (reltuples=1 over thousands of pages) turning the batch UPDATE into a nested loop with a join
// filter. This test reproduces that statistics state DETERMINISTICALLY on an isolated database and requires the
// batches to finish under the SAME limits as the R7 test (statement_timeout 45 s, lock_timeout 5 s, jit off).
const url=process.env.DATABASE_ADMIN_URL;
function isolated(){
 assert.equal(process.env.CI,'true');
 assert.ok(url);
 const u=new URL(url);
 assert.ok(['localhost','127.0.0.1'].includes(u.hostname));
 assert.equal(u.pathname,'/radar_fiscal_test');
 assert.equal(u.search,'');
 return new Pool({connectionString:url,max:2,options:'-c jit=off -c statement_timeout=45000 -c lock_timeout=5000'});
}

test('R7: 150k legacy audits with stale statistics (reltuples=1) still backfill in bounded batches',{timeout:240000},async()=>{
 const pool=isolated(); const tenants:string[]=[];
 try {
  assert.match((await pool.query<{server_version:string}>('SHOW server_version')).rows[0]!.server_version,/^18\./);
  await applyAuditBackfill(pool);
  assert.equal((await planAuditBackfill(pool)).pending,0,'starts from a drained backfill');
  for(let i=0;i<2;i++)tenants.push((await pool.query<{id:string}>(
    "INSERT INTO tenants(name,slug) VALUES('R7 stale-statistics synthetic account',$1) RETURNING id",[randomUUID()])).rows[0]!.id);
  const client=await pool.connect();
  try {
   await client.query('BEGIN');
   // Only this isolated legacy-fixture transaction bypasses the new-write guard (same fixture shape as the R7 test).
   await client.query('ALTER TABLE audit_log DISABLE TRIGGER audit_allowlist_guard');
   await client.query(`INSERT INTO audit_log(tenant_id,actor_type,actor_id,action,entity_type,entity_id,before_data,after_data)
    SELECT CASE WHEN n%2=0 THEN $1::uuid ELSE $2::uuid END,'SYSTEM','system:worker',
      CASE WHEN n%3=0 THEN 'COMPANY_CREATED' ELSE 'COMPANY_UPDATED' END,'company',lpad(n::text,14,'0'),
      jsonb_build_object('is_active',true,'cnpj',lpad(n::text,14,'0'),'legalName','Empresa Sintética',
        'nested',jsonb_build_object('message','old private text')),
      jsonb_build_object('is_active',false,'tradeName','old private name')
    FROM generate_series(1,100000)n`,[tenants[0],tenants[1]]);
   await client.query(`INSERT INTO audit_log(tenant_id,actor_type,actor_id,action,entity_type,after_data)
    SELECT $1,'ADMIN',NULL,'TAXONOMY_CURATION_IMPORT','taxonomy_curation',jsonb_build_object('rows',n,'created',1,'errors',0)
    FROM generate_series(1,50000)n`,[tenants[1]]);
   await client.query('ALTER TABLE audit_log ENABLE TRIGGER audit_allowlist_guard');
   await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  assert.equal((await planAuditBackfill(pool)).pending,150000);
  // The statistics state observed when the batch timed out: an (auto)vacuum/analyze that saw an almost empty table.
  await pool.query(`ALTER TABLE audit_log SET (autovacuum_enabled=false)`);
  await pool.query(`UPDATE pg_class SET reltuples=1,relpages=greatest(pg_relation_size('public.audit_log')/current_setting('block_size')::bigint,1)
    WHERE oid='public.audit_log'::regclass`);
  const stats=(await pool.query<{reltuples:number}>("SELECT reltuples FROM pg_class WHERE oid='public.audit_log'::regclass")).rows[0]!;
  assert.equal(Number(stats.reltuples),1,'stale statistics are in place');
  const first=await applyAuditBackfill(pool,{batchSize:5000,maxBatches:3});
  assert.equal(first.processed,15000);assert.equal(first.remaining,135000);
  const rest=await applyAuditBackfill(pool,{batchSize:5000});
  assert.equal(rest.processed,135000);assert.equal(rest.remaining,0);
  assert.equal((await applyAuditBackfill(pool)).processed,0,'idempotent');
  const leftover=(await pool.query<{n:string}>(`SELECT count(*)::text n FROM audit_log WHERE tenant_id=ANY($1::uuid[])
    AND (audit_policy_version<>1 OR before_data IS DISTINCT FROM public.audit_project(action,entity_type,before_data)
      OR after_data IS DISTINCT FROM public.audit_project(action,entity_type,after_data))`,[tenants])).rows[0]!.n;
  assert.equal(Number(leftover),0,'every row projected exactly once');
  console.log('ONB02_R7_STALE_STATS '+JSON.stringify({rows:150000,batchSize:5000,reltuples:1,
    first_ms:first.elapsedMs,rest_ms:rest.elapsedMs}));
 } finally {
  await pool.query(`ALTER TABLE audit_log RESET (autovacuum_enabled)`);
  if(tenants.length){
   await pool.query('DELETE FROM audit_log WHERE tenant_id=ANY($1::uuid[])',[tenants]);
   await pool.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])',[tenants]);
  }
  await pool.query('ANALYZE audit_log');
  await pool.end();
 }
});
