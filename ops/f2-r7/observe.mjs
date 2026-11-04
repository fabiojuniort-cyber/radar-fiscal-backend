import pg from 'pg';
import fs from 'node:fs';
import {performance} from 'node:perf_hooks';

export function guard(env=process.env){
  if(env.CI!=='true'||env.GITHUB_ACTIONS!=='true'||!/^[a-f0-9]{24}$/.test(env.F2_R7_LAB_NONCE||''))throw Error('lab_guard');
  const u=new URL(env.DATABASE_ADMIN_URL);
  if(!['localhost','127.0.0.1'].includes(u.hostname)||u.port!=='5432'||u.pathname!=='/radar_fiscal_test'||u.username!=='postgres'||u.search||u.hash)throw Error('database_guard');
}
const emit=(kind,data)=>console.log('F2_R7_DIAG '+JSON.stringify({kind,at:new Date().toISOString(),...data}));
const settings=['server_version','statement_timeout','lock_timeout','jit','work_mem','shared_buffers','max_connections','plan_cache_mode','default_statistics_target','autovacuum','autovacuum_naptime','track_io_timing','session_preload_libraries','auto_explain.log_min_duration','auto_explain.log_analyze','auto_explain.log_timing','auto_explain.log_nested_statements','auto_explain.log_buffers','auto_explain.log_parameter_max_length','auto_explain.log_format'];
const snapshotSQL=`SELECT jsonb_build_object(
 'table',(SELECT jsonb_build_object('reltuples',c.reltuples,'relpages',c.relpages,'reloptions',c.reloptions,'live',s.n_live_tup,'dead',s.n_dead_tup,'modified',s.n_mod_since_analyze,'last_analyze',s.last_analyze,'last_autoanalyze',s.last_autoanalyze,'last_autovacuum',s.last_autovacuum) FROM pg_class c LEFT JOIN pg_stat_user_tables s ON s.relid=c.oid WHERE c.oid='public.audit_log'::regclass),
 'indexes',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'definition_md5',md5(pg_get_indexdef(i.indexrelid)),'valid',i.indisvalid,'reltuples',c.reltuples,'relpages',c.relpages)) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid='public.audit_log'::regclass),
 'functions',(SELECT jsonb_agg(jsonb_build_object('name',p.proname,'definition_md5',md5(pg_get_functiondef(p.oid)),'config',p.proconfig,'acl',p.proacl)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('audit_backfill_batch','audit_backfill_pending','audit_allowlist_guard','audit_project','audit_backfill_after')),
 'triggers',(SELECT jsonb_agg(jsonb_build_object('name',tgname,'enabled',tgenabled,'definition_md5',md5(pg_get_triggerdef(oid)))) FROM pg_trigger WHERE tgrelid='public.audit_log'::regclass AND NOT tgisinternal),
 'statistics',(SELECT jsonb_agg(jsonb_build_object('column',attname,'distinct',n_distinct,'null_fraction',null_frac,'correlation',correlation)) FROM pg_stats WHERE schemaname='public' AND tablename='audit_log')
) AS data`;
export async function queryWithRelease(pool,args){
 const c=await pool.connect();
 try{const result=await c.query(...args);c.release();return result;}
 catch(error){c.release(error);throw error;}
}
let ordinal=0,connections=0;
export function instrumentPool(pool){
 guard();
 if(pool.options.max!==2)throw Error('pool_max_changed');
 const connect=pool.connect.bind(pool);
 pool.connect=async()=>{
  const c=await connect();
  if(c.__f2instrumented)return c;
  try{
   const raw=c.query.bind(c),label='C'+(++connections);
   const gucs=(await raw('SELECT name,current_setting(name,true) AS value FROM unnest($1::text[]) name',[settings])).rows;
   const g=Object.fromEntries(gucs.map(x=>[x.name,x.value]));
   if(!/^18\.6(?:\s|$)/.test(g.server_version)||g.statement_timeout!=='45s'||g.lock_timeout!=='5s'||g.jit!=='off'||g.track_io_timing!=='on'||g.session_preload_libraries!=='auto_explain'||!['250','250ms'].includes(g['auto_explain.log_min_duration'])||g['auto_explain.log_parameter_max_length']!=='0'||g['auto_explain.log_analyze']!=='on'||g['auto_explain.log_timing']!=='off'||g['auto_explain.log_nested_statements']!=='on'||g['auto_explain.log_buffers']!=='on'||g['auto_explain.log_format']!=='json')throw Error('session_settings_changed');
   emit('session',{connection:label,backend_pid:(await raw('SELECT pg_backend_pid() AS pid')).rows[0].pid,gucs:g});
   const snap=async(stage)=>{const t=performance.now();emit('snapshot',{connection:label,stage,data:(await raw(snapshotSQL)).rows[0].data,overhead_ms:performance.now()-t});};
   await snap('connection_open');
   c.query=async(...args)=>{
    const sql=typeof args[0]==='string'?args[0]:args[0]?.text||'';
    const batch=/^SELECT \* FROM public\.audit_backfill_batch\(\$1\)/.test(sql);
    const n=batch?++ordinal:null;
    if(batch){await snap('before_batch_'+n);emit('batch_begin',{connection:label,ordinal:n,batch_size:args[1]?.[0]});}
    const t=performance.now(),usage=process.resourceUsage();
    try{
     const result=await raw(...args);
     if(batch)emit('batch_end',{connection:label,ordinal:n,elapsed_ms:performance.now()-t,result:result.rows,resource_before:usage,resource_after:process.resourceUsage()});
     if(/^COMMIT$/i.test(sql)||/^DROP TRIGGER onb02_r7_fail_batch/.test(sql))await snap(/^COMMIT$/i.test(sql)?'after_commit':'after_failure_trigger_removed');
     return result;
    }catch(e){if(batch)emit('batch_error',{connection:label,ordinal:n,elapsed_ms:performance.now()-t,sqlstate:e.code||null,message:['synthetic_batch_interruption','canceling statement due to statement timeout','canceling statement due to lock timeout'].includes(e.message)?e.message:'OTHER_ERROR'});throw e;}
   };
   c.__f2instrumented=true;
   return c;
  }catch(e){c.release(e);throw e;}
 };
 // Every checkout is awaited and verified, including after pool re-open.
 // This test uses the promise API only. No global pg hooks or app pools change.
 pool.query=(...args)=>queryWithRelease(pool,args);
 return pool;
}

