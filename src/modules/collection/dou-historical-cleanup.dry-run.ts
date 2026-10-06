import { createHash } from 'node:crypto';

import type { ClientBase } from 'pg';

import {
  DOU_CLEANUP_PLAN_VERSION,
  planDouHistoricalCleanup,
  type CleanupPublication,
} from './dou-historical-cleanup.plan.js';
import { DOU_SCOPE_RULE_VERSION } from './dou-scope.rules.js';

/**
 * Issue #80. Read-only, in-database dry run of the historical cleanup planner.
 *
 * Production rows never leave the database host: publications are streamed in
 * key order inside ONE `REPEATABLE READ READ ONLY` transaction (a consistent
 * snapshot), each batch goes through the unchanged offline planner, and only
 * aggregate counts plus SHA-256 digests are returned. The candidate set is
 * re-derived deterministically by a future, separately gated executor and must
 * match `candidateSetSha256` before anything is suppressed.
 */
export const DOU_CLEANUP_DRY_RUN_VERSION = 'dou-cleanup-dry-run-v1' as const;

export interface DouCleanupDryRunSummary {
  dryRunVersion: typeof DOU_CLEANUP_DRY_RUN_VERSION;
  planVersion: typeof DOU_CLEANUP_PLAN_VERSION;
  ruleVersion: typeof DOU_SCOPE_RULE_VERSION;
  mode: 'DRY_RUN_READ_ONLY';
  executionAllowed: false;
  databaseIdentity: string;
  capturedAt: string;
  batches: number;
  counts: {
    publicationsInspected: number;
    candidatePublications: number;
    keptPublications: number;
    reviewPublications: number;
  };
  /** disposition -> primary reason code -> publications. */
  byReason: Record<'CANDIDATE' | 'KEEP' | 'REVIEW', Record<string, number>>;
  /** Candidates per DOU section as recorded in the origin's provenance. */
  candidatesBySection: Record<string, number>;
  /** What suppressing the candidates would touch (counts of candidates). */
  candidateImpact: {
    alreadyHidden: number;
    withCompanyLinks: number;
    withCompanyMatches: number;
    withTaxonomyRuns: number;
    withNcmMentions: number;
    withPersistedScopeKeep: number;
    withPersistedScopeReview: number;
    withPersistedScopeIgnore: number;
    withoutPersistedScope: number;
  };
  /** Digest of sorted `publicationId:evidenceSha256:reasons` candidate lines. */
  candidateSetSha256: string;
  /** Digest of the ordered per-batch plan digests (whole-run audit anchor). */
  runSha256: string;
}

type Disposition = 'CANDIDATE' | 'KEEP' | 'REVIEW';

const PRIMARY_REASON_ORDER = [
  'excluded_dou_section',
  'strict_routine_contract_excerpt',
] as const;

