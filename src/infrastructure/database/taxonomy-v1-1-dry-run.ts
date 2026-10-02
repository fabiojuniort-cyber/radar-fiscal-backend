import 'dotenv/config';

import { createBaselinePool } from './taxonomy-baseline-cli-common.js';
import { dryRunTaxonomyV11Successor } from '../../modules/taxonomy/release/taxonomy-successor-v1-1.database.js';

const pool = createBaselinePool();

try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const report = await dryRunTaxonomyV11Successor(client);
    await client.query('COMMIT');

    console.log(
      'TAXONOMY_V1_1_DRY_RUN=' + JSON.stringify(report),
    );

    if (report.blockers.length > 0) {
      process.exitCode = 2;
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
