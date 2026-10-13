import type { Pool } from 'pg';

import {
  canonicalJson,
  sha256Hex,
} from '../baseline/baseline.canonical-json.js';

export type CandidateTerminalStatus =
  | 'MAPPED_TO_EXISTING'
  | 'APPROVED_ALIAS'
  | 'APPROVED_NEW_CONCEPT'
  | 'REJECTED';

export interface RecordUnmappedInput {
  runId: string;
  rawTerm: string;
  language?: string;
  probableDimensionId?: string | null;
  contextExcerpt?: string | null;
  spanStart?: number | null;
  spanEnd?: number | null;
  jurisdictionMetadata?: Record<string, unknown>;
  extractorKey: string;
  extractorVersion: string;
  confidence?: number | null;
  metadata?: Record<string, unknown>;
}

export interface RecordUnmappedResult {
  occurrenceId: string;
  candidateId: string;
  occurrenceDisposition:
    | 'CREATED'
    | 'EXISTING';
  candidateDisposition:
    | 'CREATED'
    | 'EXISTING';
}

export function normalizeCandidateTerm(
  value: string,
): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function contextSignature(
  context: string | null | undefined,
): string {
  return sha256Hex(
    normalizeCandidateTerm(
      context ?? '',
    ),
  );
}

function occurrenceFingerprint(
  input: {
    runId: string;
    normalizedTerm: string;
    spanStart: number | null;
    spanEnd: number | null;
    contextSignature: string;
    extractorKey: string;
    extractorVersion: string;
  },
): string {
  return sha256Hex(
    canonicalJson(input),
  );
}

function candidateFingerprint(
  input: {
    normalizedKey: string;
    probableDimensionId: string | null;
    contextSignature: string;
    parentCandidateId: string | null;
  },
): string {
  return sha256Hex(
    canonicalJson(input),
  );
}

