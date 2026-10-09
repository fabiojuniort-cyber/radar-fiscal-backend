import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { sql } from 'kysely';

import { createStandaloneDatabase } from '../src/infrastructure/database/standalone-client.js';
import {
  brazilLegalReferenceDate, renderedLegalText, validateLegalScopeEvidence,
  type LegalScopeEvidenceV1,
} from '../src/modules/taxonomy/legal-scope/legal-scope-evidence.js';
import { currentNcmEdition, ncmTemporalFingerprint } from '../src/modules/taxonomy/ncm/ncm-temporal.evidence.js';
import { readVerifiedLegalScope } from '../src/modules/taxonomy/legal-scope/legal-scope.repository.js';

const adminUrl = process.env.DATABASE_ADMIN_URL;
const password = process.env.DB_WORKER_RUNTIME_PASSWORD ?? process.env.DB_RUNTIME_PASSWORD;
if (!adminUrl || !password) throw new Error('TAX13_ARCH02_R7_TEST_DB_REQUIRED');
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const dayPlus = (date: string, days: number) => {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const workerUrl = new URL(adminUrl);
workerUrl.username='radar_worker_runtime';
workerUrl.password=password;

test('TAX13 ARCH02 R7: an admin-seeded illegal CURRENT never becomes worker scan or public NCM without an issued V2 proof', async () => {
  const admin = new Pool({ connectionString:adminUrl,max:2 });
  const worker = createStandaloneDatabase({
    connectionString:workerUrl.toString(),poolMax:2,
    idleTimeoutMs:1500,connectionTimeoutMs:5000,
  });
  const id = randomUUID();
  const html = '<p class="TextoAcordo">Convênio ICMS 10062099</p>';
  const legalText = renderedLegalText(html);
  const d0=brazilLegalReferenceDate();
  const recheck=dayPlus(d0,3);
  try {
    const publication = await admin.query<{id:string}>(`
      INSERT INTO public.publications(identity_hash,identity_strength,identity_basis,
        jurisdiction_level,title,published_on)
      VALUES ($1,'STRONG','{}'::jsonb,'FEDERAL','TAX13 ARCH02 R7 negative',CURRENT_DATE)
      RETURNING id
    `, [hash(id)]);
    const publicationId=publication.rows[0]!.id;
    const ver = await admin.query<{id:string}>(`
      INSERT INTO public.publication_versions(
        publication_id,version_no,content_hash,content_text,source_metadata,is_current
      ) VALUES ($1::uuid,1,$2,$3,$4::jsonb,TRUE) RETURNING id
    `, [publicationId,hash(html),legalText,JSON.stringify({
      presentation:{format:'SANITIZED_HTML',html},
    })]);
    const versionId=ver.rows[0]!.id;
    await admin.query(`
      INSERT INTO public.sources(code,name,jurisdiction_level,base_url,connector_key)
      VALUES ('confaz','CONFAZ','FEDERAL',
        'https://www.confaz.fazenda.gov.br','confaz')
      ON CONFLICT(code) DO NOTHING
    `);
    const sources=await admin.query<{id:string}>(`
      SELECT id FROM public.sources WHERE code='confaz'
    `);
    const sourceId=sources.rows[0]!.id;
    const url='https://www.confaz.fazenda.gov.br/test-only/arch02/'+versionId;
    const origin=await admin.query<{id:string}>(`
      INSERT INTO public.publication_origins(
        publication_id,source_id,official_url
      ) VALUES ($1::uuid,$2::uuid,$3) RETURNING id
    `,[publicationId,sourceId,url]);
    const m:LegalScopeEvidenceV1={
      version:1,publicationVersionId:versionId,sourceId,officialUrl:url,
      htmlSha256:hash(html),validAsOf:d0,
      verifiedAt:new Date(Date.now()-60_000).toISOString(),
      recheckOn:recheck,coverage:'COMPLETE',
      segments:[{
        start:0,end:legalText.length,textSha256:hash(legalText),
        status:'CURRENT',method:'OFFICIAL_AMENDMENT',evidenceUrls:[url],
      }],
    };
    const checked=validateLegalScopeEvidence(m,{
      publicationVersionId:versionId,sourceId,officialUrl:url,
      sanitizedHtml:html,validAsOf:d0,trustedAttestor:true,
      trustedEvidenceHosts:['www.confaz.fazenda.gov.br'],
    });
    assert.equal(checked.valid,false);
    assert.equal(checked.reason,'CURRENT_IN_NON_NORMATIVE_SCOPE');
    const inserted=await admin.query<{id:string}>(`
      INSERT INTO public.publication_legal_scope_attestations(
        publication_version_id,source_id,publication_origin_id,official_url,
        html_sha256,valid_as_of,verified_at,recheck_on,coverage,
        manifest,attestor_kind,attestor_ref
      ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::date,$7::timestamptz,
        $8::date,'COMPLETE',$9::jsonb,'HUMAN_REVIEW','CI-ADVERSARIAL-INVALID')
      RETURNING id
    `,[versionId,sourceId,origin.rows[0]!.id,url,hash(html),d0,
      m.verifiedAt,recheck,JSON.stringify(m)]);
    const attestationId=inserted.rows[0]!.id;
    const nodeProof=await readVerifiedLegalScope(worker,{
      publicationVersionId:versionId,sanitizedHtml:html,asOf:d0,
    });
    assert.equal(nodeProof.valid,false);
    assert.equal(nodeProof.reason,'CURRENT_IN_NON_NORMATIVE_SCOPE');
    const sqlFragments=await admin.query<{f:unknown}>(`
      SELECT public.tax13_legal_current_fragments($1::uuid) AS f
    `,[attestationId]);
    assert.equal(sqlFragments.rows[0]!.f,null);
    const edition=await currentNcmEdition(worker,d0);
    const invalidFakeProof={
      ...nodeProof,valid:true,coverage:'COMPLETE' as const,
      currentText:legalText,currentFragments:[legalText],currentSegments:1,
      attestationId,htmlSha256:hash(html),recheckOn:recheck,
    };
    const fakeFingerprint=ncmTemporalFingerprint(versionId,invalidFakeProof,edition);
    const entries=await sql<{id:string}>`
      SELECT id FROM official_catalog_entries WHERE
        catalog_edition_id=${edition.id}::uuid
        AND regexp_replace(official_code,'[^0-9]','','g')='10062099'
        LIMIT 1
    `.execute(worker);
    assert.ok(entries.rows[0]?.id,'seed the official NCM catalog before R7 test');
    await assert.rejects(worker.transaction().execute(async (trx)=>{
      const result=await sql<{id:string}>`
        INSERT INTO public.publication_ncm_scan_evidence(
          publication_version_id,detector_key,detector_version,
          legal_scope_attestation_id,legal_as_of,recheck_on,coverage,
          html_sha256,current_fragments_sha256,catalog_edition_id,
          catalog_sha256,run_fingerprint,source_field,candidate_count,
          match_count,outcome
        ) VALUES (
          ${versionId}::uuid,'ncm.catalog.regex','1.3.0',
          ${attestationId}::uuid,${d0}::date,${recheck}::date,'COMPLETE',
          ${hash(html)},${hash(JSON.stringify([legalText]))},
          ${edition.id}::uuid,${edition.checksum},${fakeFingerprint},
          'CONTENT_TEXT',1,1,'SUCCESS'
        ) RETURNING id
      `.execute(trx);
      await sql`
        INSERT INTO public.publication_ncm_scan_evidence_codes(
          scan_evidence_id,ncm_code,catalog_entry_id,fragment_index,excerpt
        ) VALUES (
          ${result.rows[0]!.id}::uuid,'10062099',${entries.rows[0]!.id}::uuid,
          0,'Convênio ICMS 10062099'
        )
      `.execute(trx);
    }),/TAX13_NCM_SCAN_CODE_NOT_IN_CURRENT_FRAGMENT|TAX13_NCM_SCAN_INCOMPLETE_OR_UNVERIFIED/);
    const positive=await admin.query<{f:string|null;c:number}>(`
      SELECT public.tax13_current_ncm_scan_fingerprint($1::uuid) AS f,
        (SELECT count(*)::int FROM public.tax13_public_current_ncm_codes($1::uuid)) AS c
    `,[versionId]);
    assert.equal(positive.rows[0]!.f,null);
    assert.equal(positive.rows[0]!.c,0);
  } finally {
    await worker.destroy();
    await admin.end();
  }
});
