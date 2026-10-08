import { sql, type Kysely } from 'kysely';

import type { DB } from '../../../infrastructure/database/database.types.js';
import { brazilLegalReferenceDate } from '../legal-scope/legal-scope-evidence.js';
import { readVerifiedLegalScope } from '../legal-scope/legal-scope.repository.js';
import {
  isPublicationOutOfScopeError,
  lockPublicationVersionInScope,
} from '../../publication-scope/publication-scope.guard.js';
import { PROTECTED_EXCLUDED_SOURCES } from '../curation/curation.constants.js';
import {
  findLatestPublishedRelease,
  kyselyRunner,
  loadReleaseView,
  loadRuntimeSettings,
} from '../curation/curation.read.js';
import {
  PUBLICATION_NCM_DETECTOR_KEY,
  PUBLICATION_NCM_DETECTOR_VERSION,
} from '../ncm/publication-ncm.detector.js';
import {
  currentNcmEdition,
  readCurrentNcmEvidence,
  type NcmEditionSnapshot,
  type TemporalNcmEvidence,
} from '../ncm/ncm-temporal.evidence.js';
import {
  CURATED_ENGINE_KEY,
  CURATED_ENGINE_VERSION,
  planCuratedClassification,
  type CuratedConceptInput,
} from './classification.curated.js';

/**
 * TAX-11 classification seal. A current publication version is pending
 * until it has a SUCCESS seal for the latest PUBLISHED release and the
 * current engine version. Publishing a new release or bumping the engine
 * therefore re-queues the whole archive (legacy included) without deleting
 * history. Nothing runs while the curator keeps classification disabled.
 */

export const MAX_CLASSIFICATION_ATTEMPTS = 3;
const FAILED_RETRY_INTERVAL = '15 minutes';
// After the quick retries, a failed seal is retried once a day so a systemic
// failure fixed by a later deploy heals without manual intervention.
const EXHAUSTED_RETRY_INTERVAL = '24 hours';
const CONCEPT_CACHE_TTL_MS = 5 * 60_000;

export interface PublicationTaxonomyBatchResult {
  skipped: 'DISABLED' | 'NO_PUBLISHED_RELEASE' | null;
  releaseId: string | null;
  selected: number;
  succeeded: number;
  failed: number;
  assertions: number;
}

interface PendingVersion {
  publication_version_id: string;
  title: string;
  content_text: string | null;
  relevant_excerpt: string | null;
  presentation_html: string | null;
}

let conceptCache: {
  releaseId: string;
  loadedAt: number;
  concepts: CuratedConceptInput[];
} | null = null;

export function resetClassificationConceptCache(): void {
  conceptCache = null;
}

export async function loadClassificationConcepts(
  db: Kysely<DB>,
  releaseId: string,
): Promise<CuratedConceptInput[]> {
  if (
    conceptCache &&
    conceptCache.releaseId === releaseId &&
    Date.now() - conceptCache.loadedAt < CONCEPT_CACHE_TTL_MS
  ) {
    return conceptCache.concepts;
  }

  const view = await loadReleaseView(kyselyRunner(db), releaseId);
  if (!view) throw new Error('TAXONOMY_RELEASE_NOT_FOUND');

  const typeByDimension = new Map(
    view.dimensions.map((dimension) => [
      dimension.code,
      dimension.officialCodeType,
    ]),
  );

  const concepts = view.concepts.map((concept) => {
    const type = typeByDimension.get(concept.dimensionCode) ?? null;
    return {
      releaseConceptId: concept.releaseConceptId,
      code: concept.code,
      label: concept.label,
      classifyByLabel: concept.classifyByLabel,
      aliases: concept.aliases,
      ncmPrefixes: type === 'NCM' ? concept.officialCodes : [],
      cclasstribCodes: type === 'CCLASSTRIB' ? concept.officialCodes : [],
    };
  });

  conceptCache = { releaseId, loadedAt: Date.now(), concepts };
  return concepts;
}

