import { createHash } from 'node:crypto';
import type { ClientBase } from 'pg';

import {
  cleanupCanonicalJson,
  planDouHistoricalCleanup,
  validateDouCleanupSnapshot,
  type CleanupPublication,
  type DouCleanupSnapshot,
} from './dou-historical-cleanup.plan.js';
import {
  evaluatePublicationExclusionPolicy,
  PUBLICATION_EXCLUSION_POLICY,
} from './publication-exclusion-policy.js';

/** Candidate discovery only. This module has no suppression/execution branch. */
export const PUBLICATION_EXCLUSION_HISTORY_VERSION = 'publication-exclusion-history-v1' as const;
export const EXCLUSION_DEPENDENCIES = [
  'companyLinks', 'companyMatches', 'taxonomyRuns', 'taxonomyScans',
  'curatorTags', 'ncmMentions', 'ncmScans', 'files',
] as const;
export type ExclusionDependencyCounts = Record<typeof EXCLUSION_DEPENDENCIES[number], number>;

export interface ExclusionHistoryPublication extends CleanupPublication {
  /** Missing assertions cannot establish an inventory's completeness. */
  inventoryComplete?: boolean;
  originCount?: number;
  versionCount?: number;
  inScope?: boolean;
  dependencyCounts?: ExclusionDependencyCounts;
}
export interface PublicationExclusionHistorySnapshot extends Omit<DouCleanupSnapshot, 'publications'> {
  publications: ExclusionHistoryPublication[];
}
export interface PublicationExclusionHistoryDecision {
  publicationId: string;
  decision: 'KEEP' | 'REVIEW' | 'EXCLUDE';
  sourceCode: string;
  normalizedActType: string;
  category: string;
  reasonCodes: string[];
  ruleIds: string[];
  evidenceSha256: string;
}
export interface PublicationExclusionHistorySummary {
  historyVersion: typeof PUBLICATION_EXCLUSION_HISTORY_VERSION;
  mode: 'DRY_RUN_READ_ONLY';
  executionAllowed: false;
  databaseIdentity: string;
  capturedAt: string;
  policyKey: string;
  policyVersion: string;
  policySha256: string;
  counts: { publicationsInspected: number; excludedCandidates: number; kept: number; review: number };
  byReason: Record<string, number>;
  bySourceTypeGroup: Array<{
    sourceCode: string; normalizedActType: string; category: string;
    decision: PublicationExclusionHistoryDecision['decision']; count: number;
  }>;
  candidateSetSha256: string;
  inspectedSetSha256: string;
}

function hash(text: string): string { return createHash('sha256').update(text).digest('hex'); }
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function canonicalEvidence(publication: ExclusionHistoryPublication): string {
  // SQL row/array order is not evidence. Bind every supplied field otherwise.
  return cleanupCanonicalJson({
    ...publication,
    origins: [...publication.origins].sort((a, b) => a.id.localeCompare(b.id)),
    versions: [...publication.versions].sort((a, b) => a.id.localeCompare(b.id)),
  });
}
function completeEnvelope(metadata: Record<string, unknown>): boolean {
  const dou = object(metadata.dou);
  const strings = (v: unknown) => Array.isArray(v) && v.every(item => typeof item === 'string');
  // The normal parser omits this flag when false; require the explicit
  // supplementary inventories and the independent XML/ZIP provenance gate.
  if (!dou || dou.scopeStructureIncomplete === true || dou.titleFallback !== undefined ||
    dou.scopeStructureIncomplete !== undefined && typeof dou.scopeStructureIncomplete !== 'boolean' ||
    typeof dou.abstract !== 'string' || !strings(dou.continuationTitles) || !strings(dou.continuationAbstracts)) return false;
  if (metadata.files !== undefined && (!Array.isArray(metadata.files) || metadata.files.length !== 0)) return false;
  const presentation = object(metadata.presentation);
  return metadata.presentation === undefined || !!presentation && presentation.version === 1 &&
    presentation.format === 'PRESERVED_TEXT' && presentation.preservesWhitespace === true &&
    Object.keys(presentation).every(key => ['version', 'format', 'preservesWhitespace'].includes(key));
}

