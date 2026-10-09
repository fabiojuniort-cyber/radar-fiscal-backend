import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
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




import { before, after } from 'node:test';
import { writeFileSync } from 'node:fs';
const cases:any[]=[];
const add=(label:string,parts:string[],extra:any={})=>cases.push({label,parts,...extra});
const allowed=(cp:number)=>cp>=9&&cp<=13||cp>=0x20&&cp<=0xff||cp===0x1680||cp>=0x2000&&cp<=0x200a||cp>=0x2010&&cp<=0x201f||[0x2028,0x2029,0x202f,0x205f,0x20ac,0x2122,0x3000,0xfeff].includes(cp);
const white:number[]=[];
const points=[1,8,14,31,32,0x7e,0x7f,0x80,0x85,0x9f,0xa0,0xad,0xb0,0xb5,0xb7,0xc0,0xd7,0xdf,0xf7,0xff,0x100,0x130,0x17f,0x300,0x301,0x340,0x378,0x3c2,0x3c3,0x3a3,0x400,0x1680,0x1681,0x1fff,0x2000,0x200a,0x200b,0x200f,0x2010,0x201f,0x2020,0x2022,0x2026,0x2027,0x2028,0x2029,0x202f,0x2030,0x205f,0x2060,0x20ac,0x20ad,0x2122,0x212a,0x3000,0x3001,0xfeff,0xff00,0xff5a,0xfffd,0x10000,0x1f4b0,0x1f600,0x10400,0x1d49c,0x10ffff];
for(const cp of points){
 const c=String.fromCodePoint(cp),name=cp.toString(16),extra=allowed(cp)?{}:{expectSql:false};
 add('unicode-current-'+name,['Operação '+c+' NCM 10062099.'],extra);
 add('unicode-editorial-'+name,['Nota '+c,'NCM 10062099'],{statuses:['EDITORIAL','CURRENT'],fragments:['NCM 10062099'],...extra});
 add('unicode-title-'+name,['Nota '+c,'NCM 10062099'],{html:'<p class="TituloAcordo">Nota '+c+'</p><p>NCM 10062099</p>',statuses:['EDITORIAL','CURRENT'],fragments:['NCM 10062099'],...extra});
}
for(const cp of [0x1f600,0x10400,0x1d49c,0x1f4b0,0x10000,0x10ffff]){
 const c=String.fromCodePoint(cp);
 for(const position of ['before','inside','between']){
  const parts=position==='inside'?['Operação '+c+' NCM 10062099']:['Nota '+c,'NCM 10062099'];
  const statuses=position==='inside'?['CURRENT']:['EDITORIAL','CURRENT'];
  const fragments=position==='inside'?parts:['NCM 10062099'];
  for(const mode of ['correct','point-shift','bad-hash','overlap','start-shift','end-shift']){
   add('astral-'+cp.toString(16)+'-'+position+'-'+mode,parts,{statuses,fragments,expectSql:false,mutate:(m:any)=>{
    if(mode==='point-shift'){m.segments[0].end--;if(m.segments[1]){m.segments[1].start--;m.segments[1].end--;}}
    if(mode==='bad-hash')m.segments.at(-1).textSha256='0'.repeat(64);
    if(mode==='overlap'&&m.segments[1])m.segments[1].start--;
    if(mode==='start-shift')m.segments.at(-1).start++;
    if(mode==='end-shift')m.segments.at(-1).end--;
   }});
  }
  if(position==='between')add('astral-gap-'+cp.toString(16),['NCM 10062099',c,'Outro dispositivo.'],{statuses:['CURRENT','EDITORIAL','CURRENT'],fragments:['NCM 10062099','Outro dispositivo.'],expectSql:false});
 }
}
for(const text of ['Lei 10062099, de 1 de março de 2026.','Convênio ICMS 10062099, de 1 de março de 2026.','Resolução 10062099','RESOLUÇÃO 10062099','convênio icms 10062099','Ajuste SINIEF 10062099','Cláusula 10062099 - revogada.','Parágrafo 10062099 - REVOGADO.']){
 add('latin1-act-'+text,[text],{expectNode:false,expectSql:false});
}
for(const text of ['Reſolução 10062099','Ajuſte ſINIEF 10062099','Protocolo ICMſ 10062099','Convênio ICMſ 10062099','Lei 10062099, de 1 de marKo de 2026.']){
 for(const pad of ['','\t\u2003\ufeff'])add('fold-'+text+'-'+pad.length,[pad+text+pad],{expectSql:false});
}
function sized(target:number,filler:string,multiple=false){
 const prefix=multiple?'<p>Nota editorial.</p><p class="TextoAcordo">NCM 10062099 ':'<p class="TextoAcordo">NCM 10062099 ';
 const overhead=Buffer.byteLength(prefix+'</p>'),unit=Buffer.byteLength(filler);
 const count=Math.floor((target-overhead)/unit),rest=target-overhead-count*unit;
 const text='NCM 10062099 '+filler.repeat(count)+'a'.repeat(rest);
 const html=(multiple?'<p>Nota editorial.</p>':'')+'<p class="TextoAcordo">'+text+'</p>';
 assert.equal(Buffer.byteLength(html),target);
 return {parts:multiple?['Nota editorial.',text]:[text],html,statuses:multiple?['EDITORIAL','CURRENT']:['CURRENT'],fragments:[text]};
}
for(const filler of ['a','á','😀']){
 for(const target of [2097151,2097152,2097153,2097152+10000]){
  for(const multiple of [false,true]){
   const c=sized(target,filler,multiple);
   add('bytes-'+Buffer.byteLength(filler)+'-'+target+'-'+multiple,c.parts,{...c,expectNode:target<=2097152,expectSql:target<=2097152&&filler!=='😀'});
  }
 }
}
for(const mutation of ['html-case','html-hash','piece-hash']){
 const c=sized(2097152,'á',true);
 add('limit-invalid-'+mutation,c.parts,{...c,html:mutation==='html-case'?c.html.replace('<p class="TextoAcordo">','<P class="TextoAcordo">'):c.html,expectNode:false,expectSql:false,mutate:(m:any)=>{if(mutation==='html-hash')m.htmlSha256='0'.repeat(64);if(mutation==='piece-hash')m.segments[1].textSha256='0'.repeat(64);}});
}
for(const html of ['<p class="A5-1TextoAcordo">NCM 10062099</p>','<div><p>NCM 10062099</p></div>','<p>NCM <strong>10062099</strong></p>','<p>NCM 10062099 &amp; obrigação</p>','<p>NCM 10062099 …</p>','<p>NCM 10062099 •</p>','<p>NCM 10062099 criação</p>','<p>NCM 10062099 criac\u0327a\u0303o</p>']){
 add('parser-'+cases.length,[renderedLegalText(html)],{html});
}

