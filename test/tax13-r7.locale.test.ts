import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import {seedTestV2LegalProof,seedTestV2NcmSeals} from './tax13-arch02.signed-fixture.js';
import { Pool } from 'pg';
import { sql } from 'kysely';
import { createStandaloneDatabase } from '../src/infrastructure/database/standalone-client.js';
import { brazilLegalReferenceDate, renderedLegalText } from '../src/modules/taxonomy/legal-scope/legal-scope-evidence.js';
import { readVerifiedLegalScope } from '../src/modules/taxonomy/legal-scope/legal-scope.repository.js';
import { currentNcmEdition, ncmTemporalFingerprint, persistTemporalNcmScan, readCurrentNcmEvidence } from '../src/modules/taxonomy/ncm/ncm-temporal.evidence.js';
import { PUBLICATION_NCM_DETECTOR_KEY, PUBLICATION_NCM_DETECTOR_VERSION } from '../src/modules/taxonomy/ncm/publication-ncm.detector.js';
import { importNcmCatalog } from '../src/modules/taxonomy/ncm/ncm-catalog.importer.js';
import { parseNcmCatalogPayload } from '../src/modules/taxonomy/ncm/ncm-catalog.source.js';
import { processPublicationNcmEnrichmentBatch } from '../src/modules/taxonomy/ncm/publication-ncm.detector.js';
const h = (s: string) => createHash('sha256').update(s).digest('hex');
const adminUrl = process.env.DATABASE_ADMIN_URL!;
const localTarget=new URL(adminUrl);
assert.ok(process.env.NODE_ENV==='test' && process.env.GITHUB_ACTIONS==='true' &&
  ['127.0.0.1','localhost'].includes(localTarget.hostname) &&
  localTarget.port==='5432' && localTarget.pathname==='/tax13_arch02_locale_c',
  'TAX13 disposable CI locale C database only');
const runtime = (name: string) => { const u = new URL(adminUrl); u.username=name; u.password=process.env.DB_RUNTIME_PASSWORD!; return u.toString(); };
async function fixture(config:any={}) {
  const admin = new Pool({connectionString:adminUrl, max:3});
  const worker = createStandaloneDatabase({connectionString:runtime('radar_worker_runtime'),poolMax:3,idleTimeoutMs:1000,connectionTimeoutMs:3000});
  const app = new Pool({connectionString:runtime('radar_app_runtime'),max:1});
  const day = brazilLegalReferenceDate();
  const recheck = new Date(new Date(day+'T12:00:00Z').getTime()+3*86400000).toISOString().slice(0,10);
  const parts=config.parts??['NCM 1006.30.11', 'NCM 10062099', 'Demais dispositivos.'];
  const html=config.html??parts.map((s:string)=>'<p class="TextoAcordo">'+s+'</p>').join('');
  const pub=(await admin.query(`INSERT INTO publications(identity_hash,identity_strength,identity_basis,jurisdiction_level,title,published_on) VALUES ($1,'STRONG','{}','FEDERAL','Independent R2 synthetic',CURRENT_DATE) RETURNING id`,[h(randomUUID())])).rows[0].id;
  const version=(await admin.query(`INSERT INTO publication_versions(publication_id,version_no,content_hash,content_text,source_metadata,is_current) VALUES ($1,1,$2,$3,$4,true) RETURNING id`,[pub,h(html),renderedLegalText(html),JSON.stringify({presentation:{format:'SANITIZED_HTML',html}})])).rows[0].id;
  await admin.query(`INSERT INTO sources(code,name,jurisdiction_level,base_url,connector_key) VALUES ('confaz','CONFAZ','FEDERAL','https://www.confaz.fazenda.gov.br','confaz') ON CONFLICT(code) DO NOTHING`);
  const src=(await admin.query(`SELECT id FROM sources WHERE code='confaz'`)).rows[0].id;
  const url='https://www.confaz.fazenda.gov.br/test-only/independent/'+version;
  const origin=(await admin.query(`INSERT INTO publication_origins(publication_id,source_id,official_url) VALUES ($1,$2,$3) RETURNING id`,[pub,src,url])).rows[0].id;
  const attest=async (statuses:string[], options:any={}) => {
    let offset=0;
    const manifest={version:1,publicationVersionId:version,sourceId:src,officialUrl:url,htmlSha256:h(html),validAsOf:day,verifiedAt:new Date(Date.now()-60000).toISOString(),recheckOn:recheck,coverage:'COMPLETE',segments:parts.map((part,i)=>{const start=offset; offset+=part.length; return {start,end:offset,textSha256:h(part),status:statuses[i],method:'OFFICIAL_AMENDMENT',evidenceUrls:[url]};})};
    if(options.mutate) options.mutate(manifest);
    return (await (options.client??admin).query(`INSERT INTO publication_legal_scope_attestations(id,publication_version_id,source_id,publication_origin_id,official_url,html_sha256,valid_as_of,verified_at,recheck_on,coverage,manifest,attestor_kind,attestor_ref,supersedes_attestation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'COMPLETE',$10,'HUMAN_REVIEW','INDEPENDENT-R2',$11) RETURNING id`,[options.id??randomUUID(),version,src,origin,url,h(html),day,manifest.verifiedAt,recheck,manifest,options.supersedes??null])).rows[0].id;
  };
  const proof=()=>readVerifiedLegalScope(worker,{publicationVersionId:version,sanitizedHtml:html,asOf:day});
  const scan=()=>worker.transaction().execute(trx=>persistTemporalNcmScan(trx,{publicationVersionId:version,sanitizedHtml:html,asOf:day}));
  const bridge=async()=> (await app.query(`SELECT tax13_current_ncm_scan_fingerprint($1) AS fingerprint, ARRAY(SELECT ncm_code FROM tax13_public_current_ncm_codes($1)) AS codes`,[version])).rows[0];
  return {admin,worker,app,pub,version,origin,src,url,html,parts,day,recheck,attest,proof,scan,bridge,close:async()=>{await worker.destroy();await app.end();await admin.end();}};
}

