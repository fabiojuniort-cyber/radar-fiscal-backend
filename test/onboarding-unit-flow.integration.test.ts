import {dimensionGroups} from '../src/modules/onboarding/assistant.dimensions.js';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {Pool} from 'pg';
import {buildApp} from '../src/app.js';
import {ensureCnaeFixture} from './onboarding-cnae-fixture.js';
function cnpj(base:string){let out=base;for(const weights of [[5,4,3,2,9,8,7,6,5,4,3,2],[6,5,4,3,2,9,8,7,6,5,4,3,2]]){const mod=weights.reduce((n,w,i)=>n+w*Number(out[i]),0)%11;out+=String(mod<2?0:11-mod)}return out;}
test('ONB-03.5 unified CNPJ, scoped CNAEs, dimension CAS and minimal inline correction',async()=>{
 assert.ok(process.env.DATABASE_ADMIN_URL);
 const admin=new Pool({connectionString:process.env.DATABASE_ADMIN_URL,max:1}),app=await buildApp();let tenant='',user='';
 try{
  await app.ready();await ensureCnaeFixture(admin);
  const email=`onb035-${randomUUID()}@example.test`,password='ONB035-Synthetic-Secure-2026!';
  const registration=await app.inject({method:'POST',url:'/auth/register',payload:{name:'Synthetic ONB035',email,password,confirmPassword:password,acceptedTerms:true}});assert.equal(registration.statusCode,201,registration.body);tenant=registration.json().tenant.id;user=registration.json().user.id;
  const login=await app.inject({method:'POST',url:'/auth/login',payload:{email,password}}),headers={authorization:'Bearer '+login.json().accessToken,'x-tenant-id':tenant};
  const root=randomUUID().replace(/\D/g,'').padEnd(8,'4').slice(0,8);
  const payload={cnpj:cnpj(root+'0002'),legalName:'Synthetic root company',uf:'GO',typeCode:'OTHER',resolveCompanyByRoot:true,cnaes:[{code:'6201501',description:'ignored browser label',isPrimary:true}]};
  const create=await app.inject({method:'POST',url:'/api/v1/companies/manual',headers,payload});assert.equal(create.statusCode,201,create.body);const company=create.json().company.id,head=create.json().establishment;
  assert.equal(head.isHeadOffice,true);assert.equal(head.typeCode,'OTHER');assert.equal(head.cnpj,payload.cnpj,'identity is never rewritten to 0001');
  const branchCreate=await app.inject({method:'POST',url:'/api/v1/companies/manual',headers,payload:{...payload,cnpj:cnpj(root+'0003'),establishmentName:'Branch only',cnaes:[{code:'4632001',description:'ignored',isPrimary:true}]}});assert.equal(branchCreate.statusCode,201,branchCreate.body);assert.equal(branchCreate.json().company.id,company);const branch=branchCreate.json().establishment;assert.equal(branch.isHeadOffice,false);
  const companies=await admin.query('SELECT id FROM companies WHERE tenant_id=$1',[tenant]);assert.equal(companies.rowCount,1);
  const concurrent=await Promise.all([4,5].map(n=>app.inject({method:'POST',url:'/api/v1/companies/manual',headers,payload:{...payload,cnpj:cnpj(root+'000'+n)}})));assert.deepEqual(concurrent.map(r=>r.statusCode),[201,201]);assert.equal((await admin.query('SELECT id FROM companies WHERE tenant_id=$1',[tenant])).rowCount,1);
  const invalidType=await app.inject({method:'POST',url:'/api/v1/companies/manual',headers,payload:{...payload,cnpj:cnpj(root+'0006'),typeCode:'MISSING'}});assert.equal(invalidType.statusCode,400);
  // Public 35-CNAE Agrex shape, attached to a synthetic matrix in disposable PG only.
  const perfCnaes=[["0111301", "Cultivo de arroz"], ["0111302", "Cultivo de milho"], ["0111399", "Cultivo de outros cereais não especificados anteriormente"], ["0112101", "Cultivo de algodão herbáceo"], ["0115600", "Cultivo de soja"], ["0141501", "Produção de sementes certificadas, exceto de forrageiras para pasto"], ["0161099", "Atividades de apoio à agricultura não especificadas anteriormente"], ["0210107", "Extração de madeira em florestas plantadas"], ["1066000", "Fabricação de alimentos para animais"], ["1069400", "Moagem e fabricação de produtos de origem vegetal não especificados anteriormente"], ["4612500", "Representantes comerciais e agentes do comércio de combustíveis, minerais, produtos siderúrgicos e químicos"], ["4623106", "Comércio atacadista de sementes, flores, plantas e gramas"], ["4623108", "Comércio atacadista de matérias-primas agrícolas com atividade de fracionamento e acondicionamento associada"], ["4623109", "Comércio atacadista de alimentos para animais"], ["4623199", "Comércio atacadista de matérias-primas agrícolas não especificadas anteriormente"], ["4632003", "Comércio atacadista de cereais e leguminosas beneficiados, farinhas, amidos e féculas, com atividade de fracionamento e acondicionamento associada"], ["4637199", "Comércio atacadista especializado em outros produtos alimentícios não especificados anteriormente"], ["4683400", "Comércio atacadista de defensivos agrícolas, adubos, fertilizantes e corretivos do solo"], ["4692300", "Comércio atacadista de mercadorias em geral, com predominância de insumos agropecuários"], ["4732600", "Comércio varejista de lubrificantes"], ["4930202", "Transporte rodoviário de carga, exceto produtos perigosos e mudanças, intermunicipal, interestadual e internacional"], ["5211701", "Armazéns gerais - emissão de warrant"], ["5211799", "Depósitos de mercadorias para terceiros, exceto armazéns gerais e guarda-móveis"], ["5212500", "Carga e descarga"], ["5231102", "Atividades do Operador Portuário"], ["5250805", "Operador de transporte multimodal - OTM"], ["6463800", "Outras sociedades de participação, exceto holdings"], ["6612604", "Corretoras de contratos de mercadorias"], ["6810202", "Aluguel de imóveis próprios"], ["7120100", "Testes e análises técnicas"], ["7490103", "Serviços de agronomia e de consultoria às atividades agrícolas e pecuárias"], ["7490104", "Atividades de intermediação e agenciamento de serviços e negócios em geral, exceto imobiliários"], ["7729202", "Aluguel de móveis, utensílios e aparelhos de uso doméstico e pessoal; instrumentos musicais"], ["7820500", "Locação de mão de obra temporária"], ["8211300", "Serviços combinados de escritório e apoio administrativo"]];
  await admin.query('DELETE FROM establishment_cnaes WHERE establishment_id=$1',[head.id]);
  for(const [code,description] of perfCnaes){await admin.query('INSERT INTO cnaes(code,description) VALUES($1,$2) ON CONFLICT(code) DO NOTHING',[code,description]);await admin.query('INSERT INTO establishment_cnaes(establishment_id,cnae_code,is_primary) VALUES($1,$2,$3)',[head.id,code,code==='4623108']);}
  const perfPath=`/api/v1/companies/${company}/onboarding?establishmentId=${head.id}`;
  const initialPerf=await app.inject({method:'GET',url:perfPath,headers});assert.equal(initialPerf.statusCode,200,initialPerf.body);let perfData=initialPerf.json();assert.equal(new Set(perfData.cards.map((c:{cnaeCode:string})=>c.cnaeCode)).size,35);
  const durations:number[]=[];
  for(let i=0;i<12;i++){const begin=performance.now();const r=await app.inject({method:'PUT',url:perfPath,headers,payload:{selectionMode:'EFFECTIVE',expectedVersion:perfData.version,releaseId:perfData.release.id,cardId:'company',status:'CONFIRMED'}});assert.equal(r.statusCode,200,r.body);perfData=r.json();assert.ok(Array.isArray(perfData.effectiveProfiles),'save response replaces a full GET');durations.push(performance.now()-begin);}
  const sorted=durations.toSorted((a,b)=>a-b),p95=sorted[Math.ceil(sorted.length*.95)-1]!;
  console.log('ONB036_SAVE_PERFORMANCE '+JSON.stringify({environment:'disposable PostgreSQL / app.inject, warm immutable release',cnaes:35,samples:durations.length,p50Ms:sorted[Math.floor(sorted.length*.5)],p95Ms:p95,maxMs:sorted.at(-1),putOnly:true}));assert.ok(p95<1000,`warm 35-CNAE card save p95 ${p95.toFixed(1)}ms must be <1000ms`);
  const path=`/api/v1/companies/${company}/onboarding?establishmentId=${branch.id}`;
  const read=async()=>{const r=await app.inject({method:'GET',url:path,headers});assert.equal(r.statusCode,200,r.body);return r.json();};
  let data=await read();await read();assert.equal(data.version,12);assert.ok(data.cards.length);assert.ok(data.cards.every((c:{establishmentId:string;cnaeCode:string})=>c.establishmentId===branch.id&&c.cnaeCode==='4632001'));assert.deepEqual(data.effectiveProfiles.map((p:{establishmentId:string})=>p.establishmentId),[branch.id]);assert.equal((await admin.query('SELECT id FROM company_tax_profiles WHERE company_id=$1',[company])).rowCount,12,'GET does not append profile versions');
  const save=(cardId:string,extra:Record<string,unknown>={})=>app.inject({method:'PUT',url:path,headers,payload:{selectionMode:'EFFECTIVE',expectedVersion:data.version,releaseId:data.release.id,cardId,status:'CONFIRMED',...extra}});
  assert.equal((await save('profile',{establishmentId:head.id,conceptCodes:[],ncmCodes:[]})).statusCode,400,'scoped route cannot change a sibling');
  for(const card of ['company','establishments']){const r=await save(card);assert.equal(r.statusCode,200,r.body);data=await read();assert.ok(data.state.cards[card]);}
  assert.equal((await save('summary')).statusCode,409,'cannot conclude before segment/dimension review');
  for(const segment of new Set<string>(data.segmentCards.map((c:{segmentCode:string})=>c.segmentCode))){const r=await save('segment:'+segment,{units:[{establishmentId:branch.id,conceptCodes:[],ncmCodes:[]}]});assert.equal(r.statusCode,200,r.body);data=await read();}
  for(const group of dimensionGroups){
   const prior=structuredClone(data.effectiveProfiles[0]);
   const selected=group.dimensions.flatMap(code=>{const c=data.concepts.find((c:{dimensionCode:string})=>c.dimensionCode===code);return c?[c.code]:[]});
   const extra={establishmentId:branch.id,conceptCodes:selected,ncmCodes:[]};
   const outsider=data.concepts.find((c:{dimensionCode:string})=>!group.dimensions.includes(c.dimensionCode));
   if(outsider){const rejected=await save('dimension-group:'+group.code,{...extra,conceptCodes:[outsider.code]});assert.equal(rejected.statusCode,400,rejected.body);assert.equal((await read()).version,data.version,'invalid group is an atomic no-op');}
   const attempts=await Promise.all([save('dimension-group:'+group.code,extra),save('dimension-group:'+group.code,extra)]);assert.deepEqual(attempts.map(r=>r.statusCode).sort(),[200,409]);data=await read();assert.ok(data.state.cards['dimension-group:'+group.code]);
   for(const code of selected)assert.ok(data.effectiveProfiles[0].conceptCodes.includes(code));
   for(const code of prior.conceptCodes.filter((code:string)=>!data.concepts.some((c:{code:string;dimensionCode:string})=>c.code===code&&group.dimensions.includes(c.dimensionCode))))assert.ok(data.effectiveProfiles[0].conceptCodes.includes(code),'another group preserved');
   assert.deepEqual(data.effectiveProfiles[0].ncmCodes,prior.ncmCodes);
  }
  const done=await save('summary');assert.equal(done.statusCode,200,done.body);data=await read();assert.equal(data.state.completed,true);
  const global=await app.inject({method:'GET',url:path.split('?')[0]!,headers});assert.equal(global.json().state.completed,false,'a branch completion cannot complete the matrix');assert.deepEqual(global.json().effectiveProfiles.find((p:{establishmentId:string})=>p.establishmentId===head.id).conceptCodes,[]);
  const snapshot=async()=> (await admin.query('SELECT to_jsonb(e) AS unit,(SELECT jsonb_agg(to_jsonb(c)) FROM establishment_cnaes c WHERE c.establishment_id=e.id) AS cnaes,(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.version_no) FROM company_tax_profiles p WHERE p.company_id=e.company_id) AS profiles FROM establishments e WHERE e.id=$1',[branch.id])).rows[0];
  const before=await snapshot();const expected={legalName:'Synthetic root company',businessLocationCode:null,street:null,streetNumber:null,district:null,complement:null,municipalityName:null,municipalityIbgeCode:null,postalCode:null,uf:'GO'};
  const correctionPath=`/api/v1/companies/${company}/establishments/${branch.id}/onboarding-data`,values={...expected,legalName:'Corrected company',street:'Rua corrigida',streetNumber:'42',businessLocationCode:'FILIAL-35'};
  const correct=()=>app.inject({method:'PATCH',url:correctionPath,headers,payload:{expected,values}});
  const edits=await Promise.all([correct(),correct()]);assert.deepEqual(edits.map(r=>r.statusCode).sort(),[200,409]);const after=await snapshot();assert.deepEqual(after.cnaes,before.cnaes);assert.deepEqual(after.profiles,before.profiles);
  const changed=new Set(['street','street_number','business_location_code','updated_at']);for(const key of Object.keys(before.unit))if(!changed.has(key))assert.deepEqual(after.unit[key],before.unit[key],key+' preserved');
  assert.equal((await app.inject({method:'PATCH',url:correctionPath,headers,payload:{expected,values:{...values,stateRegistration:'must not overwrite'}}})).statusCode,400);
  const currentExpected={...values,stateRegistration:after.unit.state_registration};
  const ie=await app.inject({method:'PATCH',url:correctionPath,headers,payload:{expected:currentExpected,values:{...currentExpected,stateRegistration:'123456789'}}});assert.equal(ie.statusCode,200,ie.body);assert.equal(ie.json().stateRegistrationSource,'MANUAL');
  assert.equal((await app.inject({method:'PATCH',url:correctionPath,headers,payload:{expected:currentExpected,values:{...currentExpected,stateRegistration:'999'}}})).statusCode,409,'IE CAS protects the whole atomic correction');
  assert.deepEqual((await snapshot()).profiles,before.profiles,'IE correction never migrates profiles');
 }finally{await app.close();if(tenant){await admin.query('DELETE FROM tenant_memberships WHERE tenant_id=$1',[tenant]);await admin.query('DELETE FROM tenants WHERE id=$1',[tenant]);}if(user)await admin.query('DELETE FROM app_users WHERE id=$1',[user]);await admin.end();}
});


