/**
 * TAX13 R8: isolated issuer / verifier / worker / sealer positive integration.
 * ONLY synthetic HTTP bytes in a disposable GitHub CI DB. The real CONFAZ
 * source provenance gate R8-02 is NOT satisfied by this synthetic fixture.
 */
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomBytes,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {Pool} from 'pg';
import {createStandaloneDatabase} from '../src/infrastructure/database/standalone-client.js';
import {renderedLegalText,brazilLegalReferenceDate} from '../src/modules/taxonomy/legal-scope/legal-scope-evidence.js';
import {persistTemporalNcmScan} from '../src/modules/taxonomy/ncm/ncm-temporal.evidence.js';
import {seedTestLegalScopeAttestation} from './legal-scope-attestation.fixture.js';

const adminUrl=process.env.DATABASE_ADMIN_URL;
const passwords={
  radar_legal_issuer_runtime:process.env.DB_LEGAL_ISSUER_RUNTIME_PASSWORD,
  radar_proof_verifier_runtime:process.env.DB_PROOF_VERIFIER_RUNTIME_PASSWORD,
  radar_scan_sealer_runtime:process.env.DB_NCM_SEALER_RUNTIME_PASSWORD,
  radar_worker_runtime:process.env.DB_RUNTIME_PASSWORD,
};
if(!adminUrl||process.env.NODE_ENV!=='test'||process.env.GITHUB_ACTIONS!=='true'||
    !['127.0.0.1','localhost'].includes(new URL(adminUrl).hostname)||
    !Object.values(passwords).every(Boolean))
  throw new Error('TAX13_R8_DISPOSABLE_GITHUB_CI_ONLY');
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const uri=(name:keyof typeof passwords)=>{
  const u=new URL(adminUrl);u.username=name;u.password=passwords[name]!;
  return u.toString();
};
function cli(file:string,args:string[],vars:Record<string,string>):Record<string,unknown>{
  const log=execFileSync(process.execPath,['--import','tsx',file,...args],{
    cwd:process.cwd(),timeout:45000,encoding:'utf8',maxBuffer:1024*1024,
    env:{...process.env,...vars,NODE_ENV:'test',GITHUB_ACTIONS:'true'},
  });
  const line=log.trim().split('\n').at(-1);
  assert.ok(line&&line.includes('='),'CLI did not return evidence');
  return JSON.parse(line.slice(line.indexOf('=')+1)) as Record<string,unknown>;
}

