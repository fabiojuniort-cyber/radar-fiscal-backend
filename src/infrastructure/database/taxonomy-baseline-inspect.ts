import {
  readBaselineState,
} from '../../modules/taxonomy/baseline/baseline.readback.js';
import {
  loadBaseline,
} from '../../modules/taxonomy/baseline/baseline.source-reader.js';
import {
  createBaselinePool,
} from './taxonomy-baseline-cli-common.js';

const loaded = await loadBaseline();
const pool = createBaselinePool();

try {
  const client = await pool.connect();

  try {
    await client.query(
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
    const readback = await readBaselineState(client);
    await client.query('ROLLBACK');

    console.log(
      'TAXONOMY_BASELINE_INSPECTION=' +
        JSON.stringify({
          readback,
          expected: loaded.manifest.expected,
          manifestSha256: loaded.manifestSha256,
          derivationFingerprint:
            loaded.manifest.derivation.fingerprint,
          expectedRelationTypes:
            loaded.manifest.relationTypes.length,
          expectedRelationRules:
            loaded.manifest.relationRules.length,
          expectedRelations:
            loaded.manifest.relations.length,
        }),
    );
  } catch (error) {
    await client
      .query('ROLLBACK')
      .catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