async function selectPending(
  db: Kysely<DB>,
  releaseId: string,
  excludedSources: readonly string[],
  limit: number,
  asOf: string,
  edition: NcmEditionSnapshot,
): Promise<PendingVersion[]> {
  const result = await sql<PendingVersion>`
    SELECT
      pv.id AS publication_version_id,
      p.title,
      pv.content_text,
      pv.relevant_excerpt,
      CASE WHEN pv.source_metadata -> 'presentation' ->> 'format' = 'SANITIZED_HTML'
        THEN pv.source_metadata -> 'presentation' ->> 'html'
        ELSE NULL
      END AS presentation_html
    FROM publications p
    JOIN publication_versions pv
      ON pv.publication_id = p.id
     AND pv.is_current = true
    LEFT JOIN publication_taxonomy_scans s
      ON s.publication_version_id = pv.id
     AND s.taxonomy_release_id = ${releaseId}::uuid
     AND s.engine_key = ${CURATED_ENGINE_KEY}
     AND s.engine_version = ${CURATED_ENGINE_VERSION}
    WHERE (
        s.id IS NULL
        OR (
          s.status = 'SUCCESS' AND NOT EXISTS (
            SELECT 1 FROM publication_taxonomy_runs r
            JOIN public.publication_ncm_scan_evidence evidence
              ON evidence.run_fingerprint = r.config_snapshot ->> 'legalScopeFingerprint'
            WHERE r.id = s.run_id AND evidence.publication_version_id = pv.id
              AND evidence.legal_as_of = ${asOf}::date
              AND evidence.recheck_on > ${asOf}::date
              AND evidence.catalog_edition_id = ${edition.id}::uuid
              AND evidence.catalog_sha256 = ${edition.checksum}
              AND evidence.legal_scope_attestation_id = public.tax13_effective_attestation_id(pv.id, ${asOf}::date)
          )
        )
        OR (
          s.status = 'FAILED'
          AND (
            (
              s.attempt_count < ${MAX_CLASSIFICATION_ATTEMPTS}
              AND s.scanned_at <= now() - ${FAILED_RETRY_INTERVAL}::interval
            )
            OR s.scanned_at <= now() - ${EXHAUSTED_RETRY_INTERVAL}::interval
          )
        )
      )
      AND public.publication_scope_is_in_scope(p.id)
      -- The exact attested, date-bound result is mandatory, even for
      -- lexical-only tags. 028 and legacy mentions are historical data.
      AND EXISTS (
        SELECT 1 FROM public.publication_ncm_scan_evidence evidence
        WHERE evidence.publication_version_id = pv.id
          AND evidence.detector_key = ${PUBLICATION_NCM_DETECTOR_KEY}
          AND evidence.detector_version = ${PUBLICATION_NCM_DETECTOR_VERSION}
          AND evidence.legal_as_of = ${asOf}::date
          AND evidence.recheck_on > ${asOf}::date
          AND evidence.catalog_edition_id = ${edition.id}::uuid
          AND evidence.catalog_sha256 = ${edition.checksum}
          AND evidence.outcome = 'SUCCESS'
          AND evidence.legal_scope_attestation_id = public.tax13_effective_attestation_id(pv.id, ${asOf}::date)
      )
      AND NOT EXISTS (
        SELECT 1
        FROM publication_origins po
        JOIN sources src ON src.id = po.source_id
        WHERE po.publication_id = p.id
          AND src.code = ANY(${[...excludedSources]}::text[])
      )
    ORDER BY
      p.published_on DESC NULLS LAST,
      pv.captured_at DESC,
      pv.id
    LIMIT ${limit}
  `.execute(db);
  return result.rows;
}