export async function recordUnmappedOccurrence(
  pool: Pool,
  input: RecordUnmappedInput,
): Promise<RecordUnmappedResult> {
  const normalizedTerm =
    normalizeCandidateTerm(
      input.rawTerm,
    );

  if (!normalizedTerm) {
    throw new Error(
      'UNMAPPED_NORMALIZED_TERM_EMPTY',
    );
  }

  const spanStart =
    input.spanStart ?? null;
  const spanEnd =
    input.spanEnd ?? null;
  const signature =
    contextSignature(
      input.contextExcerpt,
    );

  const occurrenceHash =
    occurrenceFingerprint({
      runId: input.runId,
      normalizedTerm,
      spanStart,
      spanEnd,
      contextSignature: signature,
      extractorKey:
        input.extractorKey,
      extractorVersion:
        input.extractorVersion,
    });

  const candidateHash =
    candidateFingerprint({
      normalizedKey:
        normalizedTerm,
      probableDimensionId:
        input.probableDimensionId ??
        null,
      contextSignature: signature,
      parentCandidateId: null,
    });

  const client =
    await pool.connect();

  try {
    await client.query('BEGIN');

    const insertedOccurrence =
      await client.query<{
        id: string;
      }>(
        [
          'INSERT INTO taxonomy_unmapped_occurrences (',
          '  run_id, raw_term, normalized_term, language,',
          '  probable_dimension_id, context_excerpt, span_start, span_end,',
          '  jurisdiction_metadata, extractor_key, extractor_version,',
          '  confidence, occurrence_fingerprint, metadata',
          ') VALUES (',
          '  $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14::jsonb',
          ')',
          'ON CONFLICT (occurrence_fingerprint) DO NOTHING',
          'RETURNING id',
        ].join('\n'),
        [
          input.runId,
          input.rawTerm,
          normalizedTerm,
          input.language ?? 'pt-BR',
          input.probableDimensionId ??
            null,
          input.contextExcerpt ?? null,
          spanStart,
          spanEnd,
          JSON.stringify(
            input.jurisdictionMetadata ??
              {},
          ),
          input.extractorKey,
          input.extractorVersion,
          input.confidence ?? null,
          occurrenceHash,
          JSON.stringify(
            input.metadata ?? {},
          ),
        ],
      );

    const occurrenceDisposition =
      insertedOccurrence.rows[0]
        ? 'CREATED'
        : 'EXISTING';

    const occurrenceId =
      insertedOccurrence.rows[0]?.id ??
      (
        await client.query<{
          id: string;
        }>(
          [
            'SELECT id',
            'FROM taxonomy_unmapped_occurrences',
            'WHERE occurrence_fingerprint = $1',
          ].join('\n'),
          [occurrenceHash],
        )
      ).rows[0]?.id;

    if (!occurrenceId) {
      throw new Error(
        'UNMAPPED_OCCURRENCE_READBACK_FAILED',
      );
    }

    const insertedCandidate =
      await client.query<{
        id: string;
      }>(
        [
          'INSERT INTO taxonomy_candidates (',
          '  preferred_term, normalized_key, probable_dimension_id,',
          '  context_signature, jurisdiction_scope, candidate_fingerprint,',
          '  status',
          ') VALUES ($1,$2,$3,$4,$5::jsonb,$6,\'NEW\')',
          'ON CONFLICT (candidate_fingerprint) DO NOTHING',
          'RETURNING id',
        ].join('\n'),
        [
          input.rawTerm,
          normalizedTerm,
          input.probableDimensionId ??
            null,
          signature,
          JSON.stringify(
            input.jurisdictionMetadata ??
              {},
          ),
          candidateHash,
        ],
      );

    const candidateDisposition =
      insertedCandidate.rows[0]
        ? 'CREATED'
        : 'EXISTING';

    const candidateId =
      insertedCandidate.rows[0]?.id ??
      (
        await client.query<{
          id: string;
        }>(
          [
            'SELECT id',
            'FROM taxonomy_candidates',
            'WHERE candidate_fingerprint = $1',
          ].join('\n'),
          [candidateHash],
        )
      ).rows[0]?.id;

    if (!candidateId) {
      throw new Error(
        'TAXONOMY_CANDIDATE_READBACK_FAILED',
      );
    }

    const activeLink =
      await client.query<{
        candidate_id: string;
      }>(
        [
          'SELECT candidate_id',
          'FROM taxonomy_candidate_occurrence_links',
          'WHERE occurrence_id = $1',
          '  AND link_status = \'ACTIVE\'',
        ].join('\n'),
        [occurrenceId],
      );

    const linked =
      activeLink.rows[0];

    if (
      linked &&
      linked.candidate_id !==
        candidateId
    ) {
      throw new Error(
        'UNMAPPED_OCCURRENCE_ALREADY_GROUPED',
      );
    }

    if (!linked) {
      await client.query(
        [
          'INSERT INTO taxonomy_candidate_occurrence_links (',
          '  candidate_id, occurrence_id, justification',
          ') VALUES ($1,$2,$3)',
        ].join('\n'),
        [
          candidateId,
          occurrenceId,
          'deterministic-v1-grouping',
        ],
      );
    }

    await client.query('COMMIT');

    return {
      occurrenceId,
      candidateId,
      occurrenceDisposition,
      candidateDisposition,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function decideTaxonomyCandidate(
  pool: Pool,
  input: {
    candidateId: string;
    status: CandidateTerminalStatus;
    actorId: string;
    reason: string;
    resolvedReleaseConceptId?:
      string | null;
  },
): Promise<void> {
  if (
    (
      input.status ===
        'MAPPED_TO_EXISTING' ||
      input.status ===
        'APPROVED_ALIAS'
    ) &&
    !input.resolvedReleaseConceptId
  ) {
    throw new Error(
      'CANDIDATE_RESOLUTION_REQUIRES_RELEASE_CONCEPT',
    );
  }

  const client =
    await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      'SET LOCAL ROLE radar_taxonomy_curator',
    );

    const updated =
      await client.query<{
        id: string;
      }>(
        [
          'UPDATE taxonomy_candidates',
          'SET status = $2,',
          '    decision_actor_id = $3,',
          '    decision_at = now(),',
          '    decision_reason = $4,',
          '    resolved_release_concept_id = $5',
          'WHERE id = $1',
          'RETURNING id',
        ].join('\n'),
        [
          input.candidateId,
          input.status,
          input.actorId,
          input.reason,
          input.resolvedReleaseConceptId ??
            null,
        ],
      );

    if (!updated.rows[0]) {
      throw new Error(
        'TAXONOMY_CANDIDATE_NOT_FOUND',
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
