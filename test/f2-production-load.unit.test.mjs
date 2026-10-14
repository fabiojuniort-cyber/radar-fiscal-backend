import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {SOURCE_SHA256,authorizeF2Load,assertBackup,preflightFiles,hashBackup,parseOptions,executeF2Load} from '../ops/taxonomy/f2-production-load.mjs';
import {F2_SOURCE} from '../ops/taxonomy/f2-xlsx-dry-run.mjs';
const now=Date.parse('2026-10-14T02:00:00Z');
const hash='a'.repeat(64);
const manifest={sha256:hash,startedAt:'2026-10-14T01:00:00Z',restoreVerifiedAt:'2026-10-14T01:10:00Z',restoreVerifiedSha256:hash,
 target:{projectId:'d7291d78-020d-42d5-8cd9-c387a156a580',host:'postgres.railway.internal',database:'radar'}};
const env={NODE_ENV:'production',F2_IMPORT_SCOPE:'PRODUCTION_STAGING_ONLY',F2_LOAD_ENABLED:'true'};
const sources={segmento:F2_SOURCE.segmento.sha256,produto:F2_SOURCE.produto.sha256};
test('absent flag rejects before files and any DB pool can be used',async()=>{
 await assert.rejects(preflightFiles({mode:'apply',segmento:'/does-not-exist'}),/F2_CONFIRM_SOURCE_REQUIRED/);
 let connections=0;const pool={connect(){connections++;throw Error('must not connect');}};
 await assert.rejects(executeF2Load(pool,{},{}),/F2_APPLY_GATE_REQUIRED/);
 assert.equal(connections,0);
});
test('wrong source confirmation, source hash and expired backup produce zero connections',async()=>{
 let connections=0;const pool={connect(){connections++;throw Error('must not connect');}};
 for(const [options,m,s,b,code] of [
 [{mode:'apply',confirmSourceSha256:'0'.repeat(64)},manifest,sources,hash,/CONFIRM_SOURCE/],
 [{mode:'apply',confirmSourceSha256:SOURCE_SHA256},manifest,{...sources,produto:'bad'},hash,/SOURCE_HASH/],
 [{mode:'apply',confirmSourceSha256:SOURCE_SHA256},{...manifest,startedAt:'2026-10-12T01:00:00Z'},sources,hash,/BACKUP_EXPIRED/],
 [{mode:'apply',confirmSourceSha256:SOURCE_SHA256},manifest,sources,'b'.repeat(64),/BACKUP_HASH/]
 ])assert.throws(()=>authorizeF2Load(options,m,s,b,env,now),code);
 const gate={mode:'apply',sourceSha256:SOURCE_SHA256,manifest:{...manifest,startedAt:'2026-10-12T01:00:00Z'},backupSha:hash};
 await assert.rejects(executeF2Load(pool,{},gate,()=>now),/BACKUP_EXPIRED/);
 assert.equal(connections,0);
});
test('valid confirmation binds the two fixed original source digests and target',()=>{
 const gate=authorizeF2Load({mode:'apply',confirmSourceSha256:SOURCE_SHA256},manifest,sources,hash,env,now);
 assert.equal(gate.sourceSha256,SOURCE_SHA256);
 assert.throws(()=>authorizeF2Load({mode:'apply',confirmSourceSha256:SOURCE_SHA256},manifest,sources,hash,{},now),/PRODUCTION_ENV/);
 assert.throws(()=>assertBackup({...manifest,startedAt:'2026-10-14T03:00:00Z'},hash,now),/BACKUP_EXPIRED/);
 assert.throws(()=>assertBackup({...manifest,restoreVerifiedSha256:'bad'},hash,now),/RESTORE_EVIDENCE/);
 assert.throws(()=>assertBackup({...manifest,target:{...manifest.target,projectId:'wrong'}},hash,now),/TARGET_REQUIRED/);
 assert.throws(()=>assertBackup(manifest,hash,Date.parse(manifest.startedAt)+86400000),/BACKUP_EXPIRED/);
});
test('actual file SHA and changed workbook reject before parsing or connecting',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'f2-gates-'));
 try{
  const backup=join(dir,'backup.dump'),s=join(dir,'s.xlsx'),p=join(dir,'p.xlsx'),mf=join(dir,'manifest.json');
  await writeFile(backup,'fixture dump');await writeFile(s,'not approved');await writeFile(p,'not approved');
  const actual=createHash('sha256').update('fixture dump').digest('hex');
  assert.equal(await hashBackup(backup),actual);
  await writeFile(mf,JSON.stringify({...manifest,sha256:actual,restoreVerifiedSha256:actual}));
  await assert.rejects(preflightFiles({mode:'apply',confirmSourceSha256:SOURCE_SHA256,segmento:s,produto:p,backup,backupManifest:mf},env,now),/SOURCE_HASH_MISMATCH/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('strict explicit arguments: no defaults, unknown and duplicate flags rejected',()=>{
 assert.throws(()=>parseOptions([]),/REQUIRED_ARGUMENT/);
 assert.throws(()=>parseOptions(['--mode=apply','--mode=plan']),/INVALID_ARGUMENT/);
 assert.throws(()=>parseOptions(['--force=true']),/INVALID_ARGUMENT/);
});
