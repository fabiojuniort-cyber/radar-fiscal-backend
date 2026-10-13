import { createHash } from 'node:crypto';

import type { ClientBase } from 'pg';

import {
  deriveDouCleanupCandidates,
  type DouCleanupCandidate,
  type DouCleanupDryRunSummary,
} from './dou-historical-cleanup.dry-run.js';
import { DOU_CLEANUP_PLAN_VERSION } from './dou-historical-cleanup.plan.js';
import { DOU_SCOPE_RULE_VERSION } from './dou-scope.rules.js';

/**
 * Issue #80 — gated historical SUPPRESS/RESTORE executor (no DELETE).
 *
 * Every mode first re-derives the candidate set read-only and refuses to act
 * unless its digest and size equal the approved dry run. Transitions go only
 * through `apply_publication_scope_transition` (append-only events, optimistic
 * locking, cache epoch), with deterministic operation ids so a re-run replays
 * instead of duplicating. RESTORE compensates only this policy's current
 * SUPPRESS events. Output is aggregate-only.
 */
export const DOU_CLEANUP_POLICY_KEY = 'DOU_CLEAN_01_HISTORICAL';
export const DOU_CLEANUP_RULE_VERSION = `${DOU_CLEANUP_PLAN_VERSION}+${DOU_SCOPE_RULE_VERSION}`;
const SUPPRESS_REASON: Record<string, string> = {
  excluded_dou_section: 'EXCLUDED_DOU_SECTION',
  strict_routine_contract_excerpt: 'ROUTINE_CONTRACT_EXCERPT',
};

export type DouCleanupMode = 'verify' | 'apply' | 'restore';

export interface DouCleanupExecutorOptions {
  mode: DouCleanupMode;
  approvedCandidateSetSha256: string;
  approvedCandidateCount: number;
  actorRef: string;
  chunkSize?: number;
}

export interface DouCleanupExecutorResult {
  mode: DouCleanupMode;
  manifestSha256: string;
  derived: Pick<DouCleanupDryRunSummary, 'counts' | 'candidatesBySection' | 'candidateSetSha256' | 'capturedAt'>;
  transitions: { applied: number; replayed: number };
  state: {
    outOfScopeByThisPolicy: number;
    inScopeCandidates: number;
    candidateFeedRows: number;
    outOfScopeGlobal: number;
    epoch: string;
  };
}

export class DouCleanupRefusedError extends Error {}

