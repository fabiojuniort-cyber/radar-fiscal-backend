import assert from 'node:assert/strict';
import test from 'node:test';

import {
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
