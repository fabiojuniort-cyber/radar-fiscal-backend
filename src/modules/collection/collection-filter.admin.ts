import { sql, type Kysely } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';
import { withUserContext } from '../../infrastructure/database/tenant-context.js';
export async function readCollectionFilterAdminState(
  db: Kysely<DB>,
  userId: string,
) {
  return withUserContext(db, userId, async (trx) => {
    const policies = await sql<{
      id: string;
      version: number;
      revision: number;
      status: string;
      context_window_words: number;
      weak_score_threshold: number;
      title_weight: number;
      summary_weight: number;
      body_weight: number;
      change_notes: string | null;
      created_at: Date;
      approved_at: Date | null;
    }>`
      SELECT id, version, revision, status,
             context_window_words, weak_score_threshold,
             title_weight, summary_weight, body_weight,
             change_notes, created_at, approved_at
      FROM collection_filter_policies
      WHERE status='APPROVED'
      ORDER BY version DESC
    `.execute(trx);

    const policyIds = policies.rows.map((row) => row.id);
    if (policyIds.length === 0) {
      return {
        policies: [],
        documents: {},
        newTypesOpen: 0,
      };
    }

    const [rules, aliases, terms, newTypes] = await Promise.all([
      sql<any>`SELECT policy_id,source_code,section,canonical_type,mode,help_text
        FROM collection_filter_type_rules
        WHERE policy_id = ANY(${policyIds}::uuid[])
        ORDER BY source_code,section,canonical_type`.execute(trx),
      sql<any>`SELECT policy_id,source_code,section,normalized_alias,canonical_type
        FROM collection_filter_type_aliases
        WHERE policy_id = ANY(${policyIds}::uuid[])
        ORDER BY source_code,section,normalized_alias`.execute(trx),
      sql<any>`SELECT policy_id,term_text,normalized_term,strength,source_code,section,canonical_type,location_scope
        FROM collection_filter_terms
        WHERE policy_id = ANY(${policyIds}::uuid[])
        ORDER BY strength,normalized_term`.execute(trx),
      sql<{ count: string }>`SELECT count(*)::text AS count
        FROM collection_filter_new_types WHERE status='OPEN'`.execute(trx),
    ]);

    const documents: Record<string, unknown> = {};
    for (const policy of policies.rows) {
      documents[policy.id] = {
        id: policy.id,
        version: Number(policy.version),
        revision: Number(policy.revision),
        status: policy.status,
        contextWindowWords: Number(policy.context_window_words),
        weakScoreThreshold: Number(policy.weak_score_threshold),
        locationWeights: {
          title: Number(policy.title_weight),
          summary: Number(policy.summary_weight),
          body: Number(policy.body_weight),
        },
        changeNotes: policy.change_notes,
        createdAt: policy.created_at,
        approvedAt: policy.approved_at,
        rules: rules.rows
          .filter((row:any) => row.policy_id === policy.id)
          .map((row:any) => ({
            sourceCode: row.source_code,
            section: row.section,
            canonicalType: row.canonical_type,
            mode: row.mode,
            helpText: row.help_text,
          })),
        aliases: aliases.rows
          .filter((row:any) => row.policy_id === policy.id)
          .map((row:any) => ({
            sourceCode: row.source_code,
            section: row.section,
            alias: row.normalized_alias,
            canonicalType: row.canonical_type,
          })),
        terms: terms.rows
          .filter((row:any) => row.policy_id === policy.id)
          .map((row:any) => ({
            text: row.term_text,
            normalizedTerm: row.normalized_term,
            strength: row.strength,
            sourceCode: row.source_code,
            section: row.section,
            canonicalType: row.canonical_type,
            locationScope: row.location_scope,
          })),
      };
    }

    return {
      policies: policies.rows.map((row) => ({
        id: row.id,
        version: Number(row.version),
        revision: Number(row.revision),
        status: row.status,
      })),
      documents,
      newTypesOpen: Number(newTypes.rows[0]?.count ?? 0),
    };
  });
}

export async function listCollectionFilterNewTypes(
  db: Kysely<DB>,
  userId: string,
  status: 'OPEN' | 'RESOLVED' | 'MERGED' = 'OPEN',
) {
  return withUserContext(db, userId, async (trx) => {
    const result = await sql<any>`
      SELECT
        n.id,n.source_code,n.section,n.normalized_type,n.sample_raw_type,
        n.occurrence_count,n.first_seen_at,n.last_seen_at,
        n.sample_publication_ids,n.status,n.resolved_canonical_type,n.resolved_at,
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', sample.id,
              'title', sample.title,
              'publishedOn', sample.published_on,
              'officialUrl', sample.primary_official_url
            )
            ORDER BY sample.ord
          )
          FROM (
            SELECT
              p.id,p.title,p.published_on,p.primary_official_url,s.ord
            FROM unnest(n.sample_publication_ids)
              WITH ORDINALITY AS s(publication_id,ord)
            JOIN publications p ON p.id=s.publication_id
            ORDER BY s.ord
            LIMIT 3
          ) sample
        ), '[]'::jsonb) AS examples
      FROM collection_filter_new_types n
      WHERE n.status=${status}
      ORDER BY n.occurrence_count DESC,n.last_seen_at DESC
      LIMIT 500
    `.execute(trx);
    return result.rows;
  });
}

export async function listCollectionFilterDiscards(
  db: Kysely<DB>,
  userId: string,
  options: {
    sourceCode?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
  } = {},
) {
  return withUserContext(db, userId, async (trx) => {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const offset = Math.max(options.offset ?? 0, 0);
    const sourceCode = options.sourceCode?.trim().toLowerCase() || null;
    const result = await sql<any>`
      SELECT
        d.id,
        d.source_code,
        d.connector_key,
        d.section,
        d.raw_type,
        d.canonical_type,
        d.title,
        d.act_number,
        d.published_on,
        d.official_url,
        d.reason_code,
        d.decisive_term,
        d.policy_version,
        d.policy_revision,
        d.discarded_at,
        d.expires_at
      FROM collection_filter_discards d
      WHERE (${sourceCode}::text IS NULL OR d.source_code=${sourceCode})
      ORDER BY d.discarded_at DESC,d.id DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `.execute(trx);
    return result.rows;
  });
}

export async function listCollectionFilterDiscardAlerts(
  db: Kysely<DB>,
  userId: string,
  options: {
    status?: 'OPEN' | 'ACKNOWLEDGED' | undefined;
    limit?: number | undefined;
  } = {},
) {
  return withUserContext(db, userId, async (trx) => {
    const status = options.status ?? null;
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const result = await sql<any>`
      SELECT
        a.id,
        a.collection_run_id,
        a.source_code,
        a.discard_rate,
        a.baseline_rate,
        a.threshold_rate,
        a.found_count,
        a.discard_count,
        a.status,
        a.created_at,
        a.acknowledged_at
      FROM collection_filter_discard_alerts a
      WHERE (${status}::text IS NULL OR a.status=${status})
      ORDER BY a.created_at DESC,a.id DESC
      LIMIT ${limit}
    `.execute(trx);
    return result.rows;
  });
}

export function collectionFilterAdminErrorCode(
  error: unknown,
): string | null {
  if (!(error instanceof Error)) return null;
  const known = new Set([
    'platform_admin_required',
    'new_type_not_found',
    'invalid_new_type_status',
  ]);
  return known.has(error.message) ? error.message : null;
}
