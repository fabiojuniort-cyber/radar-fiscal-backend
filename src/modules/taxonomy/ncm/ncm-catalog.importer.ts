import type { PoolClient } from 'pg';

import type { ParsedNcmCatalog } from './ncm-catalog.source.js';

export const NCM_CATALOG_CODE = 'NCM';
export const NCM_CATALOG_NAME = 'Nomenclatura Comum do Mercosul';
export const NCM_CATALOG_MAINTAINER = 'Portal Único Siscomex / Governo Federal';

export interface ImportNcmCatalogInput {
  sourceUrl: string;
  sourceSha256: string;
  parsed: ParsedNcmCatalog;
}

export interface ImportNcmCatalogResult {
  catalogId: string;
  editionId: string;
  editionCode: string;
  created: boolean;
  entriesInserted: number;
  assignableCount: number;
}

interface CatalogRow {
  id: string;
}

interface EditionRow {
  id: string;
  edition_code: string;
  source_sha256: string | null;
  valid_from: string | null;
  status: 'CURRENT' | 'SUPERSEDED' | 'WITHDRAWN';
}

function previousValidTo(
  previousValidFrom: string | null,
  nextValidFrom: string,
): string {
  if (!previousValidFrom) return nextValidFrom;

  const previous = new Date(`${previousValidFrom}T00:00:00.000Z`);
  const next = new Date(`${nextValidFrom}T00:00:00.000Z`);

  if (next.getTime() < previous.getTime()) {
    throw new Error(
      `NCM_CATALOG_SOURCE_OLDER_THAN_CURRENT:${nextValidFrom}:${previousValidFrom}`,
    );
  }

  if (next.getTime() === previous.getTime()) return nextValidFrom;

  next.setUTCDate(next.getUTCDate() - 1);
  return next.toISOString().slice(0, 10);
}

async function ensureCatalog(client: PoolClient): Promise<string> {
  const inserted = await client.query<CatalogRow>(
    `INSERT INTO official_catalogs (
       code,
       name,
       maintainer,
       description
     ) VALUES ($1, $2, $3, $4)
     ON CONFLICT (code) DO NOTHING
     RETURNING id`,
    [
      NCM_CATALOG_CODE,
      NCM_CATALOG_NAME,
      NCM_CATALOG_MAINTAINER,
      'Catálogo oficial e versionado da Nomenclatura Comum do Mercosul, obtido do Portal Único Siscomex.',
    ],
  );

  if (inserted.rows[0]?.id) return inserted.rows[0].id;

  const existing = await client.query<CatalogRow>(
    'SELECT id FROM official_catalogs WHERE code = $1',
    [NCM_CATALOG_CODE],
  );
  const row = existing.rows[0];
  if (!row) throw new Error('NCM_CATALOG_IDENTITY_NOT_FOUND');
  return row.id;
}

async function readCurrentEdition(
  client: PoolClient,
  catalogId: string,
): Promise<EditionRow | undefined> {
  const result = await client.query<EditionRow>(
    `SELECT id, edition_code, source_sha256, valid_from, status
     FROM official_catalog_editions
     WHERE catalog_id = $1::uuid
       AND status = 'CURRENT'
     ORDER BY created_at DESC
     LIMIT 1
     FOR UPDATE`,
    [catalogId],
  );
  return result.rows[0];
}

async function findEditionByHash(
  client: PoolClient,
  catalogId: string,
  sourceSha256: string,
): Promise<EditionRow | undefined> {
  const result = await client.query<EditionRow>(
    `SELECT id, edition_code, source_sha256, valid_from, status
     FROM official_catalog_editions
     WHERE catalog_id = $1::uuid
       AND source_sha256 = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [catalogId, sourceSha256],
  );
  return result.rows[0];
}

async function insertEntries(
  client: PoolClient,
  editionId: string,
  parsed: ParsedNcmCatalog,
): Promise<number> {
  const chunkSize = 500;
  let inserted = 0;

  for (let start = 0; start < parsed.entries.length; start += chunkSize) {
    const chunk = parsed.entries.slice(start, start + chunkSize).map((entry) => ({
      officialCode: entry.officialCode,
      description: entry.description,
      metadata: {
        ...entry.metadata,
        normalizedDigits: entry.digits,
        assignable: entry.assignable,
        normalizedValidFrom: entry.validFrom,
        normalizedValidTo: entry.validTo,
      },
    }));

    const result = await client.query(
      `INSERT INTO official_catalog_entries (
         catalog_edition_id,
         official_code,
         description,
         metadata
       )
       SELECT
         $1::uuid,
         payload.official_code,
         payload.description,
         payload.metadata
       FROM jsonb_to_recordset($2::jsonb) AS payload(
         official_code text,
         description text,
         metadata jsonb
       )`,
      [
        editionId,
        JSON.stringify(chunk.map((entry) => ({
          official_code: entry.officialCode,
          description: entry.description,
          metadata: entry.metadata,
        }))),
      ],
    );

    inserted += result.rowCount ?? 0;
  }

  return inserted;
}

export async function importNcmCatalog(
  client: PoolClient,
  input: ImportNcmCatalogInput,
): Promise<ImportNcmCatalogResult> {
  if (!/^[a-f0-9]{64}$/.test(input.sourceSha256)) {
    throw new Error('NCM_CATALOG_INVALID_SOURCE_SHA256');
  }

  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE radar_taxonomy_curator');

    const catalogId = await ensureCatalog(client);
    const existingByHash = await findEditionByHash(
      client,
      catalogId,
      input.sourceSha256,
    );

    if (existingByHash) {
      if (existingByHash.status !== 'CURRENT') {
        throw new Error(
          `NCM_CATALOG_HISTORICAL_REPLAY:${existingByHash.edition_code}`,
        );
      }

      await client.query('COMMIT');
      return {
        catalogId,
        editionId: existingByHash.id,
        editionCode: existingByHash.edition_code,
        created: false,
        entriesInserted: 0,
        assignableCount: input.parsed.assignableCount,
      };
    }

    const current = await readCurrentEdition(client, catalogId);
    const validFrom = input.parsed.sourceUpdatedOnIso;
    const editionCode = `${validFrom}-${input.sourceSha256.slice(0, 12)}`;

    if (current) {
      const validTo = previousValidTo(current.valid_from, validFrom);
      await client.query(
        `UPDATE official_catalog_editions
         SET status = 'SUPERSEDED',
             valid_to = $2::date
         WHERE id = $1::uuid`,
        [current.id, validTo],
      );
    }

    const edition = await client.query<{ id: string }>(
      `INSERT INTO official_catalog_editions (
         catalog_id,
         edition_code,
         published_on,
         valid_from,
         source_url,
         source_sha256,
         status
       ) VALUES (
         $1::uuid,
         $2,
         NULL,
         $3::date,
         $4,
         $5,
         'CURRENT'
       )
       RETURNING id`,
      [
        catalogId,
        editionCode,
        validFrom,
        input.sourceUrl,
        input.sourceSha256,
      ],
    );
    const editionId = edition.rows[0]?.id;
    if (!editionId) throw new Error('NCM_CATALOG_EDITION_INSERT_FAILED');

    const entriesInserted = await insertEntries(
      client,
      editionId,
      input.parsed,
    );

    if (entriesInserted !== input.parsed.entries.length) {
      throw new Error(
        `NCM_CATALOG_ENTRY_COUNT_MISMATCH:${entriesInserted}:${input.parsed.entries.length}`,
      );
    }

    await client.query('COMMIT');
    return {
      catalogId,
      editionId,
      editionCode,
      created: true,
      entriesInserted,
      assignableCount: input.parsed.assignableCount,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
