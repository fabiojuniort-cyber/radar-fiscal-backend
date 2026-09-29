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
    [
      'TAXONOMY BASELINE DRY-RUN',
      'source integrity: PASS',
      'dimensions: ' +
        String(report.counts.dimensions) +
        '/20',
      'concepts: ' +
        String(report.counts.concepts) +
        '/628',
      'NEEDS_EVIDENCE: ' +
        String(report.counts.needsEvidence) +
        '/55',
      'lexical aliases: ' +
        String(report.counts.lexicalAliases) +
        '/21',
      'alias bindings: ' +
        String(report.counts.aliasBindings) +
        '/23',
      'multi-bind aliases: ' +
        String(report.counts.multiBindAliases) +
        '/1',
      'validation issues: ' +
        String(report.validationIssues.length),
      'new identities: ' +
        String(report.plan.summary.newIdentities),
      'reused identities: ' +
        String(report.plan.summary.reusedIdentities),
      'new revisions: ' +
        String(report.plan.summary.newRevisions),
      'reused revisions: ' +
        String(report.plan.summary.reusedRevisions),
      'load readiness: ' + report.readiness,
    ].join('\n'),
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
