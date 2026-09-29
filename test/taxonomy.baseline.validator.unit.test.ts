import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  BaselineManifest,
} from '../src/modules/taxonomy/baseline/baseline.types.js';
import {
  loadBaseline,
} from '../src/modules/taxonomy/baseline/baseline.source-reader.js';
import {
  validateManifest,
} from '../src/modules/taxonomy/baseline/baseline.validator.js';

function clone(
  manifest: BaselineManifest,
): BaselineManifest {
  return structuredClone(manifest);
}

test('approved R6 manifest validates with zero issues', async () => {
  const loaded = await loadBaseline();
  const result = validateManifest(loaded.manifest);

  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test('forbidden MIT canonicalization blocks manifest', async () => {
  const loaded = await loadBaseline();
  const manifest = clone(loaded.manifest);
  const concept = manifest.concepts[0];
  assert.ok(concept);

  concept.code = 'platform.mit';
  concept.dimensionCode = 'platform';

  const result = validateManifest(manifest);

  assert.equal(result.ok, false);
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.code ===
        'FORBIDDEN_MIT_CANONICALIZATION',
    ),
  );
});

test('duplicate code and unresolved alias target block manifest', async () => {
  const loaded = await loadBaseline();
  const manifest = clone(loaded.manifest);
  const first = manifest.concepts[0];
  const second = manifest.concepts[1];
  const alias = manifest.aliases[0];

  assert.ok(first);
  assert.ok(second);
  assert.ok(alias?.bindings[0]);

  second.code = first.code;
  alias.bindings[0].targetConceptCode =
    'theme.nonexistent';

  const result = validateManifest(manifest);
  const codes = new Set(
    result.issues.map((issue) => issue.code),
  );

  assert.equal(result.ok, false);
  assert.ok(codes.has('DUPLICATE_CONCEPT_CODE'));
  assert.ok(codes.has('UNRESOLVED_ALIAS_TARGET'));
});

test('unapproved official mappings and relation cycle block manifest', async () => {
  const loaded = await loadBaseline();
  const manifest = clone(loaded.manifest);

  // Type cast only creates a negative fixture; validator must reject it.
  manifest.officialMappings.push(
    {} as never,
  );

  manifest.relations.push(
    {
      sourceConceptCode: 'theme.penalty',
      relationType: 'narrower_than',
      targetConceptCode: 'theme.fine',
      qualifiers: {},
      evidenceStatus: 'NOT_ASSESSED',
      sourceLocator: 'negative test',
    },
  );

  const result = validateManifest(manifest);
  const codes = new Set(
    result.issues.map((issue) => issue.code),
  );

  assert.ok(
    codes.has('UNAPPROVED_OFFICIAL_MAPPING'),
  );
  assert.ok(codes.has('RELATION_CYCLE'));
});

test('relation rules are derived only from actual baseline edges', async () => {
  const loaded = await loadBaseline();

  const rule = loaded.manifest.relationRules.find(
    (item) =>
      item.relationType === 'narrower_than' &&
      item.sourceDimension === 'product' &&
      item.targetDimension === 'product',
  );

  assert.deepEqual(rule, {
    relationType: 'narrower_than',
    sourceDimension: 'product',
    targetDimension: 'product',
    allowed: true,
    requiresEvidence: false,
    acyclicOverride: null,
    derivation: {
      kind: 'R6_RELATION_EDGE',
      sourceLocator: 'R6 §15',
    },
  });

  const keys = new Set(
    loaded.manifest.relations.map((relation) => {
      const source = loaded.manifest.concepts.find(
        (concept) =>
          concept.code === relation.sourceConceptCode,
      );
      const target = loaded.manifest.concepts.find(
        (concept) =>
          concept.code === relation.targetConceptCode,
      );
      return [
        relation.relationType,
        source?.dimensionCode,
        target?.dimensionCode,
      ].join('|');
    }),
  );

  assert.equal(
    loaded.manifest.relationRules.every((item) =>
      keys.has(
        [
          item.relationType,
          item.sourceDimension,
          item.targetDimension,
        ].join('|'),
      ),
    ),
    true,
  );
});

test('part_of and replaced_by cycles are blocked before persistence', async () => {
  const loaded = await loadBaseline();

  for (const [relationType, left, right] of [
    ['part_of', 'product.soy', 'product.grains'],
    ['replaced_by', 'tax.icms', 'tax.ibs'],
  ] as const) {
    const manifest = clone(loaded.manifest);
    manifest.relations.push(
      {
        sourceConceptCode: left,
        relationType,
        targetConceptCode: right,
        qualifiers: {},
        evidenceStatus: 'NOT_ASSESSED',
        sourceLocator: 'negative cycle test',
      },
      {
        sourceConceptCode: right,
        relationType,
        targetConceptCode: left,
        qualifiers: {},
        evidenceStatus: 'NOT_ASSESSED',
        sourceLocator: 'negative cycle test',
      },
    );

    const result = validateManifest(manifest);
    assert.ok(
      result.issues.some(
        (issue) =>
          issue.code === 'RELATION_CYCLE' &&
          issue.message === relationType,
      ),
      relationType,
    );
  }
});
