import {sql} from 'kysely';
import {createManualEstablishment} from './manual-establishment-registration.service.js';
import type { Transaction } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';
import type { CnpjRegistryCnae } from './cnpj-registry.service.js';
import { replaceManualEstablishmentCnaes, rebuildCompanyCnaes } from './company-registration.service.js';
import { CompanyIdentityError, ensureHeadOfficeCnpj } from './company-identity.guard.js';
import { ManualCnaeValidationError } from './manual-cnae-validation.service.js';

export type ManualCompanyRegistrationInput = {
  typeCode?:string|undefined;
  resolveCompanyByRoot?:boolean|undefined;
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
  if(input.resolveCompanyByRoot){
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId+':'+input.cnpj.slice(0,8)},0))`.execute(trx);
    const type=await trx.selectFrom('establishment_types').select('code').where('code','=',input.typeCode??'HEAD_OFFICE').where('is_active','=',true).executeTakeFirst();
    if(!type)throw new CompanyIdentityError('establishment_type_not_found');
    const matches=await trx.selectFrom('companies').select(['id','is_active']).where('tenant_id','=',tenantId).where(sql<boolean>`left(head_office_cnpj,8)=${input.cnpj.slice(0,8)}`).forUpdate().execute();
    if(matches.length>1)throw new CompanyIdentityError('company_cnpj_exists');
    const company=matches[0];
    if(company&&!company.is_active)throw new CompanyIdentityError('company_inactive_requires_deletion');
    if(company){
      const registered=await createManualEstablishment(trx,{...input,companyId:company.id,name:input.establishmentName?.trim()||input.legalName,typeCode:input.typeCode??'HEAD_OFFICE'});
      return {...registered,companyId:company.id,establishmentName:input.establishmentName?.trim()||input.legalName};
    }
  }else ensureHeadOfficeCnpj(input.cnpj);
  const existingCompany = await trx
    .selectFrom('companies')
    .select(['id', 'is_active'])
    .where('tenant_id', '=', tenantId)
    .where('head_office_cnpj', '=', input.cnpj)
    .forUpdate()
    .executeTakeFirst();

  if (existingCompany?.is_active) throw new CompanyIdentityError('company_cnpj_exists');
  if (existingCompany) throw new CompanyIdentityError('company_inactive_requires_deletion');
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
          establishment_type_code:input.typeCode??'HEAD_OFFICE',
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
          establishment_type_code:input.typeCode??'HEAD_OFFICE',
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
