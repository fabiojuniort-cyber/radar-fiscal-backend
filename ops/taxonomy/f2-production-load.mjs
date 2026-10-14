import { createHash } from 'node:crypto';
import { readFile, mkdtemp, writeFile, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { F2_SOURCE, parseApprovedWorkbook } from './f2-xlsx-dry-run.mjs';
import { makeF2StagingPayload } from './f2-stage-payload.mjs';
import { writeF2StageRows } from './f2-stage-rows.mjs';
const digest=x=>createHash('sha256').update(x).digest('hex');
export const SOURCE_SHA256=digest(JSON.stringify({
 segmentoSha256:F2_SOURCE.segmento.sha256,produtoSha256:F2_SOURCE.produto.sha256,
}));
const reject=code=>{throw new Error(code);};
const utc=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)?Date.parse(value):NaN;
export function assertBackup(manifest, actualSha, now=Date.now()) {
 const started=utc(manifest?.startedAt),restored=utc(manifest?.restoreVerifiedAt);
 if(!/^[a-f0-9]{64}$/.test(manifest?.sha256??'')||actualSha!==manifest.sha256)reject('F2_BACKUP_HASH_MISMATCH');
 if(!Number.isFinite(started)||started>now||now-started>=86400000)reject('F2_BACKUP_EXPIRED_OR_INVALID');
 if(!Number.isFinite(restored)||restored<started||restored>now||
    manifest.restoreVerifiedSha256!==actualSha)reject('F2_BACKUP_RESTORE_EVIDENCE_REQUIRED');
 if(manifest?.target?.projectId!=='d7291d78-020d-42d5-8cd9-c387a156a580'||
    !manifest.target.database||!manifest.target.host)reject('F2_BACKUP_TARGET_REQUIRED');
}
export function authorizeF2Load(options, manifest, sourceDigests, backupSha, env=process.env, now=Date.now()) {
 if(!['apply','plan'].includes(options.mode))reject('F2_EXPLICIT_MODE_REQUIRED');
 if(options.mode==='apply'&&options.confirmSourceSha256!==SOURCE_SHA256)reject('F2_CONFIRM_SOURCE_REQUIRED');
 if(sourceDigests.segmento!==F2_SOURCE.segmento.sha256||sourceDigests.produto!==F2_SOURCE.produto.sha256)reject('F2_SOURCE_HASH_MISMATCH');
 assertBackup(manifest,backupSha,now);
 if(options.mode==='apply'&&(env.NODE_ENV!=='production'||env.F2_IMPORT_SCOPE!=='PRODUCTION_STAGING_ONLY'||
   env.F2_LOAD_ENABLED!=='true'))reject('F2_PRODUCTION_ENV_REQUIRED');
 return {manifest,backupSha,sourceSha256:SOURCE_SHA256,mode:options.mode};
}
export async function hashBackup(path) {
 const handle=await open(path,'r');
 try {
  const before=await handle.stat();if(!before.isFile()||before.size<=0)reject('F2_BACKUP_NOT_FILE');
  const hash=createHash('sha256');
  for await(const chunk of handle.createReadStream({autoClose:false}))hash.update(chunk);
  const after=await handle.stat();
  if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)reject('F2_BACKUP_CHANGED');
  return hash.digest('hex');
 } finally {await handle.close();}
}
export async function preflightFiles(options, env=process.env, now=Date.now()) {
 // Fail before opening files or making a pool when apply lacks confirmation.
 if(options.mode==='apply'&&options.confirmSourceSha256!==SOURCE_SHA256)reject('F2_CONFIRM_SOURCE_REQUIRED');
 const [s,p,m]=await Promise.all([readFile(options.segmento),readFile(options.produto),readFile(options.backupManifest,'utf8')]);
 if(s.length>8*1024*1024||p.length>8*1024*1024)reject('F2_SOURCE_TOO_LARGE');
 const manifest=JSON.parse(m),backupSha=await hashBackup(options.backup);
 const gate=authorizeF2Load(options,manifest,{segmento:digest(s),produto:digest(p)},backupSha,env,now);
 // Parser reads only private copies of bytes whose SHA was verified (no TOCTOU).
 const dir=await mkdtemp(join(tmpdir(),'f2-load-'));
 try {
  const sp=join(dir,'segmento.xlsx'),pp=join(dir,'produto.xlsx');
  await writeFile(sp,s,{mode:0o600});await writeFile(pp,p,{mode:0o600});
  const [segment,product]=await Promise.all([parseApprovedWorkbook(sp,'segmento'),parseApprovedWorkbook(pp,'produto')]);
  const payload=makeF2StagingPayload(segment.rows,product.rows);
  if(payload.summary.errors!==0||payload.summary.warnings!==448||
    payload.summary.segmentRows!==1332||payload.summary.productRows!==4225)reject('F2_PAYLOAD_GATE');
  return {gate,payload};
 } finally {await rm(dir,{recursive:true,force:true});}
}
const countsSql="SELECT (SELECT count(*)::int FROM public.taxonomy_f2_import_batches) AS batches,"+
 "(SELECT count(*)::int FROM public.taxonomy_f2_import_segment_rows) AS segments,"+
 "(SELECT count(*)::int FROM public.taxonomy_f2_import_product_rows) AS products";
