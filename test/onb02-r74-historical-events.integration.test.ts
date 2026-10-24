import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import type { DB } from '../src/infrastructure/database/database.types.js';
import { applyAuditBackfill, planAuditBackfill } from '../src/modules/audit/audit-backfill.js';
import { saveDirectFilterRule } from '../src/modules/collection/collection-filter.direct.js';

function isolated(max=2) {
  assert.equal(process.env.CI,'true');
  const url=new URL(process.env.DATABASE_ADMIN_URL!);
  assert.ok(['localhost','127.0.0.1'].includes(url.hostname));
  assert.equal(url.pathname,'/radar_fiscal_test'); assert.equal(url.search,'');
  return new Pool({connectionString:url.toString(),max});
}
const cases=[
  {action:'MERGE_RFB_NORMAS_DOU_HISTORICAL',entity:'publication',
    before:()=>({douPublicationId:randomUUID(),rfbPublicationId:randomUUID(),
      douIdentityHash:'a'.repeat(64),rfbIdentityHash:'b'.repeat(64)}),
    after:()=>({publicationId:randomUUID(),identityHash:'c'.repeat(64),
      rfbExternalId:'153678',douExternalId:'2026-09-23:DO1:180:24398395',origins:['dou','rfb-normas']})},
  {action:'TAXONOMY_CURATION_SECTOR_ALIASES_CLEARED',entity:'taxonomy_curation',
    before:()=>({concepts:[{code:'sector.synthetic',aliases:[{text:'Synthetic free text',aliasType:'EXACT_LEXICAL'}]}]}),
    after:()=>({removedSynonyms:3,rowsAffected:2,justification:'Synthetic free text'})},
  {action:'TAXONOMY_DRAFT_ORPHAN_RELATIONS_REMOVED',entity:'taxonomy_release',
    before:()=>null,
    after:()=>({removedCount:7,removedRelationIds:Array.from({length:7},()=>randomUUID()),
      preservedHistory:true,reason:'Synthetic free text'})},
];
async function fingerprint(pool:Pool) {
  return {
    audits:(await pool.query(`SELECT count(*)::text n,
      md5(string_agg(md5(to_jsonb(a)::text),'' ORDER BY id)) hash FROM audit_log a`)).rows,
    checkpoint:(await pool.query('SELECT * FROM audit_backfill_checkpoint ORDER BY job_key')).rows,
  };
}
test('R7.4 migration is additive/idempotent, retains old contracts and never backfills on install',async()=>{
  const pool=isolated(); const c=await pool.connect();
  try {
    assert.match((await c.query('SHOW server_version')).rows[0].server_version,/^18\./);
    const old=await readFile('migrations/074_audit_allowlist_and_backfill.sql','utf8');
    const oldDefinition=old.match(/CREATE OR REPLACE FUNCTION public.audit_event_policy[\s\S]*?\$policy\$;/)![0];
    const oldRules=JSON.parse(old.match(/SELECT \$json\$([\s\S]*?)\$json\$::jsonb/)![1]) as Record<string,unknown>;
    const migration=await readFile('migrations/075_audit_historical_event_rules.sql','utf8');
    const before=await fingerprint(pool);
    const headers=await c.query(`SELECT oid,proowner,proacl FROM pg_proc
      WHERE oid IN ('public.audit_event_policy(text,text)'::regprocedure,
                    'public.audit_project(text,text,jsonb)'::regprocedure) ORDER BY oid`);
    await c.query('BEGIN');
    await c.query(oldDefinition);
    for(const f of cases)assert.equal((await c.query('SELECT audit_event_policy($1,$2) p',[f.action,f.entity])).rows[0].p,null,
      'the production R7.3 contract must reproduce the missing-rule condition');
    await c.query(migration);
    for(const [key,rule] of Object.entries(oldRules)) {
      const [action,entity]=key.split('|');
      assert.deepEqual((await c.query('SELECT audit_event_policy($1,$2) p',[action,entity])).rows[0].p,rule);
    }
    for(const f of cases)assert.notEqual((await c.query('SELECT audit_event_policy($1,$2) p',[f.action,f.entity])).rows[0].p,null);
    await c.query(migration);
    assert.deepEqual((await c.query(`SELECT oid,proowner,proacl FROM pg_proc
      WHERE oid IN ('public.audit_event_policy(text,text)'::regprocedure,
                    'public.audit_project(text,text,jsonb)'::regprocedure) ORDER BY oid`)).rows,headers.rows);
    await c.query('COMMIT');
    assert.deepEqual(await fingerprint(pool),before,'install/reinstall cannot modify audits or checkpoint');
  } catch(e) {await c.query('ROLLBACK');throw e;}
  finally {c.release();await pool.end();}
});

