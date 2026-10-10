/**
 * Trifaros TAX-11: isolated operational authorisation checks.
 * This coverage is deliberately independent of legal CURRENT.
 * The original end-to-end positive curation test stays in CI and MUST fail
 * closed until authentic official provenance is admitted by TAX13-R8-02.
 *
 * Ephemeral GitHub CI PostgreSQL only; no production network/services.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {Pool} from 'pg';
import {buildApp} from '../src/app.js';

const adminUrl=process.env.DATABASE_ADMIN_URL;
if(!adminUrl||process.env.NODE_ENV!=='test'||process.env.GITHUB_ACTIONS!=='true'||
 !['127.0.0.1','localhost'].includes(new URL(adminUrl).hostname))
 throw new Error('TRIFAROS_TAX11_DISPOSABLE_CI_DATABASE_ONLY');
const password='Curadoria-Segura-2026!';

test('TAX-11 operational: only an authorized curator can access administration (NO legal CURRENT)',async()=>{
 const admin=new Pool({connectionString:adminUrl,max:1});
 const app=await buildApp();
 try{
  const register=async(label:string)=>{
   const email='trifaros-tax11-'+label+'-'+randomUUID()+'@example.test';
   const reg=await app.inject({method:'POST',url:'/auth/register',
    payload:{name:'Curadoria '+label,email,company:'Curadoria '+label,
     password,confirmPassword:password,acceptedTerms:true}});
   assert.equal(reg.statusCode,201,reg.body);
   const userId=(reg.json() as {user:{id:string}}).user.id;
   const tenantId=(reg.json() as {tenant:{id:string}}).tenant.id;
   const login=await app.inject({method:'POST',url:'/auth/login',
    payload:{email,password}});
   assert.equal(login.statusCode,200,login.body);
   const accessToken=(login.json() as {accessToken:string}).accessToken;
   return {userId,headers:{
    authorization:'Bearer '+accessToken,'x-tenant-id':tenantId,
   }};
  };
  const curator=await register('curator');
  const customer=await register('customer');
  await admin.query(`INSERT INTO public.platform_user_roles(user_id,role,granted_by)
    VALUES($1,'TAXONOMY_CURATOR','TRIFAROS-TAX11-CI'),($1,'PLATFORM_ADMIN','TRIFAROS-TAX11-CI')`,
    [curator.userId]);

  const denied=await app.inject({method:'GET',
   url:'/api/v1/admin/taxonomy/state',headers:customer.headers});
  assert.equal(denied.statusCode,403,'a customer is not a taxonomy curator');

  const customerMe=await app.inject({method:'GET',
   url:'/api/v1/admin/me',headers:customer.headers});
  assert.equal(customerMe.statusCode,200,customerMe.body);
  assert.equal(customerMe.json().taxonomyCurator,false);
  const curatorMe=await app.inject({method:'GET',
   url:'/api/v1/admin/me',headers:curator.headers});
  assert.equal(curatorMe.statusCode,200,curatorMe.body);
  assert.equal(curatorMe.json().taxonomyCurator,true);
  assert.equal(curatorMe.json().curatorDatabase,true);

  const state=await app.inject({method:'GET',
   url:'/api/v1/admin/taxonomy/state',headers:curator.headers});
  assert.equal(state.statusCode,200,state.body);
  assert.equal(typeof state.json().settings.classificationEnabled,'boolean');

  const unjustified=await app.inject({method:'POST',
   url:'/api/v1/admin/taxonomy/drafts',headers:curator.headers,
   payload:{justification:''}});
  assert.equal(unjustified.statusCode,400,
   'creating a curator draft must require justification');
  // No publication, legal-scope attestation, proof, NCM seal or green legal
  // classification is inserted. The full positive legal gate remains intact.
 }finally{
  await app.close();
  await admin.end();
 }
});
