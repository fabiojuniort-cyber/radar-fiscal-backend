import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

const url=process.env.DATABASE_ADMIN_URL;
if (!url) throw new Error('DATABASE_ADMIN_URL is required');
const PASSWORD='Collection-Filter-Seguro-2026!';

async function account(app:FastifyInstance, prefix:string) {
  const email='l11-'+prefix+'-'+randomUUID().slice(0,8)+'@example.test';
  const reg=await app.inject({method:'POST',url:'/auth/register',payload:{
    name:'Filter '+prefix,email,company:'Filter '+prefix,
    password:PASSWORD,confirmPassword:PASSWORD,acceptedTerms:true,
  }});
  assert.equal(reg.statusCode,201,reg.body);
  const data=reg.json<{user:{id:string};tenant:{id:string}}>();
  const login=await app.inject({method:'POST',url:'/auth/login',payload:{email,password:PASSWORD}});
  assert.equal(login.statusCode,200,login.body);
  const token=login.json<{accessToken:string}>().accessToken;
  return {id:data.user.id,tenantId:data.tenant.id,headers:{authorization:'Bearer '+token,'x-tenant-id':data.tenant.id}};
}

test('L-11: PLATFORM_ADMIN applies DOU rule and physically purges unlinked act with audit',async()=>{
  const admin=new Pool({connectionString:url,max:1});
  const app=await buildApp();
  let pubId:string|null=null;
  let canonicalType:string|null=null;
  let ownerId:string|null=null;
  try {
    const owner=await account(app,'owner');
    ownerId=owner.id;
    const ordinary=await account(app,'ordinary');
    await admin.query(
      "INSERT INTO platform_user_roles(user_id,role,granted_by) VALUES($1,'PLATFORM_ADMIN','l11-integration')",
      [owner.id],
    );
    const existing=await admin.query<{id:string}>(
      "SELECT id FROM collection_filter_policies WHERE status='APPROVED' LIMIT 1"
    );
    if (!existing.rows.length) {
      await admin.query(
        "INSERT INTO collection_filter_policies(version,status,approved_at,approved_by) "+
        "SELECT COALESCE(max(version),0)+1,'APPROVED',now(),$1 FROM collection_filter_policies",
        [owner.id],
      );
    }
    const source=await admin.query<{id:string}>(
      "SELECT id FROM sources WHERE code='dou' LIMIT 1"
    );
    const sourceId=source.rows[0]?.id ??
      (await admin.query<{id:string}>(
        "INSERT INTO sources(code,name,jurisdiction_level,base_url,connector_key) "+
        "VALUES('dou','Diário Oficial','FEDERAL','https://in.gov.br','dou') RETURNING id"
      )).rows[0]!.id;
    canonicalType='AVISO L11 '+randomUUID().slice(0,8).toUpperCase();
    const identifier=createHash('sha256').update(randomUUID()).digest('hex');
    const inserted=await admin.query<{id:string}>(
      "INSERT INTO publications(identity_hash,identity_strength,identity_basis,jurisdiction_level,"+
      "act_type,title,primary_official_url) VALUES($1,'STRONG','{}'::jsonb,'FEDERAL',$2,$3,$4) RETURNING id",
      [identifier,canonicalType,canonicalType+' — Publicação descartável teste L11','https://example.test/'+identifier],
    );
    pubId=inserted.rows[0]!.id;
    const version=await admin.query<{id:string}>(
      "INSERT INTO publication_versions(publication_id,version_no,content_hash,content_text,is_current,source_metadata) "+
      "VALUES($1,1,$2,'Documento administrativo não tributário',true,$3::jsonb) RETURNING id",
      [pubId,createHash('sha256').update('body '+pubId).digest('hex'),JSON.stringify({dou:{section:'DO1',sourceActType:canonicalType}})],
    );
    const versionId=version.rows[0]!.id;
    const mention=await admin.query<{id:string}>(
      "INSERT INTO publication_ncm_mentions(publication_version_id,ncm_code,method_type,detector_key,detector_version) "+
      "VALUES($1,'00000000','RULE','l11-integration','1') RETURNING id",
      [versionId],
    );
    // TAX07/TAX08 append-only evidence attached only to this publication.
    const release=await admin.query<{id:string}>(
      "INSERT INTO taxonomy_releases(version_major,version_minor,version_patch,status,approved_at,"+
      "published_at,artifact_repository,artifact_path,artifact_git_sha,artifact_sha256,created_by_actor) "+
      "VALUES($1,0,0,'PUBLISHED',now(),now(),'l11-test','l11-fixture',$2,$3,'l11-test') RETURNING id",
      [Math.floor(Math.random()*1000000)+1000,'a'.repeat(40),'b'.repeat(64)],
    );
    const fingerprint=createHash('sha256').update(randomUUID()).digest('hex');
    const taxRun=await admin.query<{id:string}>(
      "INSERT INTO publication_taxonomy_runs(publication_version_id,taxonomy_release_id,method_type,"+
      "engine_key,engine_version,config_sha256,input_sha256,run_fingerprint) "+
      "VALUES($1,$2,'RULE','l11-test','1',$3,$4,$5) RETURNING id",
      [versionId,release.rows[0]!.id,'a'.repeat(64),'b'.repeat(64),fingerprint],
    );
    const unmapped=await admin.query<{id:string}>(
      "INSERT INTO taxonomy_unmapped_occurrences(run_id,raw_term,normalized_term,"+
      "extractor_key,extractor_version,occurrence_fingerprint) "+
      "VALUES($1,'conceito exclusivo','CONCEITO EXCLUSIVO','l11','1',$2) RETURNING id",
      [taxRun.rows[0]!.id,createHash('sha256').update(randomUUID()).digest('hex')],
    );
    const candidate=await admin.query<{id:string}>(
      "INSERT INTO taxonomy_candidates(preferred_term,normalized_key,context_signature,candidate_fingerprint) "+
      "VALUES('Conceito L11','CONCEITO L11',$1,$2) RETURNING id",
      [createHash('sha256').update(randomUUID()).digest('hex'),
       createHash('sha256').update(randomUUID()).digest('hex')],
    );
    const link=await admin.query<{id:string}>(
      "INSERT INTO taxonomy_candidate_occurrence_links(candidate_id,occurrence_id) "+
      "VALUES($1,$2) RETURNING id",
      [candidate.rows[0]!.id,unmapped.rows[0]!.id],
    );
    await admin.query(
      "INSERT INTO publication_origins(publication_id,source_id,official_url,metadata) "+
      "VALUES($1,$2,$3,$4::jsonb)",
      [pubId,sourceId,'https://example.test/'+identifier,JSON.stringify({dou:{section:'DO1',sourceActType:canonicalType}})],
    );

    // Suppressed scope history is append-only and RESTRICT-bound. The L-11
    // purge must remove this publication-owned event, not weaken other FKs.
    const scopeEvent=await admin.query<{id:string}>(
      "INSERT INTO publication_scope_events(publication_id,operation_id,action,"+
      "previous_scope,new_scope,policy_key,reason_code,rule_version,"+
      "evidence_sha256,actor_ref) "+
      "VALUES($1,$2,'SUPPRESS','IN_SCOPE','OUT_OF_SCOPE','L11_TEST',"+
      "'EXCLUDED_DOU','1',$3,'l11-test') RETURNING id",
      [pubId,randomUUID(),createHash('sha256').update('scope '+pubId).digest('hex')],
    );
    await admin.query(
      "INSERT INTO publication_scope_state(publication_id,scope,current_event_id,"+
      "policy_key,evidence_sha256) VALUES($1,'OUT_OF_SCOPE',$2,'L11_TEST',$3)",
      [pubId,scopeEvent.rows[0]!.id,createHash('sha256').update('scope '+pubId).digest('hex')],
    );

    // A publication already linked to a customer must stay intact, including
    // its match history. It is counted separately from physical deletions.
    const secondHash=createHash('sha256').update(randomUUID()).digest('hex');
    const protectedPublication=await admin.query<{id:string}>(
      "INSERT INTO publications(identity_hash,identity_strength,identity_basis,jurisdiction_level,"+
      "act_type,title,primary_official_url) VALUES($1,'STRONG','{}'::jsonb,'FEDERAL',$2,$3,$4) RETURNING id",
      [secondHash,canonicalType,canonicalType+' — Publicação vinculada a cliente','https://example.test/'+secondHash],
    );
    const protectedId=protectedPublication.rows[0]!.id;
    await admin.query(
      "INSERT INTO publication_versions(publication_id,version_no,content_hash,content_text,is_current,source_metadata) "+
      "VALUES($1,1,$2,'Documento administrativo neutro',true,$3::jsonb)",
      [protectedId,createHash('sha256').update('protected '+protectedId).digest('hex'),
       JSON.stringify({dou:{section:'DO1',sourceActType:canonicalType}})],
    );
    await admin.query(
      "INSERT INTO publication_origins(publication_id,source_id,official_url,metadata) "+
      "VALUES($1,$2,$3,$4::jsonb)",
      [protectedId,sourceId,'https://example.test/'+secondHash,JSON.stringify({dou:{section:'DO1',sourceActType:canonicalType}})],
    );
    const company=await admin.query<{id:string}>(
      "INSERT INTO companies(tenant_id,legal_name,head_office_cnpj) "+
      "VALUES($1,'Cliente protegido',$2) RETURNING id",
      [owner.tenantId,'12'+Math.floor(Math.random()*1e12).toString().padStart(12,'0')],
    );
    const linked=await admin.query<{id:string}>(
      "INSERT INTO company_publications(company_id,publication_id) VALUES($1,$2) RETURNING id",
      [company.rows[0]!.id,protectedId],
    );
    const profile=await admin.query<{id:string}>(
      "INSERT INTO monitoring_profiles(company_id,name) VALUES($1,'L11 proteção') RETURNING id",
      [company.rows[0]!.id],
    );
    await admin.query(
      "INSERT INTO publication_matches(company_publication_id,monitoring_profile_id,profile_version,rule_engine_version) VALUES($1,$2,1,'l11-test')",
      [linked.rows[0]!.id,profile.rows[0]!.id],
    );

    // A single publication can also be known to other official sources.
    // DOU-specific filtering must not destroy these non-DOU origins.
    const otherCode='l11-'+randomUUID().slice(0,9);
    const other=await admin.query<{id:string}>(
      "INSERT INTO sources(code,name,jurisdiction_level,base_url,connector_key) "+
      "VALUES($1,'L11 Outra Fonte','FEDERAL','https://other.example.test',$1) RETURNING id",[otherCode],
    );
    const sharedHash=createHash('sha256').update(randomUUID()).digest('hex');
    const shared=await admin.query<{id:string}>(
      "INSERT INTO publications(identity_hash,identity_strength,identity_basis,jurisdiction_level,"+
      "act_type,title,primary_official_url) VALUES($1,'STRONG','{}'::jsonb,'FEDERAL',$2,$3,$4) RETURNING id",
      [sharedHash,canonicalType,canonicalType+' — Ato DOU compartilhado','https://example.test/'+sharedHash],
    );
    const sharedId=shared.rows[0]!.id;
    await admin.query(
      "INSERT INTO publication_versions(publication_id,version_no,content_hash,content_text,is_current,source_metadata) "+
      "VALUES($1,1,$2,'Aviso administrativo neutro',true,$3::jsonb)",
      [sharedId,createHash('sha256').update('shared '+sharedId).digest('hex'),
        JSON.stringify({dou:{section:'DO1',sourceActType:canonicalType}})],
    );
    await admin.query(
      "INSERT INTO publication_origins(publication_id,source_id,official_url,metadata) VALUES "+
      "($1,$2,$4,$5::jsonb),($1,$3,$6,'{}'::jsonb)",
      [sharedId,sourceId,other.rows[0]!.id,
       'https://example.test/'+sharedHash,JSON.stringify({dou:{section:'DO1',sourceActType:canonicalType}}),
       'https://other.example.test/'+sharedHash],
    );

    const payload={sourceCode:'dou',section:'DO1',canonicalType,mode:'EXCLUDE_ALWAYS'};
    const denied=await app.inject({method:'POST',
      url:'/api/v1/admin/collection-filter/direct-rule/preview',
      headers:ordinary.headers,payload});
    assert.equal(denied.statusCode,403,denied.body);
    const preview=await app.inject({method:'POST',
      url:'/api/v1/admin/collection-filter/direct-rule/preview',
      headers:owner.headers,payload});
    assert.equal(preview.statusCode,200,preview.body);
    const count=preview.json<{count:number;blockedCompany:number;blockedOtherSource:number;token:string;confirmationToken:string;policyRevision:number}>();
    assert.equal(count.count,1);
    assert.equal(count.blockedCompany,1);
    assert.equal(count.blockedOtherSource,1);
    assert.match(count.token,/^[a-f0-9]{64}$/);

    // The archive changed after preview: no deletion or rule update may occur
    // until PLATFORM_ADMIN explicitly confirms the newly calculated count.
    const addedHash=createHash('sha256').update(randomUUID()).digest('hex');
    const added=await admin.query<{id:string}>(
      "INSERT INTO publications(identity_hash,identity_strength,identity_basis,jurisdiction_level,"+
      "act_type,title,primary_official_url) VALUES($1,'STRONG','{}'::jsonb,'FEDERAL',$2,$3,$4) RETURNING id",
      [addedHash,canonicalType,canonicalType+' — Segundo ato descartável','https://example.test/'+addedHash],
    );
    const addedId=added.rows[0]!.id;
    await admin.query(
      "INSERT INTO publication_versions(publication_id,version_no,content_hash,content_text,is_current,source_metadata) "+
      "VALUES($1,1,$2,'Novo documento administrativo sem tema tributário',true,$3::jsonb)",
      [addedId,createHash('sha256').update('body '+addedId).digest('hex'),
       JSON.stringify({dou:{section:'DO1',sourceActType:canonicalType}})],
    );
    await admin.query(
      "INSERT INTO publication_origins(publication_id,source_id,official_url,metadata) "+
      "VALUES($1,$2,$3,$4::jsonb)",
      [addedId,sourceId,'https://example.test/'+addedHash,JSON.stringify({dou:{section:'DO1',sourceActType:canonicalType}})],
    );

    const stale=await app.inject({method:'POST',
      url:'/api/v1/admin/collection-filter/direct-rule/confirm',
      headers:owner.headers,payload:{...payload,expectedCount:count.count,previewToken:count.token,confirmationToken:count.confirmationToken,policyRevision:count.policyRevision}});
    assert.equal(stale.statusCode,409,stale.body);
    assert.equal(stale.json<{error:string}>().error,'f3_confirmation_token_stale_or_policy_revision_changed');
    // Candidate drift invalidates the revision-bound v2 capability. No deletion.
    assert.equal((await admin.query('SELECT id FROM publications WHERE id=$1',[pubId])).rowCount,1);

    const fresh=await app.inject({method:'POST',
      url:'/api/v1/admin/collection-filter/direct-rule/preview',
      headers:owner.headers,payload});
    assert.equal(fresh.statusCode,200,fresh.body);
    const approved=fresh.json<{count:number;token:string;confirmationToken:string;policyRevision:number}>();
    assert.equal(approved.count,2);

    const confirm=await app.inject({method:'POST',
      url:'/api/v1/admin/collection-filter/direct-rule/confirm',
      headers:owner.headers,payload:{...payload,expectedCount:approved.count,previewToken:approved.token,confirmationToken:approved.confirmationToken,policyRevision:approved.policyRevision}});
    assert.equal(confirm.statusCode,200,confirm.body);
    assert.equal(confirm.json<{deletedCount:number}>().deletedCount,2);
    const actual=await admin.query("SELECT id FROM publications WHERE id=$1",[pubId]);
    assert.equal(actual.rowCount,0,'document must be physically gone');

    for(const table of ['publication_scope_state','publication_scope_events',
      'publication_versions','publication_origins']){
      assert.equal((await admin.query(
        'SELECT 1 FROM '+table+' WHERE publication_id=$1',[pubId],
      )).rowCount,0,table+' must be removed with discarded publication');
    }

    assert.equal((await admin.query('SELECT id FROM publications WHERE id=$1',[addedId])).rowCount,0);
    for(const [table,id] of [
      ['publication_ncm_mentions',mention.rows[0]!.id],
      ['publication_taxonomy_runs',taxRun.rows[0]!.id],
      ['taxonomy_unmapped_occurrences',unmapped.rows[0]!.id],
      ['taxonomy_candidate_occurrence_links',link.rows[0]!.id],
    ]) {
      assert.equal((await admin.query('SELECT 1 FROM '+table+' WHERE id=$1',[id])).rowCount,0,
        'exclusive taxonomy/NCM evidence should be deleted: '+table);
    }

    const protectedRow=await admin.query(
      "SELECT id FROM publications WHERE id=$1",[protectedId],
    );
    assert.equal(protectedRow.rowCount,1,'customer-linked act must be kept');
    assert.equal((await admin.query("SELECT 1 FROM publication_matches WHERE company_publication_id=$1",
      [linked.rows[0]!.id])).rowCount,1,'client matches must remain');
    assert.equal((await admin.query("SELECT 1 FROM publications WHERE id=$1",
      [sharedId])).rowCount,1,'cross-source publication must remain');
    assert.equal((await admin.query("SELECT 1 FROM publication_origins WHERE publication_id=$1",
      [sharedId])).rowCount,2,'both official origins must remain');
    const audit=await admin.query<{after_data:{deletedIds:string[];deletedCount:number}}>(
      "SELECT after_data FROM audit_log WHERE action='COLLECTION_FILTER_DIRECT_PURGE' "+
      "AND after_data->'deletedIds' @> $1::jsonb ORDER BY occurred_at DESC LIMIT 1",
      [JSON.stringify([pubId])],
    );
    assert.equal(audit.rows[0]?.after_data.deletedCount,2);
    assert.deepEqual(new Set(audit.rows[0]?.after_data.deletedIds),new Set([pubId,addedId]));

    const noDeleteRule={...payload,mode:'KEEP_ALWAYS'};
    const noDeletePreview=await app.inject({method:'POST',
      url:'/api/v1/admin/collection-filter/direct-rule/preview',
      headers:owner.headers,payload:noDeleteRule});
    assert.equal(noDeletePreview.statusCode,200,noDeletePreview.body);
    const zero=noDeletePreview.json<{count:number;token:string;confirmationToken:string;policyRevision:number}>();
    assert.equal(zero.count,0);
    const noDeleteConfirm=await app.inject({method:'POST',
      url:'/api/v1/admin/collection-filter/direct-rule/confirm',
      headers:owner.headers,
      payload:{...noDeleteRule,expectedCount:zero.count,previewToken:zero.token,confirmationToken:zero.confirmationToken,policyRevision:zero.policyRevision}});
    assert.equal(noDeleteConfirm.statusCode,200,noDeleteConfirm.body);
    assert.equal(noDeleteConfirm.json<{deletedCount:number}>().deletedCount,0);
    const zeroAudit=await admin.query<{after_data:{deletedIds:string[];deletedCount:number}}>(
      "SELECT after_data FROM audit_log WHERE action='COLLECTION_FILTER_DIRECT_PURGE' "+
      "AND after_data->>'canonicalType'=$1 AND after_data->>'deletedCount'='0' "+
      "ORDER BY occurred_at DESC LIMIT 1",[canonicalType]);
    assert.equal(zeroAudit.rows[0]?.after_data.deletedCount,0);
    assert.deepEqual(zeroAudit.rows[0]?.after_data.deletedIds,[]);
    const removed=await admin.query<{sim: string|null; fn:string|null}>(
      "SELECT to_regclass('public.collection_filter_simulation_items')::text AS sim,"+
      "to_regprocedure('public.collection_filter_approve_draft(uuid)')::text AS fn"
    );
    assert.equal(removed.rows[0]?.sim,null);
    assert.equal(removed.rows[0]?.fn,null);
  } finally {
    if (canonicalType) {
      await admin.query("DELETE FROM collection_filter_type_rules WHERE canonical_type=$1",[canonicalType]);
    }
    if (ownerId) {
      // Avoid contaminating later last-PLATFORM_ADMIN authorization tests.
      await admin.query(
        "UPDATE platform_user_roles SET revoked_at=COALESCE(revoked_at,now()), "+
        "revoked_by=COALESCE(revoked_by,'l11-integration-cleanup') "+
        "WHERE user_id=$1 AND revoked_at IS NULL",
        [ownerId],
      );
    }
    await app.close();
    await admin.end();
  }
});
