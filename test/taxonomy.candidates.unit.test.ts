import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeCandidateTerm,
} from '../src/modules/taxonomy/candidates/candidate.service.js';

test('TAX-08 normalizes candidate terms deterministically', () => {
  assert.equal(
    normalizeCandidateTerm(
      '  Crédito   Presumido — ICMS  ',
    ),
    'credito presumido icms',
  );

  assert.equal(
    normalizeCandidateTerm('MIT'),
    'mit',
  );

  assert.equal(
    normalizeCandidateTerm('***'),
    '',
  );
});
