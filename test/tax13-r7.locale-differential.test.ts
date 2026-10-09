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
const white=[0x09,0x0a,0x0b,0x0c,0x0d,0x20,0xa0,0x1680,...Array.from({length:11},(_,i)=>0x2000+i),0x2028,0x2029,0x202f,0x205f,0x3000,0xfeff];
const acts=['Lei Complementar 10063011','Convênio ICMS 10063011, de 8 de outubro de 2026.','Ajuste SINIEF 10063011','Ato COTEPE/ICMS 10063011','Decreto 10063011','Protocolo ICMS 10063011'];
for(const cp of white){const ws=String.fromCodePoint(cp),name=cp.toString(16);
 for(const [i,act] of acts.entries()){
  add('ws-lead-'+name+'-'+i,[ws+act]);add('ws-tail-'+name+'-'+i,[act+ws]);
  add('ws-middle-'+name+'-'+i,[act.replaceAll(' ',ws+ws)]);
 }
 add('blank-'+name,['NCM 10063011'],{mutate:(m:any)=>m.segments[0].supportingActs=[ws]});
 add('annex-'+name,[ws+'ANEXO'+ws+'II - REVOGADO'+ws,'NCM 10063011'],{statuses:['REVOKED','CURRENT'],fragments:['NCM 10063011']});
}
for(const stem of ['Art.','Artigo','Artigo.','Cláusula','clausula','Parágrafo','paragrafo','Inciso','Alínea','Item','§']){
 for(const tail of ['revogado.','REVOGADA','Revogados.']) add('revoked-'+stem+'-'+tail,[stem+' 10063011 - '+tail]);
}
for(const note of ['REVOGADO','SUBSTITUIDO','SUBSTITUÍDO','SEM EFEITO','SEM VIGÊNCIA','REDAÇÃO ANTERIOR','REDAÇÃO ORIGINAL','TEXTO ANTERIOR']){
 for(const casing of [note,note.toLowerCase()]) add('annex-grammar-'+casing,['ANEXO II - '+casing,'NCM 10063011'],{statuses:['REVOKED','CURRENT'],fragments:['NCM 10063011']});
}
for(const text of ['Publicado no DOU 10063011','Ratificado pelo ato 10063011','Alterados por 10063011','Prorrogado até 10063011','Vide o art. 10063011','Nova redação dada pela Lei 10063011','Lei Complementar 10063011','Convênio 10063011','Reſolução 10063011','Lei Complementar 10063011, de 8 de outubKo de 2026.']){
 for(const pad of ['', '\t\u2003 \ufeff']) add('editorial-'+text+'-'+pad.length,[pad+text+pad]);
}
const mixes=['\u2003\u2007\u202f\ufeff',' \t\n\u1680\u3000','\u200b','\u2060','\u180e','\u0085'];
for(const blank of mixes)add('blank-mix-'+[...blank].map(x=>x.codePointAt(0)!.toString(16)).join('-'),['NCM 10063011'],{mutate:(m:any)=>m.segments[0].supportingActs=[blank]});
for(const value of [null,7,{},[null],[7],[''],['A\u0001B'],['A'.repeat(257)],Array(26).fill('act'),['😀'.repeat(128)],['á'.repeat(128)]]){
 add('support-schema-'+cases.length,['NCM 10063011'],{mutate:(m:any)=>m.segments[0].supportingActs=value});
}
for(const key of ['start','end','version','method','status','evidenceUrls','textSha256']){
 for(const value of [null,{},[],false,-1,0.5,9007199254740992,'1']){
  add('type-'+key+'-'+cases.length,['NCM 10063011'],{mutate:(m:any)=>key==='version'?m.version=value:m.segments[0][key]=value});
 }
 add('missing-'+key,['NCM 10063011'],{mutate:(m:any)=>key==='version'?delete m.version:delete m.segments[0][key]});
}
for(const uri of ['http://www.confaz.fazenda.gov.br/a','https://evil.invalid/a','https://u:p@www.confaz.fazenda.gov.br/a','https://www.confaz.fazenda.gov.br:8443/a','https://www.confaz.fazenda.gov.br/a','https://www.confaz.fazenda.gov.br/a\n']){
 add('url-'+cases.length,['NCM 10063011'],{mutate:(m:any)=>m.segments[0].evidenceUrls=[uri]});
}
for(const html of ['<p class="RedaoAnt">NCM 10063011</p>','<p class="TituloAcordo">NCM 10063011</p>','<p data-legal-status="revoked">NCM 10063011</p>','<p>NCM <strong>10063011</strong></p>','<p>NCM 10063011 &amp; texto</p>','<p>NCM 10063011','<p><p>NCM 10063011</p></p>']){
 add('dom-'+cases.length,[renderedLegalText(html)],{html});
}
add('cross-node',['1006.30.11'],{html:'<p>1006.</p><p>30.11</p>'});
for(const astral of ['😀','𐐀','𝒜']){
 add('utf16-offset-'+astral,['Histórico '+astral,'NCM 10063011'],{statuses:['EDITORIAL','CURRENT'],fragments:['NCM 10063011'],mutate:(m:any)=>{
  m.segments[0].end-=1;m.segments[1].start-=1;m.segments[1].end-=1;
 }});
 add('utf16-positive-'+astral,['Histórico '+astral,'NCM 10063011'],{statuses:['EDITORIAL','CURRENT'],fragments:['NCM 10063011']});
}
add('html-max-size',['NCM 10063011 '+ 'a'.repeat(2*1024*1024)],{fragments:['NCM 10063011 '+ 'a'.repeat(2*1024*1024)]});
add('positive-normal',['NCM 10063011']);
// R6 independent expansion: Unicode case folding and exact UTF-16/byte limits.
for(const act of ['Ajuste SINIEF','Resolução','Protocolo ICMS','Convênio ICMS']) {
 for(const transformed of [act.replaceAll(/[sS]/g,'ſ'),act.toUpperCase(),act.toLowerCase()])
  for(const pad of ['', '\u1680\t\ufeff']) add('fold-'+act+'-'+transformed+'-'+pad.length,[pad+transformed+' 10063011'+pad]);
}
for(const astral of ['😀','𐐀','𝒜']) {
 add('astral-current-shift-'+astral,[astral+' NCM 10063011'],{fragments:['NCM 10063011'],mutate:(m:any)=>{m.segments[0].start=2;m.segments[0].end-=1;m.segments[0].textSha256=h('NCM 10063011');}});
}
for(const filler of ['a','á']) {
 const part='NCM 10063011 '+filler.repeat(1024*1024);
 add('byte-limit-'+filler,[part]);
}
for(const mix of ['\t\u2003\u00a0','\ufeff\u2028\u3000','\u2007\u202f']) {
 add('mix-identifier-'+mix.length,[mix+'Lei'+mix+'Complementar'+mix+'10063011'+mix]);
 add('mix-annex-'+mix.length,[mix+'ANEXO'+mix+'II'+mix+'-'+mix+'SUBSTITUÍDO'+mix,'NCM 10063011'],{statuses:['REVOKED','CURRENT'],fragments:['NCM 10063011']});
}
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
 await db.query("INSERT INTO company_tax_profiles(company_id,version_no,tax_regime,personalization,is_current) VALUES ($1,1,'LUCRO_REAL',$2,true)",[company,{ncmCodes:['10063011'],keywords:['crédito presumido']}]);
 }finally{await db.end();}
});
after(async()=>{await api.close();writeFileSync('../locale-differential-observations-'+localTarget.port+'.json',JSON.stringify({cases:cases.length,white,observations},null,2));});
for(const c of cases)test('R6 differential '+c.label,async()=>{
 const f=await fixture({parts:c.parts,html:c.html});try{
 let a='',attError:any;try{a=await f.attest(c.statuses??c.parts.map(()=> 'CURRENT'),{mutate:c.mutate});}catch(e){attError=e;}
 const proof=a?await f.proof():null;
 let normalWorkerRejected:any=null;
 if(a&&!proof?.valid){try{await f.scan();normalWorkerRejected=false;}catch(e:any){normalWorkerRejected=e.message;}assert.equal(normalWorkerRejected,'TAX13_NCM_COMPLETE_CURRENT_PROOF_REQUIRED');}
 const sqlFragments=a?(await f.admin.query('SELECT tax13_legal_current_fragments($1) fragments',[a])).rows[0].fragments:null;
 let accepted=false,err:any;
 if(a){const fragments=c.fragments??c.parts;
  try{await rawScan(f,a,fragments,[{code:'10063011',excerpt:'10063011'}]);accepted=true;}catch(e){err=e;}
 }
 const bridge=await f.bridge(),stored=(await f.admin.query('SELECT count(*)::int n FROM publication_ncm_scan_evidence WHERE publication_version_id=$1',[f.version])).rows[0].n;
 const ncmR=await fetch(address+'/api/v1/publications/'+f.pub+'/ncms',{headers});assert.equal(ncmR.status,200);const ncm:any=await ncmR.json();
 const affinityR=await fetch(address+'/api/v1/companies/'+company+'/publications/'+f.pub+'/affinity',{headers});assert.equal(affinityR.status,200);const affinity:any=await affinityR.json();
 const obs={label:c.label,sha:'TAX13_ARCH02_R8_CANDIDATE',publicationId:f.pub,versionId:f.version,attestationId:a,nodeValid:proof?.valid??false,nodeReason:proof?.reason??'ATTESTATION_REJECTED',normalWorkerRejected,sqlFragments:sqlFragments===null?null:sqlFragments.map((s:string)=>s.length<250?s:{length:s.length,sha256:h(s)}),accepted,sqlstate:err?.code??attError?.code,error:err?.message??attError?.message,stored,bridge,ncmCodes:ncm.attestedCurrentNcmCodes,ncmVerification:ncm.items?.map((i:any)=>i.verificationStatus),score:affinity.score,matches:affinity.matches};
 observations.push(obs);if((!proof?.valid&&sqlFragments!==null)||(!proof?.valid&&accepted))console.log('R6 DIVERGENCE',JSON.stringify(obs));
 if(!a){assert.ok(['23514','P0001','22023'].includes(attError?.code));}
 if(!accepted&&a){assert.match(err?.message,/TAX13_NCM_SCAN_(CODE_NOT_IN_CURRENT_FRAGMENT|INCOMPLETE_OR_UNVERIFIED)/);assert.equal(err.code,'P0001');}
 if(!accepted){assert.equal(stored,0);assert.equal(bridge.fingerprint,null);assert.deepEqual(bridge.codes,[]);}
 if(!proof?.valid){
  assert.equal(sqlFragments===null,true,'Node invalid evidence cannot expose CURRENT fragments');
  assert.equal(accepted,false);assert.equal(stored,0);assert.deepEqual(ncm.attestedCurrentNcmCodes,[]);assert.equal(affinity.score,0);
 }else if(sqlFragments!==null){assert.deepEqual(sqlFragments,proof.currentFragments);}
 }finally{await f.close();}
});