/** UUID derived from (purpose, manifest, publication): replays reuse it. */
export function deterministicOperationId(purpose: 'suppress' | 'restore', manifestSha256: string, publicationId: string): string {
  const hex = createHash('sha256').update(`dou-clean-01:${purpose}:${manifestSha256}:${publicationId}`).digest('hex');
  // RFC 4122 layout with version 5 / variant bits, so the value is a valid UUID.
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

function suppressReason(candidate: DouCleanupCandidate): string {
  const code = Object.keys(SUPPRESS_REASON).find(key => candidate.reasonCodes.includes(key));
  if (!code) throw new DouCleanupRefusedError('CANDIDATE_WITHOUT_SUPPORTED_REASON');
  return SUPPRESS_REASON[code]!;
}

async function readState(client: ClientBase, manifestSha256: string, candidateIds: string[]): Promise<DouCleanupExecutorResult['state']> {
  const result = await client.query<{
    policy_out: string; in_scope: string; feed: string; global_out: string; epoch: string;
  }>(
    `SELECT
       (SELECT count(*) FROM public.publication_scope_state s
          JOIN public.publication_scope_events e ON e.id = s.current_event_id
         WHERE s.scope = 'OUT_OF_SCOPE' AND e.action = 'SUPPRESS'
           AND e.policy_key = $1 AND e.manifest_sha256::text = $2)::text AS policy_out,
       (SELECT count(*) FROM unnest($3::uuid[]) c(id)
         WHERE public.publication_scope_is_in_scope(c.id))::text AS in_scope,
       (SELECT count(*) FROM public.publication_source_feed f WHERE f.publication_id = ANY($3::uuid[]))::text AS feed,
       (SELECT count(*) FROM public.publication_scope_state WHERE scope = 'OUT_OF_SCOPE')::text AS global_out,
       public.publication_scope_epoch()::text AS epoch`,
    [DOU_CLEANUP_POLICY_KEY, manifestSha256, candidateIds],
  );
  const row = result.rows[0]!;
  return {
    outOfScopeByThisPolicy: Number(row.policy_out), inScopeCandidates: Number(row.in_scope),
    candidateFeedRows: Number(row.feed), outOfScopeGlobal: Number(row.global_out), epoch: row.epoch,
  };
}

export async function runDouHistoricalCleanupExecutor(
  client: ClientBase,
  options: DouCleanupExecutorOptions,
): Promise<DouCleanupExecutorResult> {
  const chunkSize = options.chunkSize ?? 200;
  if (!/^[a-f0-9]{64}$/.test(options.approvedCandidateSetSha256)) throw new DouCleanupRefusedError('APPROVED_HASH_REQUIRED');
  if (!Number.isSafeInteger(options.approvedCandidateCount) || options.approvedCandidateCount < 1) {
    throw new DouCleanupRefusedError('APPROVED_COUNT_REQUIRED');
  }
  if (!/^[A-Z0-9_]{3,64}$/.test(options.actorRef)) throw new DouCleanupRefusedError('ACTOR_REF_REQUIRED');
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 1_000) throw new DouCleanupRefusedError('INVALID_CHUNK_SIZE');

  const manifestSha256 = options.approvedCandidateSetSha256;
  const { summary, candidates } = await deriveDouCleanupCandidates(client);
  const derived = {
    counts: summary.counts, candidatesBySection: summary.candidatesBySection,
    candidateSetSha256: summary.candidateSetSha256, capturedAt: summary.capturedAt,
  };
  const transitions = { applied: 0, replayed: 0 };
  const candidateIds = candidates.map(candidate => candidate.publicationId);

  if (options.mode !== 'restore') {
    // RESTORE must stay possible even after the set drifted; it only touches
    // this manifest's own current SUPPRESS events.
    if (summary.candidateSetSha256 !== manifestSha256 || candidates.length !== options.approvedCandidateCount) {
      throw new DouCleanupRefusedError('CANDIDATE_SET_DIFFERS_FROM_APPROVED_DRY_RUN');
    }
    if (candidates.some(candidate => candidate.persistedDecisions.some(decision => decision !== 'IGNORE'))) {
      throw new DouCleanupRefusedError('PERSISTED_KEEP_OR_REVIEW_DECISION_PRESENT');
    }
  }

  if (options.mode === 'apply') {
    for (let start = 0; start < candidates.length; start += chunkSize) {
      const chunk = candidates.slice(start, start + chunkSize);
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL lock_timeout = '5s'`);
        await client.query(`SET LOCAL statement_timeout = '60s'`);
        for (const candidate of chunk) {
          const current = await client.query<{ current_event_id: string | null; scope: string }>(
            `SELECT current_event_id, scope FROM public.publication_scope_state WHERE publication_id = $1`,
            [candidate.publicationId],
          );
          const operationId = deterministicOperationId('suppress', manifestSha256, candidate.publicationId);
          const state = current.rows[0];
          // A row already OUT_OF_SCOPE is only acceptable as this exact replay
          // (the function verifies operation id and metadata and returns applied=false).
          const expected = state && state.scope === 'IN_SCOPE' ? state.current_event_id : null;
          const result = await client.query<{ applied: boolean; resulting_scope: string }>(
            `SELECT applied, resulting_scope FROM public.apply_publication_scope_transition(
               $1::uuid, 'SUPPRESS', $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9)`,
            [candidate.publicationId, operationId, expected, DOU_CLEANUP_POLICY_KEY, suppressReason(candidate),
              DOU_CLEANUP_RULE_VERSION, candidate.evidenceSha256, manifestSha256, options.actorRef],
          );
          const row = result.rows[0];
          if (!row || row.resulting_scope !== 'OUT_OF_SCOPE') throw new DouCleanupRefusedError('SUPPRESS_NOT_CONFIRMED');
          if (row.applied) transitions.applied += 1; else transitions.replayed += 1;
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    }
  }

  if (options.mode === 'restore') {
    const events = await client.query<{ publication_id: string; id: string; evidence_sha256: string; reason_code: string }>(
      `SELECT e.publication_id, e.id, e.evidence_sha256::text, e.reason_code
         FROM public.publication_scope_events e
         JOIN public.publication_scope_state s ON s.publication_id = e.publication_id AND s.current_event_id = e.id
        WHERE e.action = 'SUPPRESS' AND e.policy_key = $1 AND e.manifest_sha256::text = $2 AND s.scope = 'OUT_OF_SCOPE'
        ORDER BY e.publication_id`,
      [DOU_CLEANUP_POLICY_KEY, manifestSha256],
    );
    for (let start = 0; start < events.rows.length; start += chunkSize) {
      const chunk = events.rows.slice(start, start + chunkSize);
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL lock_timeout = '5s'`);
        await client.query(`SET LOCAL statement_timeout = '60s'`);
        for (const event of chunk) {
          const result = await client.query<{ applied: boolean; resulting_scope: string }>(
            `SELECT applied, resulting_scope FROM public.apply_publication_scope_transition(
               $1::uuid, 'RESTORE', $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9)`,
            [event.publication_id, deterministicOperationId('restore', manifestSha256, event.publication_id), event.id,
              DOU_CLEANUP_POLICY_KEY, `RESTORE_${event.reason_code}`.slice(0, 64), DOU_CLEANUP_RULE_VERSION,
              event.evidence_sha256, manifestSha256, options.actorRef],
          );
          const row = result.rows[0];
          if (!row || row.resulting_scope !== 'IN_SCOPE') throw new DouCleanupRefusedError('RESTORE_NOT_CONFIRMED');
          if (row.applied) transitions.applied += 1; else transitions.replayed += 1;
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    }
  }

  const state = await readState(client, manifestSha256, candidateIds);
  return { mode: options.mode, manifestSha256, derived, transitions, state };
}
