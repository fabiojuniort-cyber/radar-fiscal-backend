import {
  dryRunBaseline,
} from '../../modules/taxonomy/baseline/baseline.database-inspector.js';
import {
  loadBaseline,
} from '../../modules/taxonomy/baseline/baseline.source-reader.js';
import {
  createBaselinePool,
} from './taxonomy-baseline-cli-common.js';

const loaded = await loadBaseline();
const pool = createBaselinePool();

try {
  const report = await dryRunBaseline(
    pool,
    loaded,
  );

  console.log(
    'TAXONOMY_BASELINE_DRY_RUN=' +
      JSON.stringify({
        ...report,
        manifestSha256: loaded.manifestSha256,
        derivationFingerprint:
          loaded.manifest.derivation.fingerprint,
        relationTypes:
          loaded.manifest.relationTypes.length,
        relationRules:
          loaded.manifest.relationRules.length,
        relations: loaded.manifest.relations.length,
      }),
  );

  if (report.readiness !== 'READY') {
    process.exitCode = 2;
  }
} finally {
  await pool.end();
}
