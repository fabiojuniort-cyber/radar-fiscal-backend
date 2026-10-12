import {runL17RuleCapStress} from './l17-rule-cap.pg18.test.js';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { buildApp } from '../src/app.js';

const url = process.env.DATABASE_ADMIN_URL;
if (!url) throw new Error('DATABASE_ADMIN_URL required (isolated PG18 only)');
const password = 'L15-Pg18-Isolated-Security!';

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

test('L20 f57e0b03: direct purge and Apagar fora do escopo both delete when conflicting DOU/DO3 types are EXCLUDE_ALWAYS',async()=>{
  const admin=new Pool({connectionString:url,max:1});
  const app=await buildApp();
  const suffix=randomUUID().slice(0,8);
  const actType='AVISO DE DISPENSA DE LICITACAO';
  const sourceType='AVISO DE ADJUDICACAO';
  const previous=new Map<string,string>();
  const insertedTypes:string[]=[];
  let actorId:string|null=null;
  let policyId:string|null=null;
  try{
    await app.ready();
    const email='l20-'+suffix+'@example.test';
    const reg=await app.inject({method:'POST',url:'/auth/register',payload:{
      name:'L20 test',email,company:'L20 Test Tenant '+suffix,
      password,confirmPassword:password,acceptedTerms:true,
    }});
    assert.equal(reg.statusCode,201,reg.body);
    const account=reg.json<{user:{id:string};tenant:{id:string}}>();
    actorId=account.user.id;
    const login=await app.inject({method:'POST',url:'/auth/login',payload:{email,password}});
    assert.equal(login.statusCode,200,login.body);
    const headers={authorization:'Bearer '+login.json<{accessToken:string}>().accessToken,
      'x-tenant-id':account.tenant.id};
    await admin.query(
      "INSERT INTO platform_user_roles(user_id,role,granted_by) VALUES($1,'PLATFORM_ADMIN','L20_TEST')",
      [account.user.id],
    );
    let p=(await admin.query<{id:string}>(
      "SELECT id FROM collection_filter_policies WHERE status='APPROVED' LIMIT 1"
    )).rows[0];
    if(!p){
      p=(await admin.query<{id:string}>(
        "INSERT INTO collection_filter_policies(version,status,approved_at,approved_by) "+
        "SELECT COALESCE(max(version),0)+1,'APPROVED',now(),$1 FROM collection_filter_policies RETURNING id",
        [account.user.id],
      )).rows[0]!;
    }
    policyId=p.id;
    const dou=(await admin.query<{id:string}>(
      "SELECT id FROM sources WHERE code='dou' LIMIT 1"
    )).rows[0]?.id??(await admin.query<{id:string}>(
      "INSERT INTO sources(code,name,jurisdiction_level,base_url,connector_key) "+
      "VALUES('dou','DOU','FEDERAL','https://in.gov.br','dou') RETURNING id"
    )).rows[0]!.id;
    for(const canonical of [actType,sourceType]){
      const old=await admin.query<{mode:string}>(
        "SELECT mode FROM collection_filter_type_rules "+
        "WHERE policy_id=$1 AND source_code='dou' AND section='DO3' AND canonical_type=$2",
        [policyId,canonical],
      );
      if(old.rows[0])previous.set(canonical,old.rows[0].mode);
      else insertedTypes.push(canonical);
      await admin.query(
        "INSERT INTO collection_filter_type_rules(policy_id,source_code,section,canonical_type,mode) "+
        "VALUES($1,'dou','DO3',$2,'EXCLUDE_ALWAYS') "+
        "ON CONFLICT(policy_id,source_code,section,canonical_type) "+
        "DO UPDATE SET mode=EXCLUDED.mode",
        [policyId,canonical],
      );
    }
    // Two independent copies of the observed f57e0b03 shape so that each
    // purge path must prove a real physical delete (not just a KEEP/DISCARD).
    async function fixture(label:string) {
      const url='https://www.in.gov.br/l20-f57e0b03-'+suffix+'-'+label;
      const id=(await admin.query<{id:string}>(
        "INSERT INTO publications(identity_hash,identity_strength,identity_basis,jurisdiction_level,"+
        "act_type,title,published_on,primary_official_url) "+
        "VALUES($1,'STRONG','{}'::jsonb,'FEDERAL',$2,"+
        "'AVISO DE DISPENSA DE LICITAÇÃO 7/2026','2026-10-09',$3) RETURNING id",
        [sha('f57e0b03-'+suffix+'-'+label),actType,url],
      )).rows[0]!.id;
      await admin.query(
        "INSERT INTO publication_origins(publication_id,source_id,official_url,metadata) "+
        "VALUES($1,$2,$3,$4::jsonb)",
        [id,dou,url,JSON.stringify({dou:{section:'DO3',sourceActType:'Aviso de Adjudicação'}})],
      );
      await admin.query(
        "INSERT INTO publication_versions(publication_id,version_no,content_hash,content_text,"+
        "is_current,source_metadata) VALUES($1,1,$2,$3,true,$4::jsonb)",
        [id,sha('body-'+id),
         'Prefeitura de Douradoquara/MG. Contratação administrativa.',
         JSON.stringify({dou:{section:'DO3',sourceActType:'Aviso de Adjudicação'}})],
      );
      return id;
    }
    const directId=await fixture('direct');
    const directPayload={sourceCode:'dou',section:'DO3',canonicalType:actType,mode:'EXCLUDE_ALWAYS'};
    const preview=await app.inject({method:'POST',
      url:'/api/v1/admin/collection-filter/direct-rule/preview',
      headers,payload:directPayload});
    assert.equal(preview.statusCode,200,preview.body);
    const plan=preview.json<{count:number;token:string}>();
    assert.ok(plan.count>=1,'TYPE_CONFLICT_BOTH_EXCLUDED must reach direct-rule preview');
    const confirmed=await app.inject({method:'POST',
      url:'/api/v1/admin/collection-filter/direct-rule/confirm',
      headers,payload:{...directPayload,expectedCount:plan.count,previewToken:plan.token}});
    assert.equal(confirmed.statusCode,200,confirmed.body);
    assert.equal(confirmed.json<{changed:boolean}>().changed,false);
    assert.ok(confirmed.json<{deletedCount:number}>().deletedCount>=1);
    assert.equal((await admin.query('SELECT 1 FROM publications WHERE id=$1',[directId])).rowCount,0,
      'direct purge must physically delete f57e0b03 fixture');
    assert.equal((await admin.query(
      "SELECT 1 FROM collection_filter_discards WHERE archive_publication_id=$1",[directId],
    )).rowCount,1,'direct purge must preserve archived discard');

    const globalId=await fixture('out-of-scope');
    const globalPreview=await app.inject({method:'POST',
      url:'/api/v1/admin/collection-filter/out-of-scope/preview',headers});
    assert.equal(globalPreview.statusCode,200,globalPreview.body);
    const globalPlan=globalPreview.json<{count:number;ruleDiscards:number;token:string}>();
    assert.ok(globalPlan.ruleDiscards>=1,
      'TYPE_CONFLICT_BOTH_EXCLUDED must reach the global RULE bucket');
    const globalConfirm=await app.inject({method:'POST',
      url:'/api/v1/admin/collection-filter/out-of-scope/confirm',
      headers,payload:{expectedCount:globalPlan.count,previewToken:globalPlan.token}});
    assert.equal(globalConfirm.statusCode,200,globalConfirm.body);
    assert.equal(globalConfirm.json<{changed:boolean}>().changed,false);
    assert.ok(globalConfirm.json<{deletedCount:number}>().deletedCount>=1);
    assert.equal((await admin.query('SELECT 1 FROM publications WHERE id=$1',[globalId])).rowCount,0,
      'global Apagar fora do escopo must physically delete f57e0b03 fixture');
    assert.equal((await admin.query(
      "SELECT 1 FROM collection_filter_discards WHERE archive_publication_id=$1",[globalId],
    )).rowCount,1,'global purge must preserve archived discard');
  }finally{
    if(policyId){
      for(const canonical of insertedTypes){
        await admin.query(
          "DELETE FROM collection_filter_type_rules WHERE policy_id=$1 "+
          "AND source_code='dou' AND section='DO3' AND canonical_type=$2",
          [policyId,canonical],
        );
      }
      for(const [canonical,mode] of previous){
        await admin.query(
          "UPDATE collection_filter_type_rules SET mode=$3 WHERE policy_id=$1 "+
          "AND source_code='dou' AND section='DO3' AND canonical_type=$2",
          [policyId,canonical,mode],
        );
      }
    }
    if(actorId)await admin.query(
      "UPDATE platform_user_roles SET revoked_at=COALESCE(revoked_at,now()), "+
      "revoked_by=COALESCE(revoked_by,'l20-test') WHERE user_id=$1 AND revoked_at IS NULL",
      [actorId],
    );
    await app.close();
    await admin.end();
  }
});

