import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const executable=fileURLToPath(new URL('../ops/f2-load-runner/f2-load-all.mjs',import.meta.url));
test('F2-LOAD-09 rejects absent reviewed DRAFT importer before credentials, role, SQL or restore',()=>{
  const run=spawnSync(process.execPath,[executable],{encoding:'utf8',
    env:{...process.env,F2_DRAFT_IMPORT_CONTRACT:'REVIEWED'},
    timeout:10000});
  assert.equal(run.status,1);
  assert.equal(run.stdout,'');
  assert.match(run.stderr,/^F2_LOAD_ALL_BLOCK=F2_DRAFT_IMPORT_CONTRACT_MISSING\s*$/);
  assert.doesNotMatch(run.stderr,/postgresql:|password|SELECT |CREATE ROLE/i);
});
test('current Railway inspect start is inert and validates lowercase/digit identifier',()=>{
  const inspect=fileURLToPath(new URL('../ops/f2-load-runner/f2-load08-verify.mjs',import.meta.url));
  const run=spawnSync(process.execPath,[inspect,'inspect'],{encoding:'utf8',timeout:10000});
  assert.equal(run.status,0);
  assert.equal(run.stdout.trim(),'F2_LOAD09_INERT_READY_FOR_MANUAL_START');
  assert.equal(run.stderr,'');
});