function decide(
  publication: ExclusionHistoryPublication,
  sourceId: string,
  legacy: ReturnType<typeof planDouHistoricalCleanup>['decisions'][number],
): PublicationExclusionHistoryDecision {
  // Evaluation order also selects the representative category, so normalize
  // inventory order before evaluating, not only when hashing the evidence.
  const origins = [...publication.origins].sort((a, b) => a.id.localeCompare(b.id));
  const versions = [...publication.versions].sort((a, b) => a.id.localeCompare(b.id));
  const metadata = [...origins.map(row => row.metadata), ...versions.map(row => row.source_metadata)];
  // Reevaluate every body against every metadata envelope. An origin-only
  // abstract or historical KEEP must not be lost by selecting current alone.
  const evaluations = versions.flatMap(version => metadata.map(meta =>
    evaluatePublicationExclusionPolicy({
      sourceCode: 'dou',
      publication: {
        title: publication.title, officialUrl: publication.primary_official_url ?? '',
        ...(publication.act_type === null ? {} : { actType: publication.act_type }),
        ...(publication.agency === null ? {} : { agency: publication.agency }),
        ...(version.content_text === null ? {} : { content: version.content_text }),
        metadata: meta,
      },
    })));
  const first = evaluations[0];
  const base = {
    publicationId: publication.id,
    sourceCode: 'dou',
    normalizedActType: first?.normalizedActType ?? 'UNKNOWN',
    category: first?.category ?? 'UNKNOWN',
    ruleIds: [...new Set(evaluations.flatMap(value => value.ruleId ? [value.ruleId] : []))].sort(),
    evidenceSha256: hash(canonicalEvidence(publication)),
  };
  const result = (decision: PublicationExclusionHistoryDecision['decision'], ...reasonCodes: string[]) =>
    ({ ...base, decision, reasonCodes: [...new Set(reasonCodes)].sort() });

  const stored = metadata.flatMap(meta => ['douScope', 'publicationExclusion', 'publicationExclusionPolicy']
    .filter(key => meta[key] !== undefined).map(key => object(meta[key])));
  if (stored.some(value => value?.decision === 'KEEP')) return result('KEEP', 'persisted_keep_decision');
  if (evaluations.some(value => value.decision === 'KEEP')) return result('KEEP', 'policy_keep_veto');
  if (!publication.origins.length) return result('REVIEW', 'missing_origins');
  if (publication.origins.some(origin => origin.source_id !== sourceId)) return result('REVIEW', 'cross_source_publication');
  if (publication.inventoryComplete !== true || publication.originCount !== publication.origins.length ||
    publication.versionCount !== publication.versions.length) return result('REVIEW', 'unproven_inventory_completeness');
  if (!publication.versions.length || publication.versions.filter(version => version.is_current).length !== 1) {
    return result('REVIEW', 'missing_or_invalid_version_inventory');
  }
  const numbered = publication.versions.map(version => ({
    number: (version as unknown as Record<string, unknown>).version_no,
    current: version.is_current,
  }));
  if (numbered.some(version => typeof version.number !== 'number' || !Number.isSafeInteger(version.number) ||
    version.number < 1 || version.number > numbered.length || version.current && version.number !== numbered.length) ||
    new Set(numbered.map(version => version.number)).size !== numbered.length) {
    return result('REVIEW', 'incomplete_version_number_inventory');
  }
  if (publication.inScope !== true) return result('REVIEW', publication.inScope === false ? 'already_out_of_scope' : 'unknown_scope_state');
  const dependencies = publication.dependencyCounts;
  if (!dependencies || EXCLUSION_DEPENDENCIES.some(key => !Number.isSafeInteger(dependencies[key]) || dependencies[key] < 0)) {
    return result('REVIEW', 'unproven_dependency_inventory');
  }
  if (EXCLUSION_DEPENDENCIES.some(key => dependencies[key] !== 0)) return result('REVIEW', 'existing_dependent_records');
  if (stored.some(value => value?.decision !== 'IGNORE' && value?.decision !== 'EXCLUDE')) {
    return result('REVIEW', 'persisted_review_or_invalid_decision');
  }
  // Reuse the audited XML/ZIP/origin/version provenance gate without altering
  // evidence or teaching the old planner new exception families. Its only
  // permitted non-candidate exit is the post-provenance other-family KEEP.
  if (legacy.disposition !== 'CANDIDATE' && !legacy.reasonCodes.includes('not_contract_excerpt')) {
    return result(legacy.disposition === 'KEEP' ? 'KEEP' : 'REVIEW', 'legacy_safety_veto', ...legacy.reasonCodes);
  }
  if (metadata.some(meta => !completeEnvelope(meta)) ||
    publication.versions.some(version => !version.content_text?.trim())) return result('REVIEW', 'incomplete_historical_material');
  const attached = [(publication as unknown as Record<string, unknown>).files,
    ...publication.versions.map(version => (version as unknown as Record<string, unknown>).files)];
  if (attached.some(files => files !== undefined && (!Array.isArray(files) || files.length !== 0))) {
    return result('REVIEW', 'unexamined_attached_material');
  }
  if (publication.versions.length !== 1) return result('REVIEW', 'historical_titles_unproven');
  if (!publication.act_type || metadata.some(meta => object(meta.dou)?.sourceActType !== publication.act_type)) {
    return result('REVIEW', 'contradictory_source_act_type');
  }
  if (!evaluations.length || evaluations.some(value => value.decision !== 'EXCLUDE' ||
    value.policyKey !== PUBLICATION_EXCLUSION_POLICY.key || value.policyVersion !== PUBLICATION_EXCLUSION_POLICY.version)) {
    return result('REVIEW', 'policy_exclusion_not_unanimous');
  }
  if (new Set(evaluations.map(value => value.category)).size !== 1 ||
    new Set(evaluations.map(value => value.ruleId ?? '')).size !== 1) return result('REVIEW', 'conflicting_policy_evidence');
  return result('EXCLUDE', 'unanimous_policy_exclusion', ...evaluations.map(value => value.reasonCode));
}

