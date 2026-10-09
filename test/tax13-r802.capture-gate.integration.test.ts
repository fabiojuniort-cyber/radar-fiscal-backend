/** TAX13-R8-02: fixtures may NOT pass as official HTTP, PG16/18 disposable only. */
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import test from 'node:test';
import {Pool} from 'pg';
import {seedTestLegalScopeAttestation} from './legal-scope-attestation.fixture.js';
import {renderedLegalText} from '../src/modules/taxonomy/legal-scope/legal-scope-evidence.js';
const adminUrl=process.env.DATABASE_ADMIN_URL;
if(!adminUrl||process.env.NODE_ENV!=='test'||process.env.GITHUB_ACTIONS!=='true'||
 !['127.0.0.1','localhost'].includes(new URL(adminUrl).hostname))
 throw new Error('TAX13_R802_DISPOSABLE_GITHUB_ONLY');
const h=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');

test('R802 synthetic bytes + fake collector cannot establish verified capture or CURRENT',async()=>{
 const db=new Pool({connectionString:adminUrl,max:2});
 try{
  const html='<p class="TextoAcordo">NCM 1006.30.11</p>';
  const raw='<div id="parent-fieldname-text">'+html+'</div>';
  const pub=(await db.query<{id:string}>(`
    INSERT INTO publications(identity_hash,identity_strength,identity_basis,jurisdiction_level,title,published_on)
    VALUES ($1,'STRONG','{}'::jsonb,'FEDERAL','R802 synthetic provenance negative',CURRENT_DATE) RETURNING id`,
    [h(randomUUID())])).rows[0]!.id;
  const version=(await db.query<{id:string}>(`
    INSERT INTO publication_versions(publication_id,version_no,content_hash,content_text,source_metadata,is_current)
    VALUES ($1::uuid,1,$2,$3,$4::jsonb,true) RETURNING id`,
    [pub,h(html),renderedLegalText(html),JSON.stringify({presentation:{format:'SANITIZED_HTML',html}})])).rows[0]!.id;
  const att=await seedTestLegalScopeAttestation(db,version,'COMPLETE',false);
  const origin=(await db.query<{official_url:string}>(
    'SELECT official_url FROM publication_legal_scope_attestations WHERE id=$1::uuid',[att])).rows[0]!.official_url;
  const artifact=(await db.query<{id:string}>(`
    INSERT INTO tax13_v2_original_http_artifacts(publication_version_id,official_url,http_status,
      raw_http_bytes,raw_sha256,sanitized_html_sha256,collected_at,collector_identity)
    VALUES($1::uuid,$2,200,convert_to($3,'UTF8'),$4,$5,statement_timestamp(),
      'CI-SYNTHETIC-NOT-TRUSTED') RETURNING id`,
    [version,origin,raw,h(raw),h(html)])).rows[0]!.id;
  const status=await db.query<{verified:boolean;issuer:boolean;fingerprint:string|null}>(`
   SELECT public.tax13_v2_capture_verified($1::uuid) AS verified,
    public.tax13_v2_original_exists_for_issuer($2::uuid,$3) AS issuer,
    public.tax13_current_ncm_scan_fingerprint($4::uuid) AS fingerprint`,
   [artifact,att,h(raw),version]);
  assert.deepEqual(status.rows[0],{verified:false,issuer:false,fingerprint:null});

  const keyId='r802-ci-neg-'+randomUUID();
  await db.query(`INSERT INTO tax13_v2_capture_mac_keys(key_id,key_bytes)
    VALUES($1,decode($2,'hex'))`,[keyId,randomBytes(32).toString('hex')]);
  await assert.rejects(db.query(`
    INSERT INTO tax13_v2_official_capture_receipts
    (artifact_id,capture_key_id,final_url,redirect_urls,remote_ipv4,tls_peer_cert_sha256,
     collector_identity,started_at,captured_at,receipt_mac)
    SELECT id,$2,official_url,ARRAY[official_url],'8.8.8.8',repeat('a',64),
      'CI-SYNTHETIC-NOT-TRUSTED',collected_at,collected_at,repeat('0',64)
    FROM tax13_v2_original_http_artifacts WHERE id=$1::uuid`,
    [artifact,keyId]),/TAX13_R802_CAPTURE_MAC_INVALID/);
  await assert.rejects(db.query(`
    INSERT INTO tax13_v2_official_capture_receipts
    (artifact_id,capture_key_id,final_url,redirect_urls,remote_ipv4,tls_peer_cert_sha256,
     collector_identity,started_at,captured_at,receipt_mac)
    SELECT id,$2,official_url,ARRAY[official_url],'127.0.0.1',repeat('a',64),
      'CI-SYNTHETIC-NOT-TRUSTED',collected_at,collected_at,repeat('0',64)
    FROM tax13_v2_original_http_artifacts WHERE id=$1::uuid`,
    [artifact,keyId]),/TAX13_R802_CAPTURE_NOT_AUTHENTICATED/);
  const after=await db.query<{verified:boolean;fingerprint:string|null}>(`
   SELECT public.tax13_v2_capture_verified($1::uuid) AS verified,
    public.tax13_current_ncm_scan_fingerprint($2::uuid) AS fingerprint`,
   [artifact,version]);
  assert.deepEqual(after.rows[0],{verified:false,fingerprint:null});
 }finally{await db.end();}
});
