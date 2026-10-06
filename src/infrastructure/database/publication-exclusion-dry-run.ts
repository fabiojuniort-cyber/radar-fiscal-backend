import { Client } from 'pg';

import {
  parsePublicationExclusionDryRunArgs,
  runPublicationExclusionDryRun,
} from '../../modules/collection/publication-exclusion-history.js';

// Deliberately separate from every apply/suppress runner. No generic database
// URL fallback, credentials in output, or command-line execution mode.
try {
  parsePublicationExclusionDryRunArgs(process.argv.slice(2));
} catch {
  console.error('PUBLICATION_EXCLUSION_DRY_RUN_REFUSED: only read-only dry-run is available.');
  process.exit(2);
}
const connectionString = process.env.PUBLICATION_EXCLUSION_DRY_RUN_DATABASE_URL;
if (!connectionString) {
  console.error('PUBLICATION_EXCLUSION_DRY_RUN_FAILED: dedicated database configuration is required.');
  process.exit(1);
}
const client = new Client({
  connectionString, application_name: 'publication-exclusion-dry-run',
  statement_timeout: 120_000, options: '-c default_transaction_read_only=on',
});
try {
  await client.connect();
  const summary = await runPublicationExclusionDryRun(client);
  console.log('PUBLICATION_EXCLUSION_DRY_RUN=' + JSON.stringify(summary));
  console.log('PUBLICATION_EXCLUSION_DRY_RUN_PASS; READ_ONLY; NO_WRITE; EXECUTION_NOT_AVAILABLE');
} catch {
  // Never echo SQL, connection details, source material or driver messages.
  console.error('PUBLICATION_EXCLUSION_DRY_RUN_FAILED: snapshot was not proven; no operation was executed.');
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
