import {
  importBaseline,
} from '../../modules/taxonomy/baseline/baseline.importer.js';
import {
  loadBaseline,
} from '../../modules/taxonomy/baseline/baseline.source-reader.js';
import {
  createBaselinePool,
  requiredArg,
} from './taxonomy-baseline-cli-common.js';

const target = requiredArg('--target=');
const expectedHash = requiredArg(
  '--manifest-sha256=',
);

if (target !== 'v1.0.0') {
  throw new Error(
    'Unsupported taxonomy baseline target: ' + target,
  );
}

const loaded = await loadBaseline();

if (
  loaded.manifest.targetTaxonomyVersion !== target
) {
  throw new Error(
    'Manifest target does not match CLI target.',
  );
}

const pool = createBaselinePool({
  requireAdmin: true,
});

try {
  const result = await importBaseline(
    pool,
    loaded,
    {
      expectedManifestSha256: expectedHash,
    },
  );

  console.log(
    'TAXONOMY_BASELINE_IMPORT=' +
      JSON.stringify({
        ...result,
        manifestSha256: loaded.manifestSha256,
        derivationFingerprint:
          loaded.manifest.derivation.fingerprint,
      }),
  );
} finally {
  await pool.end();
}
