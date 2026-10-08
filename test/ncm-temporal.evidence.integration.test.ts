import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

import { createStandaloneDatabase } from '../src/infrastructure/database/standalone-client.js';
import {
  brazilLegalReferenceDate,
  renderedLegalText,
  type LegalScopeEvidenceV1,
} from '../src/modules/taxonomy/legal-scope/legal-scope-evidence.js';
import { sanitizeLegalPresentationHtml } from '../src/modules/collection/legal-presentation.js';
import { readVerifiedLegalScope } from '../src/modules/taxonomy/legal-scope/legal-scope.repository.js';
import {
  persistTemporalNcmScan, readCurrentNcmEvidence,
} from '../src/modules/taxonomy/ncm/ncm-temporal.evidence.js';

const adminUrl = process.env.DATABASE_ADMIN_URL;
const password = process.env.DB_WORKER_RUNTIME_PASSWORD ?? process.env.DB_RUNTIME_PASSWORD;
if (!adminUrl || !password) throw new Error('TAX13_TEST_DB_CREDENTIALS_REQUIRED');
const h = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const nextDate = (date: string, offset: number) => {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const workerUrl = new URL(adminUrl);
workerUrl.username = 'radar_worker_runtime';
workerUrl.password = password;

test('TAX13 temporal ledger: D0→D1, revoked code, same-day supersession, zero seal, PARTIAL, concurrency, append-only and RLS', async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 3 });
  const worker = createStandaloneDatabase({
    connectionString: workerUrl.toString(), poolMax: 3,
    idleTimeoutMs: 5000, connectionTimeoutMs: 5000,
  });
  const id = randomUUID();
  const d0 = brazilLegalReferenceDate();
  const d1 = nextDate(d0, 1);
  const label = 'CONVÊNIO ICMS — fixture';
  const y = 'NCM 1006.30.11';
  const x = 'NCM 10062099';
  const neutral = 'Permanecem vigentes os demais dispositivos.';
  const html = '<p class="TituloAcordo">' + label + '</p>' +
    '<p class="TextoAcordo">' + y + '</p>' +
    '<p class="TextoAcordo">' + x + '</p>' +
    '<p class="TextoAcordo">' + neutral + '</p>';
  assert.equal(sanitizeLegalPresentationHtml(html), html);
  const rendered = renderedLegalText(html);
  const parts = [label, y, x, neutral];
  assert.equal(rendered, parts.join(''));

  try {
    const pub = await admin.query<{ id: string }>(
      `INSERT INTO publications(identity_hash,identity_strength,identity_basis,
         jurisdiction_level,title,published_on)
       VALUES ($1,'STRONG','{}'::jsonb,'FEDERAL','TAX13 NCM temporal CI', '9999-12-31')
       RETURNING id`, [h(id)],
    );
    const publicationId = pub.rows[0]!.id;
    const version = await admin.query<{ id: string }>(
      `INSERT INTO publication_versions (
        publication_id,version_no,content_hash,content_text,source_metadata,is_current
       ) VALUES ($1,1,$2,$3,$4::jsonb,TRUE) RETURNING id`,
      [publicationId, h(html), rendered, JSON.stringify({
        presentation: { format: 'SANITIZED_HTML', html },
      })],
    );
    const versionId = version.rows[0]!.id;
    await admin.query(`INSERT INTO sources(code,name,jurisdiction_level,base_url,connector_key)
      VALUES ('confaz','CONFAZ','FEDERAL','https://www.confaz.fazenda.gov.br','confaz')
      ON CONFLICT (code) DO NOTHING`);
    const src = await admin.query<{ id: string }>(`SELECT id FROM sources WHERE code='confaz'`);
    const sourceId = src.rows[0]!.id;
    const officialUrl = 'https://www.confaz.fazenda.gov.br/test-only/temporal/' + versionId;
    const origin = await admin.query<{ id: string }>(
      `INSERT INTO publication_origins(publication_id,source_id,official_url)
       VALUES ($1::uuid,$2::uuid,$3) RETURNING id`,
      [publicationId, sourceId, officialUrl],
    );
    const originId = origin.rows[0]!.id;
    const attest = async (
      date: string, statuses: Array<'CURRENT' | 'REVOKED' | 'EDITORIAL'>,
      coverage: 'COMPLETE' | 'PARTIAL' = 'COMPLETE',
      supersedes: string | null = null,
    ): Promise<string> => {
      let index = 0;
      const segments = parts.map((part, i) => {
        const start = index;
        index += part.length;
        return {
          start, end: index, textSha256: h(part),
          status: statuses[i]!,
          method: i === 0 ? 'ORIGINAL_PUBLICATION' as const : 'OFFICIAL_AMENDMENT' as const,
          evidenceUrls: i === 0 ? [] : [officialUrl],
        };
      });
      const manifest: LegalScopeEvidenceV1 = {
        version: 1, publicationVersionId: versionId, sourceId, officialUrl,
        htmlSha256: h(html), validAsOf: date,
        verifiedAt: new Date(Date.now() - 60_000).toISOString(),
        recheckOn: nextDate(date, 3), coverage, segments,
      };
      const row = await admin.query<{ id: string }>(
        `INSERT INTO publication_legal_scope_attestations(
          publication_version_id,source_id,publication_origin_id,official_url,
          html_sha256,valid_as_of,verified_at,recheck_on,coverage,manifest,
          attestor_kind,attestor_ref,supersedes_attestation_id
        ) VALUES (
          $1::uuid,$2::uuid,$3::uuid,$4,$5,$6::date,$7::timestamptz,
          $8::date,$9,$10::jsonb,'HUMAN_REVIEW','CI-TEMPORAL',$11::uuid
        ) RETURNING id`,
        [versionId, sourceId, originId, officialUrl, h(html),
          date, manifest.verifiedAt, manifest.recheckOn, coverage,
          JSON.stringify(manifest), supersedes],
      );
      return row.rows[0]!.id;
    };
    const readProof = (date: string) => readVerifiedLegalScope(worker, {
      publicationVersionId: versionId, sanitizedHtml: html, asOf: date,
    });
    const rescan = (date: string) => worker.transaction().execute((trx) =>
      persistTemporalNcmScan(trx, { publicationVersionId: versionId, sanitizedHtml: html, asOf: date }));

    const a0 = await attest(d0, ['EDITORIAL','CURRENT','REVOKED','REVOKED']);
    const firstProof = await readProof(d0);
    assert.equal(firstProof.valid, true, firstProof.reason ?? undefined);
    const first = await rescan(d0);
    assert.equal(first.inserted, true);
    assert.equal(first.matches, 1);
    assert.deepEqual((await readCurrentNcmEvidence(worker, versionId, firstProof))?.codes,
      ['10063011']);
    // Read-only bridge serves the exact same vetted current scan, without
    // granting radar_app direct SELECT on the legal or NCM evidence tables.
    const bridge0 = await admin.query<{ fingerprint: string | null; code: string }>(`
      SELECT public.tax13_current_ncm_scan_fingerprint($1::uuid) AS fingerprint,
        (SELECT ncm_code FROM public.tax13_public_current_ncm_codes($1::uuid) LIMIT 1) AS code`,
      [versionId]);
    assert.match(bridge0.rows[0]!.fingerprint!, /^[a-f0-9]{64}$/);
    assert.equal(bridge0.rows[0]?.code, '10063011');

    // Tenant matching reads the effective-assertions view (020), bypassing
    // the taxonomy detail endpoint. Prove an old curated SUCCESS cannot flow
    // through that view after its legal-scope attestation is replaced.
    const dimId = randomUUID(), dimRevId = randomUUID();
    const conceptId = randomUUID(), conceptRevId = randomUUID();
    const releaseId = randomUUID(), releaseConceptId = randomUUID(), runId = randomUUID();
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    await admin.query(`INSERT INTO taxonomy_dimensions(id,code)
      VALUES ($1,$2)`, [dimId, 'temp_' + suffix]);
    await admin.query(`INSERT INTO taxonomy_dimension_revisions
      (id,dimension_id,revision_no,name) VALUES ($1,$2,1,'Temporal proof gate')`,
      [dimRevId, dimId]);
    await admin.query(`INSERT INTO taxonomy_concepts(id,code,dimension_id)
      VALUES ($1,$2,$3)`, [conceptId, 'temp_' + suffix + '.ncm', dimId]);
    await admin.query(`INSERT INTO taxonomy_concept_revisions
      (id,concept_id,revision_no,label,definition) VALUES ($1,$2,1,'Arroz','NCM fixture')`,
      [conceptRevId, conceptId]);
    await admin.query(`INSERT INTO taxonomy_releases
      (id,version_major,version_minor,version_patch,created_by_actor)
      VALUES ($1,0,$2,0,'TAX13-R2-CI')`,
      [releaseId, Number.parseInt(suffix.slice(0,7),16)]);
    await admin.query(`INSERT INTO taxonomy_release_dimensions
      (release_id,dimension_id,dimension_revision_id) VALUES ($1,$2,$3)`,
      [releaseId, dimId, dimRevId]);
    await admin.query(`INSERT INTO taxonomy_release_concepts
      (id,release_id,concept_id,concept_revision_id) VALUES ($1,$2,$3,$4)`,
      [releaseConceptId, releaseId, conceptId, conceptRevId]);
    await admin.query(`UPDATE taxonomy_releases
      SET status='PUBLISHED',approved_at=now(),published_at=now(),
        artifact_repository='ci/temporal',artifact_path='proof.json',
        artifact_git_sha=$2,artifact_sha256=$3
      WHERE id=$1`, [releaseId, 'a'.repeat(40), h(releaseId)]);
    await admin.query(`
      INSERT INTO publication_taxonomy_runs (
        id,publication_version_id,taxonomy_release_id,method_type,
        engine_key,engine_version,config_snapshot,config_sha256,
        input_sha256,run_fingerprint,status,started_at
      ) VALUES (
        $1,$2,$3,'RULE','tribusca.taxonomy.curated','2.4.0',
        $4::jsonb,$5,$6,$7,'RUNNING',now()
      )`, [runId, versionId, releaseId,
      JSON.stringify({legalScopeFingerprint: bridge0.rows[0]!.fingerprint}),
      h('tax13-config-' + id),h('tax13-input-' + id),h('tax13-run-' + id)]);
    await admin.query(`
      INSERT INTO publication_taxonomy_assertions(
        run_id,taxonomy_release_id,release_concept_id,assertion_status,
        confidence,decision_origin,reason_code
      ) VALUES ($1,$2,$3,'CONFIRMED',1.0,'RULE_ENGINE','OFFICIAL_CODE_NCM')`,
      [runId,releaseId,releaseConceptId]);
    await admin.query(`UPDATE publication_taxonomy_runs
      SET status='SUCCESS',finished_at=now() WHERE id=$1`, [runId]);
    await admin.query(`
      INSERT INTO publication_taxonomy_scans(
        publication_version_id,taxonomy_release_id,engine_key,engine_version,
        status,run_id,assertion_count,attempt_count,scanned_at
      ) VALUES ($1,$2,'tribusca.taxonomy.curated','2.4.0',
        'SUCCESS',$3,1,1,now())`,
      [versionId,releaseId,runId]);
    const effective = () => admin.query<{ count: number }>(`
      SELECT count(*)::int AS count
      FROM v_publication_taxonomy_effective_assertions
      WHERE publication_version_id=$1 AND taxonomy_release_id=$2`,
      [versionId, releaseId]);
    assert.equal((await effective()).rows[0]?.count, 1,
      'valid proof permits curated assertions in tenant matching view');

    assert.equal((await rescan(d0)).inserted, false, 'same fingerprint is idempotent');

    // Same document/version, different legal reference date; a D0 result is
    // not evidence for D1 even before D1 has been rescanned.
    const a1 = await attest(d1, ['EDITORIAL','REVOKED','CURRENT','REVOKED'], 'COMPLETE', a0);
    const tomorrowProof = await readProof(d1);
    assert.equal(tomorrowProof.valid, true, tomorrowProof.reason ?? undefined);
    assert.equal(tomorrowProof.attestationId, a1);
    assert.equal(await readCurrentNcmEvidence(worker, versionId, tomorrowProof), null);
    const [race1, race2] = await Promise.all([rescan(d1), rescan(d1)]);
    assert.equal([race1.inserted, race2.inserted].filter(Boolean).length, 1,
      'concurrent workers must make one immutable evidence event');
    assert.deepEqual((await readCurrentNcmEvidence(worker, versionId, tomorrowProof))?.codes,
      ['10062099'], 'D1 must not inherit revoked Y from D0');

    // New same-day attestation makes even cached old proof immediately stale.
    const sameDay = await attest(d0, ['EDITORIAL','REVOKED','CURRENT','REVOKED'], 'COMPLETE', a0);
    assert.equal(await readCurrentNcmEvidence(worker, versionId, firstProof), null);
    const changed = await readProof(d0);
    assert.equal(changed.attestationId, sameDay);
    assert.equal((await rescan(d0)).inserted, true);
    assert.deepEqual((await readCurrentNcmEvidence(worker, versionId, changed))?.codes,
      ['10062099']);

    // Fresh COMPLETE(0) attestation must not destroy or relabel old Y/X events.
    await attest(d0, ['EDITORIAL','REVOKED','REVOKED','CURRENT'], 'COMPLETE', sameDay);
    assert.equal(await readCurrentNcmEvidence(worker, versionId, changed), null);
    assert.equal((await rescan(d0)).matches, 0);
    const zero = await readProof(d0);
    assert.deepEqual((await readCurrentNcmEvidence(worker, versionId, zero))?.codes, []);
    const historical = await admin.query<{ ncm_code: string }>(`
      SELECT DISTINCT ncm_code FROM publication_ncm_scan_evidence_codes c
      JOIN publication_ncm_scan_evidence e ON e.id = c.scan_evidence_id
      WHERE e.publication_version_id=$1::uuid ORDER BY ncm_code`, [versionId]);
    assert.deepEqual(historical.rows.map((row) => row.ncm_code), ['10062099','10063011']);

    // New partial evidence does NOT certify an empty list over unchecked text.
    await attest(d0, ['EDITORIAL','REVOKED','REVOKED','CURRENT'], 'PARTIAL');
    const partial = await readProof(d0);
    assert.equal(partial.coverage, 'PARTIAL');
    assert.equal(await readCurrentNcmEvidence(worker, versionId, partial), null);
    await assert.rejects(rescan(d0), /TAX13_NCM_COMPLETE_CURRENT_PROOF_REQUIRED/);
    const bridgeStale = await admin.query<{ fingerprint: string | null }>(`
      SELECT public.tax13_current_ncm_scan_fingerprint($1::uuid) AS fingerprint`, [versionId]);
    assert.equal(bridgeStale.rows[0]!.fingerprint, null, 'same-day PARTIAL invalidates API projection');
    assert.equal((await effective()).rows[0]?.count, 0,
      'historical curated SUCCESS must not match tenant profiles after PARTIAL');
    const hashDrift = await readVerifiedLegalScope(worker, {
      publicationVersionId: versionId, sanitizedHtml: '<p>drift</p>', asOf: d0,
    });
    assert.equal(hashDrift.valid, false, 'HTML drift must fail closed');

    // Real scope state transition hides even immutable historical scan rows
    // from the worker. RESTORE re-exposes history without forging CURRENT.
    const transition = `SELECT * FROM public.apply_publication_scope_transition(
      $1::uuid,$2,$3::uuid,$4::uuid,'CONCURRENCY_TEST','CONTROLLED_RACE','test-v1',$5,NULL,'CI')`;
    const suppressed = await admin.query<{ event_id: string }>(transition,
      [publicationId, 'SUPPRESS', randomUUID(), null, h(publicationId)]);
    const invisible = await worker.transaction().execute(async (trx) =>
      trx.selectFrom('publication_versions').select('id')
        .where('id', '=', versionId).execute());
    assert.ok(invisible.length === 1, 'canonical versions may remain stored');
    const workerRows = await worker.transaction().execute(async (trx) => {
      const { sql } = await import('kysely');
      return sql<{ count: number }>`SELECT count(*)::int AS count
        FROM public.publication_ncm_scan_evidence
        WHERE publication_version_id=${versionId}::uuid`.execute(trx);
    });
    assert.equal(workerRows.rows[0]!.count, 0);
    await assert.rejects(rescan(d0), /PUBLICATION_OUT_OF_SCOPE/);
    await admin.query(transition,
      [publicationId, 'RESTORE', randomUUID(), suppressed.rows[0]!.event_id, h(publicationId)]);

    const immutable = await admin.query<{ id: string }>(`
      SELECT id FROM publication_ncm_scan_evidence
      WHERE publication_version_id=$1::uuid LIMIT 1`, [versionId]);
    await assert.rejects(admin.query(
      `UPDATE publication_ncm_scan_evidence SET outcome='SUCCESS' WHERE id=$1::uuid`,
      [immutable.rows[0]!.id]), /TAX13_NCM_SCAN_APPEND_ONLY/);
    await assert.rejects(admin.query(
      `DELETE FROM publication_ncm_scan_evidence_codes WHERE scan_evidence_id=$1::uuid`,
      [immutable.rows[0]!.id]), /TAX13_NCM_SCAN_APPEND_ONLY/);
    const oldEntry = await admin.query<{ id: string }>(`
      SELECT c.catalog_entry_id AS id FROM publication_ncm_scan_evidence_codes c
      JOIN publication_ncm_scan_evidence e ON e.id=c.scan_evidence_id
      WHERE e.publication_version_id=$1::uuid LIMIT 1`, [versionId]);
    await assert.rejects(admin.query(`
      INSERT INTO publication_ncm_scan_evidence_codes(
        scan_evidence_id,ncm_code,catalog_entry_id,fragment_index,excerpt)
      VALUES ($1::uuid,'10063011',$2::uuid,7,'post-commit forged positive')`,
      [immutable.rows[0]!.id, oldEntry.rows[0]!.id]
    ), /TAX13_NCM_SCAN_CODES_SEALED/,
    'a worker must not add new findings to a committed successful scan');

    // FORCE RLS and explicit privilege denial to app / curator / public roles.
    const grants = await admin.query<{
      app: boolean; curator: boolean; worker_update: boolean; forced: boolean;
    }>(`SELECT
      has_table_privilege('radar_app','public.publication_ncm_scan_evidence','SELECT') AS app,
      has_table_privilege('radar_taxonomy_curator','public.publication_ncm_scan_evidence','SELECT') AS curator,
      has_table_privilege('radar_worker','public.publication_ncm_scan_evidence','UPDATE') AS worker_update,
      (SELECT relforcerowsecurity FROM pg_class WHERE oid='public.publication_ncm_scan_evidence'::regclass) AS forced`);
    assert.deepEqual(grants.rows[0], { app: false, curator: false, worker_update: false, forced: true });
  } finally {
    await worker.destroy();
    // Proof/scan records remain intentionally immutable on disposable CI DB.
    await admin.end();
  }
});
