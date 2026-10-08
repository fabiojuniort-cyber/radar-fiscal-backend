import type { Transaction } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';
import type { CnpjRegistryCnae } from './cnpj-registry.service.js';
import { replaceManualEstablishmentCnaes, rebuildCompanyCnaes } from './company-registration.service.js';
import { CompanyIdentityError, ensureHeadOfficeCnpj } from './company-identity.guard.js';
import { ManualCnaeValidationError } from './manual-cnae-validation.service.js';

export type ManualCompanyRegistrationInput = {
  cnpj: string;
  legalName: string;
  establishmentName?: string | null | undefined;
  uf: string;
  municipalityName?: string | null | undefined;
  municipalityIbgeCode?: string | null | undefined;
  postalCode?: string | null | undefined;
  street?: string | null | undefined;
  streetNumber?: string | null | undefined;
  complement?: string | null | undefined;
  district?: string | null | undefined;
  stateRegistration?: string | null | undefined;
  businessLocationCode?: string | null | undefined;
  cnaes?: CnpjRegistryCnae[] | undefined;
  reactivateInactive?: boolean | undefined;
};

export type ManualCompanyRegistrationResult = {
  companyId: string;
  establishmentId: string;
  establishmentName: string;
  businessLocationCode: string | null;
  stateRegistration: string | null;
  stateRegistrationSource: string | null;
};

export async function createManualCompanyRegistration(
  trx: Transaction<DB>,
  tenantId: string,
  input: ManualCompanyRegistrationInput,
): Promise<ManualCompanyRegistrationResult> {
  ensureHeadOfficeCnpj(input.cnpj);
  const existingCompany = await trx
    .selectFrom('companies')
    .select(['id', 'is_active'])
    .where('tenant_id', '=', tenantId)
    .where('head_office_cnpj', '=', input.cnpj)
    .forUpdate()
    .executeTakeFirst();

  if (existingCompany?.is_active) throw new CompanyIdentityError('company_cnpj_exists');
  if (existingCompany && !input.reactivateInactive) {
    throw new CompanyIdentityError('reactivation_required');
  }
  if (existingCompany) {
    const original = await trx.selectFrom('establishments')
      .select(['id', 'name', 'business_location_code', 'state_registration',
        'state_registration_source'])
      .where('company_id', '=', existingCompany.id)
      .where('is_head_office', '=', true).executeTakeFirst();
    if (!original) throw new CompanyIdentityError('head_office_conflict');
    await trx.updateTable('companies').set({ is_active: true })
      .where('id', '=', existingCompany.id).execute();
    await trx.updateTable('establishments').set({ is_active: true })
      .where('id', '=', original.id).execute();
    await rebuildCompanyCnaes(trx, existingCompany.id);
    return {
      companyId: existingCompany.id, establishmentId: original.id,
      establishmentName: original.name,
      businessLocationCode: original.business_location_code,
      stateRegistration: original.state_registration,
      stateRegistrationSource: original.state_registration_source,
    };
  }
  if (!input.cnaes?.length) throw new ManualCnaeValidationError('invalid_cnae');

  const company = await trx
        .insertInto('companies')
        .values({
          tenant_id: tenantId,
          legal_name: input.legalName,
          trade_name: null,
          head_office_cnpj: input.cnpj,
          is_active: true,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

  const existingEstablishment = await trx
    .selectFrom('establishments')
    .select([
      'id',
      'municipality_name',
      'municipality_ibge_code',
      'postal_code',
      'street',
      'street_number',
      'complement',
      'district',
      'business_location_code',
      'state_registration',
      'state_registration_status',
      'state_registration_source',
      'state_registration_checked_at',
      'state_registration_lookup_status',
    ])
    .where('company_id', '=', company.id)
    .where('cnpj', '=', input.cnpj)
    .executeTakeFirst();

  const establishmentName =
    input.establishmentName?.trim() ||
    input.legalName;

  const preserve = <T>(
    incoming: T | undefined,
    current: T,
  ): T =>
    incoming === undefined
      ? current
      : incoming;

  const stateRegistrationPatch =
    input.stateRegistration === undefined
      ? existingEstablishment
        ? {
            state_registration:
              existingEstablishment.state_registration,
            state_registration_status:
              existingEstablishment.state_registration_status,
            state_registration_source:
              existingEstablishment.state_registration_source,
            state_registration_checked_at:
              existingEstablishment.state_registration_checked_at,
            state_registration_lookup_status:
              existingEstablishment.state_registration_lookup_status,
          }
        : {
            state_registration: null,
            state_registration_status: null,
            state_registration_source: null,
            state_registration_checked_at: null,
            state_registration_lookup_status: null,
          }
      : {
          state_registration:
            input.stateRegistration,
          state_registration_status: null,
          state_registration_source:
            input.stateRegistration
              ? 'MANUAL'
              : null,
          state_registration_checked_at: null,
          state_registration_lookup_status: null,
        };

  const establishment = existingEstablishment
    ? await trx
        .updateTable('establishments')
        .set({
          name: establishmentName,
          establishment_type_code:
            'HEAD_OFFICE',
          is_head_office: true,
          uf: input.uf,
          municipality_name: preserve(
            input.municipalityName,
            existingEstablishment.municipality_name,
          ),
          municipality_ibge_code: preserve(
            input.municipalityIbgeCode,
            existingEstablishment.municipality_ibge_code,
          ),
          postal_code: preserve(
            input.postalCode,
            existingEstablishment.postal_code,
          ),
          street: preserve(
            input.street,
            existingEstablishment.street,
          ),
          street_number: preserve(
            input.streetNumber,
            existingEstablishment.street_number,
          ),
          complement: preserve(
            input.complement,
            existingEstablishment.complement,
          ),
          district: preserve(
            input.district,
            existingEstablishment.district,
          ),
          business_location_code:
            input.businessLocationCode == null
              ? existingEstablishment.business_location_code
              : input.businessLocationCode,
          ...stateRegistrationPatch,
          is_active: true,
        })
        .where('id', '=', existingEstablishment.id)
        .returning([
          'id',
          'business_location_code',
          'state_registration',
          'state_registration_source',
        ])
        .executeTakeFirstOrThrow()
    : await trx
        .insertInto('establishments')
        .values({
          company_id: company.id,
          cnpj: input.cnpj,
          name: establishmentName,
          establishment_type_code:
            'HEAD_OFFICE',
          is_head_office: true,
          uf: input.uf,
          municipality_name:
            input.municipalityName ?? null,
          municipality_ibge_code:
            input.municipalityIbgeCode ?? null,
          postal_code:
            input.postalCode ?? null,
          street: input.street ?? null,
          street_number:
            input.streetNumber ?? null,
          complement:
            input.complement ?? null,
          district: input.district ?? null,
          business_location_code:
            input.businessLocationCode ?? null,
          ...stateRegistrationPatch,
          is_active: true,
        })
        .returning([
          'id',
          'business_location_code',
          'state_registration',
          'state_registration_source',
        ])
        .executeTakeFirstOrThrow();

  if (input.cnaes !== undefined) {
    await replaceManualEstablishmentCnaes(
      trx,
      company.id,
      establishment.id,
      input.cnaes,
    );
  }

  return {
    companyId: company.id,
    establishmentId:
      establishment.id,
    establishmentName,
    businessLocationCode:
      establishment.business_location_code,
    stateRegistration:
      establishment.state_registration,
    stateRegistrationSource:
      establishment.state_registration_source,
  };
}