export async function executeF2Load(pool,payload,gate,clock=Date.now) {
 if(gate?.mode!=='apply'||gate.sourceSha256!==SOURCE_SHA256)reject('F2_APPLY_GATE_REQUIRED');
 assertBackup(gate.manifest,gate.backupSha,clock());
 if(payload.hashes.segmentoSha256!==F2_SOURCE.segmento.sha256||payload.hashes.produtoSha256!==F2_SOURCE.produto.sha256||
    payload.summary.errors!==0||payload.summary.warnings!==448||
    payload.segments.length!==1332||payload.products.length!==4225)reject('F2_PAYLOAD_GATE');
 const client=await pool.connect();let begun=false;
 try {
  const identity=await client.query("SELECT current_database() AS db,current_setting('server_version_num')::int AS version");
  if(identity.rows[0]?.db!==gate.manifest.target.database||identity.rows[0]?.version<180000)reject('F2_TARGET_DATABASE_MISMATCH');
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');begun=true;
  await client.query('SET LOCAL search_path=pg_catalog,public');
  await client.query('SELECT pg_advisory_xact_lock(2026, 20303)');
  // Counts and all-cell readback must pass before the sole COMMIT.
  const before=(await client.query(countsSql)).rows[0];
  const result=await writeF2StageRows(client,payload);
  const after=(await client.query(countsSql)).rows[0];
  if(after.batches-before.batches!==result.insertedBatches||
     after.segments-before.segments!==result.insertedSegments||
     after.products-before.products!==result.insertedProducts)reject('F2_COUNT_DELTA_MISMATCH');
  assertBackup(gate.manifest,gate.backupSha,clock());
  await client.query('COMMIT');begun=false;
  return {sourceSha256:SOURCE_SHA256,backupSha256:gate.backupSha,...result,before,after,readback:'PASS'};
 } catch(error) {if(begun)await client.query('ROLLBACK');throw error;}
 finally {client.release();}
}
export function parseOptions(args) {
 const names=new Set(['mode','segmento','produto','backup','backup-manifest','confirm-source-sha256']);
 const o={};
 for(const arg of args) {
  const m=/^--([^=]+)=(.+)$/.exec(arg);
  if(!m||!names.has(m[1])||Object.hasOwn(o,m[1]))reject('F2_INVALID_ARGUMENT');
  o[m[1]]=m[2];
 }
 for(const n of ['mode','segmento','produto','backup','backup-manifest'])if(!o[n])reject('F2_REQUIRED_ARGUMENT');
 return {mode:o.mode,segmento:o.segmento,produto:o.produto,backup:o.backup,
  backupManifest:o['backup-manifest'],confirmSourceSha256:o['confirm-source-sha256']};
}
export async function main(args=process.argv.slice(2)) {
 const options=parseOptions(args);
 const {gate,payload}=await preflightFiles(options);
 if(options.mode==='plan'){
  console.log(JSON.stringify({mode:'PLAN_ONLY',sourceSha256:SOURCE_SHA256,backupSha256:gate.backupSha,
   summary:payload.summary,targetDatabase:gate.manifest.target.database}));return;
 }
 let url;try{url=new URL(process.env.F2_LOAD_DATABASE_URL);}catch{reject('F2_TARGET_CONNECTION_REQUIRED');}
 if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!==gate.manifest.target.host||
   decodeURIComponent(url.pathname)!=='/'+gate.manifest.target.database)reject('F2_TARGET_CONNECTION_MISMATCH');
 const pool=new pg.Pool({connectionString:process.env.F2_LOAD_DATABASE_URL,max:1});
 try {console.log('F2_LOAD_RESULT='+JSON.stringify(await executeF2Load(pool,payload,gate)));}
 finally {await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 main().catch(error=>{const code=error instanceof Error&&/^F2_[A-Z_]+$/.test(error.message)?error.message:null;console.error(code??'F2_LOAD_BLOCK: preflight or transaction failed; no automatic retry. See runbook.');process.exitCode=1;});
}