async function persistSuccess(
  db: Kysely<DB>,
  plan: ReturnType<typeof planCuratedClassification>,
  input: { asOf: string; sanitizedHtml: string; evidenceFingerprint: string },
): Promise<number> {
  return db.transaction().execute(async (trx) => {
    await lockPublicationVersionInScope(
      trx,
      plan.publicationVersionId,
    );
    // A new attestation between planning and insertion must not seal old
    // classifications. Revalidate in the SAME write transaction.
    const latest = await readVerifiedLegalScope(trx, {
      publicationVersionId: plan.publicationVersionId,
      sanitizedHtml: input.sanitizedHtml,
      asOf: input.asOf,
    });
    const currentNcm = await readCurrentNcmEvidence(trx, plan.publicationVersionId, latest);
    if (!currentNcm || currentNcm.fingerprint !== input.evidenceFingerprint) {
      throw new Error('TAX13_NCM_TEMPORAL_PROOF_CHANGED');
    }

    const inserted = await sql<{ id: string }>`
      INSERT INTO publication_taxonomy_runs (
        publication_version_id, taxonomy_release_id, method_type,
        engine_key, engine_version, code_git_sha, config_snapshot,
        config_sha256, input_sha256, run_fingerprint, status, started_at
      ) VALUES (
        ${plan.publicationVersionId}::uuid,
        ${plan.taxonomyReleaseId}::uuid,
        ${plan.methodType},
        ${plan.engineKey},
        ${plan.engineVersion},
        ${plan.codeGitSha},
        ${JSON.stringify(plan.configSnapshot)}::jsonb,
        ${plan.fingerprint.configSha256},
        ${plan.inputSha256},
        ${plan.fingerprint.runFingerprint},
        'RUNNING',
        now()
      )
      ON CONFLICT (run_fingerprint) DO NOTHING
      RETURNING id
    `.execute(trx);

    let runId = inserted.rows[0]?.id;
    let assertionCount = plan.assertions.length;

    if (!runId) {
      // A previous attempt already persisted this exact run; reuse it.
      const existing = await sql<{ id: string; status: string; count: number }>`
        SELECT r.id, r.status,
          (SELECT count(*)::int FROM publication_taxonomy_assertions a
            WHERE a.run_id = r.id) AS count
        FROM publication_taxonomy_runs r
        WHERE r.run_fingerprint = ${plan.fingerprint.runFingerprint}
      `.execute(trx);
      const row = existing.rows[0];
      if (!row || row.status !== 'SUCCESS') {
        throw new Error('TAXONOMY_RUN_CONFLICT_NOT_SUCCESS');
      }
      runId = row.id;
      assertionCount = row.count;
    } else {
      for (const assertion of plan.assertions) {
        const created = await sql<{ id: string }>`
          INSERT INTO publication_taxonomy_assertions (
            run_id, taxonomy_release_id, release_concept_id,
            assertion_status, confidence, decision_origin, reason_code
          ) VALUES (
            ${runId}::uuid,
            ${plan.taxonomyReleaseId}::uuid,
            ${assertion.releaseConceptId}::uuid,
            'CONFIRMED',
            ${assertion.confidence},
            'RULE_ENGINE',
            ${assertion.reasonCode}
          ) RETURNING id
        `.execute(trx);

        await sql`
          INSERT INTO publication_taxonomy_spans (
            assertion_id, excerpt, selector
          ) VALUES (
            ${created.rows[0]!.id}::uuid,
            ${assertion.excerpt},
            ${JSON.stringify({
              strategy: 'NFD_LOWER_ALNUM_TOKENS',
              term: assertion.matchedTerm,
              reasonCode: assertion.reasonCode,
            })}::jsonb
          )
        `.execute(trx);
      }

      await sql`
        UPDATE publication_taxonomy_runs
        SET status = 'SUCCESS', finished_at = now()
        WHERE id = ${runId}::uuid
      `.execute(trx);
    }

    await sql`
      INSERT INTO publication_taxonomy_scans (
        publication_version_id, taxonomy_release_id, engine_key,
        engine_version, status, run_id, assertion_count,
        attempt_count, error_message, scanned_at
      ) VALUES (
        ${plan.publicationVersionId}::uuid,
        ${plan.taxonomyReleaseId}::uuid,
        ${CURATED_ENGINE_KEY},
        ${CURATED_ENGINE_VERSION},
        'SUCCESS',
        ${runId}::uuid,
        ${assertionCount},
        1,
        NULL,
        now()
      )
      ON CONFLICT (
        publication_version_id, taxonomy_release_id, engine_key, engine_version
      ) DO UPDATE SET
        status = 'SUCCESS',
        run_id = EXCLUDED.run_id,
        assertion_count = EXCLUDED.assertion_count,
        attempt_count = publication_taxonomy_scans.attempt_count + 1,
        error_message = NULL,
        scanned_at = now()
      WHERE publication_taxonomy_scans.status <> 'SUCCESS'
         OR publication_taxonomy_scans.run_id IS DISTINCT FROM EXCLUDED.run_id
    `.execute(trx);

    return assertionCount;
  });
}