async function observe(){
 guard();
 const pool=new pg.Pool({connectionString:process.env.DATABASE_ADMIN_URL,max:1,options:'-c default_transaction_read_only=on -c statement_timeout=900 -c lock_timeout=500'});
 let stopped=false;process.on('SIGTERM',()=>{stopped=true;});process.on('SIGINT',()=>{stopped=true;});
 const start=performance.now();let count=0;
 try{
  while(!stopped&&count<300&&performance.now()-start<300000){
   const t=performance.now();
   try{
    const sessions=(await pool.query(`SELECT pid,backend_type,state,wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()`)).rows;
    const locks=(await pool.query(`SELECT pid,locktype,mode,granted,count(*)::int AS count FROM pg_locks WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database()) GROUP BY pid,locktype,mode,granted`)).rows;
    const tables=(await pool.query(`SELECT n_live_tup,n_dead_tup,n_mod_since_analyze,last_analyze,last_autoanalyze,last_autovacuum FROM pg_stat_user_tables WHERE relname='audit_log'`)).rows;
    const io=(await pool.query(`SELECT backend_type,object,context,sum(reads) AS reads,sum(writes) AS writes,sum(read_time) AS read_time,sum(write_time) AS write_time FROM pg_stat_io GROUP BY backend_type,object,context`)).rows;
    const db=(await pool.query(`SELECT blks_read,blks_hit,temp_files,temp_bytes,deadlocks,blk_read_time,blk_write_time FROM pg_stat_database WHERE datname=current_database()`)).rows;
    const checkpoint=(await pool.query('SELECT * FROM pg_stat_checkpointer')).rows;
    const cpu=fs.readFileSync('/proc/stat','utf8').split('\n')[0];
    let cgroup={};for(const name of ['cpu.stat','memory.current','memory.events']){try{cgroup[name]=fs.readFileSync('/sys/fs/cgroup/'+name,'utf8');}catch{cgroup[name]='UNAVAILABLE';}}
    emit('sample',{ordinal:++count,elapsed_ms:performance.now()-start,sessions,locks,tables,io,db,checkpoint,cpu,cgroup,overhead_ms:performance.now()-t});
   }catch(e){emit('observer_error',{ordinal:++count,sqlstate:e.code||null});}
   await new Promise(r=>setTimeout(r,Math.max(0,1000-(performance.now()-t))));
  }
 }finally{await pool.end();emit('observer_end',{samples:count,elapsed_ms:performance.now()-start});}
}
if(process.argv.includes('--observer'))await observe();

