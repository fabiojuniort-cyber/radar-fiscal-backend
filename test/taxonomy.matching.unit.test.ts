import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateTaxonomyCriteria,
  parseTaxonomyMonitoringCriteria,
} from '../src/modules/taxonomy/matching/taxonomy-criteria.js';

test('TAX-09 criteria v2 parses, deduplicates and sorts codes', () => {
  const criteria =
    parseTaxonomyMonitoringCriteria(
      {
        keywords: ['legacy'],
        taxonomy: {
          releasePolicy:
            'CURRENT_PUBLISHED',
          anyOf: [
            'tax.icms',
            'tax.icms',
            'tax.cbs',
          ],
          allOf: [],
          noneOf: [
            'theme.exemption',
          ],
          includeDescendants: true,
        },
      },
      2,
    );

  assert.ok(criteria);
  assert.deepEqual(
    criteria.anyOf,
    ['tax.cbs', 'tax.icms'],
  );
  assert.deepEqual(
    criteria.noneOf,
    ['theme.exemption'],
  );
  assert.equal(
    criteria.includeDescendants,
    true,
  );
});

test('TAX-09 refuses taxonomy payload outside criteria schema v2', () => {
  assert.throws(
    () =>
      parseTaxonomyMonitoringCriteria(
        {
          taxonomy: {
            releasePolicy:
              'CURRENT_PUBLISHED',
            anyOf: ['tax.icms'],
          },
        },
        1,
      ),
    /REQUIRES_SCHEMA_VERSION_2/,
  );
});

test('TAX-09 requires at least one taxonomy criterion', () => {
  assert.throws(
    () =>
      parseTaxonomyMonitoringCriteria(
        {
          taxonomy: {
            releasePolicy:
              'CURRENT_PUBLISHED',
            anyOf: [],
            allOf: [],
            noneOf: [],
          },
        },
        2,
      ),
    /INVALID_TAXONOMY_CRITERIA/,
  );
});

test('TAX-09 evaluates any/all/none with explicit descendant expansions', () => {
  const criteria =
    parseTaxonomyMonitoringCriteria(
      {
        taxonomy: {
          releasePolicy:
            'CURRENT_PUBLISHED',
          anyOf: ['theme.tax_benefit'],
          allOf: ['tax.icms'],
          noneOf: ['theme.exemption'],
          includeDescendants: true,
        },
      },
      2,
    );

  assert.ok(criteria);

  const expansions = new Map<
    string,
    ReadonlySet<string>
  >([
    [
      'theme.tax_benefit',
      new Set([
        'theme.tax_benefit',
        'theme.presumed_credit',
      ]),
    ],
    [
      'tax.icms',
      new Set(['tax.icms']),
    ],
    [
      'theme.exemption',
      new Set([
        'theme.exemption',
      ]),
    ],
  ]);

  const matched =
    evaluateTaxonomyCriteria(
      criteria,
      new Set([
        'theme.presumed_credit',
        'tax.icms',
      ]),
      expansions,
    );

  assert.equal(matched.matched, true);
  assert.deepEqual(
    matched.matchedCriteriaCodes,
    [
      'tax.icms',
      'theme.tax_benefit',
    ],
  );
  assert.deepEqual(
    matched.matchedAssertionCodes,
    [
      'tax.icms',
      'theme.presumed_credit',
    ],
  );

  const blocked =
    evaluateTaxonomyCriteria(
      criteria,
      new Set([
        'theme.presumed_credit',
        'tax.icms',
        'theme.exemption',
      ]),
      expansions,
    );

  assert.equal(blocked.matched, false);
  assert.deepEqual(
    blocked.blockedNoneOfCodes,
    ['theme.exemption'],
  );
});
