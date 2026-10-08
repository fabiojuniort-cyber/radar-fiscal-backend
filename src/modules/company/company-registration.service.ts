import type { Transaction } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';
import type {
  CnpjRegistryCnae,
  CnpjRegistryRecord,
} from './cnpj-registry.service.js';
import type {
  StateRegistrationLookup,
} from './state-registration.service.js';
import { validateAndEnsureOfficialCnaes } from './manual-cnae-validation.service.js';
import { CompanyIdentityError, ensureHeadOfficeCnpj, ensureSameCompanyRoot } from './company-identity.guard.js';

async function upsertCnaes(
  trx: Transaction<DB>,
  cnaes: CnpjRegistryCnae[],
): Promise<void> {
  for (const cnae of cnaes) {
    await trx
      .insertInto('cnaes')
      .values({
        code: cnae.code,
        description: cnae.description,
        is_active: true,
      })
      .onConflict((conflict) =>
        conflict
          .column('code')
          .doUpdateSet({
            description: cnae.description,
            is_active: true,
          }),
      )
      .execute();
  }
}

async function replaceEstablishmentCnaes(
  trx: Transaction<DB>,
  establishmentId: string,
  cnaes: CnpjRegistryCnae[],
): Promise<void> {
  await trx
    .deleteFrom('establishment_cnaes')
    .where(
      'establishment_id',
      '=',
      establishmentId,
    )
    .execute();

  if (cnaes.length === 0) return;

  await trx
    .insertInto('establishment_cnaes')
    .values(
      cnaes.map((cnae) => ({
        establishment_id:
          establishmentId,
        cnae_code: cnae.code,
        is_primary: cnae.isPrimary,
      })),
    )
    .execute();
}

export async function rebuildCompanyCnaes(
  trx: Transaction<DB>,
  companyId: string,
): Promise<void> {
  const rows = await trx
    .selectFrom(
      'establishment_cnaes as ec',
    )
    .innerJoin(
      'establishments as e',
      'e.id',
      'ec.establishment_id',
    )
    .select([
      'ec.cnae_code',
      'ec.is_primary',
      'e.is_head_office',
    ])
    .where('e.company_id', '=', companyId)
    .where('e.is_active', '=', true)
    .execute();

  const byCode = new Map<
    string,
    boolean
  >();

  for (const row of rows) {
    byCode.set(
      row.cnae_code,
      Boolean(
        byCode.get(row.cnae_code) ||
          (row.is_primary &&
            row.is_head_office),
      ),
    );
  }

  await trx
    .deleteFrom('company_cnaes')
    .where('company_id', '=', companyId)
    .execute();

  if (byCode.size === 0) return;

  await trx
    .insertInto('company_cnaes')
    .values(
      [...byCode.entries()].map(
        ([cnaeCode, isPrimary]) => ({
          company_id: companyId,
          cnae_code: cnaeCode,
          is_primary: isPrimary,
        }),
      ),
    )
    .execute();
}

