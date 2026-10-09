import { sql, type Transaction } from 'kysely';
import type { DB } from '../../infrastructure/database/database.types.js';
import type { CnpjRegistryCnae } from './cnpj-registry.service.js';

export class ManualCnaeValidationError extends Error {
  constructor(public readonly code: 'invalid_cnae' | 'cnae_catalog_unavailable') {
    super(code);
  }
}

/**
 * Enforce canonical CNAE at the API persistence boundary, never trusting a
 * browser's description. Executed in the SAME tenant transaction as the
 * establishment write so an invalid/withdrawn code cannot leave partial data.
 */
export async function validateAndEnsureOfficialCnaes(
  trx: Transaction<DB>,
  submitted: readonly CnpjRegistryCnae[] | undefined,
  allowEmpty = false,
): Promise<CnpjRegistryCnae[]> {
  if (allowEmpty && submitted?.length === 0) return [];
  if (!submitted?.length || submitted.length > 100 ||
      submitted.filter((entry) => entry.isPrimary).length !== 1 ||
      new Set(submitted.map((entry) => entry.code)).size !== submitted.length ||
      submitted.some((entry) => !/^\d{7}$/.test(entry.code))) {
    throw new ManualCnaeValidationError('invalid_cnae');
  }

  const editions = await sql<{ id: string }>`
    SELECT ed.id
    FROM official_catalog_editions ed
    JOIN official_catalogs catalog ON catalog.id = ed.catalog_id
    WHERE catalog.code = 'CNAE' AND ed.status = 'CURRENT'
    ORDER BY ed.created_at DESC
    LIMIT 1
  `.execute(trx);
  const edition = editions.rows[0];
  if (!edition) throw new ManualCnaeValidationError('cnae_catalog_unavailable');

  const canonical = await sql<{ code: string; description: string }>`
    SELECT regexp_replace(entry.official_code, '[^0-9]', '', 'g') AS code,
           entry.description
    FROM official_catalog_entries entry
    WHERE entry.catalog_edition_id = ${edition.id}::uuid
      AND entry.metadata->>'level' = 'SUBCLASSE'
      AND entry.metadata->>'assignable' = 'true'
      AND regexp_replace(entry.official_code, '[^0-9]', '', 'g')
          = ANY(${submitted.map((entry) => entry.code)}::text[])
  `.execute(trx);
  const official = new Map(canonical.rows.map((row) => [row.code, row.description]));
  if (submitted.some((entry) => !official.has(entry.code))) {
    throw new ManualCnaeValidationError('invalid_cnae');
  }

  const validated = submitted.map((entry) => ({
    code: entry.code,
    description: official.get(entry.code)!,
    isPrimary: entry.isPrimary,
  }));
  // Shared reference catalog may only receive official descriptions, never
  // arbitrary tenant text; existing references remain untouched.
  await trx.insertInto('cnaes')
    .values(validated.map((entry) => ({
      code: entry.code,
      description: entry.description,
      is_active: true,
    })))
    .onConflict((conflict) => conflict.column('code').doNothing())
    .execute();
  return validated;
}
