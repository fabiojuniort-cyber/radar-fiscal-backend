import { readFile } from 'node:fs/promises';

import { parseDouCleanupCliArgs, planDouHistoricalCleanup } from '../../modules/collection/dou-historical-cleanup.plan.js';

// Deliberately no dotenv, database client, network call, or writable execution
// branch. Environment credentials never authorize destructive operations.
try {
  const { inputPath } = parseDouCleanupCliArgs(process.argv.slice(2));
  const snapshot: unknown = JSON.parse(await readFile(inputPath, 'utf8'));
  process.stdout.write(JSON.stringify(planDouHistoricalCleanup(snapshot), null, 2) + '\n');
} catch (error) {
  // Invalid input may contain source text/secrets. Never echo input/parser errors.
  console.error('DOU_CLEANUP_DRY_RUN_FAILED: invalid arguments or snapshot; no operation was executed.');
  process.exitCode = 1;
}
