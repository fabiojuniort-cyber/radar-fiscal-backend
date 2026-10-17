import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import { Kysely, PostgresDialect } from 'kysely';
import { buildApp } from '../src/app.js';
import type { DB } from '../src/infrastructure/database/database.types.js';
import { loadApprovedCollectionFilterRuntime, evaluateRuntimeCollectionFilter } from '../src/modules/collection/collection-filter.runtime.js';
import { evaluateHistoricalCollectionCandidate, candidates, type HistoricalCollectionCandidate } from '../src/modules/collection/collection-filter.direct.js';
import { withUserContext } from '../src/infrastructure/database/tenant-context.js';
import { loadF3ArchivePlan } from '../src/modules/collection/collection-filter.scope-purge.js';
import { runL17ExcludeAlways } from '../src/modules/collection/l17-daily-always.js';

const adminUrl=process.env.DATABASE_ADMIN_URL;
if(!adminUrl) throw new Error('DATABASE_ADMIN_URL required: isolated PostgreSQL 18 only');
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');

test('F3 PG18: central decisions, protected origins/companies, preview-only cron and revision-safe confirmation', async()=>{
  const owner=new Pool({connectionString:adminUrl,max:1});
  const inspection=new Kysely<DB>({dialect:new PostgresDialect({pool:new Pool({connectionString:adminUrl,max:1})})});
  const app=await buildApp();
  const tag='F3GOV'+randomUUID().replaceAll('-','').toUpperCase();
  const type=tag+' EXTRATO DE CONTRATO';
  const doeType=tag+' ATO ESTADUAL';
  const conditionalType=tag+' AVISO CONDICIONAL';
  const ids:string[]=[];
  try{
    await app.ready();
    const email=tag.toLowerCase()+'@example.test';
    const password='F3-Isolated-Integration-2026!';
    const registered=await app.inject({method:'POST',url:'/auth/register',payload:{name:'F3 PG18',email,password,confirmPassword:password,acceptedTerms:true}});
    assert.equal(registered.statusCode,201,registered.body);
    const account=registered.json<{user:{id:string};tenant:{id:string}}>();
    const logged=await app.inject({method:'POST',url:'/auth/login',payload:{email,password}});
    assert.equal(logged.statusCode,200,logged.body);
    const headers={authorization:'Bearer '+logged.json<{accessToken:string}>().accessToken,'x-tenant-id':account.tenant.id};
    await owner.query("INSERT INTO platform_user_roles(user_id,role,granted_by) VALUES($1,'PLATFORM_ADMIN','F3_ISOLATED_TEST')",[account.user.id]);
    const policy=(await owner.query<{id:string}>("SELECT id FROM collection_filter_policies WHERE status='APPROVED' LIMIT 1")).rows[0]
      ?? (await owner.query<{id:string}>("INSERT INTO collection_filter_policies(version,status,approved_at,approved_by) SELECT COALESCE(max(version),0)+1,'APPROVED',now(),$1 FROM collection_filter_policies RETURNING id",[account.user.id])).rows[0]!;
    const source=async(code:string)=>{
      const existing=(await owner.query<{id:string}>('SELECT id FROM sources WHERE code=$1',[code])).rows[0];
      return existing?.id ?? (await owner.query<{id:string}>("INSERT INTO sources(code,name,jurisdiction_level,base_url,connector_key) VALUES($1,$1,'FEDERAL','https://example.test',$1) RETURNING id",[code])).rows[0]!.id;
    };
    const dou=await source('dou'); const doe=await source('doe-sp');
    for(const [code,section,canonical,mode] of [['dou','DO3',type,'EXCLUDE_ALWAYS'],['doe-sp','',doeType,'EXCLUDE_ALWAYS'],['dou','DO3',conditionalType,'KEEP_IF_TAX_TERM']]){
      await owner.query('INSERT INTO collection_filter_type_rules(policy_id,source_code,section,canonical_type,mode) VALUES($1,$2,$3,$4,$5)',[policy.id,code,section,canonical,mode]);
    }
    const fixture=async(label:string,code='dou',canonical=type,extraOrigin=false)=>{
      const id=randomUUID();ids.push(id);
      const sourceId=code==='dou'?dou:doe;
      const officialUrl='https://example.test/'+tag+'/'+label;
      const title=canonical+' Nº 33/2026';
      const metadata=code==='dou'?{dou:{section:'DO3E',sourceActType:'Aviso'}}:{section:'ATOS NORMATIVOS',publicationType:'Aviso'};
      await owner.query("INSERT INTO publications(id,identity_hash,identity_strength,identity_basis,jurisdiction_level,act_type,title,published_on,primary_official_url) VALUES($1,$2,'STRONG','{}'::jsonb,'FEDERAL','AVISO',$3,'2026-10-09',$4)",[id,sha(id),title,officialUrl]);
      await owner.query('INSERT INTO publication_origins(publication_id,source_id,official_url,metadata) VALUES($1,$2,$3,$4::jsonb)',[id,sourceId,officialUrl,JSON.stringify(metadata)]);
      await owner.query('INSERT INTO publication_versions(publication_id,version_no,content_hash,content_text,is_current,source_metadata) VALUES($1,1,$2,$3,true,$4::jsonb)',[id,sha('body'+id),'Contratacao administrativa de rotina.',JSON.stringify(metadata)]);
      if(extraOrigin) await owner.query('INSERT INTO publication_origins(publication_id,source_id,official_url,metadata) VALUES($1,$2,$3,$4::jsonb)',[id,sourceId,officialUrl+'/second',JSON.stringify(metadata)]);
      return {id,sourceId,metadata,title,officialUrl,identityHash:sha(id)};
    };
    // F3-NOME-01: reconstruct full counts from archive titles, never the <=3 legacy samples.
    for(const code of ['dou','doe-sp']){
      for(let n=0;n<3;n++)await fixture('name-generic-'+code+'-'+n,code,tag+' COMUNICADO');
      for(let n=0;n<12;n++)await fixture('name-opening-'+code+'-'+n,code,tag+' COMUNICADO DE ABERTURA');
    }
    const ruleBefore=(await owner.query("SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY r.id)::text) AS hash FROM collection_filter_type_rules r WHERE policy_id=$1",[policy.id])).rows[0].hash;
    const queueBefore=(await owner.query('SELECT count(*)::int AS count FROM collection_filter_new_types')).rows[0].count;
    const started=performance.now();
    let namesResponse=await app.inject({method:'GET',url:'/api/v1/admin/collection-filter/new-types?status=OPEN',headers});
    assert.ok(performance.now()-started<3000,'cold inventory response must not wait for archive rebuild');
    for(let attempt=0;attempt<100&&namesResponse.json().inventory?.status!=='READY';attempt++){
      await delay(100);
      namesResponse=await app.inject({method:'GET',url:'/api/v1/admin/collection-filter/new-types?status=OPEN',headers});
    }
    assert.equal(namesResponse.json().inventory?.status,'READY',namesResponse.body);
    const warmStart=performance.now();
    await app.inject({method:'GET',url:'/api/v1/admin/collection-filter/new-types?status=OPEN',headers});
    assert.ok(performance.now()-warmStart<3000,'warm inventory response must stay below three seconds');
    assert.equal(namesResponse.statusCode,200,namesResponse.body);
    const nameItems=namesResponse.json<{items:Array<{id:string;source_code:string;normalized_type:string;act_name:string;occurrence_count:number;queue_basis:string;examples:unknown[]}>}>().items;
    for(const code of ['dou','doe-sp']){
      const generic=nameItems.find(x=>x.source_code===code&&x.normalized_type===tag+' COMUNICADO');
      const opening=nameItems.find(x=>x.source_code===code&&x.normalized_type===tag+' COMUNICADO DE ABERTURA');
      assert.ok(generic);assert.ok(opening);
      assert.equal(generic.occurrence_count,3);assert.equal(opening.occurrence_count,12);
      assert.equal(opening.examples.length,3);assert.equal(opening.queue_basis,'ARCHIVE_ACT_NAME');
      assert.notEqual(generic.id,opening.id);
    }
    const stateResponse=await app.inject({method:'GET',url:'/api/v1/admin/collection-filter/state',headers});
    assert.equal(stateResponse.statusCode,200,stateResponse.body);
    assert.equal(stateResponse.json<{newTypesOpen:number}>().newTypesOpen,nameItems.length);
    assert.equal((await owner.query("SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY r.id)::text) AS hash FROM collection_filter_type_rules r WHERE policy_id=$1",[policy.id])).rows[0].hash,ruleBefore);
    assert.equal((await owner.query('SELECT count(*)::int AS count FROM collection_filter_new_types')).rows[0].count,queueBefore);
    const ordinary=await fixture('ordinary'); const companyProtected=await fixture('company'); const originProtected=await fixture('another-origin','dou',type,true); const doeItem=await fixture('doe','doe-sp',doeType);
    const conditional=await fixture('provenance-file','dou',conditionalType);
    const provenanceFiles=[{versionRole:'PROVENANCE',metadata:{kind:'ATTACHMENT'}}];
    await owner.query("UPDATE publication_origins SET metadata=metadata||jsonb_build_object('files',$2::jsonb) WHERE publication_id=$1",[conditional.id,JSON.stringify(provenanceFiles)]);
    await owner.query("UPDATE publication_versions SET source_metadata=source_metadata||jsonb_build_object('files',$2::jsonb) WHERE publication_id=$1",[conditional.id,JSON.stringify(provenanceFiles)]);
    await owner.query("INSERT INTO publication_files(publication_version_id,storage_provider,bucket,object_key,raw_sha256) SELECT id,'SYNTHETIC','F3_TEST',$2,$3 FROM publication_versions WHERE publication_id=$1 AND is_current",[conditional.id,tag,sha('file'+conditional.id)]);
    const company=(await owner.query<{id:string}>('INSERT INTO companies(tenant_id,legal_name,head_office_cnpj) VALUES($1,$2,$3) RETURNING id',[account.tenant.id,tag,String(BigInt('0x'+randomUUID().replaceAll('-','').slice(0,11))).padStart(14,'0')])).rows[0]!.id;
    await owner.query('INSERT INTO company_publications(company_id,publication_id) VALUES($1,$2)',[company,companyProtected.id]);
    const legacyBaseline=await app.inject({method:'POST',url:'/api/v1/admin/collection-filter/out-of-scope/preview',headers});
    assert.equal(legacyBaseline.statusCode,200,legacyBaseline.body);
    const legacyKept:string[]=[];
    for(const code of ['dou','doe-sp']){
      const generic='AVISO DE LICITACAO '+tag;
      const specific=generic+' PRESERVAR';
      for(const [canonical,mode] of [[generic,'EXCLUDE_ALWAYS'],[specific,'KEEP_ALWAYS']]){
        await owner.query('INSERT INTO collection_filter_type_rules(policy_id,source_code,section,canonical_type,mode) VALUES($1,$2,$3,$4,$5)',[policy.id,code,code==='dou'?'DO3':'',canonical,mode]);
      }
      for(const kind of ['unknown','specific-keep']){
        const kept=await fixture(code+'-legacy-'+kind,code,kind==='unknown'?tag+' SEM REGRA':specific);
        legacyKept.push(kept.id);
        // The legacy generated flag reads inferred act_type, whereas F3 reads
        // official metadata and title. That independent flag cannot delete KEEP.
        await owner.query("UPDATE publications SET act_type='AVISO DE LICITAÇÃO' WHERE id=$1",[kept.id]);
        const metadata=code==='dou'?{dou:{section:'DO3E',sourceActType:tag+' TIPO NOVO'}}:{section:'ATOS NORMATIVOS',publicationType:tag+' TIPO NOVO'};
        await owner.query('UPDATE publication_origins SET metadata=$2::jsonb WHERE publication_id=$1',[kept.id,JSON.stringify(metadata)]);
        await owner.query('UPDATE publication_versions SET source_metadata=$2::jsonb WHERE publication_id=$1',[kept.id,JSON.stringify(metadata)]);
        const flag=(await owner.query<{is_hidden:boolean}>('SELECT is_hidden FROM publications WHERE id=$1',[kept.id])).rows[0];assert.equal(flag?.is_hidden,true);
        const runtime=await loadApprovedCollectionFilterRuntime(inspection,kept.sourceId,{readOnly:true});assert.ok(runtime);
        const history=(await owner.query<HistoricalCollectionCandidate>('SELECT * FROM collection_filter_f3_candidates((SELECT id FROM publications WHERE id<$2::uuid ORDER BY id DESC LIMIT 1),500,$1) WHERE publication_id=$2::uuid',[code,kept.id])).rows[0];assert.ok(history);
        const decision=evaluateHistoricalCollectionCandidate(runtime.policy,history);
        assert.equal(decision.decision,'KEEP');assert.equal(decision.requiresNewTypeReview,kind==='unknown');
      }
    }
    const legacyPreview=await app.inject({method:'POST',url:'/api/v1/admin/collection-filter/out-of-scope/preview',headers});assert.equal(legacyPreview.statusCode,200,legacyPreview.body);
    for(const key of ['count','hiddenLegacy','blockedCompany','blockedOtherSource']){
      assert.equal(legacyPreview.json<Record<string,number>>()[key],legacyBaseline.json<Record<string,number>>()[key],key+': F3 KEEP rows must not enter legacy purge counters');
    }
    for(const fixtureItem of [ordinary,doeItem]){
      const runtime=await loadApprovedCollectionFilterRuntime(inspection,fixtureItem.sourceId,{readOnly:true});assert.ok(runtime);
      const douRuntime=await loadApprovedCollectionFilterRuntime(inspection,dou,{readOnly:true});
      assert.ok(douRuntime);
      assert.deepEqual(evaluateHistoricalCollectionCandidate(douRuntime.policy, {publication_id:fixtureItem.id,title:fixtureItem.title,source_code:fixtureItem.sourceId===dou?'dou':'doe-sp',section:fixtureItem.sourceId===dou?'DO3E':'ATOS NORMATIVOS',source_act_type:'Aviso',content_text:'Contratacao administrativa de rotina.',evidence_complete:true,has_material:false,provenance_conflict:false} as HistoricalCollectionCandidate), evaluateHistoricalCollectionCandidate(runtime.policy,{publication_id:fixtureItem.id,title:fixtureItem.title,source_code:fixtureItem.sourceId===dou?'dou':'doe-sp',section:fixtureItem.sourceId===dou?'DO3E':'ATOS NORMATIVOS',source_act_type:'Aviso',content_text:'Contratacao administrativa de rotina.',evidence_complete:true,has_material:false,provenance_conflict:false} as HistoricalCollectionCandidate),'source used to load global policy must not affect a decision');
      const publication={title:fixtureItem.title,actType:'AVISO',contentText:'Contratacao administrativa de rotina.',metadata:fixtureItem.metadata,originMetadata:fixtureItem.metadata,files:[]};
      const capture=evaluateRuntimeCollectionFilter(runtime,publication as Parameters<typeof evaluateRuntimeCollectionFilter>[1]);
      const history=(await owner.query<HistoricalCollectionCandidate>('SELECT * FROM collection_filter_f3_candidates((SELECT id FROM publications WHERE id<$2::uuid ORDER BY id DESC LIMIT 1),500,$1) WHERE publication_id=$2::uuid',[runtime.sourceCode,fixtureItem.id])).rows[0];
      assert.ok(history,'fixture must be enumerated by the production SQL evidence adapter');
      assert.deepEqual(evaluateHistoricalCollectionCandidate(runtime.policy,history),capture.decision);
      assert.equal(capture.decision.decision,'DISCARD');assert.equal(capture.decision.matchedTypeSource,'TITLE');
    }
    const conditionalRuntime=await loadApprovedCollectionFilterRuntime(inspection,dou,{readOnly:true});assert.ok(conditionalRuntime);
    const conditionalHistory=(await owner.query<HistoricalCollectionCandidate>('SELECT * FROM collection_filter_f3_candidates((SELECT id FROM publications WHERE id<$2::uuid ORDER BY id DESC LIMIT 1),500,$1) WHERE publication_id=$2::uuid',['dou',conditional.id])).rows[0];assert.ok(conditionalHistory);
    assert.equal(conditionalHistory.has_material,false,'stored PROVENANCE role must override conservative legacy file fallback');
    const conditionalCapture=evaluateRuntimeCollectionFilter(conditionalRuntime,{title:conditional.title,contentText:'Contratacao administrativa de rotina.',metadata:conditional.metadata,originMetadata:conditional.metadata,files:provenanceFiles} as Parameters<typeof evaluateRuntimeCollectionFilter>[1]);
    assert.deepEqual(evaluateHistoricalCollectionCandidate(conditionalRuntime.policy,conditionalHistory),conditionalCapture.decision);
    assert.equal(conditionalCapture.decision.decision,'DISCARD');
    for(const signature of ['public.l17_prune_hidden_batch(integer)','public.l17_prune_always_batch(uuid[],text[],uuid,integer,text,text)']){
      const acl=(await owner.query<{allowed:boolean}>("SELECT has_function_privilege('radar_worker_runtime',$1,'EXECUTE') AS allowed",[signature])).rows[0];assert.equal(acl?.allowed,false,'worker must lack the retired destructive capability');
    }
    const protectedResult=await owner.query<{protected:boolean}>('SELECT collection_filter_capture_protected($1,$2,$3) AS protected',[companyProtected.identityHash,dou,companyProtected.officialUrl]);
    assert.equal(protectedResult.rows[0]!.protected,true);
    assert.equal((await owner.query<{protected:boolean}>('SELECT collection_filter_capture_protected($1,$2,$3) AS protected',[originProtected.identityHash,dou,originProtected.officialUrl])).rows[0]!.protected,true);
    const logRows:Array<Record<string,unknown>>=[];
    await runL17ExcludeAlways(inspection,{info:data=>{logRows.push(data);},error:data=>{throw new Error(String(data.error));}});
    assert.ok(logRows.some(row=>row.deletedPublications===0&&row.confirmationRequired===true));
    assert.equal((await owner.query('SELECT id FROM publications WHERE id=ANY($1::uuid[])',[ids])).rowCount,ids.length,'daily inspection must preserve every fixture');
    // Give surviving KEEP/UNKNOWN fixtures old OUT_OF_SCOPE state as well.
    // The new button must still agree with capture, regardless of all legacy flags.
    for(const id of legacyKept){
      const event=(await owner.query<{id:string}>(
        "INSERT INTO publication_scope_events(publication_id,operation_id,action,previous_scope,new_scope,policy_key,reason_code,rule_version,evidence_sha256,actor_ref) VALUES($1,$2,'SUPPRESS','IN_SCOPE','OUT_OF_SCOPE','F3_SIMPL_TEST','TEST','1',$3,'f3-simpl') RETURNING id",
        [id,randomUUID(),sha('scope'+id)])).rows[0]!.id;
      await owner.query("INSERT INTO publication_scope_state(publication_id,scope,current_event_id,policy_key,evidence_sha256) VALUES($1,'OUT_OF_SCOPE',$2,'F3_SIMPL_TEST',$3)",[id,event,sha('scope'+id)]);
    }
    const expectedEligible=new Set<string>();
    const expectedCompany=new Set<string>();
    const expectedOrigin=new Set<string>();
    for(const code of ['dou','doe-sp']){
      const runtime=await loadApprovedCollectionFilterRuntime(inspection,code==='dou'?dou:doe,{readOnly:true});assert.ok(runtime);
      let after:string|null=null;
      while(true){
        const page=await owner.query<HistoricalCollectionCandidate>('SELECT * FROM collection_filter_f3_candidates($1::uuid,500,$2)',[after,code]);
        if(!page.rows.length)break;
        const storedRows=(await owner.query<{id:string;title:string;act_type:string;content_text:string;source_metadata:Record<string,unknown>;metadata:Record<string,unknown>}>(
          'SELECT DISTINCT ON (p.id) p.id,p.title,p.act_type,v.content_text,v.source_metadata,o.metadata FROM publications p JOIN publication_versions v ON v.publication_id=p.id AND v.is_current JOIN publication_origins o ON o.publication_id=p.id JOIN sources so ON so.id=o.source_id WHERE p.id=ANY($1::uuid[]) AND so.code=$2 ORDER BY p.id,o.id',[page.rows.map(row=>row.publication_id),code])).rows;
        const storedById=new Map(storedRows.map(row=>[row.id,row]));
        for(const history of page.rows){
          const stored=storedById.get(history.publication_id);
          if(!stored){
            assert.equal(evaluateHistoricalCollectionCandidate(runtime.policy,history).decision,'KEEP','incomplete archive evidence must be preserved');
            continue;
          }
          const files=(stored.metadata.files??stored.source_metadata.files??[]) as Parameters<typeof evaluateRuntimeCollectionFilter>[1]['files'];
          const capture=evaluateRuntimeCollectionFilter(runtime,{title:stored.title,actType:stored.act_type,contentText:stored.content_text,metadata:stored.source_metadata,originMetadata:stored.metadata,files} as Parameters<typeof evaluateRuntimeCollectionFilter>[1]);
          assert.equal(evaluateHistoricalCollectionCandidate(runtime.policy,history).decision,capture.decision.decision,'archive/capture equivalence for '+history.publication_id);
          if(capture.decision.decision!=='DISCARD')continue;
          if(history.has_company)expectedCompany.add(history.publication_id);
          else if(history.has_other_source)expectedOrigin.add(history.publication_id);
          else expectedEligible.add(history.publication_id);
        }
        after=page.rows[page.rows.length-1]!.publication_id;
        if(page.rows.length<500)break;
      }
    }
    const globalPreview=await app.inject({method:'POST',url:'/api/v1/admin/collection-filter/out-of-scope/preview',headers});
    assert.equal(globalPreview.statusCode,200,globalPreview.body);
    const archivePlan=globalPreview.json<{count:number;blockedCompany:number;blockedOtherSource:number;samples:Array<{id:string}>;outOfScope:number;hiddenLegacy:number;suspectDoe:number;token:string}>();
    assert.equal(archivePlan.count,expectedEligible.size,'button count equals capture DISCARD minus protections');
    assert.equal(archivePlan.blockedCompany,expectedCompany.size);
    assert.equal(archivePlan.blockedOtherSource,expectedOrigin.size);
    const exactPlan=await withUserContext(inspection,account.user.id,trx=>loadF3ArchivePlan(trx));
    assert.deepEqual(new Set(exactPlan.ids),expectedEligible,'button selects exactly the capture engine IDs across every page');
    assert.ok(archivePlan.samples.every(row=>expectedEligible.has(row.id)),'all displayed samples belong to the capture DISCARD set');
    assert.deepEqual([archivePlan.outOfScope,archivePlan.hiddenLegacy,archivePlan.suspectDoe],[0,0,0]);
    await owner.query('UPDATE collection_filter_policies SET revision=revision+1 WHERE id=$1',[policy.id]);
    const staleArchive=await app.inject({method:'POST',url:'/api/v1/admin/collection-filter/out-of-scope/confirm',headers,payload:{expectedCount:archivePlan.count,previewToken:archivePlan.token}});
    assert.equal(staleArchive.statusCode,200,staleArchive.body);
    assert.equal(staleArchive.json<{changed:boolean}>().changed,true,'unchanged IDs with a new policy revision require a new preview');
    assert.equal(staleArchive.json<{deletedCount:number}>().deletedCount,0);
    assert.equal((await owner.query('SELECT id FROM publications WHERE id=ANY($1::uuid[])',[ids])).rowCount,ids.length);

    assert.ok(globalPreview.json<{byRule:Array<{canonicalType:string}>}>().byRule.some(row=>row.canonicalType===type));
    const rule={sourceCode:'dou',section:'DO3',canonicalType:type,mode:'EXCLUDE_ALWAYS'};
    const preview=async()=>{
      const result=await app.inject({method:'POST',url:'/api/v1/admin/collection-filter/direct-rule/preview',headers,payload:rule});assert.equal(result.statusCode,200,result.body);
      return result.json<{count:number;token:string;confirmationToken:string;policyRevision:number;blockedCompany:number;blockedOtherSource:number;confirmationToken:string;policyRevision:number}>();
    };
    // Byte-for-byte F3 contract: prefiltered and original full-evaluation
    // paths MUST return identical IDs, hash, company/origin protection,
    // samples, policy revision and confirm capability in isolated PG18.
    const baseline=await withUserContext(inspection,account.user.id,
      trx=>candidates(trx,rule,{disableTitlePrecheck:true}));
    const optimized=await withUserContext(inspection,account.user.id,
      trx=>candidates(trx,rule));
    assert.deepEqual(optimized,baseline,'F3 optimized preview must equal original engine plan');
    const first=await preview();assert.equal(first.count,1);assert.equal(first.blockedCompany,1);assert.equal(first.blockedOtherSource,1);
    const legacy=await app.inject({method:'POST',url:'/api/v1/admin/collection-filter/direct-rule/confirm',headers,payload:{...rule,expectedCount:first.count,previewToken:first.token}});
    assert.equal(legacy.statusCode,409,legacy.body);
    assert.equal(legacy.json<{error:string}>().error,'f3_confirmation_token_required');
    assert.equal((await owner.query('SELECT 1 FROM publications WHERE id=$1',[ordinary.id])).rowCount,1,'legacy client may not delete');
    const forgedRevision=await app.inject({method:'POST',url:'/api/v1/admin/collection-filter/direct-rule/confirm',headers,payload:{
      ...rule,expectedCount:first.count,previewToken:first.token,
      confirmationToken:first.confirmationToken,policyRevision:first.policyRevision+1}});
    assert.equal(forgedRevision.statusCode,409,forgedRevision.body);
    assert.equal((await owner.query('SELECT 1 FROM publications WHERE id=$1',[ordinary.id])).rowCount,1,'wrong policy revision may not delete');
    // Adversarial stale preview: a new company link MUST invalidate the
    // server witness transactionally, without ever touching the purge endpoint.
    const e0=(await owner.query<{revision:string}>(
      "SELECT revision::text AS revision FROM collection_filter_f3_evidence_epoch WHERE table_name='company_publications'"
    )).rows[0]!.revision;
    await owner.query('INSERT INTO company_publications(company_id,publication_id) VALUES($1,$2)',
      [company,ordinary.id]);
    const e1=(await owner.query<{revision:string}>(
      "SELECT revision::text AS revision FROM collection_filter_f3_evidence_epoch WHERE table_name='company_publications'"
    )).rows[0]!.revision;
    assert.ok(BigInt(e1)>BigInt(e0),'company link must bump F3 evidence revision');
    const staleSave=await app.inject({method:'POST',url:'/api/v1/admin/collection-filter/direct-rule/save',headers,payload:{
      ...rule,expectedCount:first.count,previewToken:first.token,
      confirmationToken:first.confirmationToken,policyRevision:first.policyRevision}});
    assert.equal(staleSave.statusCode,409,staleSave.body);
    assert.equal((await owner.query('SELECT 1 FROM publications WHERE id=$1',[ordinary.id])).rowCount,1);
    await owner.query('DELETE FROM company_publications WHERE company_id=$1 AND publication_id=$2',
      [company,ordinary.id]);
    const renewed=await preview();
    assert.equal(renewed.count,1);
    const safeSave=await app.inject({method:'POST',url:'/api/v1/admin/collection-filter/direct-rule/save',headers,payload:{
      ...rule,expectedCount:renewed.count,previewToken:renewed.token,
      confirmationToken:renewed.confirmationToken,policyRevision:renewed.policyRevision}});
    assert.equal(safeSave.statusCode,200,safeSave.body);
    assert.equal(safeSave.json<{deletedCount:number}>().deletedCount,0);
    assert.equal((await owner.query('SELECT 1 FROM publications WHERE id=$1',[ordinary.id])).rowCount,1,'save is never a purge');
    // A locked evidence stamp MUST block concurrent writes until the admin
    // transaction commits. No table-level locks or blanket runtime grants.
    const guard=await owner.connect();
    const concurrent=new Pool({connectionString:adminUrl,max:1});
    try {
      await guard.query('BEGIN');
      await guard.query("SELECT set_config('app.user_id',$1,true)",[account.user.id]);
      await guard.query('SELECT public.collection_filter_f3_evidence_stamp(true)');
      const writer=await concurrent.connect();
      try {
        await writer.query('BEGIN');
        await writer.query("SET LOCAL lock_timeout = '200ms'");
        await assert.rejects(
          writer.query("UPDATE publication_versions SET content_text=content_text||' x' WHERE publication_id=$1",
            [ordinary.id]),
          (err:unknown)=>(err as {code:string}).code==='55P03',
          'writer must block while admin holds evidence epoch snapshot lock',
        );
        await writer.query('ROLLBACK');
      } finally { writer.release(); }
    } finally {
      await guard.query('ROLLBACK');
      guard.release();
      await concurrent.end();
    }
    const additional=await fixture('new-after-preview');
    assert.equal((await owner.query('SELECT 1 FROM publications WHERE id=ANY($1::uuid[])',[[ordinary.id,additional.id]])).rowCount,2);
    const refreshed=await preview();assert.equal(refreshed.count,2);
    const confirmation=await app.inject({method:'POST',url:'/api/v1/admin/collection-filter/direct-rule/confirm',headers,payload:{...rule,expectedCount:refreshed.count,previewToken:refreshed.token,confirmationToken:refreshed.confirmationToken,policyRevision:refreshed.policyRevision,resume:true}});
    assert.equal(confirmation.statusCode,200,confirmation.body);assert.equal(confirmation.json<{deletedCount:number}>().deletedCount,2);
    assert.equal((await owner.query('SELECT id FROM publications WHERE id=ANY($1::uuid[])',[[companyProtected.id,originProtected.id,doeItem.id]])).rowCount,3);
    const archived=(await owner.query<{archive_policy_rule:string;rule_mode:string}>('SELECT archive_policy_rule,rule_mode FROM collection_filter_discards WHERE archive_publication_id=ANY($1::uuid[])',[[ordinary.id,additional.id]])).rows;
    assert.equal(archived.length,2);assert.ok(archived.every(row=>row.archive_policy_rule===type&&row.rule_mode==='EXCLUDE_ALWAYS'));
    const before=(await owner.query<{revision:number}>("SELECT revision FROM collection_filter_policies WHERE id=$1",[policy.id])).rows[0]!.revision;
    const collision=await app.inject({method:'POST',url:'/api/v1/admin/collection-filter/direct-admin-edit',headers,payload:{action:'RULE_KEEP',payload:{sourceCode:'dou',section:'DO3',canonicalType:type+' Nº 33/2026',mode:'KEEP_ALWAYS'}}});
    assert.ok(collision.statusCode>=400,'opposing normalized identities must not activate');
    assert.equal((await owner.query<{revision:number}>('SELECT revision FROM collection_filter_policies WHERE id=$1',[policy.id])).rows[0]!.revision,before,'collision must roll back policy revision');
    assert.equal((await owner.query('SELECT 1 FROM collection_filter_type_rules WHERE policy_id=$1 AND canonical_type=$2',[policy.id,type+' Nº 33/2026'])).rowCount,0,'collision must roll back its rule');
    // A persisted legacy spelling that is redundant today must not survive an
    // opposite direct-rule edit whose hypothetical preview removed both rows.
    await owner.query('INSERT INTO collection_filter_type_rules(policy_id,source_code,section,canonical_type,mode) VALUES($1,$2,$3,$4,$5)',[policy.id,'dou','DO3',type+' Nº 77/2026','EXCLUDE_ALWAYS']);
    const keepRule={...rule,mode:'KEEP_ALWAYS'};
    const keepPreview=await app.inject({method:'POST',url:'/api/v1/admin/collection-filter/direct-rule/preview',headers,payload:keepRule});
    assert.ok(keepPreview.statusCode>=400,'preview must retain the other saved identity and reject the conflict before any write');
    assert.equal((await owner.query<{mode:string}>('SELECT mode FROM collection_filter_type_rules WHERE policy_id=$1 AND canonical_type=$2',[policy.id,type])).rows[0]!.mode,'EXCLUDE_ALWAYS');
    assert.equal((await owner.query<{revision:number}>('SELECT revision FROM collection_filter_policies WHERE id=$1',[policy.id])).rows[0]!.revision,before);
    const finalPreview=await app.inject({method:'POST',url:'/api/v1/admin/collection-filter/out-of-scope/preview',headers});assert.equal(finalPreview.statusCode,200,finalPreview.body);
    const finalPlan=finalPreview.json<{count:number;token:string;confirmationToken:string;policyRevision:number}>();
    const finalConfirm=await app.inject({method:'POST',url:'/api/v1/admin/collection-filter/out-of-scope/confirm',headers,payload:{expectedCount:finalPlan.count,previewToken:finalPlan.token}});
    assert.equal(finalConfirm.statusCode,200,finalConfirm.body);assert.equal(finalConfirm.json<{changed:boolean}>().changed,false);
    assert.equal((await owner.query('SELECT id FROM publications WHERE id=ANY($1::uuid[])',[legacyKept])).rowCount,legacyKept.length,'unknown and more-specific KEEP survive confirmed screen purge for both F3 sources');
    assert.equal((await owner.query('SELECT 1 FROM collection_filter_discards WHERE archive_publication_id=ANY($1::uuid[])',[legacyKept])).rowCount,0);
  } finally {await app.close();await inspection.destroy();await owner.end();}
});

