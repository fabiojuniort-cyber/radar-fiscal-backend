// F2-LOAD-09: explicit one-start operational pipeline, fail closed.
import pg from 'pg';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {preflightFiles,executeF2Load,SOURCE_SHA256} from '../taxonomy/f2-production-load.mjs';
import {verifyF2StageReadback} from '../taxonomy/f2-stage-readback.mjs';

const ROOT='/data/f2-load05-20261014160846907';
const ROLE='f2_loader';
const TABLES=['taxonomy_f2_import_batches','taxonomy_f2_import_segment_rows','taxonomy_f2_import_product_rows'];
const fail=code=>{throw new Error(code);};
const errorCode=e=>(e instanceof Error&&/^F2_[A-Z0-9_]+$/.test(e.message))?e.message:
  e?.code==='42501'?'F2_PERMISSION_DENIED':
  /^[0-9A-Z]{5}$/.test(e?.code||'')?'F2_SQLSTATE_'+e.code:
  'F2_LOAD_ALL_UNEXPECTED';
function validPassword(password){
  // Never log or print the secret, its length, or its URL.
  if(typeof password!=='string'||password.length<16||password.length>128||
    /[\u0000-\u001f\u007f]/.test(password))fail('F2_LOADER_PASSWORD_INVALID');
  return password;
}
function dbUrl(raw,host,db,username){
  let u;try{u=new URL(raw||'');}catch{fail('F2_DATABASE_URL_MISSING');}
  if(!['postgres:','postgresql:'].includes(u.protocol)||u.hostname!==host||
     decodeURIComponent(u.pathname)!=='/'+db||
     (username&&decodeURIComponent(u.username)!==username))fail('F2_DATABASE_IDENTITY_MISMATCH');
  return u;
}
function args(mode){return {mode,segmento:'/app/f2-inputs/segmento.xlsx',
  produto:'/app/f2-inputs/produto.xlsx',backup:join(ROOT,'official.dump'),
  backupManifest:join(ROOT,'backup.json'),confirmSourceSha256:SOURCE_SHA256};}