test('L15: only admin, DOU scoped preview, cross-source/company protections and 051 audit', async () => {
  const db = new Pool({connectionString: url, max: 1});
  const app = await buildApp();
  const label = randomUUID().slice(0,8);
  try {
    const email = 'l15-' + label + '@example.test';
    const reg = await app.inject({method:'POST',url:'/auth/register',payload:{
      name:'L15 isolated admin',email,company:'L15 isolated tenant',
      password,confirmPassword:password,acceptedTerms:true,
    }});
    assert.equal(reg.statusCode,201,reg.body);
    const user=reg.json<{user:{id:string};tenant:{id:string}}>();
    const login=await app.inject({method:'POST',url:'/auth/login',payload:{email,password}});
    assert.equal(login.statusCode,200,login.body);
    const headers={authorization:'Bearer '+login.json<{accessToken:string}>().accessToken,
      'x-tenant-id':user.tenant.id};
    const previewRoute='/api/v1/admin/collection-filter/out-of-scope/preview';
    const confirmRoute='/api/v1/admin/collection-filter/out-of-scope/confirm';

    // A non-platform-admin cannot even read the full-archive preview.
    const denied=await app.inject({method:'POST',url:previewRoute,headers});
    assert.equal(denied.statusCode,403,denied.body);
    const deniedConfirm=await app.inject({method:'POST',url:confirmRoute,headers,
      payload:{expectedCount:1,previewToken:'a'.repeat(64)}});
    assert.equal(deniedConfirm.statusCode,403,deniedConfirm.body);
    await db.query(
      "INSERT INTO platform_user_roles(user_id,role,granted_by) VALUES($1,'PLATFORM_ADMIN','l15-test')",
      [user.user.id],
    );

    // Archive audit capture requires an approved policy; never invent a run.
    if(!(await db.query("SELECT id FROM collection_filter_policies WHERE status='APPROVED'")).rowCount) {
      await db.query(
        "INSERT INTO collection_filter_policies(version,status,approved_at,approved_by) "+
        "SELECT COALESCE(max(version),0)+1,'APPROVED',now(),$1 FROM collection_filter_policies",
        [user.user.id],
      );
    }
    const src=await db.query<{id:string}>("SELECT id FROM sources WHERE code='dou' LIMIT 1");
    const douId=src.rows[0]?.id??(await db.query<{id:string}>(
      "INSERT INTO sources(code,name,jurisdiction_level,base_url,connector_key) "+
      "VALUES('dou','Diário Oficial','FEDERAL','https://in.gov.br','dou') RETURNING id"
    )).rows[0]!.id;
    const otherId=(await db.query<{id:string}>(
      "INSERT INTO sources(code,name,jurisdiction_level,base_url,connector_key) "+
      "VALUES($1,'Source L15','FEDERAL','https://other.example.test',$1) RETURNING id",
      ['l15-other-'+label],
    )).rows[0]!.id;
    const ids: string[] = [];
    for(const kind of ['eligible','company','other']) {
      const id=(await db.query<{id:string}>(
        "INSERT INTO publications(identity_hash,identity_strength,identity_basis,jurisdiction_level,"+
        "act_type,title,primary_official_url) VALUES($1,'STRONG','{}'::jsonb,'FEDERAL',"+
        "'AVISO L15',$2,$3) RETURNING id",
        [sha(label+kind),'Aviso L15 '+kind,'https://l15.example.test/'+kind+'/'+label],
      )).rows[0]!.id;
      ids.push(id);
      await db.query(
        "INSERT INTO publication_origins(publication_id,source_id,official_url,metadata) "+
        "VALUES($1,$2,$3,'{\"dou\":{\"section\":\"DO3\"}}'::jsonb)",
        [id,douId,'https://l15.example.test/origin/'+id],
      );
      if(kind==='other')await db.query(
        "INSERT INTO publication_origins(publication_id,source_id,official_url) VALUES($1,$2,$3)",
        [id,otherId,'https://l15-other.example.test/'+id],
      );
      const event=(await db.query<{id:string}>(
        "INSERT INTO publication_scope_events(publication_id,operation_id,action,"+
        "previous_scope,new_scope,policy_key,reason_code,rule_version,evidence_sha256,actor_ref) "+
        "VALUES($1,$2,'SUPPRESS','IN_SCOPE','OUT_OF_SCOPE','L15_TEST','TEST','1',$3,'l15') RETURNING id",
        [id,randomUUID(),sha('scope'+id)],
      )).rows[0]!.id;
      await db.query(
        "INSERT INTO publication_scope_state(publication_id,scope,current_event_id,policy_key,evidence_sha256) "+
        "VALUES($1,'OUT_OF_SCOPE',$2,'L15_TEST',$3)",
        [id,event,sha('scope'+id)],
      );
      if(kind==='company') {
        const company=(await db.query<{id:string}>(
          "INSERT INTO companies(tenant_id,legal_name,head_office_cnpj) VALUES($1,$2,$3) RETURNING id",
          [user.tenant.id,'Protected L15 '+label,'12'+String(Math.floor(Math.random()*1e12)).padStart(12,'0')],
        )).rows[0]!.id;
        await db.query(
          'INSERT INTO company_publications(company_id,publication_id) VALUES($1,$2)',
          [company,id],
        );
      }
    }

    // L-17: legacy-hidden fixture variants (synthetic isolated PostgreSQL).
    // Every origin is seeded before SUPPRESS, preserving migration 033 RESTORE.
    const hiddenKinds=['hidden','hidden-company','hidden-other','hidden-scope','hidden-non-dou'];
    const hiddenIds:Record<string,string>={};
    for(const kind of hiddenKinds) {
      const id=(await db.query<{id:string}>(
        "INSERT INTO publications(identity_hash,identity_strength,identity_basis,jurisdiction_level,"+
        "act_type,title,primary_official_url) VALUES($1,'STRONG','{}'::jsonb,'FEDERAL',"+
        "'AVISO DE LICITAÇÃO',$2,$3) RETURNING id",
        [sha(label+kind),'Aviso de licitação '+kind,'https://l17.example.test/'+kind+'/'+label],
      )).rows[0]!.id;
      hiddenIds[kind]=id;
      if(kind!=='hidden-non-dou')await db.query(
        'INSERT INTO publication_origins(publication_id,source_id,official_url) VALUES($1,$2,$3)',
        [id,douId,'https://l17-dou.example.test/'+id],
      );
      if(kind==='hidden-other'||kind==='hidden-non-dou')await db.query(
        'INSERT INTO publication_origins(publication_id,source_id,official_url) VALUES($1,$2,$3)',
        [id,otherId,'https://l17-other.example.test/'+id],
      );
      if(kind==='hidden-scope') {
        const event=(await db.query<{id:string}>(
          "INSERT INTO publication_scope_events(publication_id,operation_id,action,previous_scope,"+
          "new_scope,policy_key,reason_code,rule_version,evidence_sha256,actor_ref) "+
          "VALUES($1,$2,'SUPPRESS','IN_SCOPE','OUT_OF_SCOPE','L17_TEST','TEST','1',$3,'l17') RETURNING id",
          [id,randomUUID(),sha('hiddenScope'+id)],
        )).rows[0]!.id;
        await db.query(
          "INSERT INTO publication_scope_state(publication_id,scope,current_event_id,policy_key,evidence_sha256) "+
          "VALUES($1,'OUT_OF_SCOPE',$2,'L17_TEST',$3)",
          [id,event,sha('hiddenScope'+id)],
        );
      }
      if(kind==='hidden-company') {
        const company=(await db.query<{id:string}>(
          "INSERT INTO companies(tenant_id,legal_name,head_office_cnpj) VALUES($1,$2,$3) RETURNING id",
          [user.tenant.id,'Protected hidden '+label,'13'+String(Math.floor(Math.random()*1e12)).padStart(12,'0')],
        )).rows[0]!.id;
        await db.query(
          'INSERT INTO company_publications(company_id,publication_id) VALUES($1,$2)',[company,id],
        );
      }
    }
    // A hidden publication with complete legal evidence and an explicit
    // EXCLUDE_ALWAYS rule belongs to RULE, not also to LEGACY_HIDDEN.
    const approved=(await db.query<{id:string}>(
      "SELECT id FROM collection_filter_policies WHERE status='APPROVED' LIMIT 1")).rows[0]!.id;
    await db.query(
      "INSERT INTO collection_filter_type_rules(policy_id,source_code,section,canonical_type,mode) "+
      "VALUES($1,'dou','DO3','AVISO DE LICITACAO','EXCLUDE_ALWAYS') "+
      "ON CONFLICT (policy_id,source_code,section,canonical_type) DO UPDATE SET mode=EXCLUDED.mode",
      [approved],
    );
    const hiddenRuleId=(await db.query<{id:string}>(
      "INSERT INTO publications(identity_hash,identity_strength,identity_basis,jurisdiction_level,"+
      "act_type,title,primary_official_url) VALUES($1,'STRONG','{}'::jsonb,'FEDERAL',"+
      "'AVISO DE LICITAÇÃO','Aviso de licitação regra explícita',$2) RETURNING id",
      [sha(label+'hidden-rule'),'https://l17-dou.example.test/rule/'+label],
    )).rows[0]!.id;
    hiddenIds['hidden-rule']=hiddenRuleId;
    await db.query(
      "INSERT INTO publication_origins(publication_id,source_id,official_url,metadata) "+
      "VALUES($1,$2,$3,'{\"dou\":{\"section\":\"DO3\"}}'::jsonb)",
      [hiddenRuleId,douId,'https://l17-dou.example.test/rule/'+hiddenRuleId],
    );
    await db.query(
      "INSERT INTO publication_versions(publication_id,version_no,content_hash,content_text,is_current) "+
      "VALUES($1,1,$2,'Objeto meramente administrativo sem tributos.',true)",
      [hiddenRuleId,sha('hidden-rule-body'+hiddenRuleId)],
    );
    const hiddenFlag=await db.query<{is_hidden:boolean}>(
      'SELECT is_hidden FROM publications WHERE id=$1',[hiddenIds.hidden]);
    assert.equal(hiddenFlag.rows[0]?.is_hidden,true,'migration 029 generated legacy flag preserved');

    // Diagnostic assertions: independently verify the fixture before using
    // the authenticated API. These identify missing state versus missing DOU
    // provenance, without changing the preview implementation.
    const stateRows=await db.query<{publication_id:string;scope:string}>(
      'SELECT publication_id,scope FROM publication_scope_state WHERE publication_id=ANY($1::uuid[])',[ids]);
    assert.equal(stateRows.rowCount,3,'all synthetic scope rows must exist');
    const originRows=await db.query<{publication_id:string;code:string}>(
      'SELECT po.publication_id,s.code FROM publication_origins po JOIN sources s ON s.id=po.source_id WHERE po.publication_id=ANY($1::uuid[])',[ids]);
    assert.ok(originRows.rows.some(r=>r.publication_id===ids[0]&&r.code==='dou'),'eligible has DOU origin');
    assert.equal(stateRows.rows.find(r=>r.publication_id===ids[0])?.scope,'OUT_OF_SCOPE','eligible scope');
        const preview=await app.inject({method:'POST',url:previewRoute,headers});
    assert.equal(preview.statusCode,200,preview.body);
    const plan=preview.json<{count:number;outOfScope:number;ruleDiscards:number;byRule:Array<{count:number}>;hiddenLegacy:number;blockedCompany:number;
      blockedOtherSource:number;token:string}>();
    assert.equal(plan.count,5);
    assert.equal(plan.outOfScope,2);
    assert.equal(plan.ruleDiscards,1);
    assert.equal(plan.byRule.reduce((n,r)=>n+r.count,0),1);
    assert.equal(plan.hiddenLegacy,2);
    assert.equal(plan.blockedCompany,2);
    assert.equal(plan.blockedOtherSource,2);
    assert.match(plan.token,/^[a-f0-9]{64}$/);

    const rejected=await app.inject({method:'POST',url:confirmRoute,headers,
      payload:{expectedCount:2,previewToken:plan.token}});
    assert.equal(rejected.statusCode,200,rejected.body);
    assert.equal(rejected.json<{changed:boolean;apagadas:number}>().changed,true);
    assert.equal(rejected.json<{changed:boolean;apagadas:number}>().apagadas,0);

    const applied=await app.inject({method:'POST',url:confirmRoute,headers,
      payload:{expectedCount:5,previewToken:plan.token}});
    assert.equal(applied.statusCode,200,applied.body);
    assert.equal(applied.json<{apagadas:number;restantes:number}>().apagadas,5);
    assert.equal(applied.json<{apagadas:number;restantes:number}>().restantes,0);
    const present=await db.query<{id:string}>(
      'SELECT id FROM publications WHERE id=ANY($1::uuid[])',[ids],
    );
    assert.deepEqual(new Set(present.rows.map(x=>x.id)),new Set(ids.slice(1)));
    const hiddenRemaining=await db.query<{id:string}>(
      'SELECT id FROM publications WHERE id=ANY($1::uuid[])',
      [Object.values(hiddenIds)],
    );
    assert.deepEqual(new Set(hiddenRemaining.rows.map(x=>x.id)),new Set([
      hiddenIds['hidden-company'],hiddenIds['hidden-other'],
    ]));
    const removedIds=[ids[0]!,hiddenIds.hidden!,hiddenIds['hidden-scope']!,hiddenRuleId,hiddenIds['hidden-non-dou']!];
    const audit=await db.query<{deleted:string}>(
      "SELECT COALESCE(sum((after_data->>'deletedCount')::integer),0)::text AS deleted "+
      "FROM audit_log a WHERE action='COLLECTION_FILTER_DIRECT_PURGE' "+
      "AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(a.after_data->'deletedIds') d(id) "+
      "WHERE d.id::uuid=ANY($1::uuid[]))",
      [removedIds],
    );
    assert.equal(Number(audit.rows[0]?.deleted),5,'051 append-only audit per committed sub-batch');
    const archived=await db.query<{id:string;discard_origin:string;archive_publication_id:string;
      reason_code:string;official_url:string;collection_run_id:string|null}>(
      "SELECT id,discard_origin,archive_publication_id,reason_code,official_url,collection_run_id "+
      "FROM collection_filter_discards WHERE archive_publication_id=ANY($1::uuid[])",
      [removedIds],
    );
    assert.equal(archived.rowCount,5,'every physically purged publication gets one archive discard');
    for(const row of archived.rows){
      assert.equal(row.discard_origin,'ARCHIVE');
      assert.equal(row.reason_code,'ARCHIVE_PURGE');
      assert.equal(row.collection_run_id,null);
      assert.ok(row.official_url,'official source URL must be preserved');
    }
  } finally {
    await app.close();
    await db.end();
  }
});

