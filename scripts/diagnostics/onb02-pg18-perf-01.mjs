import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import pg from 'pg';
import {applyAuditBackfill,planAuditBackfill} from '../../dist/modules/audit/audit-backfill.js';

// ONB02-PG18-PERF-01: DIAGNOSTIC ONLY — independent disposable PG18.
const {Pool}=pg;
const scenario=process.argv[2],url=process.env.DATABASE_ADMIN_URL;
assert.ok(['A','B'].includes(scenario) && process.env.CI==='true' &&
  process.env.NODE_ENV==='test' && url,'ci_only');
const u=new URL(url);
assert.ok(['localhost','127.0.0.1'].includes(u.hostname) &&
  u.pathname==='/radar_fiscal_test' && u.username==='postgres' && !u.search,
  'disposable_database_only');
const opts={connectionString:url,max:2,
  options:'-c jit=off -c statement_timeout=45000 -c lock_timeout=5000'};
let pool=new Pool(opts);
const observer=new Pool({...opts,max:1});
let phase='init',tenantIds=[],companyId='';
const res={scenario,task:'ONB02-PG18-PERF-01',
  expected:{pg:18,company:100000,curation:50000,batch:5000,timeout:45000,lockTimeout:5000,jit:'off'},
  events:[],snapshots:{},plans:{},batches:[],outcome:'NOT_STARTED',errors:[],
  caveat:'Instrumentation itself may warm cache; diagnostic job SUCCESS is not product CI PASS'};