// Original 365 adversarial cases from independent R7, comment 6072095483.
 // Positive results require independent V2 admission/seal: raw worker INSERT
 // is adversarial here even when Node validation of the legacy 044 row succeeds.
 // No production endpoint, credentials or database is used.
 assert.equal(cases.length,365,'R7 additional suite must retain all 365 original cases');
 const observations:any[]=[];
let api:any,address='',headers:any,otherHeaders:any,company='';
before(async()=>{
 const {buildApp}=await import('../src/app.js');api=await buildApp();address=await api.listen({host:'127.0.0.1',port:0});
 const account=async()=>{const email='r6-'+randomUUID()+'@example.test',password=process.env.R4_TEST_ACCOUNT_PASSWORD!;
  const post=async(path:string,payload:any)=>{const r=await fetch(address+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});const b:any=await r.json();return{status:r.status,body:b}};
  const reg=await post('/auth/register',{name:'R6 synthetic',email,company:'R6 synthetic',password,confirmPassword:password,acceptedTerms:true});assert.equal(reg.status,201);
  const login=await post('/auth/login',{email,password});assert.equal(login.status,200);
  return {tenant:reg.body.tenant.id,headers:{authorization:'Bearer '+login.body.accessToken,'x-tenant-id':reg.body.tenant.id}};
 };
 const own=await account(),other=await account();headers=own.headers;otherHeaders=other.headers;
 const db=new Pool({connectionString:adminUrl,max:1});try{
 company=(await db.query("INSERT INTO companies(tenant_id,legal_name,head_office_cnpj) VALUES ($1,'R6 differential',$2) RETURNING id",[own.tenant,String(Date.now()).padStart(14,'0')])).rows[0].id;
 await db.query("INSERT INTO company_tax_profiles(company_id,version_no,tax_regime,personalization,is_current) VALUES ($1,1,'LUCRO_REAL',$2,true)",[company,{ncmCodes:['10062099'],keywords:['crédito presumido']}]);
 }finally{await db.end();}
});
after(async()=>{await api.close();writeFileSync('../r7-additional-observations-'+localTarget.port+'.json',JSON.stringify({cases:cases.length,white,observations},null,2));});
for(const c of cases)test('R7 additional '+c.label,async()=>{
 const f=await fixture({parts:c.parts,html:c.html});try{
 let a='',attError:any;try{a=await f.attest(c.statuses??c.parts.map(()=> 'CURRENT'),{mutate:c.mutate});}catch(e){attError=e;}
 const proof=a?await f.proof():null;
 let normalWorkerRejected:any=null;
 if(a&&!proof?.valid){try{await f.scan();normalWorkerRejected=false;}catch(e:any){normalWorkerRejected=e.message;}assert.equal(normalWorkerRejected,'TAX13_NCM_COMPLETE_CURRENT_PROOF_REQUIRED');}
 const sqlFragments=a?(await f.admin.query('SELECT tax13_legal_current_fragments($1) fragments',[a])).rows[0].fragments:null;
 let accepted=false,err:any;
 if(a){const fragments=c.fragments??c.parts;
  try{await rawScan(f,a,fragments,[{code:'10062099',excerpt:'10062099'}]);accepted=true;}catch(e){err=e;}
 }
 const bridge=await f.bridge(),stored=(await f.admin.query('SELECT count(*)::int n FROM publication_ncm_scan_evidence WHERE publication_version_id=$1',[f.version])).rows[0].n;
 const ncmR=await fetch(address+'/api/v1/publications/'+f.pub+'/ncms',{headers});assert.equal(ncmR.status,200);const ncm:any=await ncmR.json();
 const affinityR=await fetch(address+'/api/v1/companies/'+company+'/publications/'+f.pub+'/affinity',{headers});assert.equal(affinityR.status,200);const affinity:any=await affinityR.json();
 const obs={label:c.label,sha:'TAX13_ARCH02_R8_CANDIDATE',publicationId:f.pub,versionId:f.version,attestationId:a,nodeValid:proof?.valid??false,nodeReason:proof?.reason??'ATTESTATION_REJECTED',normalWorkerRejected,sqlFragments:sqlFragments===null?null:sqlFragments.map((s:string)=>s.length<250?s:{length:s.length,sha256:h(s)}),accepted,sqlstate:err?.code??attError?.code,error:err?.message??attError?.message,stored,bridge,ncmCodes:ncm.attestedCurrentNcmCodes,ncmVerification:ncm.items?.map((i:any)=>i.verificationStatus),score:affinity.score,matches:affinity.matches};
 observations.push(obs);if((!proof?.valid&&sqlFragments!==null)||(!proof?.valid&&accepted))console.log('R7 ADDITIONAL DIVERGENCE',JSON.stringify(obs));
 if(c.expectNode!==undefined&&a)assert.equal(proof?.valid,c.expectNode,'R7 expected Node admissibility');
  if(!a){assert.ok(['23514','P0001','22023'].includes(attError?.code));}
 if(!accepted&&a){assert.match(err?.message,/TAX13_NCM_SCAN_(CODE_NOT_IN_CURRENT_FRAGMENT|INCOMPLETE_OR_UNVERIFIED)/);assert.equal(err.code,'P0001');}
 if(!accepted){assert.equal(stored,0);assert.equal(bridge.fingerprint,null);assert.deepEqual(bridge.codes,[]);}
 if(!proof?.valid){
  assert.equal(sqlFragments===null,true,'Node invalid evidence cannot expose CURRENT fragments');
  assert.equal(accepted,false);assert.equal(stored,0);assert.deepEqual(ncm.attestedCurrentNcmCodes,[]);assert.equal(affinity.score,0);
 }else if(sqlFragments!==null){assert.deepEqual(sqlFragments,proof.currentFragments);}
 }finally{await f.close();}
});