test('L10: index-backed dry-run and least-privilege batch without manual deletion', async () => {
  const db=new Pool({connectionString:url,max:1});
  try {
    const acl=await db.query<{app:boolean;worker:boolean;delete_ok:boolean}>(
      "SELECT has_function_privilege('radar_app',"+
      "'public.l10_prune_collection_items_batch(integer)','EXECUTE') AS app,"+
      "has_function_privilege('radar_worker',"+
      "'public.l10_prune_collection_items_batch(integer)','EXECUTE') AS worker,"+
      "has_table_privilege('radar_worker','public.collection_items','DELETE') AS delete_ok",
    );
    assert.equal(acl.rows[0]!.app,false);
    assert.equal(acl.rows[0]!.worker,true);
    assert.equal(acl.rows[0]!.delete_ok,false);
    const index=await db.query<{exists:boolean}>(
      "SELECT EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='public' "+
      "AND indexname='ix_collection_items_created_at_id') AS exists",
    );
    assert.equal(index.rows[0]!.exists,true);
    const count=await db.query<{count:string}>(
      "SELECT count(*)::text AS count FROM collection_items "+
      "WHERE created_at < now()-INTERVAL '7 days'",
    );
    assert.ok(Number(count.rows[0]!.count)>=0);
    const ledger=await db.query<{exists:boolean}>(
      "SELECT to_regclass('public.collection_items_retention_daily') IS NOT NULL AS exists",
    );
    assert.equal(ledger.rows[0]!.exists,true);
  } finally { await db.end(); }
});

