import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { Pool } from 'pg';
import { buildApp } from '../src/app.js';

const databaseUrl = process.env.DATABASE_ADMIN_URL;
if (!databaseUrl) throw new Error('DATABASE_ADMIN_URL required: isolated PG18 only');

test('L11: 520 DOU acts in bounded steps, drift, resume and per-step audit', async () => {
  const pool = new Pool({connectionString:databaseUrl,max:1});
  const app = await buildApp();
  const tag = randomUUID().slice(0,8).toUpperCase();
  const type = 'AVISO DE LICITACAO PREGAO STAGED '+tag;
  const ids:string[] = [];
  let adminId:string|null = null;
  try {
    const email='l11-staged-'+tag.toLowerCase()+'@example.test';
    const password='Stage-Confirm-2026!Safe';
    const registration=await app.inject({method:'POST',url:'/auth/register',payload:{
      name:'L11 Staged Tester',email,company:'L11 Staged Tester',
      password,confirmPassword:password,acceptedTerms:true,
    }});
    assert.equal(registration.statusCode,201,registration.body);
    const registered=registration.json<{user:{id:string};tenant:{id:string}}>();
    adminId=registered.user.id;
    const login=await app.inject({method:'POST',url:'/auth/login',payload:{email,password}});
    assert.equal(login.statusCode,200,login.body);
    const headers={authorization:'Bearer '+login.json<{accessToken:string}>().accessToken,
      'x-tenant-id':registered.tenant.id};
    await pool.query("INSERT INTO platform_user_roles(user_id,role,granted_by) VALUES($1,'PLATFORM_ADMIN','l11-staged')",[adminId]);
    const hasPolicy=await pool.query("SELECT id FROM collection_filter_policies WHERE status='APPROVED' LIMIT 1");
    if (!hasPolicy.rows.length) {
      await pool.query("INSERT INTO collection_filter_policies(version,status,approved_at,approved_by) "+
        "SELECT COALESCE(max(version),0)+1,'APPROVED',now(),$1 FROM collection_filter_policies",[adminId]);
    }
    const src=await pool.query<{id:string}>("SELECT id FROM sources WHERE code='dou' LIMIT 1");
    const sourceId=src.rows[0]?.id ?? (await pool.query<{id:string}>(
      "INSERT INTO sources(code,name,jurisdiction_level,base_url,connector_key) "+
      "VALUES('dou','DOU L11 staged','FEDERAL','https://in.gov.br','dou') RETURNING id"
    )).rows[0]!.id;

    const insertActs = async (amount:number) => {
      const rows=await pool.query<{id:string}>(
        "INSERT INTO publications(identity_hash,identity_strength,identity_basis,jurisdiction_level,act_type,title,primary_official_url) "+
        "SELECT md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text),'STRONG','{}'::jsonb,'FEDERAL',$1,"+
        "'Aviso de licitação administrativo','https://example.test/l11-staged/'||gen_random_uuid()::text "+
        "FROM generate_series(1,$2) RETURNING id",[type,amount]);
      const newIds=rows.rows.map(r=>r.id);ids.push(...newIds);
      await pool.query(
        "INSERT INTO publication_versions(publication_id,version_no,content_hash,content_text,is_current,source_metadata) "+
        "SELECT p.id,1,md5(p.id::text)||md5('content'||p.id::text),"+
        "'Procedimento administrativo sem tributos',true,'{\"dou\":{\"section\":\"DO3\"}}'::jsonb "+
        "FROM publications p WHERE p.id=ANY($1::uuid[])",[newIds]);
      await pool.query(
        "INSERT INTO publication_origins(publication_id,source_id,official_url,metadata) "+
        "SELECT p.id,$2,'https://example.test/l11-staged/'||p.id::text,'{\"dou\":{\"section\":\"DO3\"}}'::jsonb "+
        "FROM publications p WHERE p.id=ANY($1::uuid[])",[newIds,sourceId]);
    };
    await insertActs(520);
    const rule={sourceCode:'dou',section:'DO3',canonicalType:type,mode:'EXCLUDE_ALWAYS'};
    const preview=async()=>{
      const res=await app.inject({method:'POST',url:'/api/v1/admin/collection-filter/direct-rule/preview',
        headers,payload:rule});
      assert.equal(res.statusCode,200,res.body);
      return res.json<{count:number;token:string}>();
    };
    const confirm=async(p:{count:number;token:string},resume:boolean)=>{
      const start=performance.now();
      const res=await app.inject({method:'POST',url:'/api/v1/admin/collection-filter/direct-rule/confirm',
        headers,payload:{...rule,expectedCount:p.count,previewToken:p.token,resume}});
      const ms=performance.now()-start;
      assert.equal(res.statusCode,200,res.body);
      assert.ok(ms<30000,'each step must respond below 30s, measured '+ms);
      return {result:res.json<{changed:boolean;apagadas:number;restantes:number;revision:number;count?:number}>(),
        ms:Math.round(ms)};
    };

    let count=await preview();assert.equal(count.count,520);
    const times:number[]=[];
    const first=await confirm(count,false);
    assert.equal(first.result.changed,false);
    assert.ok(first.result.apagadas>=1 && first.result.apagadas<=500);
    assert.equal(first.result.restantes,520-first.result.apagadas);
    times.push(first.ms);
    let total=first.result.apagadas;
    await insertActs(1);
    // The old preview count/token must be rejected without further deletion.
    const stale=await confirm(count,true);
    assert.equal(stale.result.changed,true);
    assert.equal(stale.result.apagadas,0);
    assert.equal(stale.result.count,521-total);
    while (true) {
      count=await preview();
      if(count.count===0)break;
      const stage=await confirm(count,true);
      assert.equal(stage.result.changed,false);
      assert.ok(stage.result.apagadas>0 && stage.result.apagadas<=500);
      assert.equal(stage.result.restantes,count.count-stage.result.apagadas);
      total+=stage.result.apagadas;times.push(stage.ms);
    }
    assert.equal(total,521);
    assert.equal((await pool.query('SELECT id FROM publications WHERE id=ANY($1::uuid[])',[ids])).rowCount,0);
    const audit=await pool.query<{n:string;deleted:string}>(
      "SELECT count(*)::text AS n,COALESCE(sum((after_data->>'deletedCount')::int),0)::text AS deleted "+
      "FROM audit_log WHERE action='COLLECTION_FILTER_DIRECT_PURGE' AND after_data->>'canonicalType'=$1",[type]);
    assert.equal(Number(audit.rows[0]?.deleted),521);
    assert.ok(Number(audit.rows[0]?.n)>=times.length);
    console.log('L11_STAGED_TIMINGS='+JSON.stringify({synthetic:true,total,perStepMs:times,maxPerCall:500}));
  } finally {
    if(ids.length) {
      await pool.query('DELETE FROM publication_origins WHERE publication_id=ANY($1::uuid[])',[ids]);
      await pool.query('DELETE FROM publication_versions WHERE publication_id=ANY($1::uuid[])',[ids]);
      await pool.query('DELETE FROM publications WHERE id=ANY($1::uuid[])',[ids]);
    }
    await pool.query('DELETE FROM collection_filter_type_rules WHERE canonical_type=$1',[type]);
    if(adminId)await pool.query("UPDATE platform_user_roles SET revoked_at=COALESCE(revoked_at,now()),revoked_by='l11-staged-cleanup' WHERE user_id=$1 AND revoked_at IS NULL",[adminId]);
    await app.close();await pool.end();
  }
});
