import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Pool } from 'pg';

const connectionString = process.env.DATABASE_ADMIN_URL;
const script = fileURLToPath(new URL('../ops/onb02/audit-backfill.mjs', import.meta.url));
function isolated() {
  assert.equal(process.env.CI, 'true');
  assert.ok(connectionString);
  const url = new URL(connectionString);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.pathname, '/radar_fiscal_test');
  assert.equal(url.search, '');
  return new Pool({connectionString, max: 2, options:'-c statement_timeout=45000 -c lock_timeout=5000'});
}
function cli(...args: string[]): Promise<{code: number; stdout: string; stderr: string}> {
  return new Promise(resolve => execFile(process.execPath, [script, ...args],
    {env: process.env, timeout: 60000, maxBuffer: 1024 * 1024},
    (error, stdout, stderr) => resolve({
      code: error ? typeof error.code === 'number' ? error.code : 1 : 0, stdout, stderr,
    })));
}
type Event = {action: string; entityType: string; count: number; pending: number; ruleExists: boolean};
type Plan = {pending: number; unregistered: number; events: Event[]};
async function seed(pool: Pool, tenant: string, events: Array<{action: string; entityType: string; version?: number}>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Isolated historical fixture only. No application bypass exists.
    await client.query('ALTER TABLE public.audit_log DISABLE TRIGGER audit_allowlist_guard');
    for (const event of events) {
      await client.query(`INSERT INTO public.audit_log(
        tenant_id,actor_type,action,entity_type,before_data,after_data,audit_policy_version
      ) VALUES($1,'SYSTEM',$2,$3,$4::jsonb,$4::jsonb,$5)`,
        [tenant,event.action,event.entityType,JSON.stringify({
          is_active:true,purged:true,rows:7,cnpj:'synthetic-private-value',
          legalName:'Synthetic private label',message:'Synthetic private message',
        }),event.version ?? 0]);
    }
    await client.query('ALTER TABLE public.audit_log ENABLE TRIGGER audit_allowlist_guard');
    await client.query('COMMIT');
  } catch(error) {await client.query('ROLLBACK');throw error;}
  finally {client.release();}
}
async function snapshot(pool: Pool) {
  return {
    audits: (await pool.query(`SELECT count(*)::text count,
      md5(string_agg(md5(to_jsonb(a)::text),'' ORDER BY id)) fingerprint
      FROM public.audit_log a`)).rows,
    checkpoint: (await pool.query('SELECT * FROM public.audit_backfill_checkpoint ORDER BY job_key')).rows,
  };
}
async function tenant(pool: Pool) {
  return (await pool.query<{id:string}>(
    "INSERT INTO tenants(name,slug) VALUES('R7.1 synthetic account',$1) RETURNING id",
    [randomUUID()])).rows[0]!.id;
}
test('R7.1 CLI: unknown action or entity type is reported; apply and direct batch abort before every write', async () => {
  const pool=isolated(); let tenantId: string|undefined;
  try {
    assert.match((await pool.query<{server_version:string}>('SHOW server_version')).rows[0]!.server_version,/^18\./);
    tenantId=await tenant(pool);
    await seed(pool,tenantId,[
      {action:'COMPANY_UPDATED',entityType:'company'},
      {action:'UNREGISTERED_R71_EVENT',entityType:'company'},
      // Even a previously marked row must not conceal an unknown event type.
      {action:'COMPANY_UPDATED',entityType:'unregistered_r71_entity',version:1},
    ]);
    const before=await snapshot(pool);
    const planned=await cli('--plan');
    assert.equal(planned.code,0);
    assert.equal(planned.stderr,'');
    const plan=JSON.parse(planned.stdout) as Plan;
    assert.equal(plan.unregistered,2);
    assert.ok(plan.events.some(event=>event.action==='UNREGISTERED_R71_EVENT' &&
      event.entityType==='company' && event.count===1 && event.pending===1 && !event.ruleExists));
    assert.ok(plan.events.some(event=>event.action==='COMPANY_UPDATED' &&
      event.entityType==='unregistered_r71_entity' && event.count===1 && event.pending===0 && !event.ruleExists));
    assert.ok(plan.events.some(event=>event.action==='COMPANY_UPDATED' &&
      event.entityType==='company' && event.count>=1 && event.ruleExists));
    assert.deepEqual(await snapshot(pool),before,'plan is SELECT-only, including checkpoint');

    const applied=await cli('--apply','--ack-irreversible-r7','--batch-size','1');
    assert.notEqual(applied.code,0);
    assert.equal(applied.stdout,'');
    const report=JSON.parse(applied.stderr) as {error:string;aborted:boolean;events:Event[]};
    assert.equal(report.error,'audit_backfill_unknown_events');
    assert.equal(report.aborted,true);
    assert.deepEqual(report.events,plan.events.filter(event=>!event.ruleExists));
    assert.deepEqual(await snapshot(pool),before,'zero rows/checkpoint changed, including known rows');

    await assert.rejects(pool.query('SELECT * FROM public.audit_backfill_batch(1)'),
      (error:unknown)=>(error as {code?:string;message?:string}).code==='55000' &&
        (error as {message?:string}).message==='audit_backfill_unknown_events');
    assert.deepEqual(await snapshot(pool),before,'direct SQL batch cannot bypass preflight');
    await assert.rejects(pool.query("SELECT public.audit_project('UNREGISTERED_R71_EVENT','company',NULL)"),
      (error:unknown)=>(error as {code?:string}).code==='23514');

    await pool.query(`DELETE FROM public.audit_log WHERE tenant_id=$1 AND
      (action='UNREGISTERED_R71_EVENT' OR entity_type='unregistered_r71_entity')`,[tenantId]);
    const allowed=await cli('--apply','--ack-irreversible-r7');
    assert.equal(allowed.code,0,allowed.stderr);
    assert.equal(JSON.parse(allowed.stdout).processed,1);
    const payload=(await pool.query<{after_data:unknown;audit_policy_version:number}>(
      'SELECT after_data,audit_policy_version FROM audit_log WHERE tenant_id=$1',[tenantId])).rows[0]!;
    assert.deepEqual(payload.after_data,{is_active:true});
    assert.equal(payload.audit_policy_version,1);
    console.log('ONB02_R71_UNKNOWN_ABORT zero_audit_writes=true zero_checkpoint_writes=true cli_exit_nonzero=true direct_batch_blocked=true');
  } finally {
    if(tenantId) {
      await pool.query('DELETE FROM public.audit_log WHERE tenant_id=$1',[tenantId]);
      await pool.query('DELETE FROM tenants WHERE id=$1',[tenantId]);
    }
    await pool.end();
  }
});
test('R7.1: every inventoried code/historical event has an explicit rule and CLI apply succeeds', async () => {
  const pool=isolated(); let tenantId: string|undefined;
  try {
    const inventory=JSON.parse(await readFile(
      new URL('../docs/audit-event-inventory-r7.json',import.meta.url),'utf8',
    )) as {events:Array<{action:string;entityType:string;sources:string[]}>};
    assert.ok(inventory.events.length>=40);
    for(const event of inventory.events) {
      for(const source of event.sources) {
        const text=await readFile(new URL('../'+source,import.meta.url),'utf8');
        assert.ok(text.includes(event.action),'inventory must point to an actual emitted event');
      }
      const rule=await pool.query<{policy:unknown}>('SELECT public.audit_event_policy($1,$2) policy',
        [event.action,event.entityType]);
      assert.notEqual(rule.rows[0]!.policy,null,'missing explicit event policy');
    }
    tenantId=await tenant(pool);
    await seed(pool,tenantId,inventory.events);
    const planned=await cli('--plan');
    assert.equal(planned.code,0);
    const plan=JSON.parse(planned.stdout) as Plan;
    assert.equal(plan.unregistered,0);
    assert.equal(plan.pending,inventory.events.length);
    for(const event of inventory.events)assert.ok(plan.events.some(row=>
      row.action===event.action && row.entityType===event.entityType && row.ruleExists && row.count>=1));
    const applied=await cli('--apply','--ack-irreversible-r7','--batch-size','7');
    assert.equal(applied.code,0,applied.stderr);
    assert.equal(JSON.parse(applied.stdout).processed,inventory.events.length);
    assert.equal(JSON.parse(applied.stdout).remaining,0);
    const changed=await pool.query<{n:string}>(`SELECT count(*)::text n FROM public.audit_log
      WHERE tenant_id=$1 AND (audit_policy_version<>1 OR after_data ?| ARRAY['cnpj','legalName','message'])`,[tenantId]);
    assert.equal(Number(changed.rows[0]!.n),0);
    const again=await cli('--apply','--ack-irreversible-r7');
    assert.equal(again.code,0);
    assert.equal(JSON.parse(again.stdout).processed,0);
    console.log('ONB02_R71_KNOWN_EVENTS '+JSON.stringify({
      inventoried:inventory.events.length,explicit_rules:true,cli_apply:true,idempotent:true,
    }));
  } finally {
    if(tenantId) {
      await pool.query('DELETE FROM public.audit_log WHERE tenant_id=$1',[tenantId]);
      await pool.query('DELETE FROM tenants WHERE id=$1',[tenantId]);
    }
    await pool.end();
  }
});
