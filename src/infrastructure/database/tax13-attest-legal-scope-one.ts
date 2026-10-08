import 'dotenv/config';

import { readFileSync } from 'node:fs';

import { Pool } from 'pg';

import {
  validateLegalScopeEvidence,
  type LegalScopeEvidenceV1,
} from '../../modules/taxonomy/legal-scope/legal-scope-evidence.js';

/**
 * TAX13/B4 administrative, version-bound human attestation.
 *
 * node dist/infrastructure/database/tax13-attest-legal-scope-one.js
 *   --manifest=/local/audited-evidence.json
 *   --origin=<publication_origin_uuid>
 *   --reviewer=<independently-authorized-person>
 *   --reason=<review-reference>
 *   [--confirm]
 *
 * Requires a human-approved official consolidation/amendment assessment.
 * This tool NEVER guesses legal validity, follows amendatory acts or
 * automatically promotes historical HTML/CSS to CURRENT.
 *
 * Dry-run is the default. Confirm additionally requires an explicit operator
 * environment gate, a dedicated admin DB connection and transaction audit.
 * This gate must stay OFF until the R2/governance deployment approval.
 */
const arg = (name: string): string | undefined =>
  process.argv.find((value) => value.startsWith('--' + name + '='))?.slice(name.length + 3);
const required = (name: string): string => {
  const value = arg(name);
  if (!value?.trim()) throw new Error('MISSING_ARGUMENT_' + name.toUpperCase());
  return value.trim();
};

const HOSTS: Readonly<Record<string, readonly string[]>> = {
  confaz: ['www.confaz.fazenda.gov.br'],
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const manifestPath = required('manifest');
const originId = required('origin');
const reviewer = required('reviewer');
const reason = required('reason');
const confirm = process.argv.includes('--confirm');
if (!uuid.test(originId)) throw new Error('INVALID_ORIGIN_UUID');
if (reviewer.length < 5 || reason.length < 16) throw new Error('REVIEW_IDENTIFICATION_REQUIRED');
if (confirm && process.env.TAX13_B4_ATTESTATION_WRITES_APPROVED !== 'true') {
  throw new Error('TAX13_B4_ATTESTATION_WRITES_NOT_AUTHORIZED');
}
if (!process.env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL_REQUIRED');
const raw = readFileSync(manifestPath, 'utf8');
if (Buffer.byteLength(raw, 'utf8') > 5 * 1024 * 1024) throw new Error('MANIFEST_OVER_LIMIT');

const manifest = JSON.parse(raw) as LegalScopeEvidenceV1;
if (!manifest || typeof manifest !== 'object' || manifest.version !== 1 ||
    !uuid.test(manifest.publicationVersionId) || !uuid.test(manifest.sourceId)) {
  throw new Error('INVALID_MANIFEST_IDENTITY');
}

const pool = new Pool({connectionString:process.env.DATABASE_ADMIN_URL, max:1});
const db = await pool.connect();
try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'.replace(' READ ONLY', confirm ? '' : ' READ ONLY'));
  const res = await db.query<{
    source_id: string;
    source_code: string;
    official_url: string;
    html: string | null;
  }>(`
    SELECT po.source_id,
           s.code AS source_code,
           po.official_url,
           pv.source_metadata -> 'presentation' ->> 'html' AS html
    FROM public.publication_versions pv
    JOIN public.publication_origins po ON po.publication_id = pv.publication_id
    JOIN public.sources s ON s.id = po.source_id
    WHERE pv.id = $1::uuid AND pv.is_current = TRUE AND po.id = $2::uuid
      AND public.publication_scope_is_in_scope(pv.publication_id)
  `, [manifest.publicationVersionId, originId]);

  const row = res.rows[0];
  if (!row) throw new Error('CURRENT_PUBLICATION_OR_ORIGIN_NOT_FOUND');
  const hosts = HOSTS[row.source_code];
  if (!hosts) throw new Error('UNSUPPORTED_OFFICIAL_SOURCE_REVIEW');
  if (row.source_id !== manifest.sourceId || row.official_url !== manifest.officialUrl) {
    throw new Error('SOURCE_ORIGIN_MANIFEST_MISMATCH');
  }
  if (!row.html) throw new Error('SANITIZED_PRESENTATION_MISSING');
  const validation = validateLegalScopeEvidence(manifest, {
    publicationVersionId: manifest.publicationVersionId,
    sourceId: row.source_id,
    officialUrl: row.official_url,
    sanitizedHtml: row.html,
    validAsOf: manifest.validAsOf,
    trustedAttestor: true, // Only after an identified human review AND admin DB gate.
    trustedEvidenceHosts: hosts,
  });
  if (!validation.valid) throw new Error('LEGAL_SCOPE_REJECTED_' + validation.reason);
  const outcome = {
    publicationVersionId: manifest.publicationVersionId,
    sourceId: row.source_id,
    originId,
    referenceDate: manifest.validAsOf,
    coverage: validation.coverage,
    currentSegments: validation.currentSegments,
    reviewer,
    reason,
    persisted: confirm,
  };
  if (!confirm) {
    console.log('TAX13_LEGAL_SCOPE_ATTEST_DRY_RUN=' + JSON.stringify(outcome));
    await db.query('ROLLBACK');
  } else {
    // Never amend an existing attestation. A new review is a new immutable
    // record; the previous one may only be superseded by a separate approved
    // workflow that explicitly references it.
    const saved = await db.query<{id:string}>(`
      INSERT INTO public.publication_legal_scope_attestations
      (publication_version_id, source_id, publication_origin_id, official_url,
       html_sha256, valid_as_of, verified_at, recheck_on, coverage, manifest,
       attestor_kind, attestor_ref)
      VALUES
      ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::date, $7::timestamptz,
       $8::date, $9, $10::jsonb, 'HUMAN_REVIEW', $11)
      RETURNING id
    `, [manifest.publicationVersionId, row.source_id, originId,
      row.official_url, manifest.htmlSha256, manifest.validAsOf,
      manifest.verifiedAt, manifest.recheckOn, manifest.coverage,
      JSON.stringify(manifest), reviewer]);
    const id = saved.rows[0]?.id;
    if (!id) throw new Error('ATTESTATION_INSERT_FAILED');
    await db.query(`
      INSERT INTO public.audit_log
        (tenant_id, actor_type, actor_id, action, entity_type, entity_id,
         after_data, correlation_id)
      VALUES
        (NULL, 'ADMIN', $1, 'TAX13_LEGAL_SCOPE_HUMAN_ATTESTATION',
         'publication_legal_scope_attestations', $2, $3::jsonb, gen_random_uuid())
    `, [reviewer, id, JSON.stringify({...outcome, attestationId:id})]);
    await db.query('COMMIT');
    console.log('TAX13_LEGAL_SCOPE_ATTEST_SAVED=' +
      JSON.stringify({...outcome, attestationId:id}));
  }
} catch (error) {
  await db.query('ROLLBACK');
  throw error;
} finally {
  db.release();
  await pool.end();
}