test('L17: worker-only hidden cleanup protects tenant/cross-source and audits synthetic batch',async()=>{
  const admin=new Pool({connectionString:url,max:1});
  const workerUrl=new URL(url);
  workerUrl.username='radar_worker_runtime';
  workerUrl.password=process.env.DB_WORKER_RUNTIME_PASSWORD??'';
  const worker=new Pool({connectionString:workerUrl.toString(),max:1});
  const label=randomUUID().slice(0,10);
  try {
    const permission=await admin.query<{app:boolean;worker:boolean}>(
      "SELECT has_function_privilege('radar_app','public.l17_prune_hidden_batch(integer)','EXECUTE') AS app,"+
      "has_function_privilege('radar_worker','public.l17_prune_hidden_batch(integer)','EXECUTE') AS worker"
    );
    assert.equal(permission.rows[0]?.app,false);
    assert.equal(permission.rows[0]?.worker,true);
    if(!(await admin.query("SELECT id FROM collection_filter_policies WHERE status='APPROVED'")).rowCount) {
      await admin.query(
        "INSERT INTO collection_filter_policies(version,status,approved_at) "+
        "SELECT COALESCE(max(version),0)+1,'APPROVED',now() FROM collection_filter_policies"
      );
    }
    const dou=(await admin.query<{id:string}>("SELECT id FROM sources WHERE code='dou' LIMIT 1")).rows[0]!.id;
    const other=(await admin.query<{id:string}>(
      "INSERT INTO sources(code,name,jurisdiction_level,base_url,connector_key) "+
      "VALUES($1,'L17 other','FEDERAL','https://other.example.test',$1) RETURNING id",
      ['l17-auto-'+label],
    )).rows[0]!.id;
    const safe=(await admin.query<{id:string}>(
      "INSERT INTO publications(identity_hash,identity_strength,identity_basis,jurisdiction_level,"+
      "act_type,title) VALUES($1,'STRONG','{}'::jsonb,'FEDERAL','AVISO DE LICITAÇÃO','Synthetic worker eligible') RETURNING id",
      [sha(label+'safe')],
    )).rows[0]!.id;
    const cross=(await admin.query<{id:string}>(
      "INSERT INTO publications(identity_hash,identity_strength,identity_basis,jurisdiction_level,"+
      "act_type,title) VALUES($1,'STRONG','{}'::jsonb,'FEDERAL','AVISO DE LICITAÇÃO','Synthetic worker cross-source') RETURNING id",
      [sha(label+'cross')],
    )).rows[0]!.id;
    for(const id of [safe,cross])await admin.query(
      'INSERT INTO publication_origins(publication_id,source_id,official_url) VALUES($1,$2,$3)',
      [id,dou,'https://l17-auto.example.test/'+id],
    );
    await admin.query(
      'INSERT INTO publication_origins(publication_id,source_id,official_url) VALUES($1,$2,$3)',
      [cross,other,'https://l17-cross.example.test/'+cross],
    );
    const removed=await worker.query<{deleted:number}>(
      'SELECT public.l17_prune_hidden_batch(20) AS deleted');
    assert.equal(removed.rows[0]?.deleted,1);
    const still=await admin.query<{id:string}>(
      'SELECT id FROM publications WHERE id=ANY($1::uuid[])',[[safe,cross]]);
    assert.deepEqual(still.rows.map(r=>r.id),[cross]);
    const logged=await admin.query<{count:string}>(
      "SELECT count(*)::text AS count FROM audit_log WHERE action='L17_HIDDEN_PURGE' "+
      "AND actor_type='SYSTEM' AND after_data->>'deletedCount'='1' "+
      "AND after_data->'deletedIds' ? $1",[safe],
    );
    assert.ok(Number(logged.rows[0]?.count)>=1,'worker purge audit required');
    const archive=await admin.query<{reason_code:string;discard_origin:string;collection_run_id:string|null}>(
      'SELECT reason_code,discard_origin,collection_run_id FROM collection_filter_discards WHERE archive_publication_id=$1',
      [safe],
    );
    assert.equal(archive.rowCount,1,'scheduled physical purge must preserve the archive discard');
    assert.deepEqual(archive.rows[0],{reason_code:'ARCHIVE_PURGE',discard_origin:'ARCHIVE',collection_run_id:null});
    assert.equal((await worker.query<{claimed:boolean}>(
      'SELECT public.l17_claim_hidden_day() AS claimed')).rows[0]?.claimed,false);
  }finally {
    await worker.end();
    await admin.end();
  }
});

