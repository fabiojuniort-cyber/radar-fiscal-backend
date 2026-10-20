import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool } from 'pg';
import { insertFixtureSource } from './fixtures/taxonomy-v1-1-source.js';

function run(file:string,args:string[],env:NodeJS.ProcessEnv) {
  return new Promise<{code:number;stdout:string;stderr:string}>(resolve=>
    execFile(file,args,{env,timeout:120000,maxBuffer:8*1024*1024},(error,stdout,stderr)=>
      resolve({code:error?typeof error.code==='number'?error.code:1:0,stdout,stderr})));
}
test('R7.3 TAX-10 documented entrypoint commits publication and audit on real isolated PG18',async()=>{
  assert.equal(process.env.CI,'true');
  const original=new URL(process.env.DATABASE_ADMIN_URL!);
  assert.ok(['localhost','127.0.0.1'].includes(original.hostname));
  assert.equal(original.pathname,'/radar_fiscal_test');assert.equal(original.search,'');
  const runtime=new URL(process.env.DATABASE_URL!);
  assert.equal(runtime.hostname,original.hostname);assert.equal(runtime.pathname,original.pathname);
  const database='radar_fiscal_tax10_r73_test';
  const admin=new Pool({connectionString:original.toString(),max:1});
  let created=false,pool:Pool|undefined;
  try {
    assert.match((await admin.query('SHOW server_version')).rows[0].server_version,/^18\./);
    // A fixed, additional disposable database. Never truncate the shared ONB fixtures.
    await admin.query('CREATE DATABASE '+database+' TEMPLATE template0');created=true;
    const target=new URL(original);target.pathname='/'+database;
    runtime.pathname=target.pathname;
    const env={...process.env,DATABASE_ADMIN_URL:target.toString(),DATABASE_URL:runtime.toString()};
    const prepared=await run('npm',['run','db:prepare'],env);
    assert.equal(prepared.code,0,'isolated database preparation failed: '+prepared.stderr);
    pool=new Pool({connectionString:target.toString(),max:1});
    const client=await pool.connect();
    let source:string;
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE radar_taxonomy_curator');
      source=(await insertFixtureSource(client)).releaseId;
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}
    finally{client.release();}
    const registry=JSON.parse(await readFile('docs/audit-actors-r73.json','utf8')) as {systemActors:string[];writers:Array<{id:string;previousIds:string[]}>};
    for(const actor of registry.systemActors) {
      assert.equal((await pool.query('SELECT audit_actor_reference($1) actor',[actor])).rows[0].actor,actor);
      await pool.query(`INSERT INTO audit_log(actor_type,actor_id,action,entity_type,after_data)
        VALUES('SYSTEM',$1,'COMPANY_UPDATED','company','{"is_active":true}')`,[actor]);
    }
    // Recognized historical system authors are renamed, not erased.
    const previous=registry.writers.flatMap(writer=>writer.previousIds.map(old=>({old,id:writer.id})));
    for(const item of previous) {
      await assert.rejects(pool.query(`INSERT INTO audit_log(actor_type,actor_id,action,entity_type)
        VALUES('SYSTEM',$1,'COMPANY_UPDATED','company')`,[item.old]),
        (error:unknown)=>(error as {message:string}).message==='audit_invalid_actor');
    }
    const seed=await pool.connect();
    const oldRows:Array<{id:string;canonical:string;action:string;occurred_at:Date;after_data:unknown}>=[];
    try {
      await seed.query('BEGIN');
      await seed.query('ALTER TABLE audit_log DISABLE TRIGGER audit_allowlist_guard');
      for(let i=0;i<previous.length;i++) {
        const item=previous[i]!;
        const row=(await seed.query(`INSERT INTO audit_log(actor_type,actor_id,action,entity_type,
          after_data,audit_policy_version) VALUES('SYSTEM',$1,'COMPANY_UPDATED','company',
          '{"is_active":true}',$2) RETURNING id,action,occurred_at,after_data`,
          [item.old,i%2])).rows[0]!;
        oldRows.push({...row,canonical:item.id});
      }
      await seed.query('ALTER TABLE audit_log ENABLE TRIGGER audit_allowlist_guard');
      await seed.query('COMMIT');
    }catch(error){await seed.query('ROLLBACK');throw error;}
    finally{seed.release();}
    const batch=(await pool.query('SELECT * FROM audit_backfill_batch(5000)')).rows[0]!;
    assert.equal(Number(batch.remaining),0);
    for(const old of oldRows) {
      const row=(await pool.query('SELECT actor_id,action,occurred_at,after_data FROM audit_log WHERE id=$1',
        [old.id])).rows[0]!;
      assert.equal(row.actor_id,old.canonical);
      assert.equal(row.action,old.action);assert.deepEqual(row.occurred_at,old.occurred_at);
      assert.deepEqual(row.after_data,old.after_data,'known system author must not be marked redacted');
    }
    assert.equal(Number((await pool.query('SELECT * FROM audit_backfill_batch(5000)')).rows[0].processed),0);
    console.log('ONB02_R73_LEGACY_ACTORS aliases='+previous.length+' versions=2 canonicalized=true new_alias_insert_rejected=true idempotent=true');
    const execute=(name:string,args:string[]=[])=>run(process.execPath,[
      'dist/infrastructure/database/'+name+'.js',...args],env);
    const draft=await execute('taxonomy-v1-1-create-draft');
    assert.equal(draft.code,0,draft.stderr);
    const before=(await pool.query(`SELECT id,status FROM taxonomy_releases
      WHERE version_major=1 AND version_minor=1 AND version_patch=0`)).rows[0]!;
    assert.equal(before.status,'DRAFT');
    assert.equal(Number((await pool.query("SELECT count(*) n FROM audit_log WHERE action='TAXONOMY_V1_1_PUBLISHED'")).rows[0].n),0);
    const runbook=await readFile('ops/taxonomy/TAX-10_RUNBOOK.md','utf8');
    assert.match(runbook,/node dist\/infrastructure\/database\/taxonomy-v1-1-publish\.js\s+--git-sha=<SHA_DO_COMMIT_PUBLICADO>/);
    // Exactly the documented executable, with a synthetic valid artifact commit.
    const sha='c'.repeat(40);
    const published=await execute('taxonomy-v1-1-publish',['--git-sha='+sha]);
    assert.equal(published.code,0,published.stderr);
    const parsed=JSON.parse(published.stdout.split('TAXONOMY_V1_1_PUBLISH=')[1]!.trim()) as {disposition:string};
    assert.equal(parsed.disposition,'PUBLISHED','must exercise the write path, not idempotent early return');
    const artifact=await readFile('docs/taxonomy/TAXONOMY_V1_1_RELEASE_POLICY.json');
    // A different connection observes the committed release and its audit together.
    await pool.end();pool=new Pool({connectionString:target.toString(),max:1});
    const after=(await pool.query(`SELECT status,artifact_git_sha,artifact_sha256 FROM taxonomy_releases
      WHERE id=$1`,[before.id])).rows[0]!;
    assert.equal(after.status,'PUBLISHED');
    assert.equal(after.artifact_git_sha,sha);
    assert.equal(after.artifact_sha256,createHash('sha256').update(artifact).digest('hex'));
    const audit=(await pool.query(`SELECT actor_id,entity_id,after_data FROM audit_log
      WHERE action='TAXONOMY_V1_1_PUBLISHED'`)).rows;
    assert.equal(audit.length,1);assert.equal(audit[0].actor_id,'system:taxonomy-v1.1-publisher');
    assert.equal(audit[0].entity_id,before.id);
    assert.deepEqual(audit[0].after_data,{artifactSha256:after.artifact_sha256});
    assert.equal((await pool.query('SELECT status FROM taxonomy_releases WHERE id=$1',[source!])).rows[0].status,'PUBLISHED');
    const replay=await execute('taxonomy-v1-1-publish',['--git-sha='+sha]);
    assert.equal(replay.code,0,replay.stderr);
    assert.equal(JSON.parse(replay.stdout.split('TAXONOMY_V1_1_PUBLISH=')[1]!.trim()).disposition,'ALREADY_PUBLISHED');
    assert.equal(Number((await pool.query("SELECT count(*) n FROM audit_log WHERE action='TAXONOMY_V1_1_PUBLISHED'")).rows[0].n),1);
    console.log('ONB02_R73_TAX10_CLI pg18=true first_run=PUBLISHED committed_audit=true separate_connection=true replay=ALREADY_PUBLISHED actors='+registry.systemActors.length);
  }finally{
    if(pool)await pool.end();
    if(created)await admin.query('DROP DATABASE '+database+' WITH (FORCE)');
    await admin.end();
  }
});
