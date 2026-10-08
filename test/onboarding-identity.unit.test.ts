import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ensureHeadOfficeCnpj, ensureSameCompanyRoot,
} from '../src/modules/company/company-identity.guard.js';

test('ONB-01 matrix/branch identity rejects branch-only and cross-root CNPJs', () => {
  assert.doesNotThrow(() => ensureHeadOfficeCnpj('10515785000198'));
  assert.throws(() => ensureHeadOfficeCnpj('10515785000350'), { code: 'head_office_cnpj_required' });
  assert.throws(() => ensureHeadOfficeCnpj('10515785000198', false), { code: 'head_office_cnpj_required' });
  assert.doesNotThrow(() => ensureHeadOfficeCnpj('10515785000350', true));

  assert.doesNotThrow(() => ensureSameCompanyRoot('10515785000198', '10515785000350'));
  assert.throws(
    () => ensureSameCompanyRoot('10515785000198', '12345678000276'),
    { code: 'establishment_cnpj_root_mismatch' },
  );
  assert.throws(
    () => ensureSameCompanyRoot('10515785000198', '10515785000198'),
    { code: 'head_office_conflict' },
  );
});