test('L17: DO1E RESOLUÇÃO CIT-SNC/MINC matches historical purge and runtime despite generic sourceActType',async()=>{
  const db=new Pool({connectionString:url,max:1});
  const app=await buildApp();
  const tag=randomUUID().slice(0,8);
  try {
    const email='l17-specific-'+tag+'@example.test';
    const registration=await app.inject({method:'POST',url:'/auth/register',payload:{
      name:'L17 specific type tester',email,company:'L17 test organization',
      password,confirmPassword:password,acceptedTerms:true,
    }});
    assert.equal(registration.statusCode,201,registration.body);
    const registered=registration.json<{user:{id:string};tenant:{id:string}}>();
    const login=await app.inject({method:'POST',url:'/auth/login',payload:{email,password}});
    assert.equal(login.statusCode,200,login.body);
    const headers={authorization:'Bearer '+login.json<{accessToken:string}>().accessToken,
      'x-tenant-id':registered.tenant.id};
    await db.query(
      "INSERT INTO platform_user_roles(user_id,role,granted_by) VALUES($1,'PLATFORM_ADMIN','L17_SPECIFIC')",
      [registered.user.id],
    );
    if(!(await db.query("SELECT id FROM collection_filter_policies WHERE status='APPROVED'")).rowCount){
      await db.query(
        "INSERT INTO collection_filter_policies(version,status,approved_at,approved_by) "+
        "VALUES(777,'APPROVED',now(),$1)",[registered.user.id],
      );
    }
    const dou=(await db.query<{id:string}>("SELECT id FROM sources WHERE code='dou' LIMIT 1")).rows[0]!.id;
    for(let i=0;i<3;i++){
      const id=(await db.query<{id:string}>(
        "INSERT INTO publications(identity_hash,identity_strength,identity_basis,jurisdiction_level,act_type,title,published_on) "+
        "VALUES($1,'STRONG','{}'::jsonb,'FEDERAL','RESOLUÇÃO CIT-SNC/MINC',$2,'2026-10-09') RETURNING id",
        [sha(tag+String(i)),'RESOLUÇÃO CIT-SNC/MINC '+i],
      )).rows[0]!.id;
      await db.query(
        "INSERT INTO publication_origins(publication_id,source_id,official_url,metadata) "+
        "VALUES($1,$2,$3,'{\"dou\":{\"section\":\"DO1E\",\"sourceActType\":\"Resolução\"}}'::jsonb)",
        [id,dou,'https://in.gov.br/l17-specific/'+id],
      );
      await db.query(
        "INSERT INTO publication_versions(publication_id,version_no,content_hash,content_text,is_current,source_metadata) "+
        "VALUES($1,1,$2,'Aprova deliberação administrativa da comissão.',true,'{}'::jsonb)",
        [id,sha('content'+id)],
      );
    }
    const preview=await app.inject({method:'POST',
      url:'/api/v1/admin/collection-filter/direct-rule/preview',
      headers,payload:{sourceCode:'dou',section:'DO1E',
        canonicalType:'RESOLUCAO CIT SNC MINC',mode:'EXCLUDE_ALWAYS'},
    });
    assert.equal(preview.statusCode,200,preview.body);
    assert.equal(preview.json<{count:number}>().count,3,
      'canonical specific type must match the three DO1E publications');
  }finally{
    await app.close();await db.end();
  }
});

