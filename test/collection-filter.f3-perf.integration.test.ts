import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import test from 'node:test';
import {Pool} from 'pg';
import {Kysely,PostgresDialect} from 'kysely';
import {buildApp} from '../src/app.js';
import type {DB} from '../src/infrastructure/database/database.types.js';
import {withUserContext} from '../src/infrastructure/database/tenant-context.js';
import {candidates, type DirectRuleInput} from '../src/modules/collection/collection-filter.direct.js';

// This benchmark intentionally runs only against disposable CI PostgreSQL 18.
// Same archive fixture, same approved policy, identical rule and transaction
// semantics for both the original JS full scan and the optimized title precheck.
const url=process.env.DATABASE_ADMIN_URL;
if(!url)throw new Error('DATABASE_ADMIN_URL required (isolated PG18 only)');
const ROWS=6000, REPETITIONS=5;
const percentile=(xs:number[],p:number)=>{
  const sorted=[...xs].sort((a,b)=>a-b);
  return Math.round(sorted[Math.min(sorted.length-1,Math.ceil(p*sorted.length)-1)]!);
};

test('F3-PERF-02: paired p50/p95 and byte-exact plans for 0/10/100 percent candidate density',async()=>{
  const admin=new Pool({connectionString:url,max:1});
  const db=new Kysely<DB>({dialect:new PostgresDialect({pool:new Pool({connectionString:url,max:1})})});
  const app=await buildApp();
  const tag='X'+randomUUID().replaceAll('-','').slice(0,12).toUpperCase();
  const canonical='COMUNICADO PERF '+tag;
  const password='F3-Performance-Isolated-2026!';
  const table='pg_temp.f3_perf_ids';
  try{
    const email='f3-perf-'+tag.toLowerCase()+'@example.test';
    const registered=await app.inject({method:'POST',url:'/auth/register',payload:{
      name:'F3 Perf Isolated',email,company:'F3 Perf CI',password,
      confirmPassword:password,acceptedTerms:true,
    }});
    assert.equal(registered.statusCode,201,registered.body);
    const actor=registered.json<{user:{id:string}}>().user.id;
    await admin.query("INSERT INTO platform_user_roles(user_id,role,granted_by) VALUES($1,'PLATFORM_ADMIN','F3_PERF_CI')",[actor]);
    const p=await admin.query("SELECT id FROM collection_filter_policies WHERE status='APPROVED'");
    if(!p.rowCount)await admin.query(
      "INSERT INTO collection_filter_policies(version,status,approved_at,approved_by) VALUES(1,'APPROVED',now(),$1)",[actor]);
    const src=await admin.query<{id:string}>("SELECT id FROM sources WHERE code='dou' LIMIT 1");
    const sourceId=src.rows[0]?.id??(await admin.query<{id:string}>(
      "INSERT INTO sources(code,name,jurisdiction_level,base_url,connector_key) VALUES('dou','DOU perf','FEDERAL','https://in.gov.br','dou') RETURNING id")).rows[0]!.id;
    await admin.query(`CREATE TEMP TABLE f3_perf_ids(id uuid PRIMARY KEY,rn bigint NOT NULL)`);
    await admin.query(`INSERT INTO ${table} SELECT gen_random_uuid(),n FROM generate_series(1,${ROWS}) AS n`);
    await admin.query(`INSERT INTO public.publications(id,identity_hash,identity_strength,identity_basis,
      jurisdiction_level,act_type,title,primary_official_url)
      SELECT id,md5(id::text)||md5('f3perf'||id::text),'STRONG','{}'::jsonb,'FEDERAL',
      'COMUNICADO','PORTARIA TESTE Nº '||rn,'https://perf.example.test/'||id::text FROM ${table}`);
    await admin.query(`INSERT INTO public.publication_versions(publication_id,version_no,content_hash,
      content_text,is_current,source_metadata)
      SELECT id,1,md5(id::text)||md5('payload'||id::text),
      'Comunicado administrativo neutro sem crédito de tributos',true,
      jsonb_build_object('dou',jsonb_build_object('section','DO1','sourceActType','COMUNICADO'))
      FROM ${table}`);
    await admin.query(`INSERT INTO public.publication_origins(publication_id,source_id,official_url,metadata)
      SELECT id,$1,'https://perf.example.test/'||id::text,
      jsonb_build_object('dou',jsonb_build_object('section','DO1','sourceActType','COMUNICADO'))
      FROM ${table}`,[sourceId]);
    const results:Record<string,unknown>[]=[];
    for(const percent of [0,10,100]){
      await admin.query(`UPDATE public.publications p SET title=CASE
        WHEN b.rn<=${ROWS}*$1/100 THEN $2||' Nº '||b.rn
        ELSE 'PORTARIA TESTE Nº '||b.rn END
        FROM ${table} b WHERE p.id=b.id`,[percent,canonical]);
      for(const mode of ['EXCLUDE_ALWAYS','EXCLUDE_UNLESS_STRONG','KEEP_IF_TAX_TERM'] as const){
        const input:DirectRuleInput={sourceCode:'dou',section:'DO1',canonicalType:canonical,mode};
        const original:number[]=[],optimized:number[]=[];
        // Alternating order prevents warm-cache bias, no writes during pairing.
        for(let n=0;n<REPETITIONS;n++){
          const a=n%2===0?true:false;
          const run=async(disableTitlePrecheck:boolean)=>{
            const t0=performance.now();
            const plan=await withUserContext(db,actor,trx=>candidates(trx,input,{disableTitlePrecheck}));
            return {ms:performance.now()-t0,plan};
          };
          const first=await run(a),second=await run(!a);
          assert.deepEqual(first.plan,second.plan,
            'optimizing title precheck must never alter IDs, hashes, tokens or protection');
          const before=a?first:second,after=a?second:first;
          original.push(before.ms);optimized.push(after.ms);
        }
        results.push({mode,candidateDensityPercent:percent,publicationsFixture:ROWS,
          beforeP50Ms:percentile(original,.5),beforeP95Ms:percentile(original,.95),
          afterP50Ms:percentile(optimized,.5),afterP95Ms:percentile(optimized,.95),
          exactPlanMatch:true});
      }
    }
    console.log('F3_PERF_02_PAIRED_PG18='+JSON.stringify({synthetic:true,repetitions:REPETITIONS,
      fixtureCount:ROWS,results}));

    // Hot save: preview and save on the same backend instance.
    // Cold save: preview on a second independent instance; the first instance
    // has NO in-memory witness and must recompute the archive evidence.
    // Both paths must persist the rule but never delete any publication.
    const login=await app.inject({method:'POST',url:'/auth/login',
      payload:{email,password}});
    assert.equal(login.statusCode,200,login.body);
    const headers={authorization:'Bearer '+login.json<{accessToken:string}>().accessToken,
      'x-tenant-id':registered.json<{tenant:{id:string}}>().tenant.id};
    const coldApp=await buildApp();
    try{
      const times={hot:[] as number[],cold:[] as number[]};
      const saveRule:DirectRuleInput={
        sourceCode:'dou',section:'DO1',canonicalType:canonical,mode:'EXCLUDE_ALWAYS'};
      for(const scenario of ['hot','cold'] as const){
        for(let i=0;i<REPETITIONS;i++){
          const source=scenario==='hot'?app:coldApp;
          const preview=await source.inject({method:'POST',
            url:'/api/v1/admin/collection-filter/direct-rule/preview',
            headers,payload:saveRule});
          assert.equal(preview.statusCode,200,preview.body.slice(0,1200));
          const v=preview.json<{count:number;token:string;
            confirmationToken:string;policyRevision:number}>();
          const t0=performance.now();
          const save=await app.inject({method:'POST',
            url:'/api/v1/admin/collection-filter/direct-rule/save',headers,
            payload:{...saveRule,expectedCount:v.count,
              previewToken:v.token,confirmationToken:v.confirmationToken,
              policyRevision:v.policyRevision}});
          times[scenario].push(performance.now()-t0);
          assert.equal(save.statusCode,200,save.body.slice(0,1200));
          assert.equal(save.json<{deletedCount:number}>().deletedCount,0);
        }
      }
      const survived=await admin.query<{n:string}>(
        'SELECT count(*)::text AS n FROM public.publications p JOIN pg_temp.f3_perf_ids b ON b.id=p.id');
      assert.equal(Number(survived.rows[0]?.n),ROWS,'no benchmark publication may be deleted by save');
      console.log('F3_PERF_02_SAVE_PG18='+JSON.stringify({synthetic:true,fixtureCount:ROWS,
        repetitions:REPETITIONS,
        hotP50Ms:percentile(times.hot,.5),hotP95Ms:percentile(times.hot,.95),
        coldP50Ms:percentile(times.cold,.5),coldP95Ms:percentile(times.cold,.95),
        deletedCount:0}));
    }finally{await coldApp.close();}
  }finally{await db.destroy();await app.close();await admin.end();}
});
