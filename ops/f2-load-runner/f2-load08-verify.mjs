// F2-LOAD-08: one-shot read-only verification of an ALREADY-restored database.
// NEVER invokes pg_restore, CREATE DATABASE, role creation, plan, apply, or publish.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

const ROOT='/data/f2-load05-20261014160846907';
const DUMP=join(ROOT,'official.dump');
const PENDING=join(ROOT,'backup.pending.json');
const VERIFIED=join(ROOT,'backup.json');
const BACKUP_SHA='5c356cb0f5ebb8bea8d2f9d2f6efac635d4583fa89409ba19df0c74d8935219f';
const STARTED='2026-10-14T16:08:46.907Z';
const PROJECT='d7291d78-020d-42d5-8cd9-c387a156a580';
const RESTORED_DB='f2_load07_restore_20261014';
const EXPECTED=Object.freeze({
  publications:7733,
  publication_origins:7833,
  publication_versions:7812,
  companies:5,
  company_publications:0,
  taxonomy_f2_import_batches:0,
  taxonomy_f2_import_segment_rows:0,
  taxonomy_f2_import_product_rows:0,
});
const NAMES=Object.freeze(Object.keys(EXPECTED));
const fail=code=>{throw new Error(code);};
function tableOK(name){return /^[a-z0-9_]+$/.test(name)&&NAMES.includes(name);}
export function assertTableNames(){
  if(NAMES.length!==8||NAMES.some(n=>!tableOK(n))||
    !tableOK('taxonomy_f2_import_batches')||
    tableOK('taxonomy_f2_import_batches;DROP TABLE publications')||
    tableOK('taxonomy_F2_import_batches')||
    tableOK('other_table')) fail('F2_RESTORE_MANIFEST_TABLE_INVALID');
}
function countsInPending(node,found={},depth=0){
  if(!node||typeof node!=='object'||depth>8)return found;
  if(!Array.isArray(node)){
    const table=typeof node.table==='string'?node.table:
      typeof node.table_name==='string'?node.table_name:
      typeof node.name==='string'?node.name:null;
    const count=node.count??node.rows??node.rowCount;
    if(tableOK(table)&&Number.isSafeInteger(Number(count))) found[table]=Number(count);
  }
  for(const [key,val] of Object.entries(node)){
    if(tableOK(key)&&Number.isSafeInteger(Number(val))) found[key]=Number(val);
    if(val&&typeof val==='object') countsInPending(val,found,depth+1);
  }
  return found;
}
async function hashFile(path){
  const h=createHash('sha256');let size=0;
  for await(const chunk of createReadStream(path)){h.update(chunk);size+=chunk.length;}
  return {sha:h.digest('hex'),size};
}
function checkedUrl(value,host,db){
  let url;try{url=new URL(value);}catch{fail('F2_RESTORE_URL_INVALID');}
  if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!==host||
    decodeURIComponent(url.pathname)!=='/'+db) fail('F2_RESTORE_TARGET_MISMATCH');
  return url;
}
async function main(){
  assertTableNames();
  if(process.argv[2]==='inspect'){
    console.log('F2_LOAD09_INERT_READY_FOR_MANUAL_START');
    return;
  }
  const raw=await readFile(PENDING,'utf8');
  const pending=JSON.parse(raw);
  const found=countsInPending(pending);
  const foundKeys=NAMES.filter(n=>Object.hasOwn(found,n));
  if(process.argv[2]==='inspect'){
    console.log('F2_LOAD08_VALIDATOR_TEST=PASS taxonomy_f2_import_batches');
    console.log('F2_LOAD08_PENDING_SHAPE='+JSON.stringify({
      topLevelKeys:Object.keys(pending).sort(),originCountKeys:foundKeys,
      originCounts:foundKeys.map(k=>[k,found[k]])}));
    return;
  }
  if(process.argv[2]!=='verify') fail('F2_LOAD08_MODE_REQUIRED');
  if(foundKeys.length!==8)fail('F2_RESTORE_ORIGIN_COUNTS_MISSING');
  for(const t of NAMES)if(found[t]!==EXPECTED[t])fail('F2_RESTORE_ORIGIN_COUNTS_MISMATCH');
  const startedMs=Date.parse(STARTED);
  const now=Date.now();
  if(!Number.isFinite(startedMs)||now<startedMs||now-startedMs>=86400000)
    fail('F2_BACKUP_EXPIRED_OR_INVALID');
  const backup=await hashFile(DUMP);
  if(backup.sha!==BACKUP_SHA||backup.size!==226226885)
    fail('F2_BACKUP_HASH_MISMATCH');
  const restoreUrl=checkedUrl(process.env.F2_RESTORE_DATABASE_URL,
    'f2-restore-pg.railway.internal','railway');
  const prodUrl=checkedUrl(process.env.F2_ADMIN_DATABASE_URL,
    'postgres.railway.internal','railway');
  const client=new pg.Client({connectionString:restoreUrl.toString(),
    connectionTimeoutMillis:10000,application_name:'f2-load08-restore-counts-ro'});
  let began=false;
  try{
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    began=true;
    await client.query("SET LOCAL statement_timeout='45s'");
    await client.query("SET LOCAL lock_timeout='3s'");
    const id=(await client.query(
      "SELECT current_database() AS db,current_setting('server_version_num')::int AS v")).rows[0];
    if(id.db!=='railway'||id.v<180000)fail('F2_RESTORE_POSTGRES_IDENTITY_MISMATCH');
    const isRestored=(await client.query(
      'SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1) AS has_db',
      [RESTORED_DB])).rows[0].has_db;
    if(!isRestored)fail('F2_RESTORE_DATABASE_MISSING');
    await client.query('ROLLBACK');began=false;
  }finally{
    if(began)await client.query('ROLLBACK').catch(()=>{});
    await client.end().catch(()=>{});
  }
  // Explicitly connect to the existing restored database, NOT production.
  const restoredUrl=new URL(restoreUrl.toString());
  restoredUrl.pathname='/'+RESTORED_DB;
  const readClient=new pg.Client({connectionString:restoredUrl.toString(),
    connectionTimeoutMillis:10000,application_name:'f2-load08-verify-restore-ro'});
  let readTx=false;
  const actual={};
  try{
    await readClient.connect();
    await readClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');readTx=true;
    await readClient.query("SET LOCAL statement_timeout='45s'");
    await readClient.query("SET LOCAL lock_timeout='3s'");
    const id=(await readClient.query(
      "SELECT current_database() AS db,current_setting('server_version_num')::int AS v")).rows[0];
    if(id.db!==RESTORED_DB||id.v<180000)fail('F2_RESTORE_POSTGRES_IDENTITY_MISMATCH');
    for(const name of NAMES){
      if(!tableOK(name))fail('F2_RESTORE_MANIFEST_TABLE_INVALID');
      const n=(await readClient.query('SELECT COUNT(*)::bigint AS n FROM public."'+name+'"')).rows[0].n;
      actual[name]=Number(n);
      if(!Number.isSafeInteger(actual[name])||actual[name]!==EXPECTED[name]||
        actual[name]!==found[name])fail('F2_RESTORE_COUNTS_MISMATCH');
    }
    await readClient.query('COMMIT');readTx=false;
  }finally{
    if(readTx)await readClient.query('ROLLBACK').catch(()=>{});
    await readClient.end().catch(()=>{});
  }
  if(Date.now()-startedMs>=86400000)fail('F2_BACKUP_EXPIRED_OR_INVALID');
  const manifest={
    sha256:BACKUP_SHA,startedAt:STARTED,
    restoreVerifiedAt:new Date().toISOString(),
    restoreVerifiedSha256:BACKUP_SHA,
    target:{projectId:PROJECT,host:prodUrl.hostname,database:decodeURIComponent(prodUrl.pathname).slice(1)}
  };
  // One private local attestation file only, after all 8/8 checks.
  try{
    await writeFile(VERIFIED,JSON.stringify(manifest)+'\n',{mode:0o600,flag:'wx'});
  }catch(e){
    // The previous click already wrote the verified manifest. Never fail
    // a fresh 8/8 read-only comparison simply because the file exists.
    if(e?.code!=='EEXIST')throw e;
    const recorded=JSON.parse(await readFile(VERIFIED,'utf8'));
    if(recorded?.sha256!==BACKUP_SHA||
       recorded?.restoreVerifiedSha256!==BACKUP_SHA||
       recorded?.startedAt!==STARTED||
       !Number.isFinite(Date.parse(recorded?.restoreVerifiedAt??''))||
       Date.parse(recorded.restoreVerifiedAt)<startedMs||
       Date.parse(recorded.restoreVerifiedAt)>Date.now()||
       recorded?.target?.projectId!==PROJECT||
       recorded?.target?.host!==prodUrl.hostname||
       recorded?.target?.database!==decodeURIComponent(prodUrl.pathname).slice(1))
      fail('F2_RESTORE_MANIFEST_ALREADY_EXISTS_MISMATCH');
  }
  console.log('F2_LOAD08_VALIDATOR_TEST=PASS taxonomy_f2_import_batches');
  console.log('F2_LOAD08_RESTORE_COUNTS=PASS 8/8 '+NAMES.map(n=>n+'='+actual[n]).join(' '));
  console.log('F2_LOAD08_BACKUP=PASS SHA256='+BACKUP_SHA+' RESTORE_VERIFIED=true');
  console.log('F2_LOAD08_STATUS=INERT_READY_FOR_PASSWORD');
}
main().catch(err=>{
  const code=err instanceof Error&&/^F2_[A-Z0-9_]+$/.test(err.message)?err.message:
    (err?.code==='EEXIST'?'F2_RESTORE_MANIFEST_ALREADY_EXISTS':'F2_LOAD08_VERIFICATION_BLOCK');
  console.error(code);process.exitCode=1;
});