async function rawScan(f:any, attestation:string, fragments:string[], rows:any[], options:any={}) {
  const ed=await currentNcmEdition(f.worker,f.day);
  const proof:any={valid:true,coverage:'COMPLETE',currentSegments:fragments.length,
    currentFragments:fragments,attestationId:attestation,asOf:f.day,
    recheckOn:f.recheck,htmlSha256:h(f.html)};
  const fp=options.fingerprint??ncmTemporalFingerprint(f.version,proof,ed);
  return f.worker.transaction().execute(async (trx:any)=>{
    const header=(await sql<{id:string}>`INSERT INTO publication_ncm_scan_evidence(
      publication_version_id,detector_key,detector_version,legal_scope_attestation_id,
      legal_as_of,recheck_on,coverage,html_sha256,current_fragments_sha256,
      catalog_edition_id,catalog_sha256,run_fingerprint,source_field,candidate_count,match_count,outcome)
      VALUES (${f.version}::uuid,${PUBLICATION_NCM_DETECTOR_KEY},${PUBLICATION_NCM_DETECTOR_VERSION},
      ${attestation}::uuid,${f.day}::date,${f.recheck}::date,'COMPLETE',${h(f.html)},
      ${h(JSON.stringify(fragments))},${ed.id}::uuid,${ed.checksum},${fp},'CONTENT_TEXT',
      ${options.candidates??1},${options.matches??1},'SUCCESS') RETURNING id`.execute(trx)).rows[0]!.id;
    for(const row of rows) {
      const entry=(await sql<{id:string}>`SELECT id FROM official_catalog_entries
        WHERE catalog_edition_id=${ed.id}::uuid
        AND regexp_replace(official_code,'[^0-9]','','g')=${row.code} LIMIT 1`.execute(trx)).rows[0]!.id;
      await sql`INSERT INTO publication_ncm_scan_evidence_codes(scan_evidence_id,ncm_code,
        catalog_entry_id,fragment_index,excerpt) VALUES (${header}::uuid,${row.code},
        ${row.entry??entry}::uuid,${row.index??0},${row.excerpt??fragments[row.index??0]})`.execute(trx);
    }
    return header;
  });
}

async function affinityProbe(f:any,personalization:any) {
  const {buildApp}=await import('../src/app.js');const api=await buildApp();
  try{
    const email='r3-'+randomUUID()+'@example.test',password=process.env.R4_TEST_ACCOUNT_PASSWORD!;
    const reg=await api.inject({method:'POST',url:'/auth/register',payload:{name:'R3 Synthetic',email,company:'R3 Synthetic',password,confirmPassword:password,acceptedTerms:true}});
    assert.equal(reg.statusCode,201,reg.body);const tenantId=reg.json().tenant.id;
    const login=await api.inject({method:'POST',url:'/auth/login',payload:{email,password}});
    assert.equal(login.statusCode,200,login.body);
    const headers={authorization:'Bearer '+login.json().accessToken,'x-tenant-id':tenantId};
    const company=(await f.admin.query(`INSERT INTO companies(tenant_id,legal_name,head_office_cnpj)
      VALUES ($1,'R3 synthetic client',$2) RETURNING id`,[tenantId,String(Date.now()).padStart(14,'0')])).rows[0].id;
    await f.admin.query(`INSERT INTO company_tax_profiles(company_id,version_no,tax_regime,personalization,is_current)
      VALUES ($1,1,'LUCRO_REAL',$2,true)`,[company,personalization]);
    const res=await api.inject({method:'GET',url:`/api/v1/companies/${company}/publications/${f.pub}/affinity`,headers});
    const list=await api.inject({method:'GET',url:`/api/v1/publications/${f.pub}/ncms`,headers});
    assert.equal(res.statusCode,200,res.body);assert.equal(list.statusCode,200,list.body);
    return {affinity:res.json(),ncmRead:list.json()};
  }finally{await api.close();}
}