test('L17: worker PG18 EXCLUDE_ALWAYS reuses shared engine, preserves generic Resolução provenance and writes archive audit',async()=>{
  const admin=new Pool({connectionString:url,max:1});
  const workerUrl=new URL(url);
  workerUrl.username='radar_worker_runtime';
  workerUrl.password=process.env.DB_WORKER_RUNTIME_PASSWORD??'';
  const worker=new Pool({connectionString:workerUrl.toString(),max:1});
  const tag=randomUUID().slice(0,10);
  try{
    const policy=(await admin.query<{id:string;revision:number}>(
      "SELECT id,revision FROM collection_filter_policies WHERE status='APPROVED' LIMIT 1")).rows[0]!;
    assert.ok(policy,'approved policy required');
    await admin.query(
      "INSERT INTO collection_filter_type_rules(policy_id,source_code,section,canonical_type,mode) "+
      "VALUES($1,'dou','DO1E','RESOLUCAO CIT SNC MINC','EXCLUDE_ALWAYS') "+
      "ON CONFLICT(policy_id,source_code,section,canonical_type) DO UPDATE SET mode=EXCLUDED.mode",
      [policy.id],
    );
    const source=(await admin.query<{id:string}>("SELECT id FROM sources WHERE code='dou'")).rows[0]!.id;
    const id=(await admin.query<{id:string}>(
      "INSERT INTO publications(identity_hash,identity_strength,identity_basis,jurisdiction_level,"+
      "act_type,title,published_on,primary_official_url) "+
      "VALUES($1,'STRONG','{}'::jsonb,'FEDERAL','RESOLUÇÃO CIT-SNC/MINC',"+
      "'Resolução CIT-SNC/MINC 09/10','2026-10-09',$2) RETURNING id",
      [sha('worker-l17-'+tag),'https://www.in.gov.br/l17-worker-'+tag],
    )).rows[0]!.id;
    const bodyHash=sha('worker-body-'+tag);
    await admin.query(
      "INSERT INTO publication_origins(publication_id,source_id,official_url,metadata) "+
      "VALUES($1,$2,$3,'{\"dou\":{\"section\":\"DO1E\",\"sourceActType\":\"Resolução\"}}'::jsonb)",
      [id,source,'https://www.in.gov.br/l17-worker-'+tag],
    );
    await admin.query(
      "INSERT INTO publication_versions(publication_id,version_no,content_hash,content_text,is_current) "+
      "VALUES($1,1,$2,'Aprova deliberação administrativa.',true)",
      [id,bodyHash],
    );
    const client=await worker.connect();
    try{
      await client.query('BEGIN');
      const candidates=await client.query<{
        publication_id:string;title:string;act_type:string;section:string;
        content_text:string|null;relevant_excerpt:string|null;content_hash:string;
        evidence_complete:boolean;has_material:boolean;type_conflict:boolean;
        provenance_conflict:boolean;has_company:boolean;has_other_source:boolean;
      }>(
        "SELECT * FROM public.collection_filter_direct_candidates(NULL,500,'DO1E',"+
        "ARRAY['RESOLUCAO CIT SNC MINC']::text[])");
      const row=candidates.rows.find(x=>x.publication_id===id);
      assert.ok(row,'worker can select canonical specific act type');
      assert.equal(row.type_conflict,false,'generic Resolução is compatible with specific act');
      assert.equal(row.evidence_complete,true);
      const {compileCollectionFilterPolicy,evaluateCollectionFilter}=
        await import('../src/modules/collection/collection-filter.engine.js');
      const engine=compileCollectionFilterPolicy({
        version:1,contextWindowWords:12,weakScoreThreshold:3,
        locationWeights:{title:3,summary:2,body:1},terms:[],aliases:[],
        rules:[{sourceCode:'dou',section:'DO1E',
          canonicalType:'RESOLUCAO CIT SNC MINC',mode:'EXCLUDE_ALWAYS'}],
      });
      const decision=evaluateCollectionFilter(engine,{
        sourceCode:'dou',section:row.section,actType:row.act_type,title:row.title,
        body:row.content_text,summary:row.relevant_excerpt,
        evidenceComplete:row.evidence_complete,
        materialAttachmentsUnexamined:row.has_material,
        typeConflict:row.type_conflict,
        provenanceConflict:row.provenance_conflict,
      });
      assert.equal(decision.decision,'DISCARD');
      assert.equal(decision.reasonCode,'EXCLUDE_ALWAYS');
      await client.query('SELECT public.l17_lock_worker_always_targets($1::uuid[])',[[id]]);
      const result=await client.query<{deleted:number}>(
        'SELECT public.l17_prune_always_batch($1::uuid[],$2::text[],$3::uuid,$4,$5,$6) AS deleted',
        [[id],[bodyHash],policy.id,policy.revision,'DO1E','RESOLUCAO CIT SNC MINC'],
      );
      assert.equal(result.rows[0]?.deleted,1);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}
    finally{client.release();}
    assert.equal((await admin.query('SELECT id FROM publications WHERE id=$1',[id])).rowCount,0);
    const archived=await admin.query<{reason_code:string;discard_origin:string}>(
      "SELECT reason_code,discard_origin FROM collection_filter_discards "+
      "WHERE archive_publication_id=$1",[id],
    );
    assert.equal(archived.rowCount,1);
    assert.equal(archived.rows[0]?.reason_code,'ARCHIVE_PURGE');
    assert.equal(archived.rows[0]?.discard_origin,'ARCHIVE');
    const audit=await admin.query<{n:string}>(
      "SELECT count(*)::text AS n FROM audit_log WHERE action='L17_RULE_PURGE' "+
      "AND after_data->'deletedIds' ? $1",[id],
    );
    assert.equal(Number(audit.rows[0]?.n),1);
  }finally{await worker.end();await admin.end();}
});