for(const f of cases)test('R7.4 historical context survives: '+f.action,async()=>{
  const pool=isolated(); let tenant:string|undefined;
  try {
    tenant=(await pool.query("INSERT INTO tenants(name,slug) VALUES('R74 synthetic',$1) RETURNING id",[randomUUID()])).rows[0].id;
    const actor=randomUUID(),id=randomUUID(),control=randomUUID();
    const before=f.before(),after=f.after();
    const expectedBefore=f.action==='TAXONOMY_CURATION_SECTOR_ALIASES_CLEARED'?{}:before;
    const expectedAfter={...after} as Record<string,unknown>;
    delete expectedAfter.justification;delete expectedAfter.reason;
    const c=await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE audit_log DISABLE TRIGGER audit_allowlist_guard');
      await c.query(`INSERT INTO audit_log(id,tenant_id,actor_type,actor_id,action,entity_type,
        entity_id,before_data,after_data,audit_policy_version,occurred_at)
        VALUES($1,$2,'SYSTEM',$3,$4,$5,$6,$7::jsonb,$8::jsonb,0,'2026-01-01T00:00:00Z')`,
        [id,tenant,actor,f.action,f.entity,randomUUID(),before===null?null:JSON.stringify({...before,cnpj:'synthetic-private',legalName:'Synthetic private'}),JSON.stringify({...after,cnpj:'synthetic-private',tradeName:'Synthetic private'})]);
      await c.query('ALTER TABLE audit_log ENABLE TRIGGER audit_allowlist_guard');
      await c.query(`INSERT INTO audit_log(id,tenant_id,actor_type,actor_id,action,entity_type,after_data)
        VALUES($1,$2,'SYSTEM',$3,'COMPANY_UPDATED','company','{"version":2}')`,[control,tenant,actor]);
      await c.query('COMMIT');
    } catch(e){await c.query('ROLLBACK');throw e;} finally {c.release();}
    const headers=(await pool.query(`SELECT action,entity_type,entity_id,actor_type,actor_id,occurred_at
      FROM audit_log WHERE id=$1`,[id])).rows;
    const other=(await pool.query('SELECT to_jsonb(a) row FROM audit_log a WHERE id=$1',[control])).rows;
    const globalBefore=(await pool.query(`SELECT
      (SELECT md5(string_agg(md5(to_jsonb(p)::text),'' ORDER BY id)) FROM publications p) publications,
      (SELECT md5(string_agg(md5(to_jsonb(t)::text),'' ORDER BY id)) FROM taxonomy_concepts t) concepts`)).rows;
    const planBefore=await fingerprint(pool);
    const plan=await planAuditBackfill(pool);
    assert.ok(plan.events.some(e=>e.action===f.action&&e.entityType===f.entity&&e.ruleExists&&e.pending===1));
    assert.equal(plan.unregistered,0);
    assert.deepEqual(await fingerprint(pool),planBefore,'plan writes nothing');
    await applyAuditBackfill(pool,{batchSize:1});
    const row=(await pool.query('SELECT before_data,after_data,audit_policy_version FROM audit_log WHERE id=$1',[id])).rows[0];
    assert.deepEqual(row.before_data,expectedBefore);
    assert.deepEqual(row.after_data,expectedAfter);
    assert.equal(row.audit_policy_version,1);
    assert.deepEqual((await pool.query(`SELECT action,entity_type,entity_id,actor_type,actor_id,occurred_at
      FROM audit_log WHERE id=$1`,[id])).rows,headers);
    assert.deepEqual((await pool.query('SELECT to_jsonb(a) row FROM audit_log a WHERE id=$1',[control])).rows,other);
    assert.deepEqual((await pool.query(`SELECT
      (SELECT md5(string_agg(md5(to_jsonb(p)::text),'' ORDER BY id)) FROM publications p) publications,
      (SELECT md5(string_agg(md5(to_jsonb(t)::text),'' ORDER BY id)) FROM taxonomy_concepts t) concepts`)).rows,globalBefore);
    assert.equal((await applyAuditBackfill(pool)).processed,0);
    for(const payload of [{...expectedAfter,cnpj:'synthetic-private'},
      {...expectedAfter,message:'synthetic-private'},{...expectedAfter,privateName:'synthetic-private'}]) {
      await assert.rejects(pool.query(`INSERT INTO audit_log(tenant_id,actor_type,actor_id,action,entity_type,after_data)
        VALUES($1,'SYSTEM',$2,$3,$4,$5::jsonb)`,[tenant,actor,f.action,f.entity,JSON.stringify(payload)]),
        (e:unknown)=>(e as {code?:string}).code==='23514');
    }
    if(f.entity==='publication') {
      for(const payload of [{...expectedAfter,origins:['rfb-normas','dou']},
        {...expectedAfter,origins:['dou','synthetic-private']},
        {...expectedAfter,rfbExternalId:'synthetic-private'}]) {
        await assert.rejects(pool.query(`INSERT INTO audit_log(tenant_id,actor_type,actor_id,action,entity_type,after_data)
          VALUES($1,'SYSTEM',$2,$3,$4,$5::jsonb)`,[tenant,actor,f.action,f.entity,JSON.stringify(payload)]),
          (e:unknown)=>(e as {code?:string}).code==='23514');
      }
    }
  } finally {
    if(tenant){await pool.query('DELETE FROM audit_log WHERE tenant_id=$1',[tenant]);await pool.query('DELETE FROM tenants WHERE id=$1',[tenant]);}
    await pool.end();
  }
});

