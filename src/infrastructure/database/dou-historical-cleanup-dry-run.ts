import { Client } from 'pg';

import { runDouHistoricalCleanupDryRun } from '../../modules/collection/dou-historical-cleanup.dry-run.js';

/**
 * Issue #80 — READ ONLY in-database dry run.
 *
 *   npm run db:dou-cleanup-dry-run
 *
 * Uses DOU_CLEANUP_DRY_RUN_DATABASE_URL (a private Railway reference to an
 * unfiltered role; never printed). The session is forced read-only before any
 * query. Prints only aggregate counts and digests: no identifiers, titles,
 * texts or connection details. There is deliberately no write/apply branch.
 */
const connectionString = process.env.DOU_CLEANUP_DRY_RUN_DATABASE_URL;
if (process.argv.slice(2).some(arg => /^--(?:execute|confirm|apply|delete|suppress)(?:=|$)/.test(arg))) {
  console.error('DOU_CLEANUP_DRY_RUN_REFUSED: execution is not available in this command.');
  process.exit(2);
}
if (!connectionString) {
  console.error('DOU_CLEANUP_DRY_RUN_FAILED: DOU_CLEANUP_DRY_RUN_DATABASE_URL is required.');
  process.exit(1);
}

const client = new Client({
  connectionString,
  application_name: 'dou-cleanup-dry-run',
  statement_timeout: 120_000,
  options: '-c default_transaction_read_only=on',
});
try {
  await client.connect();
  const summary = await runDouHistoricalCleanupDryRun(client);
  console.log('DOU_CLEANUP_DRY_RUN=' + JSON.stringify(summary));
  console.log('DOU_CLEANUP_DRY_RUN_PASS; READ_ONLY; NO_WRITE; EXECUTION_NOT_AVAILABLE');
} catch (error) {
  // Planner validation messages are fixed source strings; anything else may
  // carry driver detail, so only its class is printed.
  const message = error instanceof Error && /^Invalid cleanup snapshot: [a-zA-Z0-9_. -]+$/.test(error.message)
    ? error.message : 'UNCLASSIFIED_ERROR';
  console.error(`DOU_CLEANUP_DRY_RUN_FAILED: ${message}; no operation was executed.`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
