import { Client } from 'pg';

import {
  DouCleanupRefusedError,
  runDouHistoricalCleanupExecutor,
  type DouCleanupMode,
} from '../../modules/collection/dou-historical-cleanup.executor.js';

/**
 * Issue #80 — gated SUPPRESS/RESTORE executor for the approved DOU dry run.
 *
 *   DOU_CLEANUP_MODE=verify|apply|restore npm run db:dou-cleanup-execute
 *
 * Required: DOU_CLEANUP_DATABASE_URL (private Railway reference, never
 * printed), DOU_CLEANUP_APPROVED_CANDIDATE_SET_SHA256,
 * DOU_CLEANUP_APPROVED_CANDIDATE_COUNT. `apply` additionally needs
 * DOU_CLEANUP_CONFIRM=SUPPRESS_APPROVED_DOU_CANDIDATES and an R3_APPROVAL_SHA256;
 * `restore` needs DOU_CLEANUP_CONFIRM=RESTORE_APPROVED_DOU_CANDIDATES.
 * There is no DELETE path. Output is aggregate-only.
 */
const env = process.env;
const mode = env.DOU_CLEANUP_MODE as DouCleanupMode | undefined;

function refuse(label: string): never {
  console.error(`DOU_CLEANUP_EXECUTE_REFUSED: ${label}; no operation was executed.`);
  process.exit(2);
}

if (mode !== 'verify' && mode !== 'apply' && mode !== 'restore') refuse('DOU_CLEANUP_MODE_REQUIRED');
if (!env.DOU_CLEANUP_DATABASE_URL) refuse('DATABASE_REFERENCE_REQUIRED');
if (mode === 'apply' && (env.DOU_CLEANUP_CONFIRM !== 'SUPPRESS_APPROVED_DOU_CANDIDATES' ||
  !/^[a-f0-9]{64}$/.test(env.R3_APPROVAL_SHA256 ?? ''))) refuse('APPLY_CONFIRMATION_AND_R3_APPROVAL_REQUIRED');
if (mode === 'restore' && env.DOU_CLEANUP_CONFIRM !== 'RESTORE_APPROVED_DOU_CANDIDATES') refuse('RESTORE_CONFIRMATION_REQUIRED');

const client = new Client({
  connectionString: env.DOU_CLEANUP_DATABASE_URL,
  application_name: `dou-cleanup-${mode}`,
  statement_timeout: 120_000,
  // verify never writes; apply/restore write only inside their own transactions.
  ...(mode === 'verify' ? { options: '-c default_transaction_read_only=on' } : {}),
});
try {
  await client.connect();
  const result = await runDouHistoricalCleanupExecutor(client, {
    mode,
    approvedCandidateSetSha256: env.DOU_CLEANUP_APPROVED_CANDIDATE_SET_SHA256 ?? '',
    approvedCandidateCount: Number(env.DOU_CLEANUP_APPROVED_CANDIDATE_COUNT),
    actorRef: env.DOU_CLEANUP_ACTOR_REF ?? 'DOU_CLEAN_01_BATCH_EXECUTOR',
    ...(env.DOU_CLEANUP_CHUNK_SIZE ? { chunkSize: Number(env.DOU_CLEANUP_CHUNK_SIZE) } : {}),
  });
  console.log('DOU_CLEANUP_EXECUTE=' + JSON.stringify(result));
  console.log(`DOU_CLEANUP_${mode.toUpperCase()}_PASS`);
} catch (error) {
  // Refusals carry fixed labels; database messages may embed values, so only
  // the PostgreSQL exception token (e.g. PUBLICATION_SCOPE_*) is surfaced.
  const label = error instanceof DouCleanupRefusedError ? error.message
    : error instanceof Error && /^(PUBLICATION_SCOPE_[A-Z_]+)$/.test(error.message) ? error.message
    : 'UNCLASSIFIED_ERROR';
  console.error(`DOU_CLEANUP_EXECUTE_FAILED: ${label}; completed chunks stay committed and replay idempotently.`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
