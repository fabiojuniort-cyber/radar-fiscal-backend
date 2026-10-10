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
  return {id:data.user.id,headers:{authorization:'Bearer '+token,'x-tenant-id':data.tenant.id}};
}

test('L-11: PLATFORM_ADMIN applies DOU rule and physically purges unlinked act with audit',async()=>{
  const admin=new Pool({connectionString:url,max:1});
  const app=await buildApp();
  let pubId:string|null=null;
  let canonicalType:string|null=null;
  try {
    const owner=await account(app,'owner');
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
      [identifier,canonicalType,'Publicação descartável teste L11','https://example.test/'+identifier],
    );
    pubId=inserted.rows[0]!.id;
    await admin.query(
      "INSERT INTO publication_versions(publication_id,version_no,content_hash,content_text,is_current,source_metadata) "+
      "VALUES($1,1,$2,'Documento administrativo não tributário',true,$3::jsonb)",
      [pubId,createHash('sha256').update('body '+pubId).digest('hex'),JSON.stringify({dou:{section:'DO1'}})],
    );
    await admin.query(
      "INSERT INTO publication_origins(publication_id,source_id,official_url,metadata) "+
      "VALUES($1,$2,$3,$4::jsonb)",
      [pubId,sourceId,'https://example.test/'+identifier,JSON.stringify({dou:{section:'DO1'}})],
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
    const count=preview.json<{count:number;blockedCompany:number;token:string}>();
    assert.equal(count.count,1);
    assert.equal(count.blockedCompany,0);
    assert.match(count.token,/^[a-f0-9]{64}$/);

    const confirm=await app.inject({method:'POST',
      url:'/api/v1/admin/collection-filter/direct-rule/confirm',
      headers:owner.headers,payload:{...payload,expectedCount:count.count,previewToken:count.token}});
    assert.equal(confirm.statusCode,200,confirm.body);
    assert.equal(confirm.json<{deletedCount:number}>().deletedCount,1);
    const actual=await admin.query("SELECT id FROM publications WHERE id=$1",[pubId]);
    assert.equal(actual.rowCount,0,'document must be physically gone');
    const audit=await admin.query<{after_data:{deletedIds:string[];deletedCount:number}}>(
      "SELECT after_data FROM audit_log WHERE action='COLLECTION_FILTER_DIRECT_PURGE' "+
      "AND after_data->'deletedIds' @> $1::jsonb ORDER BY occurred_at DESC LIMIT 1",
      [JSON.stringify([pubId])],
    );
    assert.equal(audit.rows[0]?.after_data.deletedCount,1);
    assert.deepEqual(audit.rows[0]?.after_data.deletedIds,[pubId]);

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
    await app.close();
    await admin.end();
  }
});