async function markFailed(
  db: Kysely<DB>,
  publicationVersionId: string,
  releaseId: string,
  error: unknown,
): Promise<void> {
  const message =
    error instanceof Error
      ? error.message.slice(0, 2_000)
      : 'Unknown taxonomy classification error';

  await db.transaction().execute(async (trx) => {
    await lockPublicationVersionInScope(
      trx,
      publicationVersionId,
    );

    await sql`
      INSERT INTO publication_taxonomy_scans (
        publication_version_id, taxonomy_release_id, engine_key,
        engine_version, status, run_id, assertion_count, attempt_count,
        error_message, scanned_at
      ) VALUES (
        ${publicationVersionId}::uuid,
        ${releaseId}::uuid,
        ${CURATED_ENGINE_KEY},
        ${CURATED_ENGINE_VERSION},
        'FAILED',
        NULL,
        0,
        1,
        ${message},
        now()
      )
      ON CONFLICT (
        publication_version_id, taxonomy_release_id, engine_key, engine_version
      ) DO UPDATE SET
        status = 'FAILED',
        run_id = NULL,
        assertion_count = 0,
        attempt_count = publication_taxonomy_scans.attempt_count + 1,
        error_message = EXCLUDED.error_message,
        scanned_at = now()
      WHERE publication_taxonomy_scans.status <> 'SUCCESS'
    `.execute(trx);
  });
}

export async function processPublicationTaxonomyBatch(
  db: Kysely<DB>,
  options: { limit?: number; codeGitSha?: string | null } = {},
): Promise<PublicationTaxonomyBatchResult> {
  const limit = Math.max(1, Math.min(options.limit ?? 10, 200));
  const run = kyselyRunner(db);
  const result: PublicationTaxonomyBatchResult = {
    skipped: null,
    releaseId: null,
    selected: 0,
    succeeded: 0,
    failed: 0,
    assertions: 0,
  };

  const settings = await loadRuntimeSettings(run);
  if (!settings.classificationEnabled) {
    return { ...result, skipped: 'DISABLED' };
  }

  const release = await findLatestPublishedRelease(run);
  if (!release) return { ...result, skipped: 'NO_PUBLISHED_RELEASE' };
  result.releaseId = release.id;

  const concepts = await loadClassificationConcepts(db, release.id);
  const asOf = brazilLegalReferenceDate();
  const edition = await currentNcmEdition(db, asOf);
  const pending = await selectPending(
    db,
    release.id,
    [...new Set([...settings.classificationExcludedSources, ...PROTECTED_EXCLUDED_SOURCES])],
    limit,
    asOf,
    edition,
  );
  result.selected = pending.length;
  for (const row of pending) {
    try {
      const verified = await readVerifiedLegalScope(db, {
        publicationVersionId: row.publication_version_id,
        sanitizedHtml: row.presentation_html ?? '',
        asOf,
      });
      // Never seal zero assertions or reclassify the archive from an
      // unverified headline, revoked wording, or stale attestation.
      // The publication remains pending, preserving previous releases.
      if (!verified.valid || verified.coverage !== 'COMPLETE' || verified.currentSegments === 0) continue;
      const currentNcm = await readCurrentNcmEvidence(db, row.publication_version_id, verified);
      if (!currentNcm) continue;
      const plan = planCuratedClassification({
        publicationVersionId: row.publication_version_id,
        taxonomyReleaseId: release.id,
        // Editorial titles are not independently attested CURRENT evidence.
        title: '',
        contentText: verified.currentText,
        verifiedCurrentFragments: verified.currentFragments,
        ncmCodes: currentNcm.codes,
        legalScopeFingerprint: currentNcm.fingerprint,
        concepts,
        codeGitSha: options.codeGitSha ?? null,
      });
      result.assertions += await persistSuccess(db, plan, {
        asOf,
        sanitizedHtml: row.presentation_html ?? '',
        evidenceFingerprint: currentNcm.fingerprint,
      });
      result.succeeded += 1;
    } catch (error) {
      if (isPublicationOutOfScopeError(error)) {
        continue;
      }

      try {
        await markFailed(db, row.publication_version_id, release.id, error);
        result.failed += 1;
      } catch (markError) {
        if (isPublicationOutOfScopeError(markError)) {
          continue;
        }
        throw markError;
      }
    }
  }

  return result;
}

export interface SinglePublicationClassification {
  publicationVersionId: string;
  releaseId: string;
  ncmScanned: boolean;
  persisted: boolean;
  tags: Array<{
    conceptCode: string;
    label: string;
    reasonCode: string;
    matchedTerm: string;
    confidence: number;
  }>;
}

/**
 * Classifies ONE publication (its current version) against a given release,
 * on demand and independently of the global switch: the curator can see the
 * result of a release on a chosen act before enabling classification for
 * the archive. With `persist` the seal is written exactly like the worker's.
 */