export function summarizePublicationExclusionHistory(
  input: Pick<PublicationExclusionHistorySnapshot, 'databaseIdentity' | 'capturedAt'>,
  decisions: readonly PublicationExclusionHistoryDecision[],
): PublicationExclusionHistorySummary {
  const ordered = [...decisions].sort((a, b) => a.publicationId.localeCompare(b.publicationId));
  if (new Set(ordered.map(row => row.publicationId)).size !== ordered.length) throw new Error('Duplicate history decision');
  const policySha256 = hash(cleanupCanonicalJson(PUBLICATION_EXCLUSION_POLICY));
  const byReason: Record<string, number> = {};
  const groups = new Map<string, PublicationExclusionHistorySummary['bySourceTypeGroup'][number]>();
  for (const row of ordered) {
    for (const reason of row.reasonCodes) byReason[reason] = (byReason[reason] ?? 0) + 1;
    const key = cleanupCanonicalJson([row.sourceCode, row.normalizedActType, row.category, row.decision]);
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { sourceCode: row.sourceCode, normalizedActType: row.normalizedActType,
      category: row.category, decision: row.decision, count: 1 });
  }
  const line = (row: PublicationExclusionHistoryDecision) =>
    `${row.publicationId}:${row.evidenceSha256}:${policySha256}:${row.decision}:${row.reasonCodes.join('|')}`;
  const prefix = `${PUBLICATION_EXCLUSION_HISTORY_VERSION}:${input.databaseIdentity}:${policySha256}\n`;
  return {
    historyVersion: PUBLICATION_EXCLUSION_HISTORY_VERSION, mode: 'DRY_RUN_READ_ONLY', executionAllowed: false,
    databaseIdentity: input.databaseIdentity, capturedAt: input.capturedAt,
    policyKey: PUBLICATION_EXCLUSION_POLICY.key, policyVersion: PUBLICATION_EXCLUSION_POLICY.version, policySha256,
    counts: { publicationsInspected: ordered.length, excludedCandidates: ordered.filter(row => row.decision === 'EXCLUDE').length,
      kept: ordered.filter(row => row.decision === 'KEEP').length, review: ordered.filter(row => row.decision === 'REVIEW').length },
    byReason: Object.fromEntries(Object.entries(byReason).sort(([a], [b]) => a.localeCompare(b))),
    bySourceTypeGroup: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => group),
    candidateSetSha256: hash(prefix + ordered.filter(row => row.decision === 'EXCLUDE').map(line).join('\n')),
    inspectedSetSha256: hash(prefix + ordered.map(line).join('\n')),
  };
}

