import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DIMENSIONS,
} from '../src/modules/taxonomy/baseline/baseline.constants.js';
import {
  REQUIRED_PRESERVED_DIMENSION_CODES,
  RETIRED_DIMENSION_CODES,
  planTaxonomyV11FromCanonicalV1,
  planTaxonomyV11Successor,
} from '../src/modules/taxonomy/release/taxonomy-successor-v1-1.js';

test('v1.1 retires only the five non-canonical dimensions', () => {
  const plan = planTaxonomyV11FromCanonicalV1();

  assert.equal(plan.targetVersion, 'v1.1.0');
  assert.equal(plan.sourceDimensions, 20);
  assert.equal(plan.sourceConcepts, 628);
  assert.equal(plan.retiredDimensions, 5);
  assert.equal(plan.retiredConcepts, 38);
  assert.equal(plan.retainedDimensions, 15);
  assert.equal(plan.retainedConcepts, 590);

  assert.deepEqual(
    plan.retiredDimensionCodes,
    [...RETIRED_DIMENSION_CODES],
  );

  for (const code of REQUIRED_PRESERVED_DIMENSION_CODES) {
    assert.ok(
      plan.retainedDimensionCodes.includes(code),
      code + ' must remain in v1.1',
    );
  }
});

test('v1.1 retained dimensions are exactly canonical V1 minus retired dimensions', () => {
  const plan = planTaxonomyV11FromCanonicalV1();
  const retired = new Set<string>(RETIRED_DIMENSION_CODES);
  const expected = DIMENSIONS
    .map(([code]) => code)
    .filter((code) => !retired.has(code));

  assert.deepEqual(plan.retainedDimensionCodes, expected);
});

test('planner blocks a source missing a dimension scheduled for retirement', () => {
  const source = DIMENSIONS
    .filter(([code]) => code !== 'event')
    .map(([code, , conceptCount]) => ({ code, conceptCount }));

  assert.throws(
    () => planTaxonomyV11Successor(source),
    /TAXONOMY_V1_1_SOURCE_MISSING_RETIRED_DIMENSION:event/,
  );
});

test('planner blocks a source missing legislation dimensions that must remain', () => {
  const source = DIMENSIONS
    .filter(([code]) => code !== 'theme')
    .map(([code, , conceptCount]) => ({ code, conceptCount }));

  assert.throws(
    () => planTaxonomyV11Successor(source),
    /TAXONOMY_V1_1_SOURCE_MISSING_REQUIRED_DIMENSION:theme/,
  );
});
