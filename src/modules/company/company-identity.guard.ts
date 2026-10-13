/** Fail closed on ambiguous company identity. A branch is never a new company. */
export class CompanyIdentityError extends Error {
  constructor(public readonly code:
    | 'head_office_cnpj_required'
    | 'establishment_cnpj_root_mismatch'
    | 'head_office_conflict'
    | 'company_cnpj_exists'
    | 'establishment_conflict'
    | 'reactivation_required') {
    super(code);
  }
}

export function ensureHeadOfficeCnpj(cnpj: string, knownHeadOffice?: boolean | null): void {
  // The provider's explicit filial flag outranks the 0001 prefix; where
  // metadata is absent (particularly manual input) accept only 0001.
  if (knownHeadOffice === false ||
      (knownHeadOffice !== true && cnpj.slice(8, 12) !== '0001')) {
    throw new CompanyIdentityError('head_office_cnpj_required');
  }
}

export function ensureSameCompanyRoot(
  headOfficeCnpj: string,
  establishmentCnpj: string,
): void {
  if (headOfficeCnpj.slice(0, 8) !== establishmentCnpj.slice(0, 8)) {
    throw new CompanyIdentityError('establishment_cnpj_root_mismatch');
  }
  if (headOfficeCnpj === establishmentCnpj) {
    throw new CompanyIdentityError('head_office_conflict');
  }
}
