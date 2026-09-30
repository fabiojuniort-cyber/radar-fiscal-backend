import {
  loadBaseline,
} from '../../modules/taxonomy/baseline/baseline.source-reader.js';
import {
  validateManifest,
} from '../../modules/taxonomy/baseline/baseline.validator.js';

const loaded = await loadBaseline();
const validation = validateManifest(loaded.manifest);

console.log(
  'TAXONOMY_BASELINE_VALIDATION=' +
    JSON.stringify({
      ok: validation.ok,
      issues: validation.issues,
      manifestSha256: loaded.manifestSha256,
      derivationFingerprint:
        loaded.manifest.derivation.fingerprint,
      expected: loaded.manifest.expected,
      relationTypes:
        loaded.manifest.relationTypes.length,
      relationRules:
        loaded.manifest.relationRules.length,
      relations: loaded.manifest.relations.length,
    }),
);

if (!validation.ok) {
  process.exitCode = 1;
}
