import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { applyAuditBackfill, planAuditBackfill } from '../src/modules/audit/audit-backfill.js';

function isolated() {
  assert.equal(process.env.CI,'true');
  const url=new URL(process.env.DATABASE_ADMIN_URL!);
  assert.ok(['localhost','127.0.0.1'].includes(url.hostname));
  assert.equal(url.pathname,'/radar_fiscal_test'); assert.equal(url.search,'');
  return new Pool({connectionString:url.toString(),max:2,
    options:'-c statement_timeout=45000 -c lock_timeout=5000'});
}
async function account(pool:Pool) {
  assert.match((await pool.query('SHOW server_version')).rows[0].server_version,/^18\./);
  return (await pool.query("INSERT INTO tenants(name,slug) VALUES('R7.2 synthetic account',$1) RETURNING id",
    [randomUUID()])).rows[0].id as string;
}
async function cleanup(pool:Pool,tenant:string|undefined) {
  try { if(tenant) {
    await pool.query('DELETE FROM audit_log WHERE tenant_id=$1',[tenant]);
    await pool.query('DELETE FROM tenants WHERE id=$1',[tenant]);
  }} finally {await pool.end();}
}
async function legacy(pool:Pool,tenant:string,rows:Array<{
  actor:string|null;version?:number;action?:string;entity?:string;payload:unknown;
}>) {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE audit_log DISABLE TRIGGER audit_allowlist_guard');
    for(const row of rows) await client.query(`
      INSERT INTO audit_log(tenant_id,actor_type,actor_id,action,entity_type,
        before_data,after_data,audit_policy_version,occurred_at)
      VALUES($1,'SYSTEM',$2,$3,$4,$5::jsonb,$5::jsonb,$6,'2025-01-02T03:04:05Z')`,
      [tenant,row.actor,row.action??'COMPANY_UPDATED',row.entity??'company',
        row.payload===null ? null : JSON.stringify(row.payload),row.version??0]);
    await client.query('ALTER TABLE audit_log ENABLE TRIGGER audit_allowlist_guard');
    await client.query('COMMIT');
  } catch(error) {await client.query('ROLLBACK');throw error;}
  finally {client.release();}
}
test('R7.2 new writes: only UUID or exact closed system identities; invalid authors and forged redaction rejected',async()=>{
  const pool=isolated(); let tenant:string|undefined;
  try {
    tenant=await account(pool);
    const insert=(actor:string|null,payload:unknown={is_active:true})=>pool.query(`
      INSERT INTO audit_log(tenant_id,actor_type,actor_id,action,entity_type,after_data)
      VALUES($1,'SYSTEM',$2,'COMPANY_UPDATED','company',$3::jsonb)`,
      [tenant,actor,JSON.stringify(payload)]);
    for(const actor of [null,'','synthetic@example.test','12345678000199',
      'Synthetic Private Label','system:unregistered','system:worker@example.test',
      randomUUID()+'trailing']) await assert.rejects(insert(actor),
      (error:unknown)=>(error as {code:string;message:string}).code==='23514' &&
        (error as {message:string}).message==='audit_invalid_actor',
      'known event with invalid author must be rejected by database');
    assert.equal(Number((await pool.query('SELECT count(*) n FROM audit_log WHERE tenant_id=$1',[tenant])).rows[0].n),0);
    for(const actor of [randomUUID(),'system:worker','system:scheduler',
      'system:taxonomy-baseline-importer','system:taxonomy-v1.1-successor','system:taxonomy-v1.1-publisher',
      'system:grant-platform-admin','system:grant-taxonomy-curator','system:import-confaz-act','system:l17-scheduler']) {
      await insert(actor);
    }
    await assert.rejects(insert('system:worker',{actor_redacted:true}),
      (error:unknown)=>(error as {message:string}).message==='audit_reserved_metadata');
    console.log('ONB02_R72_ACTOR_GUARD invalid_rejected=true closed_system_list=true reserved_flag=true');
  } finally {await cleanup(pool,tenant);}
});
test('R7.2 historical authors: private values redacted including marked v1; resume, headers, other rows and idempotence preserved',async()=>{
  const pool=isolated();let tenant:string|undefined;
  try {
    tenant=await account(pool);
    const invalid=['synthetic@example.test','12345678000199','Synthetic Private Label'];
    const valid=randomUUID();
    await legacy(pool,tenant,[
      ...[0,1].flatMap(version=>invalid.map(actor=>({actor,version,payload:{is_active:true}}))),
      {actor:valid,payload:{is_active:true}},
      {actor:'system:scheduler',payload:{is_active:false}},
      {actor:null,payload:{is_active:true}},
      {actor:'system:worker',version:1,payload:{is_active:false}},
      {actor:invalid[0]!,payload:null},
    ]);
    const select=()=>pool.query(`SELECT id,actor_id,action,entity_type,occurred_at,
      before_data,after_data,audit_policy_version,correlation_id,tenant_id FROM audit_log
      WHERE tenant_id=$1 ORDER BY id`,[tenant]);
    assert.equal(Number((await pool.query(`SELECT count(*) n FROM audit_log
      WHERE tenant_id=$1 AND before_data IS NULL AND after_data IS NULL`,[tenant])).rows[0].n),1,
      'fixture must contain SQL NULL, not the JSON null scalar');
    const before=(await select()).rows;
    const plan=await planAuditBackfill(pool);
    assert.equal(plan.pending,10,'invalid v1 authors are pending too');
    assert.deepEqual((await select()).rows,before,'plan writes nothing');
    const partial=await applyAuditBackfill(pool,{batchSize:2,maxBatches:1});
    assert.equal(partial.processed,2);assert.equal(partial.completed,false);
    const rest=await applyAuditBackfill(pool,{batchSize:2});
    assert.equal(rest.processed,8);assert.equal(rest.remaining,0);
    const after=(await select()).rows;
    for(let i=0;i<before.length;i++) {
      const old=before[i]!,now=after[i]!;
      assert.deepEqual({id:now.id,action:now.action,entity:now.entity_type,date:now.occurred_at,
        correlation:now.correlation_id,tenant:now.tenant_id},
        {id:old.id,action:old.action,entity:old.entity_type,date:old.occurred_at,
          correlation:old.correlation_id,tenant:old.tenant_id});
      if(old.actor_id!==null && invalid.includes(old.actor_id)) {
        assert.equal(now.actor_id,null);
        assert.deepEqual(now.before_data,old.before_data);
        assert.deepEqual(now.after_data,{...(old.after_data??{}),actor_redacted:true});
      } else {
        assert.equal(now.actor_id,old.actor_id);
        assert.deepEqual(now.before_data,old.before_data);
        assert.deepEqual(now.after_data,old.after_data);
      }
      assert.equal(now.audit_policy_version,1);
    }
    assert.equal((await applyAuditBackfill(pool)).processed,0);
    assert.deepEqual((await select()).rows,after,'second apply changes zero rows');
    console.log('ONB02_R72_ACTOR_BACKFILL redacted_classes=3 versions=2 headers_preserved=true resume=true idempotent=true');
  } finally {await cleanup(pool,tenant);}
});
for(const scope of ['FULL_ARCHIVE','RECENT']) for(const reviewMode of ['ALL','SAMPLE','NONE']) {
  test('R7.2 historical simulation context '+scope+'/'+reviewMode,async()=>{
    const pool=isolated();let tenant:string|undefined;
    try {
      tenant=await account(pool);
      const actor=randomUUID(),allowed={policyId:randomUUID(),version:4,revision:17,scope,reviewMode};
      const source={...allowed,message:'Synthetic private message',cnpj:'synthetic-private-value'};
      await legacy(pool,tenant,[{actor,action:'COLLECTION_FILTER_SIMULATION_REQUESTED',
        entity:'collection_filter_simulation',payload:source}]);
      const before=(await pool.query('SELECT * FROM audit_log WHERE tenant_id=$1',[tenant])).rows[0]!;
      assert.deepEqual(before.before_data,source);assert.deepEqual(before.after_data,source);
      assert.equal((await applyAuditBackfill(pool,{batchSize:1})).processed,1);
      const after=(await pool.query('SELECT * FROM audit_log WHERE tenant_id=$1',[tenant])).rows[0]!;
      assert.deepEqual(after.before_data,allowed);
      assert.deepEqual(after.after_data,allowed);
      for(const key of ['id','tenant_id','actor_type','actor_id','action','entity_type','occurred_at','correlation_id']) {
        assert.deepEqual(after[key],before[key],'historical header remains unchanged: '+key);
      }
      assert.equal((await applyAuditBackfill(pool)).processed,0);
      console.log('ONB02_R72_SIMULATION '+scope+'/'+reviewMode+' exact_context=true idempotent=true');
    } finally {await cleanup(pool,tenant);}
  });
}
