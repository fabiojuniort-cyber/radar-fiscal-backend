import type { Transaction } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';
import type { CnpjRegistryCnae } from './cnpj-registry.service.js';
import { replaceManualEstablishmentCnaes } from './company-registration.service.js';

export type ManualCompanyRegistrationInput = {
  cnpj: string;
  legalName: string;
  establishmentName?: string | null;
  uf: string;
  municipalityName?: string | null;
  municipalityIbgeCode?: string | null;
  postalCode?: string | null;
  street?: string | null;
  streetNumber?: string | null;
  complement?: string | null;
  district?: string | null;
  stateRegistration?: string | null;
  businessLocationCode?: string | null;
  cnaes?: CnpjRegistryCnae[];
};

export type ManualCompanyRegistrationResult = {
  companyId: string;
  establishmentId: string;
  establishmentName: string;
};

export async function createManualCompanyRegistration(
  trx: Transaction<DB>,
  tenantId: string,
  input: ManualCompanyRegistrationInput,
): Promise<ManualCompanyRegistrationResult> {
  const existingCompany = await trx
    .selectFrom('companies')
    .select(['id', 'trade_name'])
    .where('tenant_id', '=', tenantId)
    .where('head_office_cnpj', '=', input.cnpj)
    .executeTakeFirst();

  const company = existingCompany
    ? await trx
        .updateTable('companies')
        .set({
          legal_name: input.legalName,
          is_active: true,
        })
        .where('id', '=', existingCompany.id)
        .returning('id')
        .executeTakeFirstOrThrow()
    : await trx
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
            input.businessLocationCode === undefined
              ? existingEstablishment.business_location_code
              : input.businessLocationCode,
          ...stateRegistrationPatch,
          is_active: true,
        })
        .where('id', '=', existingEstablishment.id)
        .returning('id')
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
        .returning('id')
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
  };
}