test('L18 PG18: cross-source 029 and DOE-SP type mismatch are distinct, guarded and archived',async()=>{
  const admin=new Pool({connectionString:url,max:1});
  const app=await buildApp();
  const suffix=randomUUID().slice(0,8);
  const ids:Record<string,string>={};
  try {
    await app.ready();
    const email='l18-purge-'+suffix+'@example.test';
    const reg=await app.inject({method:'POST',url:'/auth/register',payload:{
      name:'L18 security',email,company:'L18 Test Tenant '+suffix,
      password,confirmPassword:password,acceptedTerms:true,
    }});
    assert.equal(reg.statusCode,201,reg.body);
    const user=reg.json<{user:{id:string};tenant:{id:string}}>();
    const login=await app.inject({method:'POST',url:'/auth/login',payload:{email,password}});
    assert.equal(login.statusCode,200,login.body);
    const headers={authorization:'Bearer '+login.json<{accessToken:string}>().accessToken,
      'x-tenant-id':user.tenant.id};
    const previewRoute='/api/v1/admin/collection-filter/out-of-scope/preview';
    const confirmRoute='/api/v1/admin/collection-filter/out-of-scope/confirm';
    assert.equal((await app.inject({method:'POST',url:previewRoute,headers})).statusCode,403);
    await admin.query(
      "INSERT INTO platform_user_roles(user_id,role,granted_by) VALUES($1,'PLATFORM_ADMIN','l18-test')",
      [user.user.id],
    );
    // L17 DOU runtime remains required by the same old preview, even when
    // this isolated fixture exercises only non-DOU special candidates.
    await admin.query(
      "INSERT INTO sources(code,name,jurisdiction_level,base_url,connector_key) "+
      "VALUES('dou','DOU','FEDERAL','https://example.test','dou') ON CONFLICT DO NOTHING",
    );
    const doe=(await admin.query<{id:string}>(
      "SELECT id FROM sources WHERE code='doe-sp' LIMIT 1"
    )).rows[0]?.id??(await admin.query<{id:string}>(
      "INSERT INTO sources(code,name,jurisdiction_level,uf,base_url,connector_key) "+
      "VALUES('doe-sp','DOE-SP','STATE','SP','https://doe.example.test','doe-sp') RETURNING id"
    )).rows[0]!.id;
    const other=(await admin.query<{id:string}>(
      "INSERT INTO sources(code,name,jurisdiction_level,base_url,connector_key) "+
      "VALUES($1,'Other L18','FEDERAL','https://other.example.test',$1) RETURNING id",
      ['l18-other-'+suffix],
    )).rows[0]!.id;
    async function item(key:string,sourceId:string,type:string,title:string,otherOrigin=false){
      const id=(await admin.query<{id:string}>(
        "INSERT INTO publications(identity_hash,identity_strength,identity_basis,"+
        "jurisdiction_level,uf,act_type,title,primary_official_url) "+
        "VALUES($1,'STRONG','{}'::jsonb,'STATE','SP',$2,$3,$4) RETURNING id",
        [sha('l18'+suffix+key),type,title,'https://l18.example.test/'+suffix+'/'+key]
      )).rows[0]!.id;
      ids[key]=id;
      await admin.query(
        "INSERT INTO publication_origins(publication_id,source_id,official_url) "+
        "VALUES($1,$2,$3)",[id,sourceId,'https://l18.example.test/origin/'+id],
      );
      if(otherOrigin)await admin.query(
        "INSERT INTO publication_origins(publication_id,source_id,official_url) VALUES($1,$2,$3)",
        [id,other,'https://l18.example.test/second/'+id],
      );
      return id;
    }
    await item('legacyDoe',doe,'AVISO DE LICITAÇÃO','Aviso administrativo');
    await item('legacyOther',other,'COMUNICADO DGFIN','Comunicado administrativo');
    await item('doeMismatch',doe,'EMENDA CONSTITUCIONAL','PDs Pagas');
    await item('doeCorrect',doe,'EMENDA CONSTITUCIONAL','Emenda Constitucional 9');
    await item('otherMismatch',other,'EMENDA CONSTITUCIONAL','PDs outra origem');
    await item('protectedOrigin',doe,'EMENDA CONSTITUCIONAL','PDs duas fontes',true);
    await item('protectedCompany',doe,'AVISO DE LICITAÇÃO','Aviso empresa vinculada');
    const company=(await admin.query<{id:string}>(
      "INSERT INTO companies(tenant_id,legal_name,head_office_cnpj) "+
      "VALUES($1,$2,$3) RETURNING id",
      [user.tenant.id,'L18 Protected '+suffix,'14'+String(Math.floor(Math.random()*1e12)).padStart(12,'0')]
    )).rows[0]!.id;
    await admin.query("INSERT INTO company_publications(company_id,publication_id) VALUES($1,$2)",
      [company,ids.protectedCompany]);

    const pre=await app.inject({method:'POST',url:previewRoute,headers});
    assert.equal(pre.statusCode,200,pre.body);
    const plan=pre.json<{count:number;hiddenLegacy:number;suspectDoe:number;
      blockedCompany:number;blockedOtherSource:number;token:string}>();
    assert.ok(plan.hiddenLegacy>=2,'029 must include DOE-SP and the unrelated source');
    assert.ok(plan.suspectDoe>=1,'DOE-SP title mismatch must be separate');
    assert.ok(plan.blockedCompany>=1,'company link protected');
    assert.ok(plan.blockedOtherSource>=1,'multiple official sources protected');
    const confirmed=await app.inject({method:'POST',url:confirmRoute,headers,payload:{
      expectedCount:plan.count,previewToken:plan.token,
    }});
    assert.equal(confirmed.statusCode,200,confirmed.body);
    assert.equal(confirmed.json<{changed:boolean}>().changed,false);
    for(const key of ['legacyDoe','legacyOther','doeMismatch']){
      assert.equal((await admin.query('SELECT 1 FROM publications WHERE id=$1',[ids[key]])).rowCount,0,key+' should be purged');
      const archived=await admin.query<{source_code:string;discard_origin:string}>(
        "SELECT source_code,discard_origin FROM collection_filter_discards "+
        "WHERE archive_publication_id=$1",[ids[key]]);
      assert.equal(archived.rowCount,1,key+' must be stored in Desconsiderados');
      assert.equal(archived.rows[0]?.discard_origin,'ARCHIVE');
      assert.equal(archived.rows[0]?.source_code,key==='legacyOther'?'l18-other-'+suffix:'doe-sp');
    }
    for(const key of ['doeCorrect','otherMismatch','protectedOrigin','protectedCompany']){
      assert.equal((await admin.query('SELECT 1 FROM publications WHERE id=$1',[ids[key]])).rowCount,1,key+' must be preserved');
    }
    const post=await app.inject({method:'POST',url:previewRoute,headers});
    assert.equal(post.statusCode,200,post.body);
    assert.equal(post.json<{suspectDoe:number}>().suspectDoe,0);
  }finally{
    await app.close();
    await admin.end();
  }
});

