import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';

import { createStandaloneDatabase } from '../src/infrastructure/database/standalone-client.js';
import { brazilLegalReferenceDate } from '../src/modules/taxonomy/legal-scope/legal-scope-evidence.js';
import { readVerifiedLegalScope } from '../src/modules/taxonomy/legal-scope/legal-scope.repository.js';
import {
  persistTemporalNcmScan, readCurrentNcmEvidence,
} from '../src/modules/taxonomy/ncm/ncm-temporal.evidence.js';
import { seedTestLegalScopeAttestation } from './legal-scope-attestation.fixture.js';
import { seedTestV2NcmSeals } from './tax13-arch02.signed-fixture.js';

const adminUrl = process.env.DATABASE_ADMIN_URL;
const workerPassword = process.env.DB_WORKER_RUNTIME_PASSWORD ?? process.env.DB_RUNTIME_PASSWORD;
if (!adminUrl || !workerPassword || process.env.NODE_ENV !== 'test') {
  throw new Error('TAX13_TEST_ONLY_DATABASE_REQUIRED');
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

test('TAX13 ARCH02: independent key revocation instantly hides formerly sealed CURRENT', async () => {
  const admin = new Pool({connectionString: adminUrl, max: 2});
  const workerUri = new URL(adminUrl);
  workerUri.username = 'radar_worker_runtime';
  workerUri.password = workerPassword;
  const worker = createStandaloneDatabase({
    connectionString: workerUri.toString(),
    poolMax: 2,
    connectionTimeoutMs: 5000,
    idleTimeoutMs: 1000,
  });
  const html = '<p class="TextoAcordo">NCM 1006.30.11</p>';
  const legalAsOf = brazilLegalReferenceDate();
  try {
    const pub = await admin.query<{id:string}>(`
      INSERT INTO public.publications(
        identity_hash,identity_strength,identity_basis,jurisdiction_level,title,published_on
      ) VALUES ($1,'STRONG','{}'::jsonb,'FEDERAL','TAX13 V2 key revocation CI','9999-12-31')
      RETURNING id
    `,[sha(randomUUID())]);
    const version = await admin.query<{id:string}>(`
      INSERT INTO public.publication_versions(
        publication_id,version_no,content_hash,content_text,source_metadata,is_current
      ) VALUES ($1::uuid,1,$2,'NCM 1006.30.11',$3::jsonb,true)
      RETURNING id
    `, [pub.rows[0]!.id,sha(html),JSON.stringify({
      presentation:{format:'SANITIZED_HTML',html}
    })]);
    const versionId = version.rows[0]!.id;
    await seedTestLegalScopeAttestation(admin, versionId, 'COMPLETE');
    const proof = await readVerifiedLegalScope(worker, {
      publicationVersionId:versionId,sanitizedHtml:html,asOf:legalAsOf,
    });
    assert.equal(proof.valid,true,proof.reason??'unknown');
    const written = await worker.transaction().execute(trx =>
      persistTemporalNcmScan(trx, {
        publicationVersionId:versionId,sanitizedHtml:html,asOf:legalAsOf
      }));
    assert.equal(written.matches,1);
    await seedTestV2NcmSeals(admin,versionId,legalAsOf);
    const active = await admin.query<{fingerprint:string|null;codes:string[]}>(`
      SELECT public.tax13_current_ncm_scan_fingerprint($1::uuid) AS fingerprint,
        array(SELECT ncm_code FROM public.tax13_public_current_ncm_codes($1::uuid)) AS codes
    `,[versionId]);
    assert.match(active.rows[0]!.fingerprint!,/^[a-f0-9]{64}$/);
    assert.deepEqual(active.rows[0]?.codes,['10063011']);
    assert.deepEqual((await readCurrentNcmEvidence(worker,versionId,proof))?.codes,['10063011']);
    const key = await admin.query<{key_id:string}>(`
      SELECT proof.signature_key_id AS key_id FROM public.tax13_legal_proofs_v2 proof
      WHERE proof.attestation_id=$1::uuid
    `,[proof.attestationId]);
    assert.equal(key.rows.length,1);
    await admin.query(`
      INSERT INTO public.tax13_v2_key_revocations(key_id,reason_code)
      VALUES ($1,'CI_COMPROMISED_KEY')
    `,[key.rows[0]!.key_id]);
    const revoked = await admin.query<{fingerprint:string|null;codes:string[]}>(`
      SELECT public.tax13_current_ncm_scan_fingerprint($1::uuid) AS fingerprint,
        array(SELECT ncm_code FROM public.tax13_public_current_ncm_codes($1::uuid)) AS codes
    `,[versionId]);
    assert.equal(revoked.rows[0]?.fingerprint,null);
    assert.deepEqual(revoked.rows[0]?.codes,[]);
    assert.equal(await readCurrentNcmEvidence(worker,versionId,proof),null);
    const snapshot = await admin.query<{n:number}>(`
      SELECT count(*)::int AS n
      FROM public.publication_ncm_scan_evidence WHERE publication_version_id=$1::uuid
    `,[versionId]);
    assert.equal(snapshot.rows[0]?.n,1,'invalidating CURRENT never deletes historical scan ledger');
    await assert.rejects(admin.query(
      `DELETE FROM public.tax13_v2_key_revocations WHERE key_id=$1`,
      [key.rows[0]!.key_id]),/TAX13_ARCH02_APPEND_ONLY/);
  } finally {
    await worker.destroy();
    await admin.end();
  }
});
