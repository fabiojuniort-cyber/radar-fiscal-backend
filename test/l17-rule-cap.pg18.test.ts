import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {Pool} from 'pg';
import {buildApp} from '../src/app.js';

const url=process.env.DATABASE_ADMIN_URL;
if(!url)throw new Error('DATABASE_ADMIN_URL required for PG18');
const password='L17-Pg18-Stress-Security!';

export async function runL17RuleCapStress():Promise<void>{
  const admin=new Pool({connectionString:url,max:1});
  const app=await buildApp();
  const label=randomUUID().slice(0,10);
  try{
    const email='l17-perf-'+label+'@example.test';
    const reg=await app.inject({method:'POST',url:'/auth/register',payload:{
      name:'L17 stress admin',email,company:'L17 isolated',
      password,confirmPassword:password,acceptedTerms:true}});
    assert.equal(reg.statusCode,201,reg.body);
    const user=reg.json<{user:{id:string};tenant:{id:string}}>();
    const login=await app.inject({method:'POST',url:'/auth/login',payload:{email,password}});
    assert.equal(login.statusCode,200,login.body);
    const headers={authorization:'Bearer '+login.json<{accessToken:string}>().accessToken,
      'x-tenant-id':user.tenant.id};
    await admin.query("INSERT INTO platform_user_roles(user_id,role,granted_by) VALUES($1,'PLATFORM_ADMIN','l17-perf')",[user.user.id]);
    await admin.query(
      "INSERT INTO collection_filter_policies(version,status,approved_at) "+
      "SELECT COALESCE((SELECT max(version) FROM collection_filter_policies),0)+1,'APPROVED',now() "+
      "WHERE NOT EXISTS(SELECT 1 FROM collection_filter_policies WHERE status='APPROVED')"
    );
    const policy=(await admin.query<{id:string}>(
      "SELECT id FROM collection_filter_policies WHERE status='APPROVED' LIMIT 1"
    )).rows[0]!.id;
    const n=3000;
    await admin.query(
      "INSERT INTO collection_filter_type_rules(policy_id,source_code,section,canonical_type,mode) "+
      "SELECT $1,'dou','DO1E','L17 PERF TYPE '||lpad(i::text,4,'0'),'EXCLUDE_ALWAYS' "+
      "FROM generate_series(1,$2::integer) i "+
      "ON CONFLICT(policy_id,source_code,section,canonical_type) DO UPDATE SET mode=EXCLUDED.mode",
      [policy,n]);
    const records=12000;
    await admin.query(
      "INSERT INTO publications(identity_hash,identity_strength,identity_basis,jurisdiction_level,act_type,title,primary_official_url) "+
      "SELECT encode(digest($1||i::text,'sha256'),'hex'),'STRONG','{}'::jsonb,'FEDERAL',"+
      "'L17 PERF TYPE '||lpad((((i-1)%3000)+1)::text,4,'0'),"+
      "$2||lpad(i::text,4,'0'),'https://l17-benchmark.example.test/'||$1||'/'||i::text "+
      "FROM generate_series(1,$3::integer) i",
      [label,'L17_perf_'+label+'_',records]);
    await admin.query(
      "INSERT INTO sources(code,name,jurisdiction_level,base_url,connector_key) "+
      "SELECT 'dou','Diário Oficial','FEDERAL','https://in.gov.br','dou' "+
      "WHERE NOT EXISTS(SELECT 1 FROM sources WHERE code='dou')"
    );
    const source=(await admin.query<{id:string}>(
      "SELECT id FROM sources WHERE code='dou' LIMIT 1")).rows[0]!.id;
    await admin.query(
      "INSERT INTO publication_origins(publication_id,source_id,official_url,metadata) "+
      "SELECT p.id,$1,p.primary_official_url,jsonb_build_object('dou',jsonb_build_object('section','DO1E')) "+
      "FROM publications p WHERE p.title LIKE $2",
      [source,'L17_perf_'+label+'_%']);
    await admin.query(
      "INSERT INTO publication_versions(publication_id,version_no,content_hash,content_text,is_current) "+
      "SELECT p.id,1,encode(digest('body'||p.id::text,'sha256'),'hex'),"+
      "'Texto administrativo sem termos fiscais.',true "+
      "FROM publications p WHERE p.title LIKE $1",
      ['L17_perf_'+label+'_%']);
    const started=performance.now();
    const res=await app.inject({method:'POST',
      url:'/api/v1/admin/collection-filter/out-of-scope/preview',headers});
    const elapsed=Math.round(performance.now()-started);
    assert.equal(res.statusCode,200,res.body.slice(0,1000));
    const plan=res.json<{ruleDiscards:number;byRule:Array<{count:number}>;token:string}>();
    assert.ok(plan.ruleDiscards>=records);
    assert.equal(plan.byRule.filter(r=>(r as {canonicalType:string}).canonicalType.startsWith('L17 PERF TYPE '))
      .reduce((sum,r)=>sum+r.count,0),records);
    assert.match(plan.token,/^[a-f0-9]{64}$/);
    console.log('L17_PG18_3000_RULE_PREVIEW_MS='+elapsed+' ACTIVE_RULES=3000 MATCHED_DOCUMENTS='+records);
    assert.ok(elapsed<30000,'preview exceeded 30 s: '+elapsed+' ms');
  }finally{await app.close();await admin.end();}
}