function error(e){return {code:e?.code??null,message:String(e?.message??e).slice(0,330)};}
function event(name,data={}){
  const a={name,time:new Date().toISOString(),...data};
  res.events.push(a);console.log('PERF_01 '+JSON.stringify({scenario,...a}));
}
async function one(sql,params=[]){return (await pool.query(sql,params)).rows[0];}
async function measured(name,f){
  const t=performance.now();
  try {const v=await f();event(name,{ms:Math.round(performance.now()-t),ok:true});return v;}
  catch(e){event(name,{ms:Math.round(performance.now()-t),ok:false,error:error(e)});throw e;}
}
async function snapshot(name){
  const o={};
  for(const [key,sql] of Object.entries({
    table:`SELECT relname,n_live_tup,n_dead_tup,n_mod_since_analyze,
      last_analyze,last_autoanalyze,last_autovacuum,autovacuum_count,
      seq_scan,idx_scan FROM pg_stat_all_tables
      WHERE schemaname='public' AND relname='audit_log'`,
    size:`SELECT c.reltuples,c.relpages,
      pg_relation_size(c.oid) AS heap_bytes,
      pg_indexes_size(c.oid) AS indexes_bytes,
      pg_total_relation_size(c.oid) AS total_bytes
      FROM pg_class c WHERE c.oid='public.audit_log'::regclass`,
    stats:`SELECT attname,n_distinct,correlation,null_frac
      FROM pg_stats WHERE schemaname='public' AND tablename='audit_log'
      AND attname IN ('id','actor_id','audit_policy_version','action','entity_type')
      ORDER BY attname`,
    indexes:`SELECT indexname,indexdef FROM pg_indexes
      WHERE schemaname='public' AND tablename='audit_log' ORDER BY indexname`,
    index_usage:`SELECT indexrelname,idx_scan,idx_tup_read,idx_tup_fetch
      FROM pg_stat_user_indexes WHERE schemaname='public' AND relname='audit_log'`,
    counts:`SELECT count(*)::bigint total,
      count(*) FILTER (WHERE public.audit_backfill_pending(audit_policy_version,actor_id))::bigint pending
      FROM audit_log`,
    checkpoint:'SELECT * FROM public.audit_backfill_checkpoint ORDER BY job_key',
  })){
    try{
      if(key==='table')await pool.query('SELECT pg_stat_clear_snapshot()');
      o[key]=(await pool.query(sql)).rows;
    }catch(e){o[key]={error:error(e)};}
  }
  res.snapshots[name]=o;
  event('snapshot_'+name,{counts:o.counts?.[0],table:o.table?.[0],size:o.size?.[0]});
  return o;
}
async function explain(name,query,rollback=false){
  const client=await pool.connect(),t=performance.now();
  try{
    if(rollback)await client.query('BEGIN');
    const rows=(await client.query(
      'EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS, FORMAT JSON) '+query
    )).rows;
    const plan=rows[0]['QUERY PLAN'];
    res.plans[name]=plan;
    const x=plan[0];
    event('explain_'+name,{ms:Math.round(performance.now()-t),
      executionMs:x?.['Execution Time'],planningMs:x?.['Planning Time'],
      root:x?.Plan?.['Node Type'],triggers:x?.Triggers});
  }catch(e){
    res.plans[name]={error:error(e)};
    event('explain_'+name,{ms:Math.round(performance.now()-t),error:error(e)});
  }finally{
    if(rollback)try{await client.query('ROLLBACK');}catch{}
    client.release();
  }
}
async function history(){
  phase='history';
  const tenant=(await one(
    "INSERT INTO tenants(name,slug) VALUES('PERF historical tenant',$1) RETURNING id",
    [randomUUID()])).id;
  const company=(await one(
    `INSERT INTO companies(tenant_id,legal_name,head_office_cnpj)
      VALUES($1,'PERF old synthetic company',$2) RETURNING id`,
    [tenant,randomUUID().replace(/\D/g,'').padEnd(14,'7').slice(0,14)])).id;
  const source=(await one(
    `INSERT INTO sources(code,name,jurisdiction_level,base_url,connector_key)
    VALUES($1,'PERF synthetic','FEDERAL','https://example.test/',$1) RETURNING id`,
    [randomUUID()])).id;
  const run=(await one(
    `INSERT INTO collection_runs(source_id,scheduled_for,trigger_type,status)
    VALUES($1,now(),'MANUAL','SUCCESS') RETURNING id`,[source])).id;
  await measured('history_420k_items',()=>pool.query(
    `INSERT INTO collection_items(collection_run_id,source_item_key,status,raw_metadata)
    SELECT $1,n::text,'PROCESSED_EXISTING',
    jsonb_build_object('official',true,'text',repeat('x',128))
    FROM generate_series(1,420000)n`,[run]));
  await measured('history_150k_audits',()=>pool.query(
    `INSERT INTO audit_log(tenant_id,actor_type,actor_id,action,entity_type,entity_id,before_data,after_data)
    SELECT $1,'SYSTEM','system:worker','COMPANY_UPDATED','company',$2::text,
    jsonb_build_object('company_id',$2::text,'is_active',true),
    jsonb_build_object('company_id',$2::text,'is_active',false)
    FROM generate_series(1,150000)n`,[tenant,company]));
  await measured('history_ANALYZE_audit',()=>pool.query('ANALYZE audit_log'));
  await measured('history_ANALYZE_items',()=>pool.query('ANALYZE collection_items'));
  await measured('history_DELETE_audits',()=>pool.query(
    'DELETE FROM audit_log WHERE tenant_id=$1',[tenant]));
  assert.equal((await one(
    'SELECT count(*)::int n FROM audit_log WHERE tenant_id=$1',[tenant])).n,0);
  assert.equal((await one(
    'SELECT count(*)::int n FROM collection_items WHERE collection_run_id=$1',[run])).n,420000);
  await pool.query('DELETE FROM companies WHERE id=$1',[company]);
  await pool.query('DELETE FROM tenants WHERE id=$1',[tenant]);
  event('history_residual_confirmed',{deletedAudit:150000,preservedItems:420000});
  await snapshot('history_after_delete_before_R7');
}
async function seedR7(){
  phase='fixture_R7';
  await measured('empty_initial_backfill',()=>applyAuditBackfill(pool));
  for(let i=0;i<2;i++)tenantIds.push((await one(
    "INSERT INTO tenants(name,slug) VALUES('PERF R7 synthetic',$1) RETURNING id",
    [randomUUID()])).id);
  companyId=(await one(
    `INSERT INTO companies(tenant_id,legal_name,head_office_cnpj)
    VALUES($1,'PERF unrelated company',$2) RETURNING id`,
    [tenantIds[1],randomUUID().replace(/\D/g,'').padEnd(14,'7').slice(0,14)])).id;
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query('ALTER TABLE audit_log DISABLE TRIGGER audit_allowlist_guard');
    await measured('R7_insert_100k_company',()=>client.query(
      `INSERT INTO audit_log(tenant_id,actor_type,actor_id,action,entity_type,entity_id,before_data,after_data)
       SELECT CASE WHEN n%2=0 THEN $1::uuid ELSE $2::uuid END,'SYSTEM','system:worker',
       CASE WHEN n%3=0 THEN 'COMPANY_CREATED' ELSE 'COMPANY_UPDATED' END,
       'company',CASE WHEN n%2=0 THEN $3::text ELSE lpad(n::text,14,'0') END,
       jsonb_build_object('company_id',$3::text,'is_active',true,'cnpj',lpad(n::text,14,'0'),
       'legalName',normalize('Empresa Sintética Árvore',NFD),
       'nested',jsonb_build_object('message','old private text'),
       gen_random_uuid()::text,'old private key'),
       jsonb_build_object('company_id',$3::text,'is_active',false,'tradeName','old private name')
       FROM generate_series(1,100000)n`,[tenantIds[0],tenantIds[1],companyId]));
    await measured('R7_insert_50k_curation',()=>client.query(
      `INSERT INTO audit_log(tenant_id,actor_type,actor_id,action,entity_type,after_data)
       SELECT $1,'ADMIN',NULL,'TAXONOMY_CURATION_IMPORT','taxonomy_curation',
       jsonb_build_object('rows',n,'created',1,'errors',0)
       FROM generate_series(1,50000)n`,[tenantIds[1]]));
    await client.query('ALTER TABLE audit_log ENABLE TRIGGER audit_allowlist_guard');
    await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}
  finally{client.release();}
  const counts=await one(
    `SELECT count(*)::int n,
      count(*) FILTER (WHERE entity_type='company')::int company,
      count(*) FILTER (WHERE action='TAXONOMY_CURATION_IMPORT')::int curation
      FROM audit_log WHERE tenant_id=ANY($1::uuid[])`,[tenantIds]);
  assert.deepEqual([counts.n,counts.company,counts.curation],[150000,100000,50000]);
  event('fixture_confirmed',counts);
}
async function checksum(){
  const h=await one(`SELECT md5(string_agg(
    md5(jsonb_build_array(id,tenant_id,actor_type,actor_id,action,entity_type,
    occurred_at,correlation_id)::text),'' ORDER BY id)) hash
    FROM audit_log WHERE tenant_id=ANY($1::uuid[])`,[tenantIds]);
  const s=await one(`SELECT md5(string_agg(
    md5(jsonb_build_array(entity_id,before_data,after_data)::text),'' ORDER BY id)) hash
    FROM audit_log WHERE tenant_id=$1 AND action='TAXONOMY_CURATION_IMPORT'`,[tenantIds[1]]);
  return {headers:h.hash,curation:s.hash};
}
async function rollbackFailure(){
  phase='rollback_expected';
  const prev=(await pool.query('SELECT * FROM audit_backfill_checkpoint ORDER BY job_key')).rows;
  await pool.query(`CREATE FUNCTION public.perf01_fail_batch() RETURNS trigger LANGUAGE plpgsql AS $f$
     BEGIN RAISE EXCEPTION 'synthetic_batch_interruption'; END $f$;
     CREATE TRIGGER perf01_fail_batch BEFORE UPDATE ON audit_log FOR EACH ROW
     EXECUTE FUNCTION public.perf01_fail_batch()`);
  let rejected=false;
  try{await applyAuditBackfill(pool,{batchSize:5000,maxBatches:1});}
  catch(e){
    assert.match(e.message,/synthetic_batch_interruption/);
    rejected=true;event('expected_failure',{error:error(e)});
  }finally{
    await pool.query('DROP TRIGGER perf01_fail_batch ON audit_log; DROP FUNCTION public.perf01_fail_batch()');
  }
  assert.equal(rejected,true);
  assert.deepEqual((await pool.query('SELECT * FROM audit_backfill_checkpoint ORDER BY job_key')).rows,prev);
  assert.equal((await planAuditBackfill(pool)).pending,150000);
  event('rollback_invariants',{pending:150000,checkpointUnchanged:true});
}
function summarizeWaits(samples){
  const counts={};
  for(const r of samples){
    const key=[r.wait_event_type??'CPU_UNREPORTED',r.wait_event??'none'].join('/');
    counts[key]=(counts[key]??0)+1;
  }
  return counts;
}
async function batch(n){
  const client=await pool.connect();
  let timer,querying=false,active=false;
  const samples=[];
  let pollError=0;
  try{
    const pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    timer=setInterval(async()=>{
      if(!active||querying)return;querying=true;
      try{
        const s=(await observer.query(
          `SELECT a.wait_event_type,a.wait_event,
            (SELECT count(*)::int FROM pg_locks l WHERE l.pid=$1 AND NOT l.granted) waiting_locks
            FROM pg_stat_activity a WHERE a.pid=$1`,[pid])).rows[0];
        if(s)samples.push(s);
      }catch{pollError++;}finally{querying=false;}
    },250);
    const t=performance.now();active=true;
    try{
      const r=(await client.query('SELECT * FROM public.audit_backfill_batch($1)',[5000])).rows[0];
      const rec={batch:n,ms:Math.round(performance.now()-t),
        processed:Number(r.processed),remaining:Number(r.remaining),
        waitSamples:samples.length,waits:summarizeWaits(samples),pollError};
      res.batches.push(rec);event('batch_success',rec);return rec;
    }catch(e){
      const rec={batch:n,ms:Math.round(performance.now()-t),error:error(e),
        waitSamples:samples.length,waits:summarizeWaits(samples),pollError};
      res.batches.push(rec);event('batch_failure',rec);throw e;
    }finally{active=false;}
  }finally{
    if(timer)clearInterval(timer);
    client.release();
  }
}
async function decisive(){
  phase='original_contract';
  const before=await checksum();res.initialHash=before;
  assert.equal((await planAuditBackfill(pool)).pending,150000);
  let processed=0,remaining=150000;
  for(let n=1;n<=3;n++){
    const item=await batch(n);
    assert.equal(item.processed,5000);processed+=5000;remaining=item.remaining;
  }
  assert.equal(processed,15000);assert.equal(remaining,135000);
  event('first_three_batches_committed',{processed,remaining});
  await pool.end();pool=new Pool(opts);
  assert.equal((await planAuditBackfill(pool)).pending,135000);
  event('real_pool_restart_confirmed',{pending:135000});
  for(let n=4;n<=30;n++){
    const item=await batch(n);
    assert.equal(item.processed,5000);processed+=5000;remaining=item.remaining;
  }
  assert.equal(processed,150000);assert.equal(remaining,0);
  assert.equal((await applyAuditBackfill(pool)).processed,0);
  assert.deepEqual(await checksum(),before);
  const invalid=await one(`SELECT count(*)::int n FROM audit_log
    WHERE tenant_id=ANY($1::uuid[]) AND
      (before_data IS DISTINCT FROM public.audit_project(action,entity_type,before_data)
      OR after_data IS DISTINCT FROM public.audit_project(action,entity_type,after_data)
      OR entity_id IS DISTINCT FROM public.audit_entity_reference(entity_id))`,[tenantIds]);
  assert.equal(invalid.n,0);
  const data=await one(`SELECT
    count(*) FILTER (WHERE action='COMPANY_UPDATED' AND
      before_data=jsonb_build_object('company_id',$2::text,'is_active',true) AND
      after_data=jsonb_build_object('company_id',$2::text,'is_active',false))::int updated,
    count(*) FILTER (WHERE action='COMPANY_CREATED' AND
      before_data=jsonb_build_object('company_id',$2::text,'is_active',true) AND
      after_data=jsonb_build_object('company_id',$2::text,'is_active',false))::int created
    FROM audit_log WHERE tenant_id=ANY($1::uuid[])`,[tenantIds,companyId]);
  assert.equal(data.updated,66667);assert.equal(data.created,33333);
  res.outcome='COMPLETE_150000';
  event('integrity_verified',{processed,remaining,checkpoint:true,restart:true,
    idempotent:true,headersPreserved:true,curationPreserved:true,updated:data.updated,created:data.created});
}
async function run(){
  phase='server';
  const version=(await one('SHOW server_version')).server_version;
  assert.match(version,/^18\./);
  res.postgres=version;
  const cfg={};
  for(const k of ['statement_timeout','lock_timeout','jit','work_mem']){
    cfg[k]=(await one('SHOW '+k))[k];
  }
  assert.equal(cfg.statement_timeout,'45s');
  assert.equal(cfg.lock_timeout,'5s');assert.equal(cfg.jit,'off');
  event('server_verified',{version,cfg});
  if(scenario==='B')await history();
  else await snapshot('A_fresh_before_R7');
  await seedR7();
  await snapshot('before_explain');
  phase='explain';
  const pending=`SELECT count(*) FROM public.audit_log
    WHERE public.audit_backfill_pending(audit_policy_version,actor_id)`;
  const pick=`SELECT id FROM public.audit_log
    WHERE public.audit_backfill_pending(audit_policy_version,actor_id)
    ORDER BY id LIMIT 5000 FOR UPDATE`;
  const update=`WITH picked AS MATERIALIZED (${pick}), changed AS (
    UPDATE public.audit_log a SET
    actor_id=public.audit_historical_actor_reference(a.actor_id),
    entity_id=public.audit_entity_reference(a.entity_id),
    request_id=public.audit_entity_reference(a.request_id),
    before_data=public.audit_project(a.action,a.entity_type,a.before_data),
    after_data=public.audit_backfill_after(a.action,a.entity_type,a.after_data,a.actor_id),
    audit_policy_version=1
    FROM picked WHERE a.id=picked.id RETURNING a.id
    ) SELECT count(*)::int FROM changed`;
  await explain('allowlist_global',
    `WITH event_types AS MATERIALIZED (SELECT action,entity_type,count(*) n
    FROM audit_log GROUP BY action,entity_type)
    SELECT * FROM event_types WHERE public.audit_event_policy(action,entity_type) IS NULL`);
  await explain('remaining_count',pending);
  await explain('pick_5000',pick,true);
  await explain('update_5000_with_triggers_rollback',update,true);
  await snapshot('after_reversible_explain');
  await rollbackFailure();
  await snapshot('before_decisive');
  await decisive();
}
try{await run();}
catch(e){
  res.outcome=e?.code==='57014'?'SQLSTATE_57014_REPRODUCED':'DIAGNOSTIC_ERROR';
  res.errors.push({phase,...error(e)});
  event('exception',{outcome:res.outcome,error:error(e)});
  if(e?.code!=='57014')process.exitCode=1;
  try{res.checkpointOnFailure=(await pool.query(
    'SELECT * FROM audit_backfill_checkpoint ORDER BY job_key')).rows;}catch{}
}
finally{
  try{await snapshot('final');}catch(e){res.errors.push({phase:'final_snapshot',...error(e)});}
  res.finishedAt=new Date().toISOString();
  mkdirSync('perf-results',{recursive:true});
  writeFileSync('perf-results/scenario-'+scenario+'.json',JSON.stringify(res,null,2));
  await Promise.allSettled([pool.end(),observer.end()]);
  console.log('PERF_01_FINAL '+JSON.stringify({scenario,outcome:res.outcome,
    batches:res.batches.length,lastBatch:res.batches.at(-1),
    errors:res.errors}));
}