export async function createCompanyFromRegistry(
  trx: Transaction<DB>,
  tenantId: string,
  record: CnpjRegistryRecord,
  stateRegistration?: StateRegistrationLookup,
  businessLocationCode?: string | null,
  reactivateInactive = false,
): Promise<{
  companyId: string;
  establishmentId: string;
}> {
  ensureHeadOfficeCnpj(record.cnpj, record.isHeadOffice);
  const existingCompany = await trx
    .selectFrom('companies')
    .select(['id', 'is_active'])
    .where('tenant_id', '=', tenantId)
    .where('head_office_cnpj', '=', record.cnpj)
    .forUpdate()
    .executeTakeFirst();

  if (existingCompany?.is_active) {
    throw new CompanyIdentityError('company_cnpj_exists');
  }
  if (existingCompany) {
    if (!reactivateInactive) throw new CompanyIdentityError('reactivation_required');
    await trx.updateTable('companies')
      .set({ is_active: true })
      .where('id', '=', existingCompany.id).execute();
    await trx.updateTable('establishments')
      .set({ is_active: true })
      .where('company_id', '=', existingCompany.id).execute();
    const headOffice = await trx.selectFrom('establishments')
      .select('id').where('company_id', '=', existingCompany.id)
      .where('is_head_office', '=', true).executeTakeFirst();
    if (!headOffice) throw new CompanyIdentityError('head_office_conflict');
    await rebuildCompanyCnaes(trx, existingCompany.id);
    return { companyId: existingCompany.id, establishmentId: headOffice.id };
  }
  await upsertCnaes(trx, record.cnaes);

  const company = await trx
        .insertInto('companies')
        .values({
          tenant_id: tenantId,
          legal_name: record.legalName,
          trade_name: record.tradeName,
          head_office_cnpj: record.cnpj,
          is_active: true,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

  const establishment = await trx
        .insertInto('establishments')
        .values({
          company_id: company.id,
          cnpj: record.cnpj,
          name:
            record.tradeName ??
            record.legalName,
          establishment_type_code:
            'HEAD_OFFICE',
          is_head_office: true,
          uf: record.uf,
          municipality_name:
            record.municipalityName,
          municipality_ibge_code:
            record.municipalityIbgeCode,
          postal_code: record.postalCode,
          street: record.street,
          street_number:
            record.streetNumber,
          complement: record.complement,
          district: record.district,
          business_location_code:
            businessLocationCode ?? null,
          state_registration:
            stateRegistration?.registration ?? null,
          state_registration_status:
            stateRegistration?.registrationStatus ?? null,
          state_registration_source:
            stateRegistration?.source ?? null,
          state_registration_checked_at:
            stateRegistration?.checkedAt ?? null,
          state_registration_lookup_status:
            stateRegistration?.lookupStatus ?? null,
          is_active: true,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

  await replaceEstablishmentCnaes(
    trx,
    establishment.id,
    record.cnaes,
  );

  await rebuildCompanyCnaes(
    trx,
    company.id,
  );

  return {
    companyId: company.id,
    establishmentId:
      establishment.id,
  };
}

export async function createEstablishmentFromRegistry(
  trx: Transaction<DB>,
  companyId: string,
  record: CnpjRegistryRecord,
  typeCode: string,
  stateRegistration?: StateRegistrationLookup,
  businessLocationCode?: string | null,
  reactivateInactive = false,
): Promise<string> {
  const company = await trx.selectFrom('companies')
    .select('head_office_cnpj').where('id', '=', companyId)
    .where('is_active', '=', true).forUpdate().executeTakeFirst();
  if (!company) throw new CompanyIdentityError('establishment_cnpj_root_mismatch');
  ensureSameCompanyRoot(company.head_office_cnpj, record.cnpj);

  const existingEstablishment = await trx
    .selectFrom('establishments')
    .select([
      'id',
      'is_head_office',
      'business_location_code',
      'is_active',
    ])
    .where('company_id', '=', companyId)
    .where('cnpj', '=', record.cnpj)
    .forUpdate()
    .executeTakeFirst();

  if (existingEstablishment?.is_active) {
    throw new CompanyIdentityError('establishment_conflict');
  }
  if (existingEstablishment) {
    if (!reactivateInactive) throw new CompanyIdentityError('reactivation_required');
    await trx.updateTable('establishments')
      .set({ is_active: true }).where('id', '=', existingEstablishment.id).execute();
    await rebuildCompanyCnaes(trx, companyId);
    return existingEstablishment.id;
  }
  await upsertCnaes(trx, record.cnaes);

  const establishment = await trx
        .insertInto('establishments')
        .values({
          company_id: companyId,
          cnpj: record.cnpj,
          name:
            record.tradeName ??
            record.legalName,
          establishment_type_code:
            typeCode,
          is_head_office: false,
          uf: record.uf,
          municipality_name:
            record.municipalityName,
          municipality_ibge_code:
            record.municipalityIbgeCode,
          postal_code: record.postalCode,
          street: record.street,
          street_number:
            record.streetNumber,
          complement: record.complement,
          district: record.district,
          business_location_code:
            businessLocationCode ?? null,
          state_registration:
            stateRegistration?.registration ?? null,
          state_registration_status:
            stateRegistration?.registrationStatus ?? null,
          state_registration_source:
            stateRegistration?.source ?? null,
          state_registration_checked_at:
            stateRegistration?.checkedAt ?? null,
          state_registration_lookup_status:
            stateRegistration?.lookupStatus ?? null,
          is_active: true,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

  await replaceEstablishmentCnaes(
    trx,
    establishment.id,
    record.cnaes,
  );

  await rebuildCompanyCnaes(
    trx,
    companyId,
  );

  return establishment.id;
}

export async function replaceManualEstablishmentCnaes(
  trx: Transaction<DB>,
  companyId: string,
  establishmentId: string,
  cnaes: CnpjRegistryCnae[],
): Promise<void> {
  const canonicalCnaes = await validateAndEnsureOfficialCnaes(trx, cnaes);
  await replaceEstablishmentCnaes(
    trx,
    establishmentId,
    canonicalCnaes,
  );
  await rebuildCompanyCnaes(
    trx,
    companyId,
  );
}