test('R7.4 still blocks genuinely unknown historical events before audits/checkpoint change',async()=>{
  const pool=isolated();let tenant:string|undefined;
  try {
    tenant=(await pool.query("INSERT INTO tenants(name,slug) VALUES('R74 unknown synthetic',$1) RETURNING id",[randomUUID()])).rows[0].id;
    const c=await pool.connect();
    try {
      await c.query('BEGIN');await c.query('ALTER TABLE audit_log DISABLE TRIGGER audit_allowlist_guard');
      await c.query(`INSERT INTO audit_log(tenant_id,actor_type,action,entity_type,after_data)
        VALUES($1,'SYSTEM','UNREGISTERED_R74_FUTURE','publication','{"context":7}')`,[tenant]);
      await c.query('ALTER TABLE audit_log ENABLE TRIGGER audit_allowlist_guard');await c.query('COMMIT');
    } finally {c.release();}
    const before=await fingerprint(pool);
    assert.equal((await planAuditBackfill(pool)).unregistered,1);
    await assert.rejects(applyAuditBackfill(pool),{name:'AuditBackfillUnknownEventsError'});
    assert.deepEqual(await fingerprint(pool),before);
  } finally {
    if(tenant){await pool.query('DELETE FROM audit_log WHERE tenant_id=$1',[tenant]);await pool.query('DELETE FROM tenants WHERE id=$1',[tenant]);}
    await pool.end();
  }
});

test('PROD-1.1 direct-rule contention times out before audit; pool transaction settings are restored',async()=>{
  const pool=isolated(1),blocker=isolated(1);
  const db=new Kysely<DB>({dialect:new PostgresDialect({pool})});
  const hold=await blocker.connect();
  try {
    const before=(await pool.query('SHOW lock_timeout')).rows;
    const statementBefore=(await pool.query('SHOW statement_timeout')).rows;
    const audits=await fingerprint(pool);
    await hold.query("SELECT pg_advisory_lock(hashtextextended('collection-filter-direct-rule',0))");
    await assert.rejects(saveDirectFilterRule(db,randomUUID(),
      {sourceCode:'dou',section:'DO1',canonicalType:'R74_SYNTHETIC',mode:'KEEP_ALWAYS'},
      0,'synthetic',0,'synthetic'),(e:unknown)=>(e as {code?:string}).code==='55P03');
    assert.deepEqual((await pool.query('SHOW lock_timeout')).rows,before);
    assert.deepEqual((await pool.query('SHOW statement_timeout')).rows,statementBefore);
    await db.transaction().execute(async trx=>{
      await sql`SET LOCAL lock_timeout='5s'`.execute(trx);
      assert.equal((await sql<{lock_timeout:string}>`SHOW lock_timeout`.execute(trx)).rows[0]!.lock_timeout,'5s');
    });
    assert.deepEqual((await pool.query('SHOW lock_timeout')).rows,before,'commit restores same pooled connection');
    assert.deepEqual(await fingerprint(pool),audits,'failed advisory acquisition never reaches audit');
  } finally {
    await hold.query("SELECT pg_advisory_unlock(hashtextextended('collection-filter-direct-rule',0))");
    hold.release();await blocker.end();await db.destroy();
  }
});
