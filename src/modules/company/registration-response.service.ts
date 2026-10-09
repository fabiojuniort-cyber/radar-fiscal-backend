import type { Transaction } from 'kysely';
import type { DB } from '../../infrastructure/database/database.types.js';

// Read inside the mutation transaction: reactivation deliberately preserves
// existing fields, and CNAE descriptions belong to the persisted catalog.
export async function readRegistrationEstablishment(trx: Transaction<DB>, establishmentId: string) {
  const row = await trx.selectFrom('establishments').select([
    'id', 'company_id', 'cnpj', 'name', 'establishment_type_code', 'is_head_office',
    'uf', 'municipality_name', 'municipality_ibge_code', 'postal_code', 'street',
    'street_number', 'complement', 'district', 'business_location_code',
    'state_registration', 'state_registration_status', 'state_registration_lookup_status',
    'state_registration_source', 'state_registration_checked_at',
  ])
    .where('id', '=', establishmentId).executeTakeFirstOrThrow();
  const cnaes = await trx.selectFrom('establishment_cnaes as ec')
    .innerJoin('cnaes as c', 'c.code', 'ec.cnae_code')
    .select(['c.code', 'c.description', 'ec.is_primary'])
    .where('ec.establishment_id', '=', row.id)
    .orderBy('ec.is_primary', 'desc').orderBy('c.code').execute();
  return {
    id: row.id, companyId: row.company_id, cnpj: row.cnpj, name: row.name,
    typeCode: row.establishment_type_code, isHeadOffice: row.is_head_office,
    uf: row.uf, municipalityName: row.municipality_name,
    municipalityIbgeCode: row.municipality_ibge_code, postalCode: row.postal_code,
    street: row.street, streetNumber: row.street_number, complement: row.complement,
    district: row.district, businessLocationCode: row.business_location_code,
    stateRegistration: row.state_registration,
    stateRegistrationStatus: row.state_registration_status,
    stateRegistrationLookupStatus: row.state_registration_lookup_status,
    stateRegistrationSource: row.state_registration_source,
    stateRegistrationCheckedAt: row.state_registration_checked_at
      ? new Date(row.state_registration_checked_at).toISOString() : null,
    cnaes: cnaes.map((item) => ({ code: item.code, description: item.description, isPrimary: item.is_primary })),
  };
}

export async function readCompanyRegistration(trx: Transaction<DB>, companyId: string, establishmentId: string) {
  const company = await trx.selectFrom('companies').select(['id', 'legal_name', 'trade_name', 'head_office_cnpj'])
    .where('id', '=', companyId).executeTakeFirstOrThrow();
  const establishment = await readRegistrationEstablishment(trx, establishmentId);
  return {
    company: { id: company.id, legalName: company.legal_name, tradeName: company.trade_name,
      cnpj: company.head_office_cnpj, businessLocationCode: establishment.businessLocationCode },
    establishment,
  };
}