test('R8 real isolated logins issue, verify, scan, seal and publish one synthetic NCM',async()=>{
  const admin=new Pool({connectionString:adminUrl,max:2});
  const worker=createStandaloneDatabase({
    connectionString:uri('radar_worker_runtime'),
    poolMax:2,idleTimeoutMs:1000,connectionTimeoutMs:5000,
  });
  try{
    const html='<p class="TextoAcordo">NCM 1006.30.11</p>';
    const raw='<div id="parent-fieldname-text">'+html+'</div>';
    const rawHash=sha(Buffer.from(raw));
    const publication=(await admin.query<{id:string}>(
      "INSERT INTO public.publications(identity_hash,identity_strength,identity_basis,jurisdiction_level,title,published_on) VALUES ($1,'STRONG','{}'::jsonb,'FEDERAL','R8 synthetic isolated positive',CURRENT_DATE) RETURNING id",
      [sha(randomUUID())])).rows[0]!.id;
    const version=(await admin.query<{id:string}>(
      "INSERT INTO public.publication_versions(publication_id,version_no,content_hash,content_text,source_metadata,is_current) VALUES ($1::uuid,1,$2,$3,$4::jsonb,true) RETURNING id",
      [publication,sha(html),renderedLegalText(html),
        JSON.stringify({presentation:{format:'SANITIZED_HTML',html}})])).rows[0]!.id;
    const attestation=await seedTestLegalScopeAttestation(admin,version,'COMPLETE',false);
    const info=(await admin.query<{official_url:string}>(
      'SELECT official_url FROM public.publication_legal_scope_attestations WHERE id=$1::uuid',
      [attestation])).rows[0]!;
    // R8-02 boundary: syntactically plausible metadata is insufficient.
    // SQL refuses bytes that do not match the declared digest and artifacts
    // whose URL is not an origin of this exact publication. Synthetic only.
    await assert.rejects(admin.query(
      "INSERT INTO public.tax13_v2_original_http_artifacts(publication_version_id,official_url,http_status,raw_http_bytes,raw_sha256,sanitized_html_sha256,collected_at,collector_identity) VALUES ($1::uuid,$2,200,convert_to($3,'UTF8'),$4,$5,statement_timestamp(),'CI-ONLY-SYNTHETIC-COLLECTOR')",
      [version,info.official_url,raw,'0'.repeat(64),sha(html)]),
    (error:unknown)=>(error as {code?:string}).code==='23514',
    'R8 raw bytes must match SHA-256 at database admission');
    await assert.rejects(admin.query(
      "INSERT INTO public.tax13_v2_original_http_artifacts(publication_version_id,official_url,http_status,raw_http_bytes,raw_sha256,sanitized_html_sha256,collected_at,collector_identity) VALUES ($1::uuid,$2,200,convert_to($3,'UTF8'),$4,$5,statement_timestamp(),'CI-ONLY-SYNTHETIC-COLLECTOR')",
      [version,'https://www.confaz.fazenda.gov.br/r8-foreign-version/'+randomUUID(),raw,rawHash,sha(html)]),
    /TAX13_R8_ORIGINAL_HTTP_IDENTITY_MISMATCH/,
    'R8 raw artifact must match the official URL registered for this version');
    await admin.query(
      "INSERT INTO public.tax13_v2_original_http_artifacts(publication_version_id,official_url,http_status,raw_http_bytes,raw_sha256,sanitized_html_sha256,collected_at,collector_identity) VALUES ($1::uuid,$2,200,convert_to($3,'UTF8'),$4,$5,statement_timestamp(),'CI-ONLY-SYNTHETIC-COLLECTOR')",
      [version,info.official_url,raw,rawHash,sha(html)]);

    const pair=generateKeyPairSync('ed25519');
    const signerId='ci-r8-signer-'+randomUUID();
    const verifierKeyId='ci-r8-verifier-'+randomUUID();
    const macSecret=randomBytes(32);
    const conf={
      TAX13_LEGAL_PARSER_BUILD_SHA:sha('ci-r8-pinned-parser'),
      TAX13_LEGAL_PARSER_VERSION:'ci-r8-parser-v1',
      TAX13_LEGAL_SANITIZER_VERSION:'ci-r8-sanitizer-v1',
      TAX13_LEGAL_POLICY_VERSION:'ci-r8-policy-v1',
    };
    await admin.query(
      "INSERT INTO public.tax13_v2_authorized_keys(key_id,public_key_pem,active_from,registered_by) VALUES ($1,$2,statement_timestamp()-interval '2 minutes','CI-R8-E2E')",
      [signerId,pair.publicKey.export({format:'pem',type:'spki'}).toString()]);
    await admin.query(
      'INSERT INTO public.tax13_v2_verifier_mac_keys(key_id,key_bytes) VALUES ($1,$2::bytea)',
      [verifierKeyId,macSecret]);

    const prior=(await admin.query<{value:unknown}>(
      'SELECT public.tax13_v2_admitted_current_fragments($1::uuid) AS value',
      [attestation])).rows[0]!;
    assert.equal(prior.value,null);

    const issued=cli('src/infrastructure/database/tax13-issue-legal-proof-v2.ts',
      ['--attestation='+attestation,'--raw-artifact-sha='+rawHash,'--confirm'],{
      ...conf,DATABASE_LEGAL_ISSUER_URL:uri('radar_legal_issuer_runtime'),
      TAX13_ARCH02_ISSUANCE_APPROVED:'true',TAX13_LEGAL_ISSUER_ID:'CI-R8-ISSUER',
      TAX13_LEGAL_SIGNING_KEY_ID:signerId,
      TAX13_LEGAL_ED25519_PRIVATE_KEY_PEM:pair.privateKey.export({format:'pem',type:'pkcs8'}).toString(),
    });
    const proofId=issued.proofId;
    assert.equal(typeof proofId,'string');
    const notYetVerified=(await admin.query<{value:unknown}>(
      'SELECT public.tax13_v2_admitted_current_fragments($1::uuid) AS value',
      [attestation])).rows[0]!;
    assert.equal(notYetVerified.value,null,'issuer cannot authorize own CURRENT');

    const verified=cli('src/infrastructure/database/tax13-verify-proof-v2.ts',
      ['--proof='+proofId,'--confirm'],{
      ...conf,DATABASE_PROOF_VERIFIER_URL:uri('radar_proof_verifier_runtime'),
      TAX13_R8_PROOF_VERIFICATION_APPROVED:'true',
      TAX13_R8_VERIFIER_MAC_KEY_ID:verifierKeyId,
      TAX13_R8_VERIFIER_MAC_KEY_HEX:macSecret.toString('hex'),
      TAX13_R8_VERIFIER_ID:'CI-R8-VERIFIER',
    });
    assert.equal(verified.proofId,proofId);
    const admitted=(await admin.query<{value:string[]|null}>(
      'SELECT public.tax13_v2_admitted_current_fragments($1::uuid) AS value',
      [attestation])).rows[0]!;
    assert.deepEqual(admitted.value,['NCM 1006.30.11']);

    const scan=await worker.transaction().execute(trx=>persistTemporalNcmScan(trx,{
      publicationVersionId:version,sanitizedHtml:html,asOf:brazilLegalReferenceDate(),
    }));
    assert.equal(scan.inserted,true);
    assert.equal(scan.matches,1);
    const scanId=(await admin.query<{id:string}>(
      'SELECT id FROM public.publication_ncm_scan_evidence WHERE publication_version_id=$1::uuid',
      [version])).rows[0]?.id;
    assert.ok(scanId);
    const unsealed=(await admin.query<{fp:string|null}>(
      'SELECT public.tax13_current_ncm_scan_fingerprint($1::uuid) AS fp',
      [version])).rows[0]!;
    assert.equal(unsealed.fp,null,'scan alone cannot publish positive');

    const sealed=cli('src/infrastructure/database/tax13-seal-ncm-v2.ts',
      ['--scan='+scanId,'--confirm'],{
      DATABASE_NCM_SEALER_URL:uri('radar_scan_sealer_runtime'),
      TAX13_ARCH02_SCAN_SEAL_APPROVED:'true',TAX13_NCM_SEALER_ID:'CI-R8-SEALER',
    });
    assert.equal(sealed.scanId,scanId);
    assert.equal(sealed.proofId,proofId);
    const published=(await admin.query<{fp:string|null;codes:string[]}>(
      'SELECT public.tax13_current_ncm_scan_fingerprint($1::uuid) AS fp, ARRAY(SELECT ncm_code FROM public.tax13_public_current_ncm_codes($1::uuid)) AS codes',
      [version])).rows[0]!;
    assert.match(published.fp??'',/^[0-9a-f]{64}$/);
    assert.deepEqual(published.codes,['10063011']);

    const {buildApp}=await import('../src/app.js');
    const app=await buildApp();
    try{
      const email='ci-r8-'+randomUUID()+'@example.test';
      const password=process.env.R4_TEST_ACCOUNT_PASSWORD??'Ci-R8-Isolated-Example-Password-2026!';
      const register=await app.inject({method:'POST',url:'/auth/register',payload:{
        name:'CI R8',email,company:'CI R8',password,confirmPassword:password,acceptedTerms:true,
      }});
      assert.equal(register.statusCode,201,register.body);
      const login=await app.inject({method:'POST',url:'/auth/login',payload:{email,password}});
      assert.equal(login.statusCode,200,login.body);
      const response=await app.inject({
        method:'GET',url:'/api/v1/publications/'+publication+'/ncms',headers:{
          authorization:'Bearer '+login.json().accessToken,
          'x-tenant-id':register.json().tenant.id,
        },
      });
      assert.equal(response.statusCode,200,response.body);
      assert.deepEqual(response.json().attestedCurrentNcmCodes,['10063011']);
      assert.equal(response.json().items[0]?.verificationStatus,'CURRENT_ATTESTED');
      // The verifier's trust anchor is a live gate, not a one-time issuance.
      // Revocation must invalidate a previously accepted proof and NCM
      // projection immediately, without deleting the immutable ledger.
      await admin.query(
        "INSERT INTO public.tax13_v2_verifier_key_revocations(verifier_key_id,reason) VALUES ($1,$2)",
        [verifierKeyId,'R8_SYNTHETIC_TEST_REVOKE']);
      const afterRevocation=(await admin.query<{
        fragments:string[]|null; fingerprint:string|null; codes:string[];
      }>(
        'SELECT public.tax13_v2_admitted_current_fragments($1::uuid) AS fragments, public.tax13_current_ncm_scan_fingerprint($2::uuid) AS fingerprint, ARRAY(SELECT ncm_code FROM public.tax13_public_current_ncm_codes($2::uuid)) AS codes',
        [attestation,version])).rows[0]!;
      assert.equal(afterRevocation.fragments,null,
        'revoked verifier must erase CURRENT from read projection');
      assert.equal(afterRevocation.fingerprint,null);
      assert.deepEqual(afterRevocation.codes,[]);
      const httpAfterRevocation=await app.inject({
        method:'GET',url:'/api/v1/publications/'+publication+'/ncms',headers:{
          authorization:'Bearer '+login.json().accessToken,
          'x-tenant-id':register.json().tenant.id,
        },
      });
      assert.equal(httpAfterRevocation.statusCode,200,httpAfterRevocation.body);
      assert.deepEqual(httpAfterRevocation.json().attestedCurrentNcmCodes,[]);
      assert.deepEqual(httpAfterRevocation.json().items,[],
        'revoked verifier MAC key cannot continue exposing positive CURRENT');

    } finally {await app.close();}
  } finally {await worker.destroy();await admin.end();}
});
