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
    const plan=preview.json<{count:number;outOfScope:number;hiddenLegacy:number;blockedCompany:number;
      blockedOtherSource:number;token:string}>();
    assert.equal(plan.count,3);
    assert.equal(plan.outOfScope,2);
    assert.equal(plan.hiddenLegacy,1);
    assert.equal(plan.blockedCompany,2);
    assert.equal(plan.blockedOtherSource,3);
    assert.match(plan.token,/^[a-f0-9]{64}$/);

    const rejected=await app.inject({method:'POST',url:confirmRoute,headers,
      payload:{expectedCount:2,previewToken:plan.token}});
    assert.equal(rejected.statusCode,200,rejected.body);
    assert.equal(rejected.json<{changed:boolean;apagadas:number}>().changed,true);
    assert.equal(rejected.json<{changed:boolean;apagadas:number}>().apagadas,0);

    const applied=await app.inject({method:'POST',url:confirmRoute,headers,
      payload:{expectedCount:3,previewToken:plan.token}});
    assert.equal(applied.statusCode,200,applied.body);
    assert.equal(applied.json<{apagadas:number;restantes:number}>().apagadas,3);
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
      hiddenIds['hidden-company'],hiddenIds['hidden-other'],hiddenIds['hidden-non-dou'],
    ]));
    const audit=await db.query<{count:string}>(
      "SELECT count(*)::text AS count FROM audit_log "+
      "WHERE action='COLLECTION_FILTER_DIRECT_PURGE' "+
      "AND entity_id='OUT_OF_SCOPE' AND after_data->>'deletedCount'='3'",
    );
    assert.ok(Number(audit.rows[0]!.count)>=1,'051 append-only audit required');
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
