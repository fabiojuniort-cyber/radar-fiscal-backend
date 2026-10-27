import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {buildApp} from '../dist/app.js';
import {makeF2StagingPayload} from '../ops/taxonomy/f2-stage-payload.mjs';
import {F2_APPROVED_BATCH_ID} from '../dist/modules/taxonomy/curation/curation.f2-draft-import.js';
import {withCuratorTransaction} from '../dist/modules/taxonomy/curation/curation.draft.js';
import {saveOperationalApproval} from '../dist/modules/taxonomy/curation/curation.f2-links.js';
import {publishedOperationalLinks} from '../dist/modules/taxonomy/curation/curation.f2-links.js';
import {pgRunner} from '../dist/modules/taxonomy/curation/curation.read.js';

test('ONB03 PG18 real API: readonly plan, approval rollback/staleness, publication and reversal preserve profiles',async()=>{
 assert.equal(process.env.NODE_ENV,'test');
 const url=process.env.DATABASE_ADMIN_URL;
 assert.ok(url);
 assert.ok(['localhost','127.0.0.1'].includes(new URL(url).hostname),'local disposable CI only');
 const admin=new Pool({connectionString:url,max:2});
 let app;
 try{
  const identity=(await admin.query("SELECT current_database() db,current_setting('server_version_num')::int version")).rows[0];
  assert.equal(identity.db,'radar_fiscal_test');assert.ok(identity.version>=180000&&identity.version<190000);
  assert.equal((await admin.query('SELECT count(*)::int n FROM taxonomy_f2_import_batches')).rows[0].n,0);
  const labels=[['Serviço',505],['Indústria',370],['Comércio atacadista',115],['Produtor rural',107],
   ['Comércio varejista',86],['Transportador',44],['Extração mineral',40],['Locação e licenciamento',20],
   ['Institucional',19],['Representação comercial',15],['Energia e utilidades',8],['Armazém',3]];
  const segments=[],products=[];let j=0;
  for(const [label,count] of labels)for(let k=0;k<count;k++,j++){
   segments.push(['Agro','Grãos',label,String(1000000+j),'CNAE sintético '+j,'',
    j>=198&&j<448?'Prod A;Prod B;Prod C':j<198?'Prod A;Prod B':'Prod A',
    j===0?'010;1002;1003':j<198?'1001;1002;1003':j<448?'1001;1002':'1001',
    'x','x',String(j),'sector.onb03_fixture_'+j]);
  }
  for(let i=0;i<4225;i++)products.push(['Agro','Grãos','Produto sintético '+i,'1001;1001.90;1001.90.00',
   'Sinônimo '+i,'x','x',String(i),'product.onb03_fixture_'+i,'Definição sintética '+i]);
  const payload=makeF2StagingPayload(segments,products);
  assert.equal(payload.summary.warnings,448);
  await admin.query(`INSERT INTO taxonomy_f2_import_batches(id,segmento_sha256,produto_sha256,content_sha256,segmento_rows,produto_rows,expected_warnings)
   VALUES($1,$2,$3,$4,1332,4225,448)`,[F2_APPROVED_BATCH_ID,payload.hashes.segmentoSha256,payload.hashes.produtoSha256,payload.contentSha256]);
  await admin.query(`INSERT INTO taxonomy_f2_import_segment_rows(batch_id,source_line,cnae_code,atuacao,raw_cells,row_sha256)
   SELECT $1,s.source_line,s.cnae_code,s.atuacao,s.raw_cells,s.row_sha256 FROM jsonb_to_recordset($2::jsonb)
   AS s(source_line int,cnae_code text,atuacao text,raw_cells jsonb,row_sha256 text)`,[F2_APPROVED_BATCH_ID,JSON.stringify(payload.segments)]);
  await admin.query(`INSERT INTO taxonomy_f2_import_product_rows(batch_id,source_line,product_code,segmento,grupo,item,ncm_normalized,raw_cells,row_sha256)
   SELECT $1,s.source_line,s.product_code,s.segmento,s.grupo,s.item,s.ncm_normalized,s.raw_cells,s.row_sha256
   FROM jsonb_to_recordset($2::jsonb) AS s(source_line int,product_code text,segmento text,grupo text,item text,ncm_normalized jsonb,raw_cells jsonb,row_sha256 text)`,
   [F2_APPROVED_BATCH_ID,JSON.stringify(payload.products)]);
  const catalog=(await admin.query("INSERT INTO official_catalogs(code,name,maintainer) VALUES('NCM','NCM fixture','CI') ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name RETURNING id")).rows[0].id;
  await admin.query("UPDATE official_catalog_editions SET status='SUPERSEDED' WHERE catalog_id=$1 AND status='CURRENT'",[catalog]);
  const edition=(await admin.query(`INSERT INTO official_catalog_editions(catalog_id,edition_code,status,source_url,source_sha256)
   VALUES($1,'onb03-ci','CURRENT','https://example.test/catalog',$2) RETURNING id`,[catalog,'a'.repeat(64)])).rows[0].id;
  for(const code of ['01012100','1001','1002','1003','12130000','23024000','27160000'])await admin.query(
   'INSERT INTO official_catalog_entries(catalog_edition_id,official_code,description,metadata) VALUES($1,$2,$3,$4::jsonb)',
   [edition,code,'Entrada sintética '+code,JSON.stringify({normalizedDigits:code,assignable:false})]);
  const major=(await admin.query('SELECT coalesce(max(version_major),0)+100 major FROM taxonomy_releases')).rows[0].major;
  const base=(await admin.query(`INSERT INTO taxonomy_releases(version_major,version_minor,version_patch,status,manifest,created_by_actor)
   VALUES($1,0,0,'DRAFT','{"kind":"TAX-11_CURATED_RELEASE"}','onb03-ci') RETURNING id`,[major])).rows[0].id;
  for(const [dimension,code,label,official] of [
   ['sector','sector.onb03_test','CNAE sintético',['1000000']],
   ['product','product.onb03_test','Prod A',['1001']],
  ]){
   const dim=(await admin.query('INSERT INTO taxonomy_dimensions(code) VALUES($1) ON CONFLICT(code) DO UPDATE SET code=EXCLUDED.code RETURNING id',[dimension])).rows[0].id;
   const dr=(await admin.query(`INSERT INTO taxonomy_dimension_revisions(dimension_id,revision_no,name)
    SELECT $1,coalesce(max(revision_no),0)+1,$2 FROM taxonomy_dimension_revisions WHERE dimension_id=$1 RETURNING id`,[dim,dimension])).rows[0].id;
   await admin.query(`INSERT INTO taxonomy_release_dimensions(release_id,dimension_id,dimension_revision_id,profile_visible,official_code_type)
    VALUES($1,$2,$3,false,$4)`,[base,dim,dr,dimension==='sector'?'CNAE':'NCM']);
   const concept=(await admin.query('INSERT INTO taxonomy_concepts(code,dimension_id) VALUES($1,$2) RETURNING id',[code,dim])).rows[0].id;
   const rev=(await admin.query('INSERT INTO taxonomy_concept_revisions(concept_id,revision_no,label,definition) VALUES($1,1,$2,$2) RETURNING id',[concept,label])).rows[0].id;
   await admin.query('INSERT INTO taxonomy_release_concepts(release_id,concept_id,concept_revision_id,official_codes) VALUES($1,$2,$3,$4)',[base,concept,rev,official]);
  }
  await admin.query(`UPDATE taxonomy_releases SET status='PUBLISHED',approved_at=now(),published_at=now(),
   artifact_repository='test',artifact_path='onb03',artifact_git_sha=$2,artifact_sha256=$3 WHERE id=$1`,[base,'0'.repeat(40),'0'.repeat(64)]);
  app=await buildApp();
  async function account(name){
   const email='onb03-'+randomUUID()+'@example.test',password='Synthetic-Safe-2026!';
   const register=await app.inject({method:'POST',url:'/auth/register',payload:{name,email,password,confirmPassword:password,acceptedTerms:true}});
   assert.equal(register.statusCode,201,register.body);const data=register.json();
   const login=await app.inject({method:'POST',url:'/auth/login',payload:{email,password}});
   assert.equal(login.statusCode,200,login.body);
   return {userId:data.user.id,tenantId:data.tenant.id,headers:{authorization:'Bearer '+login.json().accessToken,'x-tenant-id':data.tenant.id}};
  }
  const curator=await account('Curador sintético'),customer=await account('Cliente sintético');
  await admin.query("INSERT INTO platform_user_roles(user_id,role,granted_by) VALUES($1,'PLATFORM_ADMIN','onb03-ci'),($1,'TAXONOMY_CURATOR','onb03-ci')",[curator.userId]);
  const company=(await admin.query("INSERT INTO companies(tenant_id,legal_name,head_office_cnpj) VALUES($1,'Fixture preservada','00000000000000') RETURNING id",[customer.tenantId])).rows[0].id;
  await admin.query(`INSERT INTO company_tax_profiles(company_id,version_no,tax_regime,personalization)
   VALUES($1,1,'LUCRO_REAL','{"testMarker":"preserve-onb03"}')`,[company]);
  const snapshot=async()=> (await admin.query("SELECT md5(coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id)::text,'[]')) hash FROM company_tax_profiles p")).rows[0].hash;
  // A real onboarding GET must consume published links even without a mapped parent.
  await admin.query("INSERT INTO cnaes(code,description) VALUES('1000000','CNAE sintético ONB03') ON CONFLICT(code) DO NOTHING");
  const unit=(await admin.query("INSERT INTO establishments(company_id,cnpj,name,establishment_type_code,is_head_office,uf) VALUES($1,'00000000000000','Matriz sintética','HEAD_OFFICE',true,'GO') RETURNING id",[company])).rows[0].id;
  await admin.query("INSERT INTO establishment_cnaes(establishment_id,cnae_code,is_primary) VALUES($1,'1000000',true)",[unit]);
  const profiles=await snapshot();
  const auditCount=async()=> (await admin.query('SELECT count(*)::int n FROM audit_log')).rows[0].n;
  const root='/api/v1/admin/taxonomy/drafts';
  const call=async(method,path,body,expected=200,headers=curator.headers)=>{
   const response=await app.inject({method,url:path,headers,...(body?{payload:body}:{})});
   assert.equal(response.statusCode,expected,response.body);return response.statusCode===204?null:response.json();
  };
  await call('GET',root+'/current/f2-links/plan',null,403,customer.headers);
  await call('POST',root,{justification:'Criar rascunho sintético'},201);
  const auditBefore=await auditCount();
  const before=(await admin.query("SELECT manifest FROM taxonomy_releases WHERE status='DRAFT' AND manifest->>'kind'='TAX-11_CURATED_RELEASE'")).rows[0].manifest;
  let plan=await call('GET',root+'/current/f2-links/plan');
  assert.equal(plan.ruleVersion,'onb03-t07-t08-v3');
  assert.ok(plan.links.some(l=>l.kind==='NCM'&&l.target==='010'));
  assert.equal(await auditCount(),auditBefore,'plan must not write audit');
  assert.deepEqual((await admin.query("SELECT manifest FROM taxonomy_releases WHERE status='DRAFT' AND manifest->>'kind'='TAX-11_CURATED_RELEASE'")).rows[0].manifest,before);
  const approve=(ids,hash=plan.planSha256,expected=200)=>call('POST',root+'/current/f2-links/approve',
   {justification:'Aprovar vínculos sintéticos',planSha256:hash,candidateIds:ids},expected);
  await approve(['f'.repeat(64)],plan.planSha256,409);
  assert.equal(await auditCount(),auditBefore,'rejected approval must roll back manifest/audit');
  await assert.rejects(withCuratorTransaction(app.curatorPool,async client=>{
   await saveOperationalApproval(client,{userId:curator.userId,justification:'Probe transacional sintético'},
    {planSha256:plan.planSha256,candidateIds:plan.links.map(l=>l.id)});
   throw new Error('ROLLBACK_PROBE');
  }),/ROLLBACK_PROBE/);
  assert.equal(await auditCount(),auditBefore,'rollback after approval must undo audit');
  assert.deepEqual((await admin.query("SELECT manifest FROM taxonomy_releases WHERE status='DRAFT' AND manifest->>'kind'='TAX-11_CURATED_RELEASE'")).rows[0].manifest,before);
  await approve(plan.links.map(l=>l.id));
  assert.equal(await auditCount(),auditBefore+1);
  assert.deepEqual(await publishedOperationalLinks(pgRunner(admin),'1000000'),[],'DRAFT approval cannot leak');
  await call('PATCH',root+'/current/f2-suggestions/sector.onb03_test',
   {justification:'Alteração após aprovação',suggestedProducts:['Prod A'],suggestedNcms:['010','1213','2302.40','2716']});
  await call('POST',root+'/current/publish',{justification:'Publicação obsoleta',changeNotes:'Deve rejeitar hash antigo'},409);
  plan=await call('GET',root+'/current/f2-links/plan');
  await approve(plan.links.map(l=>l.id));
  const published=await call('POST',root+'/current/publish',{justification:'Publicação sintética',changeNotes:'Teste isolado ONB03'});
  const publishedId=published.release.id;
  const sealed=(await admin.query('SELECT manifest,artifact_sha256 FROM taxonomy_releases WHERE id=$1',[publishedId])).rows[0];
  assert.equal((await publishedOperationalLinks(pgRunner(admin),'1000000')).length,5);
  assert.ok((await publishedOperationalLinks(pgRunner(admin),'1000000')).some(l=>l.target==='010'));
  assert.deepEqual((await publishedOperationalLinks(pgRunner(admin),'1000000')).filter(l=>l.kind==='NCM').map(l=>l.target).sort(),
   ['010','1213','230240','2716'].sort());
  const onboarding=await call('GET','/api/v1/companies/'+company+'/onboarding',null,200,customer.headers);
  assert.equal(onboarding.release.id,publishedId);
  const activity=onboarding.cards.find(c=>c.establishmentId===unit&&c.cnaeCode==='1000000');
  assert.ok(activity);
  assert.equal(activity.segmentCode,'sector.sem_segmento');
  assert.ok(activity.suggestions.some(s=>s.kind==='PRODUCT'&&s.target==='product.onb03_test'));
  assert.ok(activity.suggestions.some(s=>s.kind==='NCM'&&s.target==='010'));
  assert.equal(await snapshot(),profiles,'onboarding GET cannot write existing profiles');
  await call('POST',root,{justification:'Nova release de reversão'},201);
  plan=await call('GET',root+'/current/f2-links/plan');
  await approve([]);
  await call('POST',root+'/current/publish',{justification:'Reverter sugestões',changeNotes:'Retirar todos os vínculos operacionais'});
  assert.deepEqual(await publishedOperationalLinks(pgRunner(admin),'1000000'),[]);
  const reversed=await call('GET','/api/v1/companies/'+company+'/onboarding',null,200,customer.headers);
  assert.ok(reversed.cards.every(c=>c.suggestions.every(s=>s.kind==='SEGMENT')),'onboarding cannot show withdrawn links');
  assert.deepEqual((await admin.query('SELECT manifest,artifact_sha256 FROM taxonomy_releases WHERE id=$1',[publishedId])).rows[0],sealed,'old PUBLISHED remains immutable');
  assert.equal(await snapshot(),profiles,'profiles unchanged across approval/publication/reversal');
  console.log('ONB03_PG18_LIFECYCLE=PASS: plan readonly; approval rejection rollback/audit; stale publish409; published-only read; reversal by new release; profiles invariant');
 }finally{if(app)await app.close();await admin.end();}
});
