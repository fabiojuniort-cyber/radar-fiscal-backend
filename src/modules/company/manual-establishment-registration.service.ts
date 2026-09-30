import type { Transaction } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';
import type { CnpjRegistryCnae } from './cnpj-registry.service.js';
import { replaceManualEstablishmentCnaes } from './company-registration.service.js';

export class ManualEstablishmentConflictError extends Error {
  constructor(
    public readonly code: 'head_office_conflict',
  ) {
    super(code);
  }
}

export type ManualEstablishmentRegistrationInput = {
  companyId: string;
  cnpj: string;
  name: string;
  typeCode: string;
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
};

export type ManualEstablishmentRegistrationResult = {
  establishmentId: string;
  businessLocationCode: string | null;
  stateRegistration: string | null;
  stateRegistrationSource: string | null;
};

export async function createOrReactivateManualEstablishment(
  trx: Transaction<DB>,
  input: ManualEstablishmentRegistrationInput,
): Promise<ManualEstablishmentRegistrationResult> {
  const existing = await trx
    .selectFrom('establishments')
    .select([
      'id',
      'is_head_office',
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
    .where('company_id', '=', input.companyId)
    .where('cnpj', '=', input.cnpj)
    .executeTakeFirst();

  if (existing?.is_head_office) {
    throw new ManualEstablishmentConflictError(
      'head_office_conflict',
    );
  }

  const preserve = <T>(
    incoming: T | undefined,
    current: T,
  ): T =>
    incoming === undefined
      ? current
      : incoming;

  const stateRegistrationPatch = existing
    ? input.stateRegistration === undefined
      ? {
          state_registration:
            existing.state_registration,
          state_registration_status:
            existing.state_registration_status,
          state_registration_source:
            existing.state_registration_source,
          state_registration_checked_at:
            existing.state_registration_checked_at,
          state_registration_lookup_status:
            existing.state_registration_lookup_status,
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
        }
    : {
        state_registration:
          input.stateRegistration ?? null,
        state_registration_status: null,
        state_registration_source:
          input.stateRegistration
            ? 'MANUAL'
            : null,
        state_registration_checked_at: null,
        state_registration_lookup_status: null,
      };

  const establishment = existing
    ? await trx
        .updateTable('establishments')
        .set({
          name: input.name,
          establishment_type_code:
            input.typeCode,
          is_head_office: false,
          uf: input.uf,
          municipality_name: preserve(
            input.municipalityName,
            existing.municipality_name,
          ),
          municipality_ibge_code: preserve(
            input.municipalityIbgeCode,
            existing.municipality_ibge_code,
          ),
          postal_code: preserve(
            input.postalCode,
            existing.postal_code,
          ),
          street: preserve(
            input.street,
            existing.street,
          ),
          street_number: preserve(
            input.streetNumber,
            existing.street_number,
          ),
          complement: preserve(
            input.complement,
            existing.complement,
          ),
          district: preserve(
            input.district,
            existing.district,
          ),
          business_location_code:
            input.businessLocationCode == null
              ? existing.business_location_code
              : input.businessLocationCode,
          ...stateRegistrationPatch,
          is_active: true,
        })
        .where('id', '=', existing.id)
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
          company_id: input.companyId,
          cnpj: input.cnpj,
          name: input.name,
          establishment_type_code:
            input.typeCode,
          is_head_office: false,
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
      input.companyId,
      establishment.id,
      input.cnaes,
    );
  }

  return {
    establishmentId: establishment.id,
    businessLocationCode:
      establishment.business_location_code,
    stateRegistration:
      establishment.state_registration,
    stateRegistrationSource:
      establishment.state_registration_source,
  };
}