export async function classifySinglePublication(
  db: Kysely<DB>,
  input: { publicationId: string; releaseId: string; persist: boolean; codeGitSha?: string | null },
): Promise<SinglePublicationClassification> {
  const current = await sql<PendingVersion>`
    SELECT pv.id AS publication_version_id, p.title, pv.content_text, pv.relevant_excerpt,
      CASE WHEN pv.source_metadata -> 'presentation' ->> 'format' = 'SANITIZED_HTML'
        THEN pv.source_metadata -> 'presentation' ->> 'html'
        ELSE NULL
      END AS presentation_html
    FROM publications p
    JOIN publication_versions pv ON pv.publication_id = p.id AND pv.is_current = true
    WHERE p.id = ${input.publicationId}::uuid
      AND public.publication_scope_is_in_scope(p.id)
  `.execute(db);
  const row = current.rows[0];
  if (!row) throw new Error('PUBLICATION_NOT_FOUND');

  // Acquire the SUPPRESS/RESTORE serialization barrier before ANY derivative
  // catalog / attestation lookup. A catalog may be absent; that must never
  // skip a pending SUPPRESS lock or return an unrelated error in its place.
  // persistSuccess obtains the barrier again in its write transaction.
  if (input.persist) {
    await db.transaction().execute((trx) =>
      lockPublicationVersionInScope(trx, row.publication_version_id));
  }
  const asOf = brazilLegalReferenceDate();
  const verified = await readVerifiedLegalScope(db, {
    publicationVersionId: row.publication_version_id,
    sanitizedHtml: row.presentation_html ?? '',
    asOf,
  });
  const currentNcm = await readCurrentNcmEvidence(db, row.publication_version_id, verified);
  const ncmScanned = Boolean(currentNcm);
  const scopeCurrent = verified.valid && verified.coverage === 'COMPLETE' &&
    verified.currentSegments > 0;
  if (input.persist && !scopeCurrent) {
    // Preserve the publication scope suppression/rebuild race contract:
    // acquire the canonical publication SHARE lock before reporting that
    // evidence is missing. An in-flight SUPPRESS must win the lock first
    // and report PUBLICATION_OUT_OF_SCOPE, not an unrelated B4 error.
    await db.transaction().execute((trx) =>
      lockPublicationVersionInScope(trx, row.publication_version_id));
    throw new Error('TAX13_OFFICIAL_LEGAL_SCOPE_REQUIRED: ' +
      (verified.reason ?? 'NO_ATTESTED_CURRENT_FRAGMENT'));
  }

  // Report a missing legal proof before the derivative NCM seal. A scan
  // stamp never substitutes for an official scope attestation.
  if (input.persist && !ncmScanned) {
    // Preserve SUPPRESS/RESTORE serialization even when a legacy 028 stamp
    // cannot authorize a new temporal classification. A pending SUPPRESS
    // must win the canonical lock before we report missing derivative proof.
    await db.transaction().execute((trx) =>
      lockPublicationVersionInScope(trx, row.publication_version_id));
    throw new Error('NCM_SCAN_NOT_SUCCESS');
  }

  const concepts = await loadClassificationConcepts(db, input.releaseId);
  const plan = planCuratedClassification({
    publicationVersionId: row.publication_version_id,
    taxonomyReleaseId: input.releaseId,
    // Editorial titles are not independently attested CURRENT evidence.
        title: '',
    contentText: scopeCurrent && currentNcm ? verified.currentText : null,
    verifiedCurrentFragments: scopeCurrent && currentNcm ? verified.currentFragments : [],
    ncmCodes: scopeCurrent && currentNcm ? currentNcm.codes : [],
    ...(currentNcm ? { legalScopeFingerprint: currentNcm.fingerprint } : {}),
    concepts,
    codeGitSha: input.codeGitSha ?? null,
  });
  if (input.persist) await persistSuccess(db, plan, {
    asOf,
    sanitizedHtml: row.presentation_html ?? '',
    evidenceFingerprint: currentNcm!.fingerprint,
  });

  const labelById = new Map(concepts.map((concept) => [concept.releaseConceptId, concept.label]));
  return {
    publicationVersionId: row.publication_version_id,
    releaseId: input.releaseId,
    ncmScanned,
    persisted: input.persist,
    tags: plan.assertions
      .map((assertion) => ({
        conceptCode: assertion.conceptCode,
        label: labelById.get(assertion.releaseConceptId) ?? assertion.conceptCode,
        reasonCode: assertion.reasonCode,
        matchedTerm: assertion.matchedTerm,
        confidence: assertion.confidence,
      }))
      .sort((a, b) => a.conceptCode.localeCompare(b.conceptCode)),
  };
}