test('L17 hotfix PG18: 3000 rules and 12000 archive records, preview <30s',runL17RuleCapStress);

test('L18: preservation policy migration adds seven global STRONG tax terms without changing unrelated rules', async () => {
  const db=new Pool({connectionString:url,max:1});
  try {
    const terms=await db.query<{normalized_term:string}>(
      "SELECT DISTINCT t.normalized_term FROM collection_filter_terms t "+
      "JOIN collection_filter_policies p ON p.id=t.policy_id "+
      "WHERE p.status='APPROVED' AND t.strength='STRONG' "+
      "AND t.source_code IS NULL AND t.section IS NULL "+
      "AND t.canonical_type IS NULL AND t.location_scope='ANY' "+
      "AND t.normalized_term=ANY($1::text[])",
      [['COANA','ADUANEIRO','RECEITA FEDERAL','RFB','RECOF','REPETRO','DRAWBACK']],
    );
    assert.deepEqual(new Set(terms.rows.map(r=>r.normalized_term)),
      new Set(['COANA','ADUANEIRO','RECEITA FEDERAL','RFB','RECOF','REPETRO','DRAWBACK']));
    const audit=await db.query<{count:string}>(
      "SELECT count(*)::text AS count FROM audit_log WHERE action='L18_PRESERVATION_RULES'"
    );
    assert.ok(Number(audit.rows[0]?.count)>=1,'L18 policy change must be audited');
    const unrelated=await db.query<{canon:string;eligible:boolean}>(
      "SELECT text AS canon, (public.collection_filter_l11_normalize(text) "+
      "~ '^ATO DECLARATORIO EXECUTIVO( |$)' AND "+
      "public.collection_filter_l11_normalize(text) ~ '(^| )(COANA|RFB|SRRF|DRF)( |$)') "+
      "AS eligible FROM unnest($1::text[]) AS text",
      [['ATO DECLARATÓRIO EXECUTIVO COANA','ATO DECLARATÓRIO EXECUTIVO DRF',
        'ATO DECLARATÓRIO EXECUTIVO SRRF', 'ATO DECLARATÓRIO EXECUTIVO RFB',
        'ATO DECLARATÓRIO EXECUTIVO ANVISA','RESOLUÇÃO CIT-SNC/MINC']],
    );
    assert.deepEqual(unrelated.rows.map(r=>r.eligible),
      [true,true,true,true,false,false]);
  } finally {await db.end();}
});


