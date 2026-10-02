import 'dotenv/config';

import { createBaselinePool } from './taxonomy-baseline-cli-common.js';
import { createTaxonomyV11Draft } from '../../modules/taxonomy/release/taxonomy-successor-v1-1.database.js';

const pool = createBaselinePool({ requireAdmin: true });

try {
  const result = await createTaxonomyV11Draft(pool);
  console.log(
    'TAXONOMY_V1_1_CREATE_DRAFT=' + JSON.stringify(result),
  );
} finally {
  await pool.end();
}
