import 'dotenv/config';

import { Pool } from 'pg';

import { executeSpedSanitization, planSpedSanitization } from './sped-sanitization.js';

/**
 * Usage:
 *   npm run db:sanitize-sped                 -> dry-run only (default)
 *   SPED_SANITIZE_CONFIRM=<token> npm run db:sanitize-sped -- --execute
 *
 * The token is printed by the dry-run and binds the execution to exactly the
 * counts that were reviewed. Any change in between aborts the execution.
 */
const databaseUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_ADMIN_URL or DATABASE_URL is required.');
  process.exit(1);
}

const execute = process.argv.includes('--execute');
const pool = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  const client = await pool.connect();
  try {
    if (!execute) {
      const plan = await planSpedSanitization(client);
      console.log('SPED_SANITIZE_DRY_RUN=' + JSON.stringify(plan));
    } else {
      const confirmation = process.env.SPED_SANITIZE_CONFIRM;
      if (!confirmation) throw new Error('SPED_SANITIZE_CONFIRM is required with --execute.');
      const result = await executeSpedSanitization(client, confirmation);
      console.log('SPED_SANITIZE_EXECUTED=' + JSON.stringify(result));
    }
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