async function restoreGate(){
  const child=spawn(process.execPath,['ops/f2-load-runner/f2-load08-verify.mjs','verify'],
    {stdio:['ignore','pipe','pipe'],env:process.env});
  let out='',err='';
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',x=>{if(out.length<12000)out+=x;});
  child.stderr.on('data',x=>{if(err.length<12000)err+=x;});
  const status=await new Promise((ok,no)=>{child.once('error',no);child.once('close',ok);});
  if(status!==0)fail(err.match(/\bF2_[A-Z0-9_]+\b/)?.[0]||'F2_RESTORE_VERIFY_FAILED');
  if(!out.includes('F2_LOAD08_RESTORE_COUNTS=PASS 8/8 ')||
     !out.includes('RESTORE_VERIFIED=true'))fail('F2_RESTORE_PROOF_MISSING');
  console.log('F2_LOAD_ALL_RESTORE=PASS_8_OF_8');
}
async function databaseGate(admin){
  const x=(await admin.query("SELECT current_database() AS db,current_setting('server_version_num')::int AS pg")).rows[0];
  if(x.db!=='railway'||x.pg<180000)fail('F2_PROD_DB_IDENTITY_MISMATCH');
}
async function roleGate(admin){
  const result=(await admin.query("SELECT rolcanlogin,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls,rolinherit FROM pg_roles WHERE rolname=$1",[ROLE])).rows[0];
  if(!result?.rolcanlogin||result.rolsuper||result.rolcreaterole||result.rolcreatedb||
    result.rolreplication||result.rolbypassrls||result.rolinherit)fail('F2_ROLE_FLAGS_INVALID');
  for(const name of TABLES){
    const x=(await admin.query("SELECT has_table_privilege($1,$2,'SELECT') AS sel,has_table_privilege($1,$2,'INSERT') AS ins,has_table_privilege($1,$2,'UPDATE') AS upd,has_table_privilege($1,$2,'DELETE') AS del",
      [ROLE,'public.'+name])).rows[0];
    if(!x.sel||!x.ins||x.del||x.upd!==(name===TABLES[0]))fail('F2_ROLE_PRIVILEGES_INVALID');
  }
  const p=(await admin.query("SELECT has_table_privilege($1,'public.publications','SELECT') AS sel,has_table_privilege($1,'public.publications','INSERT') AS ins",[ROLE])).rows[0];
  if(p.sel||p.ins)fail('F2_ROLE_SCOPE_INVALID');
}
async function prepareRole(admin,password,alreadyExists){
  const secret=validPassword(password);
  if(alreadyExists){
    const x=(await admin.query(
      "SELECT rolcanlogin,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls,rolinherit FROM pg_roles WHERE rolname=$1",[ROLE])).rows[0];
    if(!x?.rolcanlogin||x.rolsuper||x.rolcreaterole||x.rolcreatedb||
      x.rolreplication||x.rolbypassrls||x.rolinherit)fail('F2_ROLE_PREEXISTING_UNSAFE');
  }
  await admin.query('BEGIN');
  try{
    // Password is a bind parameter; only the static DDL is sent separately.
    // The SET LOCAL value is rolled back/cleared at COMMIT; never printed.
    await admin.query("SELECT set_config('f2.temp_password',$1,true)",[secret]);
    await admin.query(
      "DO $ddl$ BEGIN "+
      "IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='f2_loader') THEN "+
      "EXECUTE format('ALTER ROLE f2_loader WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',current_setting('f2.temp_password',true)); "+
      "ELSE "+
      "EXECUTE format('CREATE ROLE f2_loader LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',current_setting('f2.temp_password',true)); "+
      "END IF; END $ddl$;");
    await admin.query('GRANT CONNECT ON DATABASE railway TO f2_loader');
    await admin.query('GRANT USAGE ON SCHEMA public TO f2_loader');
    await admin.query('GRANT SELECT,INSERT ON public.taxonomy_f2_import_batches,public.taxonomy_f2_import_segment_rows,public.taxonomy_f2_import_product_rows TO f2_loader');
    await admin.query('GRANT UPDATE ON public.taxonomy_f2_import_batches TO f2_loader');
    await admin.query('COMMIT');
  }catch(e){await admin.query('ROLLBACK').catch(()=>{});throw e;}
  await roleGate(admin);
  console.log('F2_LOAD_ALL_ROLE=PASS '+(alreadyExists?'EXISTING_PASSWORD_UPDATED':'CREATED'));
}
async function removeRole(url){
  const c=new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:10000});
  try{
    await c.connect();await databaseGate(c);
    await c.query('BEGIN');
    try{
      const exists=(await c.query("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1) AS found",[ROLE])).rows[0].found;
      if(exists){
        // Exact authorised teardown; never DROP OWNED.
        await c.query('REVOKE ALL ON public.taxonomy_f2_import_batches,public.taxonomy_f2_import_segment_rows,public.taxonomy_f2_import_product_rows FROM f2_loader');
        await c.query('REVOKE USAGE ON SCHEMA public FROM f2_loader');
        await c.query('REVOKE CONNECT ON DATABASE railway FROM f2_loader');
        await c.query('DROP ROLE f2_loader');
      }
      await c.query('COMMIT');
      if((await c.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname=$1",[ROLE])).rows[0].n!==0)
        fail('F2_ROLE_REMOVAL_NOT_VERIFIED');
      console.log('F2_LOAD_ALL_ROLE_REMOVED=true '+(exists?'DROP_VERIFIED':'ALREADY_ABSENT'));
    }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
  }finally{await c.end().catch(()=>{});}
}
async function finalReadback(pool,payload,batchId){
  const client=await pool.connect();let tx=false;
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');tx=true;
    await verifyF2StageReadback(client,batchId,payload);
    const counts=(await client.query('SELECT (SELECT count(*)::int FROM public.taxonomy_f2_import_batches) AS batches,'+
      '(SELECT count(*)::int FROM public.taxonomy_f2_import_segment_rows) AS segments,'+
      '(SELECT count(*)::int FROM public.taxonomy_f2_import_product_rows) AS products')).rows[0];
    if(counts.batches!==1||counts.segments!==1332||counts.products!==4225)
      fail('F2_FINAL_READBACK_COUNTS_MISMATCH');
    await client.query('COMMIT');tx=false;
    return counts;
  }finally{if(tx)await client.query('ROLLBACK').catch(()=>{});client.release();}
}
export async function main(){
  let admin=null,pool=null,adminUrl=null,cleanRole=false,failure=null,result=null;
  try{
    adminUrl=dbUrl(process.env.F2_ADMIN_DATABASE_URL,'postgres.railway.internal','railway');
    dbUrl(process.env.F2_RESTORE_DATABASE_URL,'f2-restore-pg.railway.internal','railway');
    const loaderUrl=dbUrl(process.env.F2_LOAD_DATABASE_URL,'postgres.railway.internal','railway',ROLE);
    // URL password encoding in Railway references may be incomplete.
    // Use the approved current secret via URL's own percent-encoding setter.
    loaderUrl.password=validPassword(process.env.F2_LOADER_PASSWORD);
    await restoreGate();
    const p=await preflightFiles(args('plan'));
    if(p.payload.summary.segmentRows!==1332||p.payload.summary.productRows!==4225||
       p.payload.summary.errors!==0||p.payload.summary.warnings!==448)fail('F2_PLAN_GATE');
    console.log('F2_LOAD_ALL_PLAN=1332/4225/0/448');
    admin=new pg.Client({connectionString:adminUrl.toString(),connectionTimeoutMillis:10000});
    await admin.connect();await databaseGate(admin);
    const before=(await admin.query(
      'SELECT (SELECT count(*)::int FROM public.taxonomy_f2_import_batches) AS batches,'+
      '(SELECT count(*)::int FROM public.taxonomy_f2_import_segment_rows) AS segments,'+
      '(SELECT count(*)::int FROM public.taxonomy_f2_import_product_rows) AS products')).rows[0];
    const existed=(await admin.query("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1) AS found",[ROLE])).rows[0].found;
    console.log('F2_LOAD_ALL_INSPECT='+JSON.stringify({roleExists:existed,counts:before}));
    if(before.batches!==0||before.segments!==0||before.products!==0)
      fail('F2_PRODUCTION_STAGING_NOT_EMPTY');
    validPassword(process.env.F2_LOADER_PASSWORD);
    cleanRole=true;await prepareRole(admin,process.env.F2_LOADER_PASSWORD,existed);
    await admin.end();admin=null;
    // Owner's explicit one-click command is the ONLY process-scoped apply enablement.
    const a=await preflightFiles(args('apply'),{...process.env,F2_LOAD_ENABLED:'true'});
    pool=new pg.Pool({connectionString:loaderUrl.toString(),max:1,connectionTimeoutMillis:10000});
    const first=await executeF2Load(pool,a.payload,a.gate);
    if(!first.firstRun||first.insertedBatches!==1||first.insertedSegments!==1332||
       first.insertedProducts!==4225||first.liveTaxonomyChanges!==0)fail('F2_FIRST_APPLY_GATE');
    const second=await executeF2Load(pool,a.payload,a.gate);
    if(second.firstRun||second.batchId!==first.batchId||second.insertedBatches!==0||
       second.insertedSegments!==0||second.insertedProducts!==0||
       second.liveTaxonomyChanges!==0)fail('F2_SECOND_APPLY_GATE');
    const counts=await finalReadback(pool,a.payload,first.batchId);
    result={batchId:first.batchId,counts,readback:'PASS',published:false,firstApply:{batches:1,segments:1332,products:4225},secondApply:{batches:0,segments:0,products:0}};
  }catch(e){
    failure=errorCode(e);
    // Printed immediately: cleanup failures must never hide the original gate.
    console.error('F2_LOAD_ALL_ORIGINAL_BLOCK='+failure);
  }
  finally{
    if(!failure)console.log('F2_LOAD_ALL_ORIGINAL_BLOCK=NONE');
    let cleanupFailure=null;
    if(pool){
      try{await pool.end();}catch{cleanupFailure='F2_POOL_TEARDOWN_FAILED';}
    }
    if(admin){
      try{await admin.end();}catch{cleanupFailure='F2_ADMIN_TEARDOWN_FAILED';}
    }
    if(cleanRole){
      try{await removeRole(adminUrl);}
      catch(e){
        cleanupFailure='F2_ROLE_REMOVAL_FAILED';
        const code=errorCode(e);
        console.error('F2_LOAD_ALL_CLEANUP_BLOCK='+cleanupFailure+' ORIGINAL_CLEANUP_CODE='+code);
      }
    }
    if(failure||cleanupFailure){
      console.error('F2_LOAD_ALL_BLOCK='+(failure||cleanupFailure));
      process.exitCode=1;
    }
    else if(result)console.log('F2_LOAD_ALL_RESULT='+JSON.stringify({...result,roleRemoved:true}));
    else{console.error('F2_LOAD_ALL_BLOCK=F2_RESULT_NOT_CERTIFIED');process.exitCode=1;}
  }
}
if(import.meta.url===new URL('file://'+process.argv[1]).href){
  main().catch(()=>{console.error('F2_LOAD_ALL_BLOCK=F2_UNEXPECTED_TOP_LEVEL');process.exitCode=1;});
}