/** The reason that decided the disposition; extra codes are classifier detail. */
export function primaryReason(disposition: Disposition, reasonCodes: readonly string[]): string {
  if (disposition === 'CANDIDATE') {
    return PRIMARY_REASON_ORDER.find(code => reasonCodes.includes(code)) ?? 'unknown_candidate_reason';
  }
  // KEEP/REVIEW decisions carry exactly one planner reason, optionally followed
  // by classifier detail that is not a recognised planner code.
  const plannerCodes = [
    'not_dou_source', 'persisted_keep_decision', 'material_relevance', 'not_contract_excerpt',
    'missing_origins', 'cross_source_publication', 'missing_or_invalid_version_inventory',
    'missing_or_conflicting_dou_provenance', 'missing_or_conflicting_origin_external_id',
    'conflicting_origin_official_url', 'version_provenance_without_matching_origin',
    'version_and_origin_part_inventory_disagree', 'conflicting_primary_official_url',
    'mixed_included_and_excluded_sections', 'persisted_review_or_invalid_scope',
    'unexamined_presentation_material', 'unexamined_attached_material',
    'conflicting_or_missing_contract_act_type', 'historical_titles_unproven',
    'historical_text_completeness_unproven', 'not_unanimously_proven_routine',
  ];
  return plannerCodes.find(code => reasonCodes.includes(code)) ?? 'unknown_reason';
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export interface DouCleanupDryRunOptions {
  batchSize?: number;
  now?: () => Date;
}

/**
 * Runs on a dedicated client. The caller owns the connection; this function
 * opens and always rolls back its own read-only transaction.
 */
export async function runDouHistoricalCleanupDryRun(
  client: ClientBase,
  options: DouCleanupDryRunOptions = {},
): Promise<DouCleanupDryRunSummary> {
  return (await deriveDouCleanupCandidates(client, options)).summary;
}

/** One candidate as re-derived from the database (kept in memory only). */
export interface DouCleanupCandidate {
  publicationId: string;
  evidenceSha256: string;
  reasonCodes: string[];
  /** Persisted douScope decisions found on any origin/version envelope. */
  persistedDecisions: string[];
}

/**
 * Same read-only derivation as the dry run, also returning the candidate list
 * for a gated executor. The list never leaves the process.
 */
export async function deriveDouCleanupCandidates(
  client: ClientBase,
  options: DouCleanupDryRunOptions = {},
): Promise<{ summary: DouCleanupDryRunSummary; candidates: DouCleanupCandidate[] }> {
  const batchSize = options.batchSize ?? 500;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 5_000) {
    throw new Error('batchSize must be between 1 and 5000');
  }
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const identity = await client.query<{ identity: string; read_only: string }>(
      `SELECT encode(sha256(convert_to((SELECT system_identifier::text FROM pg_control_system())
         || ':' || current_database(), 'UTF8')), 'hex') AS identity,
         current_setting('transaction_read_only') AS read_only`,
    );
    if (identity.rows[0]?.read_only !== 'on') throw new Error('dry run requires a read-only transaction');
    const databaseIdentity = `pg:${identity.rows[0].identity.slice(0, 32)}`;
    const capturedAt = (options.now?.() ?? new Date()).toISOString();

    const source = await client.query<{ id: string }>(
      `SELECT id FROM public.sources WHERE code = 'dou' AND connector_key = 'dou'`,
    );
    if (source.rows.length !== 1) throw new Error('exactly one dou source is required');
    const sourceId = source.rows[0]!.id;

    const counts = { publicationsInspected: 0, candidatePublications: 0, keptPublications: 0, reviewPublications: 0 };
    const byReason: DouCleanupDryRunSummary['byReason'] = { CANDIDATE: {}, KEEP: {}, REVIEW: {} };
    const candidatesBySection: Record<string, number> = {};
    const candidateImpact: DouCleanupDryRunSummary['candidateImpact'] = {
      alreadyHidden: 0, withCompanyLinks: 0, withCompanyMatches: 0, withTaxonomyRuns: 0, withNcmMentions: 0,
      withPersistedScopeKeep: 0, withPersistedScopeReview: 0, withPersistedScopeIgnore: 0, withoutPersistedScope: 0,
    };
    const candidateLines: string[] = [];
    const candidates: DouCleanupCandidate[] = [];
    const batchDigests: string[] = [];
    let lastId: string | null = null;

    for (;;) {
      const page: { rows: Array<{ id: string }> } = await client.query<{ id: string }>(
        `SELECT p.id FROM public.publications p
          WHERE ($1::uuid IS NULL OR p.id > $1::uuid)
            AND EXISTS (SELECT 1 FROM public.publication_origins o WHERE o.publication_id = p.id AND o.source_id = $2::uuid)
          ORDER BY p.id LIMIT $3`,
        [lastId, sourceId, batchSize],
      );
      if (!page.rows.length) break;
      const ids: string[] = page.rows.map((row: { id: string }) => row.id);
      lastId = ids[ids.length - 1]!;

      // One client, one snapshot: queries run sequentially (pg forbids overlap).
      const publications = await client.query<{ id: string; title: string; act_type: string | null; agency: string | null; primary_official_url: string | null }>(
          `SELECT id, title, act_type, agency, primary_official_url
             FROM public.publications WHERE id = ANY($1::uuid[]) ORDER BY id`, [ids]);
      const origins = await client.query<{ id: string; publication_id: string; source_id: string; external_id: string | null; official_url: string | null; metadata: unknown }>(
          `SELECT id, publication_id, source_id, external_id, official_url, metadata
             FROM public.publication_origins WHERE publication_id = ANY($1::uuid[]) ORDER BY id`, [ids]);
      const versions = await client.query<{ id: string; publication_id: string; version_no: number; is_current: boolean; content_text: string | null; source_metadata: unknown }>(
          `SELECT id, publication_id, version_no, is_current, content_text, source_metadata
             FROM public.publication_versions WHERE publication_id = ANY($1::uuid[]) ORDER BY id`, [ids]);

      const byPublication = new Map<string, CleanupPublication>();
      for (const row of publications.rows) {
        byPublication.set(row.id, {
          id: row.id, title: row.title, act_type: row.act_type, agency: row.agency,
          primary_official_url: row.primary_official_url, origins: [], versions: [],
        });
      }
      for (const row of origins.rows) {
        byPublication.get(row.publication_id)?.origins.push({
          id: row.id, source_id: row.source_id, external_id: row.external_id,
          official_url: row.official_url, metadata: asObject(row.metadata),
        });
      }
      for (const row of versions.rows) {
        const version = {
          id: row.id, version_no: row.version_no, is_current: row.is_current,
          content_text: row.content_text, source_metadata: asObject(row.source_metadata),
        };
        byPublication.get(row.publication_id)?.versions.push(version);
      }

      const plan = planDouHistoricalCleanup({
        schemaVersion: 'dou-cleanup-snapshot-v1',
        databaseIdentity,
        capturedAt,
        source: { id: sourceId, code: 'dou', connector_key: 'dou' },
        publications: [...byPublication.values()],
      });
      batchDigests.push(plan.planSha256);

      for (const decision of plan.decisions) {
        counts.publicationsInspected += 1;
        if (decision.disposition === 'CANDIDATE') counts.candidatePublications += 1;
        else if (decision.disposition === 'KEEP') counts.keptPublications += 1;
        else counts.reviewPublications += 1;
        const reason = primaryReason(decision.disposition, decision.reasonCodes);
        byReason[decision.disposition][reason] = (byReason[decision.disposition][reason] ?? 0) + 1;
        if (decision.disposition === 'CANDIDATE') {
          candidateLines.push(`${decision.publicationId}:${decision.evidenceSha256}:${decision.reasonCodes.join('|')}`);
          const publication = byPublication.get(decision.publicationId);
          const sections = new Set(publication?.origins
            .filter(origin => origin.source_id === sourceId)
            .map(origin => String(asObject(asObject(origin.metadata).dou).section ?? 'unknown')));
          for (const section of sections) candidatesBySection[section] = (candidatesBySection[section] ?? 0) + 1;
          // Persisted scope decisions on any origin/version envelope.
          const decisions = new Set((publication ? [
            ...publication.origins.map(origin => origin.metadata),
            ...publication.versions.map(version => version.source_metadata),
          ] : []).map(meta => asObject(meta).douScope).filter(value => value !== undefined)
            .map(value => String(asObject(value).decision ?? 'INVALID')));
          if (decisions.has('KEEP')) candidateImpact.withPersistedScopeKeep += 1;
          if ([...decisions].some(value => value !== 'KEEP' && value !== 'IGNORE')) candidateImpact.withPersistedScopeReview += 1;
          if (decisions.has('IGNORE')) candidateImpact.withPersistedScopeIgnore += 1;
          if (!decisions.size) candidateImpact.withoutPersistedScope += 1;
          candidates.push({
            publicationId: decision.publicationId, evidenceSha256: decision.evidenceSha256,
            reasonCodes: [...decision.reasonCodes], persistedDecisions: [...decisions].sort(),
          });
        }
      }
      const candidateIds = plan.decisions.filter(row => row.disposition === 'CANDIDATE').map(row => row.publicationId);
      if (candidateIds.length) {
        const impact = await client.query<{
          hidden: string; company: string; matches: string; taxonomy: string; ncm: string;
        }>(
          `SELECT count(*) FILTER (WHERE p.is_hidden)::text AS hidden,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.company_publications c WHERE c.publication_id = p.id))::text AS company,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.publication_matches m
               JOIN public.company_publications c ON c.id = m.company_publication_id WHERE c.publication_id = p.id))::text AS matches,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.publication_taxonomy_runs r
               JOIN public.publication_versions v ON v.id = r.publication_version_id WHERE v.publication_id = p.id))::text AS taxonomy,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.publication_ncm_mentions n
               JOIN public.publication_versions v ON v.id = n.publication_version_id WHERE v.publication_id = p.id))::text AS ncm
           FROM public.publications p WHERE p.id = ANY($1::uuid[])`, [candidateIds]);
        const row = impact.rows[0]!;
        candidateImpact.alreadyHidden += Number(row.hidden);
        candidateImpact.withCompanyLinks += Number(row.company);
        candidateImpact.withCompanyMatches += Number(row.matches);
        candidateImpact.withTaxonomyRuns += Number(row.taxonomy);
        candidateImpact.withNcmMentions += Number(row.ncm);
      }
    }

    const summary: DouCleanupDryRunSummary = {
      dryRunVersion: DOU_CLEANUP_DRY_RUN_VERSION,
      planVersion: DOU_CLEANUP_PLAN_VERSION,
      ruleVersion: DOU_SCOPE_RULE_VERSION,
      mode: 'DRY_RUN_READ_ONLY',
      executionAllowed: false,
      databaseIdentity,
      capturedAt,
      batches: batchDigests.length,
      counts,
      byReason,
      candidatesBySection,
      candidateImpact,
      candidateSetSha256: sha256(candidateLines.sort().join('\n')),
      runSha256: sha256(batchDigests.join('\n')),
    };
    candidates.sort((left, right) => left.publicationId.localeCompare(right.publicationId));
    return { summary, candidates };
  } finally {
    await client.query('ROLLBACK');
  }
}
