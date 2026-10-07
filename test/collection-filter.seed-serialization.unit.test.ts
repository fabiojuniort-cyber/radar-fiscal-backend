import assert from 'node:assert/strict';
import test from 'node:test';

import { serializeCollectionFilterDraft } from '../src/modules/collection/collection-filter.admin.js';

test('ACT-SCOPE-02 seed serializer matches collection_filter_save_draft SQL shape', () => {
  const document = serializeCollectionFilterDraft({
    contextWindowWords: 12,
    weakScoreThreshold: 3,
    locationWeights: {
      title: 3,
      summary: 2,
      body: 1,
    },
    changeNotes: 'seed test',
    rules: [
      {
        sourceCode: 'DOU',
        section: 'do1',
        canonicalType: 'Portaria',
        mode: 'KEEP_IF_TAX_TERM',
      },
    ],
    aliases: [
      {
        sourceCode: 'CONFAZ',
        alias: 'Convênio ICMS',
        canonicalType: 'Convenio ICMS',
      },
    ],
    terms: [
      {
        text: 'ICMS',
        strength: 'STRONG',
        locationScope: 'ANY',
      },
    ],
  });

  assert.deepEqual(document.rules[0], {
    source_code: 'dou',
    section: 'DO1',
    canonical_type: 'PORTARIA',
    mode: 'KEEP_IF_TAX_TERM',
    help_text: null,
  });

  assert.deepEqual(document.aliases[0], {
    source_code: 'confaz',
    section: '',
    normalized_alias: 'CONVENIO ICMS',
    canonical_type: 'CONVENIO ICMS',
  });

  assert.deepEqual(document.terms[0], {
    term_text: 'ICMS',
    normalized_term: 'ICMS',
    strength: 'STRONG',
    source_code: '',
    section: '',
    canonical_type: '',
    location_scope: 'ANY',
  });

  assert.equal('sourceCode' in document.rules[0], false);
  assert.equal('canonicalType' in document.rules[0], false);
});
