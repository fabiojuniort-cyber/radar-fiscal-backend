import assert from 'node:assert/strict';
import { test } from 'node:test';

import { unavailablePublicLegalScope } from '../src/modules/taxonomy/legal-scope/legal-scope.public-projection.js';

test('TAX13 public API does not infer CURRENT from an act identity or its presence', () => {
  const row = unavailablePublicLegalScope(
    '00000000-0000-4000-8000-000000000001',
    '2026-10-08',
  );
  assert.deepEqual(row, {
    schemaVersion: 1,
    status: 'UNVERIFIED',
    reason: 'NO_AUTHORIZED_PUBLIC_ATTESTATION',
    referenceDate: '2026-10-08',
    publicationVersionId: '00000000-0000-4000-8000-000000000001',
    highlightsAuthorized: false,
    currentSegments: [],
  });
});

test('TAX13 public API remains fail-closed for absent current versions', () => {
  const row = unavailablePublicLegalScope(null, '2026-10-08');
  assert.equal(row.publicationVersionId, null);
  assert.equal(row.highlightsAuthorized, false);
  assert.equal(row.status, 'UNVERIFIED');
  assert.deepEqual(row.currentSegments, []);
});