export function planPublicationExclusionHistory(input: unknown) {
  validateDouCleanupSnapshot(input);
  const snapshot = input as PublicationExclusionHistorySnapshot;
  const legacy = planDouHistoricalCleanup(snapshot);
  const legacyById = new Map(legacy.decisions.map(row => [row.publicationId, row]));
  const decisions = snapshot.publications.map(row => decide(row, snapshot.source.id, legacyById.get(row.id)!))
    .sort((a, b) => a.publicationId.localeCompare(b.publicationId));
  return { summary: summarizePublicationExclusionHistory(snapshot, decisions), decisions };
}

export function parsePublicationExclusionDryRunArgs(args: readonly string[]): void {
  if (args.length > 1 || args.some(arg => arg !== '--dry-run')) throw new Error('Only read-only dry-run is available');
}

/** Dedicated, unfiltered client required. No identifiers/bodies leave the summary. */
export async function runPublicationExclusionDryRun(
  client: ClientBase,
  options: { batchSize?: number; now?: () => Date } = {},
): Promise<PublicationExclusionHistorySummary> {
  const batchSize = options.batchSize ?? 500;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 5000) throw new Error('Invalid batch size');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const guard = await client.query<{ identity: string; read_only: string; default_read_only: string; isolation: string; unfiltered: boolean }>(
      `SELECT encode(sha256(convert_to((SELECT system_identifier::text FROM pg_control_system()) || ':' || current_database(), 'UTF8')), 'hex') AS identity,
       current_setting('transaction_read_only') AS read_only,
       current_setting('default_transaction_read_only') AS default_read_only,
       current_setting('transaction_isolation') AS isolation,
       (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS unfiltered`);
    const checked = guard.rows[0];
    if (!checked || checked.read_only !== 'on' || checked.default_read_only !== 'on' ||
      checked.isolation !== 'repeatable read' || checked.unfiltered !== true || !/^[a-f0-9]{64}$/.test(checked.identity)) {
      throw new Error('Read-only unfiltered snapshot guard failed');
    }
    const context = { databaseIdentity: `pg:${checked.identity.slice(0, 32)}`, capturedAt: (options.now?.() ?? new Date()).toISOString() };
    const sources = await client.query<{ id: string }>("SELECT id FROM public.sources WHERE code = 'dou' AND connector_key = 'dou'");
    if (sources.rows.length !== 1) throw new Error('Exactly one DOU source is required');
    const sourceId = sources.rows[0]!.id;
    const decisions: PublicationExclusionHistoryDecision[] = [];
    let lastId: string | null = null;
    for (;;) {
      const page: { rows: Array<{ id: string }> } = await client.query(
        `SELECT p.id FROM public.publications p WHERE ($1::uuid IS NULL OR p.id > $1::uuid)
          AND EXISTS (SELECT 1 FROM public.publication_origins o WHERE o.publication_id = p.id AND o.source_id = $2::uuid)
          ORDER BY p.id LIMIT $3`, [lastId, sourceId, batchSize]);
      if (!page.rows.length) break;
      const ids = page.rows.map(row => row.id);
      if (ids.some((id, i) => (i > 0 && id <= ids[i - 1]!) || (lastId !== null && id <= lastId))) throw new Error('Invalid snapshot page order');
      lastId = ids[ids.length - 1]!;
      // Same snapshot/loader shape as the existing DOU read-only planner.
      const publications = await client.query<{
        id: string; title: string; act_type: string | null; agency: string | null;
        primary_official_url: string | null; in_scope: boolean;
      }>(`SELECT id, title, act_type, agency, primary_official_url,
        public.publication_scope_is_in_scope(id) AS in_scope
        FROM public.publications WHERE id = ANY($1::uuid[]) ORDER BY id`, [ids]);
      const origins = await client.query<{
        id: string; publication_id: string; source_id: string; external_id: string | null;
        official_url: string | null; metadata: Record<string, unknown>;
      }>('SELECT id, publication_id, source_id, external_id, official_url, metadata FROM public.publication_origins WHERE publication_id = ANY($1::uuid[]) ORDER BY id', [ids]);
      const versions = await client.query<{
        id: string; publication_id: string; version_no: number; is_current: boolean;
        content_text: string | null; source_metadata: Record<string, unknown>;
      }>('SELECT id, publication_id, version_no, is_current, content_text, source_metadata FROM public.publication_versions WHERE publication_id = ANY($1::uuid[]) ORDER BY id', [ids]);
      const dependencies = await client.query<{ id: string; dependency_counts: ExclusionDependencyCounts }>(
        `SELECT p.id, jsonb_build_object(
          'companyLinks', (SELECT count(*) FROM public.company_publications c WHERE c.publication_id = p.id),
          'companyMatches', (SELECT count(*) FROM public.publication_matches m JOIN public.company_publications c ON c.id = m.company_publication_id WHERE c.publication_id = p.id),
          'taxonomyRuns', (SELECT count(*) FROM public.publication_taxonomy_runs r JOIN public.publication_versions v ON v.id = r.publication_version_id WHERE v.publication_id = p.id),
          'taxonomyScans', (SELECT count(*) FROM public.publication_taxonomy_scans r JOIN public.publication_versions v ON v.id = r.publication_version_id WHERE v.publication_id = p.id),
          'curatorTags', (SELECT count(*) FROM public.publication_taxonomy_curator_tags r JOIN public.publication_versions v ON v.id = r.publication_version_id WHERE v.publication_id = p.id),
          'ncmMentions', (SELECT count(*) FROM public.publication_ncm_mentions r JOIN public.publication_versions v ON v.id = r.publication_version_id WHERE v.publication_id = p.id),
          'ncmScans', (SELECT count(*) FROM public.publication_ncm_scans r JOIN public.publication_versions v ON v.id = r.publication_version_id WHERE v.publication_id = p.id),
          'files', (SELECT count(*) FROM public.publication_files f JOIN public.publication_versions v ON v.id = f.publication_version_id WHERE v.publication_id = p.id)
        ) AS dependency_counts FROM public.publications p WHERE p.id = ANY($1::uuid[]) ORDER BY p.id`, [ids]);
      if (publications.rows.length !== ids.length || dependencies.rows.length !== ids.length) throw new Error('Incomplete snapshot batch');
      const rows: ExclusionHistoryPublication[] = publications.rows.map(row => {
        const rowOrigins = origins.rows.filter(origin => origin.publication_id === row.id);
        const rowVersions = versions.rows.filter(version => version.publication_id === row.id);
        const dependencyCounts = dependencies.rows.find(item => item.id === row.id)?.dependency_counts;
        return {
          id: row.id, title: row.title, act_type: row.act_type, agency: row.agency, primary_official_url: row.primary_official_url,
          origins: rowOrigins, versions: rowVersions, inventoryComplete: true,
          originCount: rowOrigins.length, versionCount: rowVersions.length, inScope: row.in_scope,
          ...(dependencyCounts === undefined ? {} : { dependencyCounts }),
        };
      });
      const plan = planPublicationExclusionHistory({
        schemaVersion: 'dou-cleanup-snapshot-v1', ...context,
        source: { id: sourceId, code: 'dou', connector_key: 'dou' }, publications: rows,
      });
      decisions.push(...plan.decisions);
    }
    return summarizePublicationExclusionHistory(context, decisions);
  } finally {
    await client.query('ROLLBACK');
  }
}
