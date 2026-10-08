import assert from 'node:assert/strict';
import test from 'node:test';

import { ncmTemporalFingerprint } from '../src/modules/taxonomy/ncm/ncm-temporal.evidence.js';
import type { LegalScopeReadResult } from '../src/modules/taxonomy/legal-scope/legal-scope.repository.js';

const base: LegalScopeReadResult = {
  valid: true, reason: null, coverage: 'COMPLETE',
  currentText: 'NCM 10063011', currentFragments: ['NCM 10063011'],
  currentSegments: 1,
  attestationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  asOf: '2026-10-08',
  htmlSha256: 'a'.repeat(64),
  recheckOn: '2026-10-10',
};
const edition = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', checksum: 'c'.repeat(64) };
const fingerprint = (e: LegalScopeReadResult = base, c = edition) =>
  ncmTemporalFingerprint('cccccccc-cccc-4ccc-8ccc-cccccccccccc', e, c);

test('TAX13 NCM fingerprint is stable per exact immutable evidence', () => {
  assert.equal(fingerprint(), fingerprint({ ...base }));
  assert.match(fingerprint(), /^[a-f0-9]{64}$/);
});

test('TAX13 NCM supersession, as-of, recheck, HTML, fragment and catalogue edits each re-key', () => {
  const original = fingerprint();
  const variants: LegalScopeReadResult[] = [
    { ...base, attestationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
    { ...base, asOf: '2026-10-09' },
    { ...base, recheckOn: '2026-10-12' },
    { ...base, htmlSha256: 'f'.repeat(64) },
    { ...base, currentFragments: ['NCM 10062099'], currentText: 'NCM 10062099' },
    { ...base, currentFragments: ['NCM', ' 10063011'] },
  ];
  for (const changed of variants) assert.notEqual(fingerprint(changed), original);
  assert.notEqual(fingerprint(base, { ...edition, checksum: 'e'.repeat(64) }), original);
  assert.notEqual(fingerprint(base, { ...edition, id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }), original);
});

test('TAX13 never fingerprints PARTIAL/UNVERIFIED/expired proof as COMPLETE', () => {
  for (const changed of [
    { ...base, coverage: 'PARTIAL' as const },
    { ...base, valid: false },
    { ...base, attestationId: null },
    { ...base, recheckOn: '2026-10-08' },
    { ...base, currentSegments: 0 },
  ]) assert.throws(() => fingerprint(changed), /TAX13_NCM_COMPLETE_CURRENT_PROOF_REQUIRED/);
});
