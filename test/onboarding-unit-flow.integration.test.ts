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
  const path=`/api/v1/companies/${company}/onboarding?establishmentId=${branch.id}`;
  const read=async()=>{const r=await app.inject({method:'GET',url:path,headers});assert.equal(r.statusCode,200,r.body);return r.json();};
  let data=await read();await read();assert.equal(data.version,0);assert.ok(data.cards.length);assert.ok(data.cards.every((c:{establishmentId:string;cnaeCode:string})=>c.establishmentId===branch.id&&c.cnaeCode==='4632001'));assert.deepEqual(data.effectiveProfiles.map((p:{establishmentId:string})=>p.establishmentId),[branch.id]);assert.equal((await admin.query('SELECT id FROM company_tax_profiles WHERE company_id=$1',[company])).rowCount,0);
  const save=(cardId:string,extra:Record<string,unknown>={})=>app.inject({method:'PUT',url:path,headers,payload:{selectionMode:'EFFECTIVE',expectedVersion:data.version,releaseId:data.release.id,cardId,status:'CONFIRMED',...extra}});
  assert.equal((await save('profile',{establishmentId:head.id,conceptCodes:[],ncmCodes:[]})).statusCode,400,'scoped route cannot change a sibling');
  for(const card of ['company','establishments']){const r=await save(card);assert.equal(r.statusCode,200,r.body);data=await read();assert.ok(data.state.cards[card]);}
  assert.equal((await save('summary')).statusCode,409,'cannot conclude before segment/dimension review');
  for(const segment of new Set<string>(data.segmentCards.map((c:{segmentCode:string})=>c.segmentCode))){const r=await save('segment:'+segment,{units:[{establishmentId:branch.id,conceptCodes:[],ncmCodes:[]}]});assert.equal(r.statusCode,200,r.body);data=await read();}
  for(const dim of data.dimensions as {code:string}[]){
   const concept=data.concepts.find((c:{dimensionCode:string})=>c.dimensionCode===dim.code);
   const extra={establishmentId:branch.id,conceptCodes:concept?[concept.code]:[],ncmCodes:[]};
   const attempts=await Promise.all([save('dimension:'+dim.code,extra),save('dimension:'+dim.code,extra)]);assert.deepEqual(attempts.map(r=>r.statusCode).sort(),[200,409]);data=await read();assert.ok(data.state.cards['dimension:'+dim.code]);
   if(concept)assert.ok(data.effectiveProfiles[0].conceptCodes.includes(concept.code));
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
 }finally{await app.close();if(tenant){await admin.query('DELETE FROM tenant_memberships WHERE tenant_id=$1',[tenant]);await admin.query('DELETE FROM tenants WHERE id=$1',[tenant]);}if(user)await admin.query('DELETE FROM app_users WHERE id=$1',[user]);await admin.end();}
});
