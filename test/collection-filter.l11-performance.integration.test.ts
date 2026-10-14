import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { Pool } from 'pg';
import { buildApp } from '../src/app.js';

const databaseUrl=process.env.DATABASE_ADMIN_URL;
if (!databaseUrl) throw new Error('DATABASE_ADMIN_URL is required');
const ROWS=120_000;
const PASSWORD='Performance-L11-Isolated-2026!';

test('L-11: measure preview and confirm across 120k synthetic DOU publications in isolated PG18',async()=>{
  const admin=new Pool({connectionString:databaseUrl,max:1});
  const app=await buildApp();
  const tag=randomUUID().replaceAll('-','').slice(0,12).toUpperCase();
  const canonicalType='COMUNICADO PERFORMANCE '+tag;
  let previewMs:number|null=null,confirmMs:number|null=null;
  try {
    const email='l11-benchmark-'+tag.toLowerCase()+'@example.test';
    const register=await app.inject({method:'POST',url:'/auth/register',payload:{
      name:'Admin L11 Benchmark',email,company:'L11 Benchmark',
      password:PASSWORD,confirmPassword:PASSWORD,acceptedTerms:true,
    }});
    assert.equal(register.statusCode,201,register.body);
    const registration=register.json<{user:{id:string};tenant:{id:string}}>();
    const login=await app.inject({method:'POST',url:'/auth/login',payload:{email,password:PASSWORD}});
    assert.equal(login.statusCode,200,login.body);
    const headers={
      authorization:'Bearer '+login.json<{accessToken:string}>().accessToken,
      'x-tenant-id':registration.tenant.id,
    };
    await admin.query(
      "INSERT INTO platform_user_roles(user_id,role,granted_by) VALUES($1,'PLATFORM_ADMIN','l11-benchmark')",
      [registration.user.id],
    );
    const source=await admin.query<{id:string}>("SELECT id FROM sources WHERE code='dou' LIMIT 1");
    const sourceId=source.rows[0]?.id ?? (await admin.query<{id:string}>(
      "INSERT INTO sources(code,name,jurisdiction_level,base_url,connector_key) "+
      "VALUES('dou','DOU Benchmark','FEDERAL','https://in.gov.br','dou') RETURNING id"
    )).rows[0]!.id;
    const t0=performance.now();
    await admin.query('CREATE TEMP TABLE l11_benchmark_ids (id uuid NOT NULL PRIMARY KEY)');
    await admin.query(
      'INSERT INTO l11_benchmark_ids(id) SELECT gen_random_uuid() FROM generate_series(1,$1)',
      [ROWS],
    );
    await admin.query(
      `INSERT INTO publications(
        id,identity_hash,identity_strength,identity_basis,jurisdiction_level,
        act_type,title,primary_official_url
      ) SELECT id,md5(id::text)||md5('l11'||id::text),'STRONG','{}'::jsonb,'FEDERAL',
        CASE WHEN rn % 10 = 0 THEN $1 ELSE 'OUTRO TIPO DOU' END,
        'Documento administrativo de teste de desempenho',
        'https://bench.example.test/'||id::text
      FROM (SELECT id,ROW_NUMBER() OVER (ORDER BY id) AS rn FROM l11_benchmark_ids) base`,
      [canonicalType],
    );
    await admin.query(
      `INSERT INTO publication_versions(
        publication_id,version_no,content_hash,content_text,is_current,source_metadata
      ) SELECT p.id,1,md5('content'||p.id::text)||md5('hash'||p.id::text),
        'Aviso administrativo genérico sem matéria tributária',
        true,jsonb_build_object('dou',jsonb_build_object('section','DO1','sourceActType',p.act_type))
      FROM l11_benchmark_ids b JOIN publications p ON p.id=b.id`,
    );
    await admin.query(
      `INSERT INTO publication_origins(publication_id,source_id,official_url,metadata)
      SELECT p.id,$1,'https://bench.example.test/'||p.id::text,
        jsonb_build_object('dou',jsonb_build_object('section','DO1','sourceActType',p.act_type))
      FROM l11_benchmark_ids b JOIN publications p ON p.id=b.id`,[sourceId],
    );
    const count=await admin.query<{count:string}>('SELECT count(*)::text AS count FROM l11_benchmark_ids');
    assert.equal(Number(count.rows[0]?.count),ROWS);
    const subset=await admin.query<{count:string}>("SELECT count(*)::text AS count FROM publications WHERE act_type=$1",[canonicalType]);
    assert.equal(Number(subset.rows[0]?.count),ROWS/10);
    const seedMs=Math.round(performance.now()-t0);

    const rule={sourceCode:'dou',section:'DO1',canonicalType,mode:'KEEP_ALWAYS'};
    const startedPreview=performance.now();
    const preview=await app.inject({method:'POST',
      url:'/api/v1/admin/collection-filter/direct-rule/preview',headers,payload:rule});
    previewMs=Math.round(performance.now()-startedPreview);
    assert.equal(preview.statusCode,200,preview.body.slice(0,1500));
    const info=preview.json<{count:number;blockedCompany:number;blockedOtherSource:number;token:string;confirmationToken:string;policyRevision:number}>();
    assert.equal(info.count,0,'KEEP_ALWAYS must not physically purge benchmark acts');
    assert.match(info.token,/^[a-f0-9]{64}$/);

    const startedConfirm=performance.now();
    const confirm=await app.inject({method:'POST',
      url:'/api/v1/admin/collection-filter/direct-rule/confirm',headers,
      payload:{...rule,expectedCount:info.count,previewToken:info.token,confirmationToken:info.confirmationToken,policyRevision:info.policyRevision}});
    confirmMs=Math.round(performance.now()-startedConfirm);
    assert.equal(confirm.statusCode,200,confirm.body.slice(0,1500));
    assert.equal(confirm.json<{deletedCount:number}>().deletedCount,0);

    // Timings include scanning 120k acts for both operations, but not physical
    // deletion of 120k rows (deliberately not exercised by KEEP_ALWAYS).
    console.log('L11_PERFORMANCE='+JSON.stringify({
      publications:ROWS,matching:ROWS/10,matchingPercent:10,synthetic:true,mode:'KEEP_ALWAYS',
      seedMs,previewMs,confirmMs,limitMs:60000,
      previewOver60s:previewMs>60000,
      confirmOver60s:confirmMs>60000,
      destructivePurgeBenchmarked:false,
    }));
  } finally {
    await app.close();
    await admin.end();
  }
});
