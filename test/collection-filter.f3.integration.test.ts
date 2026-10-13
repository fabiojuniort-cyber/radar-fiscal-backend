import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import { buildApp } from '../src/app.js';
import type { DB } from '../src/infrastructure/database/database.types.js';
import { loadApprovedCollectionFilterRuntime, evaluateRuntimeCollectionFilter } from '../src/modules/collection/collection-filter.runtime.js';
import { evaluateHistoricalCollectionCandidate, type HistoricalCollectionCandidate } from '../src/modules/collection/collection-filter.direct.js';
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
    const globalPreview=await app.inject({method:'POST',url:'/api/v1/admin/collection-filter/out-of-scope/preview',headers});
    assert.equal(globalPreview.statusCode,200,globalPreview.body);
    assert.ok(globalPreview.json<{byRule:Array<{canonicalType:string}>}>().byRule.some(row=>row.canonicalType===type));
    const rule={sourceCode:'dou',section:'DO3',canonicalType:type,mode:'EXCLUDE_ALWAYS'};
    const preview=async()=>{
      const result=await app.inject({method:'POST',url:'/api/v1/admin/collection-filter/direct-rule/preview',headers,payload:rule});assert.equal(result.statusCode,200,result.body);
      return result.json<{count:number;token:string;blockedCompany:number;blockedOtherSource:number}>();
    };
    const first=await preview();assert.equal(first.count,1);assert.equal(first.blockedCompany,1);assert.equal(first.blockedOtherSource,1);
    const additional=await fixture('new-after-preview');
    const stale=await app.inject({method:'POST',url:'/api/v1/admin/collection-filter/direct-rule/confirm',headers,payload:{...rule,expectedCount:first.count,previewToken:first.token}});
    assert.equal(stale.statusCode,200,stale.body);assert.equal(stale.json<{changed:boolean;deletedCount:number}>().changed,true);assert.equal(stale.json<{deletedCount:number}>().deletedCount,0);
    assert.equal((await owner.query('SELECT id FROM publications WHERE id=ANY($1::uuid[])',[[ordinary.id,additional.id]])).rowCount,2);
    const refreshed=await preview();assert.equal(refreshed.count,2);
    const confirmation=await app.inject({method:'POST',url:'/api/v1/admin/collection-filter/direct-rule/confirm',headers,payload:{...rule,expectedCount:refreshed.count,previewToken:refreshed.token}});
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
    const keepPreview=await app.inject({method:'POST',url:'/api/v1/admin/collection-filter/direct-rule/preview',headers,payload:keepRule});assert.equal(keepPreview.statusCode,200,keepPreview.body);
    const kp=keepPreview.json<{count:number;token:string}>();
    const rejected=await app.inject({method:'POST',url:'/api/v1/admin/collection-filter/direct-rule/confirm',headers,payload:{...keepRule,expectedCount:kp.count,previewToken:kp.token}});
    assert.ok(rejected.statusCode>=400,'direct confirmation must validate persisted identities');
    assert.equal((await owner.query<{mode:string}>('SELECT mode FROM collection_filter_type_rules WHERE policy_id=$1 AND canonical_type=$2',[policy.id,type])).rows[0]!.mode,'EXCLUDE_ALWAYS');
    assert.equal((await owner.query<{revision:number}>('SELECT revision FROM collection_filter_policies WHERE id=$1',[policy.id])).rows[0]!.revision,before);
    const finalPreview=await app.inject({method:'POST',url:'/api/v1/admin/collection-filter/out-of-scope/preview',headers});assert.equal(finalPreview.statusCode,200,finalPreview.body);
    const finalPlan=finalPreview.json<{count:number;token:string}>();
    const finalConfirm=await app.inject({method:'POST',url:'/api/v1/admin/collection-filter/out-of-scope/confirm',headers,payload:{expectedCount:finalPlan.count,previewToken:finalPlan.token}});
    assert.equal(finalConfirm.statusCode,200,finalConfirm.body);assert.equal(finalConfirm.json<{changed:boolean}>().changed,false);
    assert.equal((await owner.query('SELECT id FROM publications WHERE id=ANY($1::uuid[])',[legacyKept])).rowCount,legacyKept.length,'unknown and more-specific KEEP survive confirmed screen purge for both F3 sources');
    assert.equal((await owner.query('SELECT 1 FROM collection_filter_discards WHERE archive_publication_id=ANY($1::uuid[])',[legacyKept])).rowCount,0);
  } finally {await app.close();await inspection.destroy();await owner.end();}
});
