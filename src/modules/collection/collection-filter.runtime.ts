import { sql, type Kysely } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';
import {
  compileCollectionFilterPolicy,
  evaluateCollectionFilter,
  normalizeCollectionFilterType,
  collectionFilterTypeConflict,
  type CollectionFilterDecision,
  type CollectionFilterPolicyInput,
  type CollectionFilterTermHit,
  type CompiledCollectionFilterPolicy,
} from './collection-filter.engine.js';
import type { NormalizedPublication } from './publication.normalizer.js';

const EXCLUDED_SOURCES = new Set(['doe-sp', 'doe-sp-legado']);
const ENFORCED_SOURCES = new Set(['dou']);

export interface ApprovedCollectionFilterRuntime {
  policyId: string;
  policyVersion: number;
  policyRevision: number;
  sourceId: string;
  sourceCode: string;
  connectorKey: string;
  policy: CompiledCollectionFilterPolicy;
}

export interface RuntimeCollectionFilterDecision {
  decision: CollectionFilterDecision;
  decisiveTerm: string | null;
  section: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function douMetadata(publication: NormalizedPublication): Record<string, unknown> {
  return record(publication.originMetadata.dou) ??
    record(publication.metadata.dou) ??
    {};
}

function sectionOf(publication: NormalizedPublication): string {
  return (text(douMetadata(publication).section) ?? '').toUpperCase();
}

function evidenceComplete(publication: NormalizedPublication): boolean {
  const dou = douMetadata(publication);
  const hasBody = Boolean(publication.contentText?.trim());
  const incomplete =
    dou.scopeStructureIncomplete === true ||
    dou.scopeStructureIncomplete === 'true' ||
    Object.prototype.hasOwnProperty.call(dou, 'titleFallback');

  return hasBody && !incomplete;
}

function materialAttachmentsUnexamined(
  publication: NormalizedPublication,
): boolean {
  const dou = douMetadata(publication);
  const parts = Array.isArray(dou.parts) ? dou.parts : [];
  const highlightImage = parts.some((part) => {
    const row = record(part);
    return row?.hasHighlightImage === true ||
      row?.hasHighlightImage === 'true';
  });

  const attachment = publication.files.some((file) => {
    if (file.versionRole === 'PROVENANCE') return false;
    return record(file.metadata)?.kind === 'ATTACHMENT' ||
      file.versionRole === 'MATERIAL_CONTENT';
  });

  return highlightImage || attachment;
}

function typeConflict(publication: NormalizedPublication): boolean {
  return collectionFilterTypeConflict(
    text(douMetadata(publication).sourceActType),
    publication.actType ?? '',
  );
}

function decisiveHit(
  hits: readonly CollectionFilterTermHit[],
): CollectionFilterTermHit | undefined {
  return hits.find(
    (hit) => hit.strength === 'STRONG' && !hit.neutralizedByNegative,
  ) ?? hits.find(
    (hit) => hit.strength === 'WEAK' && !hit.neutralizedByNegative,
  );
}

export async function loadApprovedCollectionFilterRuntime(
  db: Kysely<DB>,
  sourceId: string,
  options: { readOnly?: boolean } = {},
): Promise<ApprovedCollectionFilterRuntime | null> {
  const source = await db
    .selectFrom('sources')
    .select(['id', 'code', 'connector_key'])
    .where('id', '=', sourceId)
    .executeTakeFirstOrThrow();

  const sourceCode = source.code.trim().toLowerCase();
  if (EXCLUDED_SOURCES.has(sourceCode)) return null;
  if (!ENFORCED_SOURCES.has(sourceCode)) return null;

  const result = await sql<{
    policy_id: string;
    policy_version: number;
    policy_revision: number;
    document: CollectionFilterPolicyInput;
  }>`
    SELECT
      p.id AS policy_id,
      p.version AS policy_version,
      p.revision AS policy_revision,
      jsonb_build_object(
        'version',p.version,
        'contextWindowWords',p.context_window_words,
        'weakScoreThreshold',p.weak_score_threshold,
        'locationWeights',jsonb_build_object(
          'title',p.title_weight,
          'summary',p.summary_weight,
          'body',p.body_weight
        ),
        'rules',COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'sourceCode',r.source_code,
            'section',r.section,
            'canonicalType',r.canonical_type,
            'mode',r.mode
          ) ORDER BY r.source_code,r.section,r.canonical_type)
          FROM collection_filter_type_rules r
          WHERE r.policy_id=p.id
        ),'[]'::jsonb),
        'aliases',COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'sourceCode',a.source_code,
            'section',a.section,
            'alias',a.normalized_alias,
            'canonicalType',a.canonical_type
          ) ORDER BY a.source_code,a.section,a.normalized_alias)
          FROM collection_filter_type_aliases a
          WHERE a.policy_id=p.id
        ),'[]'::jsonb),
        'terms',COALESCE((
          SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
            'text',t.term_text,
            'strength',t.strength,
            'sourceCode',NULLIF(t.source_code,''),
            'section',NULLIF(t.section,''),
            'canonicalType',NULLIF(t.canonical_type,''),
            'locationScope',t.location_scope
          )) ORDER BY t.strength,t.normalized_term)
          FROM collection_filter_terms t
          WHERE t.policy_id=p.id
        ),'[]'::jsonb)
      ) AS document
    FROM collection_filter_policies p
    WHERE p.status='APPROVED'
    ORDER BY p.version DESC
    LIMIT 1
  `.execute(db);

  const row = result.rows[0];
  if (!row) {
    throw new Error('approved_collection_filter_required');
  }

  if (!options.readOnly) {
    await sql`SELECT collection_filter_cleanup_discards()`.execute(db);
  }

  return {
    policyId: row.policy_id,
    policyVersion: Number(row.policy_version),
    policyRevision: Number(row.policy_revision),
    sourceId: source.id,
    sourceCode,
    connectorKey: source.connector_key,
    policy: compileCollectionFilterPolicy(row.document),
  };
}

export function evaluateRuntimeCollectionFilter(
  runtime: ApprovedCollectionFilterRuntime,
  publication: NormalizedPublication,
): RuntimeCollectionFilterDecision {
  const section = sectionOf(publication);
  const decision = evaluateCollectionFilter(runtime.policy, {
    sourceCode: runtime.sourceCode,
    section,
    ...(publication.actType !== undefined
      ? { actType: publication.actType }
      : {}),
    title: publication.title,
    ...(publication.contentText !== undefined
      ? { body: publication.contentText }
      : {}),
    evidenceComplete: evidenceComplete(publication),
    materialAttachmentsUnexamined:
      materialAttachmentsUnexamined(publication),
    typeConflict: typeConflict(publication),
    provenanceConflict: false,
  });
  const hit = decisiveHit(decision.termHits);

  return {
    decision,
    decisiveTerm: hit?.text ?? null,
    section,
  };
}

export async function recordRuntimeCollectionDiscard(
  db: Kysely<DB>,
  input: {
    runtime: ApprovedCollectionFilterRuntime;
    runId: string;
    attemptId: string;
    publication: NormalizedPublication;
    decision: RuntimeCollectionFilterDecision;
  },
): Promise<void> {
  await sql`
    SELECT collection_filter_record_discard(
      ${input.runtime.sourceId}::uuid,
      ${input.runId}::uuid,
      ${input.attemptId}::uuid,
      ${input.publication.sourceItemKey},
      ${input.publication.externalId ?? null},
      ${input.runtime.sourceCode},
      ${input.runtime.connectorKey},
      ${input.decision.section},
      ${input.decision.decision.rawType || null},
      ${input.decision.decision.canonicalType ?? null},
      ${input.publication.title},
      ${input.publication.actNumber ?? null},
      ${input.publication.publishedOn ?? null}::date,
      ${input.publication.officialUrl},
      ${input.decision.decision.reasonCode},
      ${input.decision.decisiveTerm},
      ${input.runtime.policyId}::uuid,
      ${input.runtime.policyVersion},
      ${input.runtime.policyRevision}
    )
  `.execute(db);
}

export async function recordRuntimeUnknownType(
  db: Kysely<DB>,
  input: {
    runtime: ApprovedCollectionFilterRuntime;
    publicationId: string;
    decision: RuntimeCollectionFilterDecision;
  },
): Promise<void> {
  if (!input.decision.decision.requiresNewTypeReview) return;
  await sql`
    SELECT collection_filter_record_unknown_type(
      ${input.runtime.sourceCode},
      ${input.decision.section},
      ${input.decision.decision.rawType},
      ${input.decision.decision.normalizedRawType},
      ${input.publicationId}::uuid
    )
  `.execute(db);
}

export async function recordRuntimeDiscardRate(
  db: Kysely<DB>,
  input: {
    runtime: ApprovedCollectionFilterRuntime;
    runId: string;
    foundCount: number;
    discardCount: number;
  },
): Promise<boolean> {
  const result = await sql<{ alerted: boolean }>`
    SELECT collection_filter_record_run_stats(
      ${input.runId}::uuid,
      ${input.runtime.sourceId}::uuid,
      ${input.runtime.sourceCode},
      ${input.runtime.policyId}::uuid,
      ${input.runtime.policyVersion},
      ${input.runtime.policyRevision},
      ${input.foundCount},
      ${input.discardCount}
    ) AS alerted
  `.execute(db);
  return result.rows[0]?.alerted ?? false;
}
