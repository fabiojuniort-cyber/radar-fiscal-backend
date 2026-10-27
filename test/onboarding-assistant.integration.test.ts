import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {Pool} from 'pg';
import {buildApp} from '../src/app.js';
import {ensureCnaeFixture} from './onboarding-cnae-fixture.js';
function cnpj(base:string){let out=base;for(const weights of [[5,4,3,2,9,8,7,6,5,4,3,2],[6,5,4,3,2,9,8,7,6,5,4,3,2]]){const mod=[...weights].reduce((n,w,i)=>n+w*Number(out[i]),0)%11;out+=String(mod<2?0:11-mod)}return out}
test('assistant: read-only resume, tenant/unit boundaries, stale card and legacy snapshot, blank filial, skip and conclude',async()=>{
 assert.ok(process.env.DATABASE_ADMIN_URL);
 const admin=new Pool({connectionString:process.env.DATABASE_ADMIN_URL,max:1}),app=await buildApp();
 const tenants:string[]=[],users:string[]=[];
 try{
  await app.ready();await ensureCnaeFixture(admin);
  const owner=async()=>{const email='onb03-'+randomUUID()+'@example.test',password='Synthetic-Onb03-Password-2026!';const registered=await app.inject({method:'POST',url:'/auth/register',payload:{name:'Synthetic owner',email,password,confirmPassword:password,acceptedTerms:true}});assert.equal(registered.statusCode,201,registered.body);const r=registered.json();tenants.push(r.tenant.id);users.push(r.user.id);const login=await app.inject({method:'POST',url:'/auth/login',payload:{email,password}});assert.equal(login.statusCode,200,login.body);return {authorization:'Bearer '+login.json().accessToken,'x-tenant-id':r.tenant.id}};
  const a=await owner(),b=await owner();
  const root=randomUUID().replace(/\D/g,'').padEnd(8,'7').slice(0,8);
  const create=await app.inject({method:'POST',url:'/api/v1/companies/manual',headers:a,payload:{cnpj:cnpj(root+'0001'),legalName:'Synthetic ONB03',uf:'GO',cnaes:[{code:'6201501',description:'Synthetic',isPrimary:true}]}});
  assert.equal(create.statusCode,201,create.body);const company=create.json().company.id,head=create.json().establishment.id,path='/api/v1/companies/'+company+'/onboarding';
  const read=async()=>{const r=await app.inject({method:'GET',url:path,headers:a});assert.equal(r.statusCode,200,r.body);return r.json()};
  const before=await admin.query('SELECT count(*)::int AS n FROM company_tax_profiles WHERE company_id=$1',[company]);
  let data=await read();await read();assert.equal(data.version,0);assert.deepEqual(data.state.units,{});
  const after=await admin.query('SELECT count(*)::int AS n FROM company_tax_profiles WHERE company_id=$1',[company]);assert.deepEqual(after.rows,before.rows,'GET never creates a profile');
  assert.equal((await app.inject({method:'GET',url:path,headers:b})).statusCode,404);
  const save=(cardId:string,version:number,extra:Record<string,unknown>={})=>app.inject({method:'PUT',url:path,headers:a,payload:{expectedVersion:version,releaseId:data.release.id,cardId,status:'CONFIRMED',...extra}});
  const concurrent=await Promise.all([save('company',0),save('company',0)]);assert.deepEqual(concurrent.map(r=>r.statusCode).sort(),[200,409]);
  assert.equal((await save('establishments',0)).statusCode,409,'second screen retains stale version');
  assert.equal((await save('establishments',1)).statusCode,200);
  const legacy=await app.inject({method:'PUT',url:'/api/v1/companies/'+company+'/tax-profile',headers:a,payload:{expectedVersion:1,taxRegime:'LUCRO_REAL',personalization:{establishmentOverrides:[]}}});assert.equal(legacy.statusCode,409,legacy.body);
  assert.equal((await save('cnae:6201501',2,{establishmentId:randomUUID()})).statusCode,400);
  assert.equal((await save('cnae:0000000',2,{establishmentId:head})).statusCode,400);
  assert.equal((await save('cnae:6201501',2,{establishmentId:head,ncmCodes:['99999999']})).statusCode,400);
  assert.equal((await save('cnae:6201501',2,{establishmentId:head,releaseId:randomUUID()})).statusCode,409);
  assert.equal((await save('cnae:6201501',2,{establishmentId:head,status:'SKIPPED'})).statusCode,200);
  data=await read();assert.equal(data.state.units[head].cards['cnae:6201501'].status,'SKIPPED');
  const branch=await app.inject({method:'POST',url:'/api/v1/establishments/manual',headers:a,payload:{companyId:company,cnpj:cnpj(root+'0002'),name:'Synthetic branch',typeCode:'OTHER',uf:'GO',cnaes:[{code:'6201501',description:'Synthetic',isPrimary:true}]}});
  assert.equal(branch.statusCode,201,branch.body);const branchId=branch.json().establishment.id;
  data=await read();assert.equal(data.state.units[branchId],undefined);assert.equal(data.cards.filter((c:{establishmentId:string})=>c.establishmentId===branchId).length,1);
  assert.equal((await save('summary',3)).statusCode,409,'new filial requires its own card');
  assert.equal((await save('cnae:6201501',3,{establishmentId:branchId,status:'SKIPPED'})).statusCode,200);
  assert.equal((await save('summary',4)).statusCode,200);
  data=await read();assert.equal(data.state.completed,true);assert.equal(data.version,5);

  // Inline IE writes neither profile versions nor other establishment fields.
  const snapshot=async()=> (await admin.query(
    'SELECT to_jsonb(e) AS unit,(SELECT jsonb_agg(to_jsonb(ec) ORDER BY ec.cnae_code) FROM establishment_cnaes ec WHERE ec.establishment_id=e.id) AS cnaes,(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM company_tax_profiles p WHERE p.company_id=e.company_id) AS profiles FROM establishments e WHERE e.id=$1',[branchId])).rows[0];
  const beforeIe=await snapshot();
  const ieUrl='/api/v1/companies/'+company+'/establishments/'+branchId+'/state-registration';
  const patchIe=(expected:string|null,value:string|null,headers=a,url=ieUrl)=>app.inject({
    method:'PATCH',url,headers,payload:{expectedStateRegistration:expected,stateRegistration:value}});
  assert.equal((await patchIe(null,'123456789',b)).statusCode,404,'tenant cannot reach another company');
  assert.equal((await patchIe(null,'123456789',a,ieUrl.replace(branchId,randomUUID()))).statusCode,404);
  await admin.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'VIEWER')",[tenants[0],users[1]]);
  assert.equal((await patchIe(null,'123456789',{...b,'x-tenant-id':tenants[0]!})).statusCode,403,'member cannot edit IE');
  const ieWrites=await Promise.all([patchIe(null,'123456789'),patchIe(null,'987654321')]);
  assert.deepEqual(ieWrites.map(r=>r.statusCode).sort(),[200,409],'stale IE must not overwrite');
  const savedIe=ieWrites.find(r=>r.statusCode===200)!.json();
  assert.equal(savedIe.establishmentId,branchId);
  assert.equal(savedIe.stateRegistrationSource,'MANUAL');
  assert.equal((await patchIe(null,'111111111')).statusCode,409);
  assert.equal((await app.inject({method:'PATCH',url:ieUrl,headers:a,payload:{expectedStateRegistration:savedIe.stateRegistration,stateRegistration:'X'.repeat(31)}})).statusCode,400);
  assert.equal((await app.inject({method:'PATCH',url:ieUrl,headers:a,payload:{expectedStateRegistration:savedIe.stateRegistration,stateRegistration:'123',name:'must not write'}})).statusCode,400);
  const afterIe=await snapshot();
  assert.deepEqual(afterIe.profiles,beforeIe.profiles,'all profile rows byte-equivalent');
  assert.deepEqual(afterIe.cnaes,beforeIe.cnaes,'CNAEs untouched');
  const ieFields=new Set(['state_registration','state_registration_source','state_registration_status','state_registration_checked_at','state_registration_lookup_status','updated_at']);
  for(const key of Object.keys(beforeIe.unit)) if(!ieFields.has(key)) assert.deepEqual(afterIe.unit[key],beforeIe.unit[key],key+' preserved');
  const unitsAfter=await app.inject({method:'GET',url:'/api/v1/companies/'+company+'/establishments',headers:a});
  assert.equal(unitsAfter.json().items.find((u:{id:string})=>u.id===branchId).stateRegistration,savedIe.stateRegistration);
  assert.equal(unitsAfter.json().items.find((u:{id:string})=>u.id===head).stateRegistration,null,'matrix unchanged');
  const unchanged=await snapshot();assert.equal((await patchIe(savedIe.stateRegistration,savedIe.stateRegistration)).statusCode,200);assert.deepEqual(await snapshot(),unchanged,'no-op does not change timestamps/provenance');
  const cleared=await patchIe(savedIe.stateRegistration,'   ');assert.equal(cleared.statusCode,200);assert.equal(cleared.json().stateRegistration,null);

  await admin.query("UPDATE company_tax_profiles SET personalization=jsonb_set(personalization,'{taxonomy}', $1::jsonb) WHERE company_id=$2 AND is_current=true",[JSON.stringify({releaseId:randomUUID(),releaseVersion:'v0.0.1',conceptCodes:['product.unknown_historical']}),company]);
  const historical=await save('company',5);assert.equal(historical.statusCode,409,historical.body);assert.equal(historical.json().error,'taxonomy_selection_review_required');
  assert.equal((await read()).version,5,'historical selections cannot be relabeled implicitly');
  const phrases=await app.inject({method:'GET',url:'/api/v1/onboarding/phrases',headers:a});assert.equal(phrases.statusCode,200,phrases.body);assert.equal(phrases.json().items.length,19);assert.ok(phrases.json().items.every((p:{phrases:string[]})=>p.phrases.length===20));
  const forbidden=await app.inject({method:'PUT',url:'/api/v1/admin/onboarding/phrases/generico',headers:a,payload:{expectedVersion:1,phrases:['Unauthorized']}});assert.equal(forbidden.statusCode,403);
  await admin.query("INSERT INTO platform_user_roles(user_id,role,granted_by) VALUES($1,'PLATFORM_ADMIN',$2)",[users[0],users[0]]);
  const original=phrases.json().items.find((row:{segment:string})=>row.segment==='generico');
  try {
    const edit=await app.inject({method:'PUT',url:'/api/v1/admin/onboarding/phrases/generico',headers:a,payload:{expectedVersion:original.version_no,phrases:['Frase sintética de integração.']}});
    assert.equal(edit.statusCode,200,edit.body);
    const stale=await app.inject({method:'PUT',url:'/api/v1/admin/onboarding/phrases/generico',headers:a,payload:{expectedVersion:original.version_no,phrases:['Não deve sobrescrever.']}});
    assert.equal(stale.statusCode,409,stale.body);
    const empty=await app.inject({method:'PUT',url:'/api/v1/admin/onboarding/phrases/generico',headers:a,payload:{expectedVersion:original.version_no+1,phrases:[]}});
    assert.equal(empty.statusCode,400,empty.body);
  } finally { await admin.query('UPDATE onboarding_phrases SET phrases=$1::jsonb,version_no=version_no+1 WHERE segment=$2',[JSON.stringify(original.phrases),'generico']); }
 }finally{await app.close();for(const tenant of tenants){await admin.query('DELETE FROM tenant_memberships WHERE tenant_id=$1',[tenant]);await admin.query('DELETE FROM tenants WHERE id=$1',[tenant])}for(const user of users){await admin.query('DELETE FROM platform_user_roles WHERE user_id=$1',[user]);await admin.query('DELETE FROM app_users WHERE id=$1',[user]);}await admin.end()}
});
