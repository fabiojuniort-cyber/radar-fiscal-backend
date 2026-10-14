import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const executable=fileURLToPath(new URL('../ops/f2-load-runner/f2-load-all.mjs',import.meta.url));
const inspect=fileURLToPath(new URL('../ops/f2-load-runner/f2-load08-verify.mjs',import.meta.url));

test('F2-LOAD-11 blocks before touching SQL when required URLs are absent',()=>{
  const env={...process.env,
    F2_ADMIN_DATABASE_URL:'',F2_RESTORE_DATABASE_URL:'',F2_LOAD_DATABASE_URL:''};
  const run=spawnSync(process.execPath,[executable],{encoding:'utf8',env,timeout:10000});
  assert.equal(run.status,1);
  assert.equal(run.stdout,'');
  assert.match(run.stderr,/^F2_LOAD_ALL_ORIGINAL_BLOCK=F2_DATABASE_URL_MISSING\nF2_LOAD_ALL_BLOCK=F2_DATABASE_URL_MISSING\s*$/);
  assert.doesNotMatch(run.stderr,/postgresql:|password|SELECT |CREATE ROLE/i);
});
test('F2-LOAD-11 sanitizes a missing loader password without any external DB call',()=>{
  const run=spawnSync(process.execPath,[executable],{encoding:'utf8',
    env:{...process.env,
      F2_ADMIN_DATABASE_URL:'postgresql://safe@postgres.railway.internal:5432/railway',
      F2_RESTORE_DATABASE_URL:'postgresql://safe@f2-restore-pg.railway.internal:5432/railway',
      F2_LOAD_DATABASE_URL:'postgresql://f2_loader@postgres.railway.internal:5432/railway',
      F2_LOADER_PASSWORD:''},timeout:10000});
  assert.equal(run.status,1);
  assert.match(run.stderr,/F2_LOAD_ALL_ORIGINAL_BLOCK=F2_LOADER_PASSWORD_INVALID/);
  assert.match(run.stderr,/F2_LOAD_ALL_BLOCK=F2_LOADER_PASSWORD_INVALID/);
  assert.doesNotMatch(run.stderr,/postgresql:|CREATE ROLE|SELECT /i);
});
test('F2-LOAD-11 teardown honors explicit REVOKEs and never DROP OWNED',()=>{
  const s=readFileSync(executable,'utf8');
  assert.match(s,/REVOKE ALL ON public\.taxonomy_f2_import_batches,public\.taxonomy_f2_import_segment_rows,public\.taxonomy_f2_import_product_rows FROM f2_loader/);
  assert.match(s,/REVOKE USAGE ON SCHEMA public FROM f2_loader/);
  assert.match(s,/REVOKE CONNECT ON DATABASE railway FROM f2_loader/);
  assert.match(s,/DROP ROLE f2_loader/);
  assert.doesNotMatch(s,/\bDROP\s+OWNED\s+BY\b/i);
  assert.match(s,/IF EXISTS\(SELECT 1 FROM pg_roles WHERE rolname='f2_loader'\)/);
  assert.match(s,/ALTER ROLE f2_loader WITH LOGIN NOINHERIT/);
  assert.match(s,/console\.error\('F2_LOAD_ALL_ORIGINAL_BLOCK='\+failure\)/);
  assert.match(s,/finally\s*\{[\s\S]*if\(cleanRole\)\s*\{\s*try\s*\{\s*await removeRole\(adminUrl\)/);
  assert.match(s,/F2_LOAD_ALL_INSPECT=/);
  assert.doesNotMatch(s,/importDraft|F2_DRAFT_IMPORT_CONTRACT_MISSING|taxonomy:publish-draft/);
});
test('F2-LOAD-11 verified manifest reuse is exact-match-only',()=>{
  const s=readFileSync(inspect,'utf8');
  assert.match(s,/e\?\.code!=='EEXIST'/);
  assert.match(s,/F2_RESTORE_MANIFEST_ALREADY_EXISTS_MISMATCH/);
  assert.match(s,/F2_LOAD08_RESTORE_COUNTS=PASS 8\/8/);
});
test('current Railway inspect start is inert and makes no external calls',()=>{
  const run=spawnSync(process.execPath,[inspect,'inspect'],{encoding:'utf8',timeout:10000});
  assert.equal(run.status,0);
  assert.equal(run.stdout.trim(),'F2_LOAD09_INERT_READY_FOR_MANUAL_START');
  assert.equal(run.stderr,'');
});