const r6Cases=[
 {label:'latin1-convenio-lower',parts:['Convênio ICMS 10062099']},
 {label:'latin1-resolucao-lower',parts:['Resolução 10062099']},
 {label:'latin1-month-marco',parts:['Lei 10062099, de 1 de março de 2026.']},
 {label:'latin1-clausula-revogada',parts:['Cláusula 10062099 - revogada.']},
 {label:'latin1-annex-redacao',parts:['Anexo II - redação anterior','NCM 10062099'],statuses:['REVOKED','CURRENT'],fragments:['NCM 10062099']},
 {label:'ascii-identifier-control',parts:['Lei 10062099']},
 {label:'positive',parts:['NCM 10062099']}
];
for(const c of r6Cases)test('R7 locale real HTTP '+c.label,async()=>{
 const f=await fixture({parts:c.parts});const {buildApp}=await import('../src/app.js');const api=await buildApp();try{
 const a=await f.attest(c.statuses??['CURRENT'],{mutate:c.mutate});
 if(c.label==='positive') await seedTestV2LegalProof(f.admin,a);
 const proof=await f.proof();
 assert.equal(proof.valid,c.label==='positive');let normal:any=null;
 try{await f.scan();normal='accepted';}catch(e:any){normal=e.message;}
 if(c.label==='positive' && normal==='accepted')
   await seedTestV2NcmSeals(f.admin,f.version,brazilLegalReferenceDate());
 let committed=false,rawError:any=null;
 if(c.label==='positive')committed=true;else try{await rawScan(f,a,c.fragments??c.parts,[{code:'10062099',excerpt:'10062099'}]);committed=true;}catch(e:any){rawError={code:e.code,message:e.message};}
 const address=await api.listen({host:'127.0.0.1',port:0});
 const account=async()=>{const email='r6-http-'+randomUUID()+'@example.test',password=process.env.R4_TEST_ACCOUNT_PASSWORD!;
 const post=async(path:string,payload:any)=>{const r=await fetch(address+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});return{status:r.status,body:await r.json() as any}};
 const reg=await post('/auth/register',{name:'R6 synthetic',email,company:'R6 synthetic',password,confirmPassword:password,acceptedTerms:true});assert.equal(reg.status,201);
 const login=await post('/auth/login',{email,password});assert.equal(login.status,200);
 return{tenant:reg.body.tenant.id,headers:{authorization:'Bearer '+login.body.accessToken,'x-tenant-id':reg.body.tenant.id}};};
 const own=await account(),other=await account();
 const company=(await f.admin.query("INSERT INTO companies(tenant_id,legal_name,head_office_cnpj) VALUES ($1,'R6 HTTP',$2) RETURNING id",[own.tenant,String(Date.now()).padStart(14,'0')])).rows[0].id;
 await f.admin.query("INSERT INTO company_tax_profiles(company_id,version_no,tax_regime,personalization,is_current) VALUES ($1,1,'LUCRO_REAL',$2,true)",[company,{ncmCodes:['10062099']}]);
 const path='/api/v1/companies/'+company+'/publications/'+f.pub+'/affinity',np='/api/v1/publications/'+f.pub+'/ncms';
 const get=async(p:string,headers?:any)=>{const r=await fetch(address+p,{headers});return{status:r.status,body:await r.json() as any}};
 const anon=await get(path),anonNcm=await get(np),foreign=await get(path,other.headers),ar=await get(path,own.headers),nr=await get(np,own.headers);
 assert.equal(anon.status,401);assert.equal(anonNcm.status,401);assert.equal(foreign.status,404);assert.equal(ar.status,200);assert.equal(nr.status,200);
 const headersPersisted=(await f.admin.query('SELECT count(*)::int n FROM publication_ncm_scan_evidence WHERE publication_version_id=$1',[f.version])).rows[0].n;
 const observed={label:c.label,sha:'TAX13_ARCH02_R8_CANDIDATE',nodeReason:proof.reason,normal,committed,rawError,headersPersisted,bridge:await f.bridge(),anon:anon.status,anonNcm:anonNcm.status,crossTenant:foreign.status,affinity:ar.body,ncm:nr.body};
 console.log('R7 LOCALE HTTP',JSON.stringify(observed));
 if(c.label!=='positive'){assert.equal(normal,'TAX13_NCM_COMPLETE_CURRENT_PROOF_REQUIRED');assert.equal(headersPersisted,0,'invalid evidence must leave no scan');assert.deepEqual(nr.body.attestedCurrentNcmCodes,[]);assert.equal(ar.body.score,0);}else{assert.equal(headersPersisted,1);assert.deepEqual(nr.body.attestedCurrentNcmCodes,['10062099']);assert.equal(ar.body.score,3);}
 }finally{await api.close();await f.close();}
});

