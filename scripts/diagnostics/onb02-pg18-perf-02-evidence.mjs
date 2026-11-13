import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {Pool} from 'pg';

// ONB02-PG18-PERF-02: read-only evidence, disposable GitHub runner only.
const phase=process.argv[2],variant=process.env.PERF_PG_VARIANT;
const url=process.env.DATABASE_ADMIN_URL;
assert.ok(['before','after'].includes(phase));
assert.ok(['18.6','18.7'].includes(variant));
assert.equal(process.env.CI,'true');
assert.equal(process.env.NODE_ENV,'test');
assert.ok(url);
const u=new URL(url);
assert.ok(['localhost','127.0.0.1'].includes(u.hostname));
assert.equal(u.pathname,'/radar_fiscal_test');
assert.equal(u.username,'postgres');
assert.equal(u.search,'');
const pool=new Pool({connectionString:url,max:1,options:'-c jit=off -c statement_timeout=45000 -c lock_timeout=5000'});
const result={task:'ONB02-PG18-PERF-02',phase,variant,
  time:new Date().toISOString(),queries:{},official:null,notes:[
    'No EXPLAIN ANALYZE before unchanged official R7 test',
    'pg_stat_all_tables n_dead_tup and pg_class.reltuples are estimates',
    'This capture does not change any table or statement timeout',
  ]};
async function query(name,sql,params=[]){
  const start=performance.now();
  try {
    const r=await pool.query(sql,params);
    result.queries[name]={elapsedMs:Math.round((performance.now()-start)*1000)/1000,rows:r.rows};
  }catch(e){
    result.queries[name]={error:{code:e?.code??null,message:String(e?.message??e).slice(0,300)}};
  }
}
try {
  await query('version',"SELECT version() AS version,current_setting('server_version') AS server_version");
  const v=result.queries.version?.rows?.[0]?.server_version;
  assert.ok(v && (v===variant || v.startsWith(variant+' ')),'postgres_version_mismatch');
  await query('settings',`SELECT current_setting('statement_timeout') AS statement_timeout,
    current_setting('lock_timeout') AS lock_timeout,
    current_setting('jit') AS jit,current_setting('work_mem') AS work_mem,
    current_setting('max_parallel_workers_per_gather') AS max_parallel_workers_per_gather`);
  await query('stat_all_tables',`SELECT relname,n_live_tup,n_dead_tup,n_mod_since_analyze,
    last_analyze,last_autoanalyze,last_autovacuum,vacuum_count,
    autovacuum_count,analyze_count,autoanalyze_count,seq_scan,idx_scan
    FROM pg_stat_all_tables WHERE schemaname='public' AND relname='audit_log'`);
  await query('pg_class',`SELECT c.reltuples,c.relpages,
    pg_relation_size(c.oid) AS heap_bytes,pg_indexes_size(c.oid) AS indexes_bytes,
    pg_total_relation_size(c.oid) AS total_bytes
    FROM pg_class c WHERE c.oid='public.audit_log'::regclass`);
  await query('pg_stats',`SELECT attname,null_frac,n_distinct,correlation
    FROM pg_stats WHERE schemaname='public' AND tablename='audit_log'
    AND attname IN ('id','actor_id','audit_policy_version','action','entity_type')
    ORDER BY attname`);
  await query('indexes',`SELECT indexname,indexdef FROM pg_indexes
    WHERE schemaname='public' AND tablename='audit_log' ORDER BY indexname`);
  await query('index_usage',`SELECT indexrelname,idx_scan,idx_tup_read,idx_tup_fetch
    FROM pg_stat_user_indexes WHERE schemaname='public' AND relname='audit_log'
    ORDER BY indexrelname`);
  await query('checkpoint',`SELECT job_key,processed,last_batch_at,completed_at
    FROM public.audit_backfill_checkpoint ORDER BY job_key`);
  await query('activity_counts',`SELECT state,wait_event_type,wait_event,count(*) AS sessions
    FROM pg_stat_activity WHERE datname=current_database()
    GROUP BY state,wait_event_type,wait_event ORDER BY state,wait_event_type,wait_event`);
  await query('ungranted_locks',`SELECT mode,locktype,count(*) AS sessions
    FROM pg_locks WHERE NOT granted GROUP BY mode,locktype ORDER BY mode,locktype`);
  if(phase==='after'){
    const path='perf-results/official-'+variant+'.log';
    if(existsSync(path)){
      const all=readFileSync(path,'utf8');
      result.official={
        markers:all.split('\n').filter(s=>/ONB02_R71_STAGE|ONB02_R7_BACKFILL|canceling statement due to statement timeout|SQLSTATE 57014|not ok|✖ R7:/.test(s)).slice(0,35).map(s=>s.slice(0,600)),
        hasEndMarker:all.includes('ONB02_R7_BACKFILL'),
        hasTimeout:all.includes('canceling statement due to statement timeout'),
        bytes:Buffer.byteLength(all,'utf8'),
      };
    }
  }
  console.log('PERF02_SNAPSHOT '+JSON.stringify({
    variant,phase,server_version:v,
    audit_stats:result.queries.stat_all_tables?.rows?.[0],
    checkpoint:result.queries.checkpoint?.rows,
    official:result.official,
  }));
}finally{
  mkdirSync('perf-results',{recursive:true});
  writeFileSync('perf-results/snapshot-'+variant+'-'+phase+'.json',JSON.stringify(result,null,2));
  await pool.end();
}
