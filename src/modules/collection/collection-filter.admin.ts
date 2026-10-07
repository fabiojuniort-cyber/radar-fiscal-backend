import { sql, type Kysely } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';
import { withUserContext } from '../../infrastructure/database/tenant-context.js';
import {
  compileCollectionFilterPolicy,
  normalizeCollectionFilterText,
  normalizeCollectionFilterType,
  type CollectionFilterMode,
  type CollectionFilterTermStrength,
} from './collection-filter.engine.js';

export interface CollectionFilterDraftInput {
  contextWindowWords: number;
  weakScoreThreshold: number;
  locationWeights: {
    title: number;
    summary: number;
    body: number;
  };
  changeNotes?: string | null;
  rules: Array<{
    sourceCode: string;
    section?: string;
    canonicalType: string;
    mode: CollectionFilterMode;
    helpText?: string | null;
  }>;
  aliases: Array<{
    sourceCode: string;
    section?: string;
    alias: string;
    canonicalType: string;
  }>;
  terms: Array<{
    text: string;
    strength: CollectionFilterTermStrength;
    sourceCode?: string;
    section?: string;
    canonicalType?: string;
    locationScope?: 'ANY' | 'TITLE' | 'SUMMARY' | 'BODY';
  }>;
}

function serializableDraft(input: CollectionFilterDraftInput) {
  const compiled = compileCollectionFilterPolicy({
    version: 1,
    contextWindowWords: input.contextWindowWords,
    weakScoreThreshold: input.weakScoreThreshold,
    locationWeights: input.locationWeights,
    rules: input.rules,
    aliases: input.aliases,
    terms: input.terms,
  });

  return {
    contextWindowWords: compiled.contextWindowWords,
    weakScoreThreshold: compiled.weakScoreThreshold,
    locationWeights: {
      title: compiled.locationWeights.TITLE,
      summary: compiled.locationWeights.SUMMARY,
      body: compiled.locationWeights.BODY,
    },
    changeNotes: input.changeNotes ?? null,
    rules: input.rules.map((rule) => ({
      source_code: rule.sourceCode.trim().toLowerCase(),
      section: (rule.section ?? '').trim().toUpperCase(),
      canonical_type: normalizeCollectionFilterType(rule.canonicalType),
      mode: rule.mode,
      help_text: rule.helpText ?? null,
    })),
    aliases: input.aliases.map((alias) => ({
      source_code: alias.sourceCode.trim().toLowerCase(),
      section: (alias.section ?? '').trim().toUpperCase(),
      normalized_alias: normalizeCollectionFilterType(alias.alias),
      canonical_type: normalizeCollectionFilterType(alias.canonicalType),
    })),
    terms: input.terms.map((term) => ({
      term_text: term.text.trim(),
      normalized_term: normalizeCollectionFilterText(term.text),
      strength: term.strength,
      source_code: term.sourceCode?.trim().toLowerCase() ?? '',
      section: term.section?.trim().toUpperCase() ?? '',
      canonical_type: term.canonicalType
        ? normalizeCollectionFilterType(term.canonicalType)
        : '',
      location_scope: term.locationScope ?? 'ANY',
    })),
  };
}

export async function saveCollectionFilterDraft(
  db: Kysely<DB>,
  userId: string,
  input: CollectionFilterDraftInput,
) {
  const document = serializableDraft(input);
  return withUserContext(db, userId, async (trx) => {
    const result = await sql<{
      policy_id: string;
      policy_version: number;
      policy_revision: number;
    }>`SELECT * FROM collection_filter_save_draft(${JSON.stringify(document)}::jsonb)`.execute(trx);
    const row = result.rows[0];
    if (!row) throw new Error('collection_filter_draft_save_failed');
    return {
      policyId: row.policy_id,
      version: Number(row.policy_version),
      revision: Number(row.policy_revision),
    };
  });
}

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
      WHERE status IN ('DRAFT','APPROVED')
      ORDER BY CASE status WHEN 'DRAFT' THEN 0 ELSE 1 END, version DESC
    `.execute(trx);

    const policyIds = policies.rows.map((row) => row.id);
    if (policyIds.length === 0) {
      return {
        policies: [],
        documents: {},
        simulations: [],
        newTypesOpen: 0,
      };
    }

    const [rules, aliases, terms, simulations, newTypes] = await Promise.all([
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
      sql<any>`SELECT id,policy_id,policy_revision,status,scope,review_mode,metrics,error_code,created_at,completed_at
        FROM collection_filter_simulations
        WHERE policy_id = ANY(${policyIds}::uuid[])
        ORDER BY created_at DESC LIMIT 20`.execute(trx),
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
        rules: rules.rows.filter((row:any) => row.policy_id === policy.id),
        aliases: aliases.rows.filter((row:any) => row.policy_id === policy.id),
        terms: terms.rows.filter((row:any) => row.policy_id === policy.id),
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
      simulations: simulations.rows,
      newTypesOpen: Number(newTypes.rows[0]?.count ?? 0),
    };
  });
}

export async function listCollectionFilterNewTypes(
  db: Kysely<DB>,
  userId: string,
  status: 'OPEN' | 'RESOLVED' | 'IGNORED' = 'OPEN',
) {
  return withUserContext(db, userId, async (trx) => {
    const result = await sql<any>`
      SELECT id,source_code,section,normalized_type,sample_raw_type,
             occurrence_count,first_seen_at,last_seen_at,
             sample_publication_ids,status,resolved_at
      FROM collection_filter_new_types
      WHERE status=${status}
      ORDER BY occurrence_count DESC,last_seen_at DESC
      LIMIT 500
    `.execute(trx);
    return result.rows;
  });
}

export async function resolveCollectionFilterNewType(
  db: Kysely<DB>,
  userId: string,
  id: string,
  status: 'RESOLVED' | 'IGNORED',
) {
  return withUserContext(db, userId, async (trx) => {
    await sql`SELECT collection_filter_resolve_new_type(${id}::uuid,${status})`.execute(trx);
    return { id, status };
  });
}
