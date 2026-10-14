import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const executable=fileURLToPath(new URL('../ops/f2-load-runner/f2-load-all.mjs',import.meta.url));
test('F2-LOAD-10 blocks before touching SQL when required URLs are absent',()=>{
  const env={...process.env,
    F2_ADMIN_DATABASE_URL:'',F2_RESTORE_DATABASE_URL:'',F2_LOAD_DATABASE_URL:''};
  const run=spawnSync(process.execPath,[executable],{encoding:'utf8',env,timeout:10000});
  assert.equal(run.status,1);
  assert.equal(run.stdout,'');
  assert.match(run.stderr,/^F2_LOAD_ALL_BLOCK=F2_DATABASE_URL_MISSING\s*$/);
  assert.doesNotMatch(run.stderr,/postgresql:|password|SELECT |CREATE ROLE/i);
});
test('F2-LOAD-10 has no curator DRAFT import; role teardown is in finally',()=>{
  const source=readFileSync(executable,'utf8');
  assert.doesNotMatch(source,/importDraft|F2_DRAFT_IMPORT_CONTRACT_MISSING|taxonomy:publish-draft/);
  assert.match(source,/await finalReadback\(/);
  assert.match(source,/finally\s*\{[\s\S]*if\(cleanRole\)\{try\{await removeRole\(adminUrl\);\}/);
  assert.match(source,/F2_LOAD_ALL_RESULT=/);
});
test('current Railway inspect start is inert and makes no external calls',()=>{
  const inspect=fileURLToPath(new URL('../ops/f2-load-runner/f2-load08-verify.mjs',import.meta.url));
  const run=spawnSync(process.execPath,[inspect,'inspect'],{encoding:'utf8',timeout:10000});
  assert.equal(run.status,0);
  assert.equal(run.stdout.trim(),'F2_LOAD09_INERT_READY_FOR_MANUAL_START');
  assert.equal(run.stderr,'');
});