test('ONB-03.6: root-confirmed purge removes linked and legacy separate branches; old intent and another tenant/root remain protected',async()=>{
 const admin=new Pool({connectionString:process.env.DATABASE_ADMIN_URL,max:1}),app=await buildApp();const tenants:string[]=[],users:string[]=[];
 try{
  await app.ready();await ensureCnaeFixture(admin);
  const owner=async()=>{const email=`onb036-${randomUUID()}@example.test`,password='ONB036-Synthetic-Secure-2026!';const r=await app.inject({method:'POST',url:'/auth/register',payload:{name:'ONB036 owner',email,password,confirmPassword:password,acceptedTerms:true}});assert.equal(r.statusCode,201,r.body);tenants.push(r.json().tenant.id);users.push(r.json().user.id);const login=await app.inject({method:'POST',url:'/auth/login',payload:{email,password}});return {tenant:r.json().tenant.id as string,headers:{authorization:'Bearer '+login.json().accessToken,'x-tenant-id':r.json().tenant.id as string}};};
  const a=await owner(),b=await owner(),root=randomUUID().replace(/\D/g,'').padEnd(8,'6').slice(0,8);
  const create=async(account:typeof a,n:string,companyRoot=root)=>{const r=await app.inject({method:'POST',url:'/api/v1/companies/manual',headers:account.headers,payload:{cnpj:cnpj(companyRoot+n),legalName:'Synthetic ONB036',uf:'GO',typeCode:'OTHER',resolveCompanyByRoot:true,cnaes:[{code:'6201501',description:'ignored',isPrimary:true}]}});assert.equal(r.statusCode,201,r.body);return r.json();};
  const target=await create(a,'0001'),linked=await create(a,'0002'),remote=await create(b,'0001'),unrelated=await create(a,'0001',root==='12345678'?'87654321':'12345678');assert.equal(linked.company.id,target.company.id);
  await admin.query("UPDATE companies SET legal_name='Different root preserved' WHERE id=$1",[unrelated.company.id]);
  // Reproduce a pre-unified registration: a branch CNPJ exists as a separate company.
  const legacy=(await admin.query("INSERT INTO companies(tenant_id,head_office_cnpj,legal_name) VALUES($1,$2,'Legacy separate branch') RETURNING id",[a.tenant,cnpj(root+'0003')])).rows[0].id;
  const legacyUnit=(await admin.query("INSERT INTO establishments(company_id,name,cnpj,establishment_type_code,uf,is_head_office) VALUES($1,'Legacy branch',$2,'OTHER','GO',true) RETURNING id",[legacy,cnpj(root+'0003')])).rows[0].id;
  await admin.query("INSERT INTO company_tax_profiles(company_id,version_no,tax_regime,valid_from,is_current) VALUES($1,1,'NAO_INFORMADO',CURRENT_DATE,true)",[legacy]);
  const path='/api/v1/companies/'+target.company.id;
  const old=await app.inject({method:'DELETE',url:path,headers:{...a.headers,'x-company-delete-intent':'permanent-v1'}});assert.equal(old.statusCode,409,old.body);assert.equal(old.json().error,'company_root_delete_confirmation_required');assert.equal((await admin.query('SELECT count(*) FROM companies WHERE tenant_id=$1',[a.tenant])).rows[0].count,'3');
  // Make the LAST family graph fail the existing legacy-identity guard, after
  // an earlier graph would already have cascaded. The outer transaction must undo all of it.
  const accountName=(await admin.query('SELECT name FROM tenants WHERE id=$1',[a.tenant])).rows[0].name;
  const last=(await admin.query('SELECT legal_name FROM companies WHERE id=ANY($1::uuid[]) ORDER BY id DESC LIMIT 1',[[target.company.id,legacy]])).rows[0].legal_name;
  await admin.query('UPDATE tenants SET name=$1 WHERE id=$2',[last,a.tenant]);
  const blocked=await app.inject({method:'DELETE',url:path,headers:{...a.headers,'x-company-delete-intent':'permanent-root-v1'}});assert.equal(blocked.statusCode,409,blocked.body);
  assert.equal((await admin.query('SELECT count(*) FROM companies WHERE id=ANY($1::uuid[])',[[target.company.id,legacy]])).rows[0].count,'2','root purge rolls back an earlier graph');
  assert.equal((await admin.query('SELECT count(*) FROM establishments WHERE id=ANY($1::uuid[])',[[target.establishment.id,linked.establishment.id,legacyUnit]])).rows[0].count,'3','cascade is rolled back atomically');
  assert.equal((await admin.query("SELECT count(*) FROM audit_log WHERE tenant_id=$1 AND action='COMPANY_PURGED'",[a.tenant])).rows[0].count,'0','no partial success audit survives');
  await admin.query('UPDATE tenants SET name=$1 WHERE id=$2',[accountName,a.tenant]);
  // Same legal name is normal for branches; verified signup CNPJ/root must
  // distinguish that case from an unrelated custom account label.
  await admin.query('UPDATE companies SET legal_name=$1 WHERE id=$2',['Synthetic ONB036',legacy]);
  await admin.query("UPDATE tenant_onboarding_profiles SET cnpj=$1,company_name='Synthetic ONB036' WHERE tenant_id=$2",[target.company.cnpj??cnpj(root+'0001'),a.tenant]);
  await admin.query("UPDATE tenants SET name='Synthetic ONB036' WHERE id=$1",[a.tenant]);
  const deleted=await app.inject({method:'DELETE',url:path,headers:{...a.headers,'x-company-delete-intent':'permanent-root-v1'}});assert.equal(deleted.statusCode,204,deleted.body);
  assert.equal((await admin.query('SELECT count(*) FROM companies WHERE id=ANY($1::uuid[])',[[target.company.id,legacy]])).rows[0].count,'0');
  assert.equal((await admin.query('SELECT count(*) FROM establishments WHERE id=ANY($1::uuid[])',[[target.establishment.id,linked.establishment.id,legacyUnit]])).rows[0].count,'0');
  assert.equal((await admin.query('SELECT count(*) FROM company_tax_profiles WHERE company_id=$1',[legacy])).rows[0].count,'0');
  assert.equal((await admin.query('SELECT count(*) FROM companies WHERE id=ANY($1::uuid[])',[[remote.company.id,unrelated.company.id]])).rows[0].count,'2');
  assert.equal((await admin.query("SELECT count(*) FROM audit_log WHERE tenant_id=$1 AND action='COMPANY_PURGED'",[a.tenant])).rows[0].count,'2');
 }finally{await app.close();for(const tenant of tenants){await admin.query('DELETE FROM audit_log WHERE tenant_id=$1',[tenant]);await admin.query('DELETE FROM tenants WHERE id=$1',[tenant]);}for(const user of users)await admin.query('DELETE FROM app_users WHERE id=$1',[user]);await admin.end();}
});
