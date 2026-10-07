import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyTaxonomyCodeCompatibilityPatch,
  canonicalizeTaxonomyConceptCodes,
  parseTaxonomyCodeCompatibility,
  resolveTaxonomyConceptCode,
} from '../src/modules/taxonomy/taxonomy-code-compatibility.js';

test('taxonomy compatibility resolves redirects, chains and retired codes', () => {
  const compatibility = parseTaxonomyCodeCompatibility({
    taxonomyCompatibility: {
      version: 1,
      redirects: {
        'treatment.exemption': 'theme.exemption',
        'legacy.exemption': 'treatment.exemption',
        'treatment.st': 'theme.tax_substitution',
      },
      retiredCodes: ['platform.sped', 'tax_species.tax', 'treatment.old_benefit'],
    },
  });

  assert.equal(
    resolveTaxonomyConceptCode('treatment.exemption', compatibility),
    'theme.exemption',
  );
  assert.equal(
    resolveTaxonomyConceptCode('legacy.exemption', compatibility),
    'theme.exemption',
  );
  assert.equal(
    resolveTaxonomyConceptCode('treatment.st', compatibility),
    'theme.tax_substitution',
  );
  assert.equal(resolveTaxonomyConceptCode('platform.sped', compatibility), null);
  assert.equal(resolveTaxonomyConceptCode('treatment.old_benefit', compatibility), null);
  assert.equal(resolveTaxonomyConceptCode('theme.other', compatibility), 'theme.other');

  assert.deepEqual(
    canonicalizeTaxonomyConceptCodes(
      [
        'treatment.exemption',
        'theme.exemption',
        'platform.sped',
        'treatment.old_benefit',
        'treatment.st',
      ],
      compatibility,
    ),
    ['theme.exemption', 'theme.tax_substitution'],
  );
});

test('taxonomy compatibility rejects redirect cycles', () => {
  const compatibility = parseTaxonomyCodeCompatibility({
    taxonomyCompatibility: {
      redirects: {
        'legacy.a': 'legacy.b',
        'legacy.b': 'legacy.a',
      },
      retiredCodes: [],
    },
  });

  assert.throws(
    () => resolveTaxonomyConceptCode('legacy.a', compatibility),
    /TAXONOMY_CODE_REDIRECT_CYCLE/,
  );
});


test('retiring a canonical target retires inherited upstream aliases too', () => {
  const next = applyTaxonomyCodeCompatibilityPatch(
    {
      version: 1,
      redirects: {
        'legacy.a': 'legacy.b',
        'legacy.b': 'theme.x',
        'legacy.keep': 'theme.keep',
      },
      retiredCodes: [],
    },
    {
      retiredCodes: ['theme.x'],
    },
  );

  assert.deepEqual(next.redirects, {
    'legacy.keep': 'theme.keep',
  });
  assert.deepEqual(next.retiredCodes, [
    'legacy.a',
    'legacy.b',
    'theme.x',
  ]);
  assert.equal(resolveTaxonomyConceptCode('legacy.a', next), null);
  assert.equal(resolveTaxonomyConceptCode('legacy.b', next), null);
});


test('a redirect patch promotes a previously retired code when a successor exists', () => {
  const next = applyTaxonomyCodeCompatibilityPatch(
    {
      version: 1,
      redirects: {},
      retiredCodes: ['treatment.legacy_exemption'],
    },
    {
      redirects: {
        'treatment.legacy_exemption': 'theme.exemption',
      },
    },
  );

  assert.deepEqual(next.redirects, {
    'treatment.legacy_exemption': 'theme.exemption',
  });
  assert.equal(
    next.retiredCodes.includes('treatment.legacy_exemption'),
    false,
  );
  assert.equal(
    resolveTaxonomyConceptCode('treatment.legacy_exemption', next),
    'theme.exemption',
  );
});
