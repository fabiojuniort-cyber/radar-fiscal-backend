import type { PoolClient } from 'pg';

/**
 * Generic, versioned import into official_catalogs / editions / entries.
 * Runs inside the caller's transaction, which must already be
 * SET LOCAL ROLE radar_taxonomy_curator. Mirrors the NCM-01 semantics:
 * a new source hash creates a new CURRENT edition and supersedes the
 * previous one; replaying the current hash is a no-op; entries are
 * append-only.
 */

export interface CatalogIdentity {
  code: string;
  name: string;
  maintainer: string;
  description: string;
}

export interface CatalogEntryInput {
  officialCode: string;
  description: string;
  parentCode: string | null;
  metadata: Record<string, unknown>;
}

export interface ImportOfficialCatalogInput {
  catalog: CatalogIdentity;
  sourceUrl: string | null;
  sourceSha256: string;
  validFrom: string;
  entries: readonly CatalogEntryInput[];
}

export interface ImportOfficialCatalogResult {
  catalogId: string;
  editionId: string;
  editionCode: string;
  created: boolean;
  entriesInserted: number;
}

async function ensureCatalog(
  client: PoolClient,
  catalog: CatalogIdentity,
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO official_catalogs (code, name, maintainer, description)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (code) DO NOTHING
     RETURNING id`,
    [catalog.code, catalog.name, catalog.maintainer, catalog.description],
  );
  if (inserted.rows[0]?.id) return inserted.rows[0].id;
  const existing = await client.query<{ id: string }>(
    'SELECT id FROM official_catalogs WHERE code = $1',
    [catalog.code],
  );
  if (!existing.rows[0]) throw new Error('CATALOG_IDENTITY_NOT_FOUND');
  return existing.rows[0].id;
}

function dayBefore(iso: string): string {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export async function importOfficialCatalog(
  client: PoolClient,
  input: ImportOfficialCatalogInput,
): Promise<ImportOfficialCatalogResult> {
  if (!/^[a-f0-9]{64}$/.test(input.sourceSha256)) {
    throw new Error('CATALOG_INVALID_SOURCE_SHA256');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.validFrom)) {
    throw new Error('CATALOG_INVALID_VALID_FROM');
  }
  if (input.entries.length === 0) throw new Error('CATALOG_EMPTY_SOURCE');

  const codes = new Set<string>();
  for (const entry of input.entries) {
    if (codes.has(entry.officialCode)) {
      throw new Error(`CATALOG_DUPLICATE_CODE:${entry.officialCode}`);
    }
    codes.add(entry.officialCode);
  }

  const catalogId = await ensureCatalog(client, input.catalog);

  const sameHash = await client.query<{
    id: string;
    edition_code: string;
    status: string;
  }>(
    `SELECT id, edition_code, status FROM official_catalog_editions
     WHERE catalog_id = $1::uuid AND source_sha256 = $2
     ORDER BY created_at DESC LIMIT 1`,
    [catalogId, input.sourceSha256],
  );
  const replay = sameHash.rows[0];
  if (replay) {
    if (replay.status !== 'CURRENT') {
      throw new Error(`CATALOG_HISTORICAL_REPLAY:${replay.edition_code}`);
    }
    return {
      catalogId,
      editionId: replay.id,
      editionCode: replay.edition_code,
      created: false,
      entriesInserted: 0,
    };
  }

  const current = await client.query<{ id: string; valid_from: string | null }>(
    `SELECT id, to_char(valid_from, 'YYYY-MM-DD') AS valid_from
     FROM official_catalog_editions
     WHERE catalog_id = $1::uuid AND status = 'CURRENT'
     ORDER BY created_at DESC LIMIT 1
     FOR UPDATE`,
    [catalogId],
  );
  const previous = current.rows[0];
  if (previous) {
    if (previous.valid_from && input.validFrom < previous.valid_from) {
      throw new Error(
        `CATALOG_SOURCE_OLDER_THAN_CURRENT:${input.validFrom}:${previous.valid_from}`,
      );
    }
    const validTo =
      previous.valid_from && input.validFrom > previous.valid_from
        ? dayBefore(input.validFrom)
        : input.validFrom;
    await client.query(
      `UPDATE official_catalog_editions
       SET status = 'SUPERSEDED', valid_to = $2::date
       WHERE id = $1::uuid`,
      [previous.id, validTo],
    );
  }

  const editionCode = `${input.validFrom}-${input.sourceSha256.slice(0, 12)}`;
  const edition = await client.query<{ id: string }>(
    `INSERT INTO official_catalog_editions (
       catalog_id, edition_code, published_on, valid_from,
       source_url, source_sha256, status
     ) VALUES ($1::uuid, $2, NULL, $3::date, $4, $5, 'CURRENT')
     RETURNING id`,
    [catalogId, editionCode, input.validFrom, input.sourceUrl, input.sourceSha256],
  );
  const editionId = edition.rows[0]!.id;

  // Parents first so parent_entry_id can be resolved within the edition.
  const ordered = [...input.entries].sort(
    (left, right) =>
      Number(left.parentCode !== null) - Number(right.parentCode !== null),
  );
  const pending = new Map(ordered.map((entry) => [entry.officialCode, entry]));
  const insertedCodes = new Set<string>();
  let entriesInserted = 0;

  while (pending.size > 0) {
    const ready = [...pending.values()].filter(
      (entry) => entry.parentCode === null || insertedCodes.has(entry.parentCode),
    );
    if (ready.length === 0) {
      throw new Error('CATALOG_PARENT_NOT_FOUND:' + [...pending.keys()][0]);
    }
    for (let start = 0; start < ready.length; start += 500) {
      const chunk = ready.slice(start, start + 500);
      const result = await client.query(
        `INSERT INTO official_catalog_entries (
           catalog_edition_id, official_code, description, parent_entry_id, metadata
         )
         SELECT $1::uuid, payload.official_code, payload.description, parent.id,
                payload.metadata
         FROM jsonb_to_recordset($2::jsonb) AS payload(
           official_code text, description text, parent_code text, metadata jsonb
         )
         LEFT JOIN official_catalog_entries parent
           ON parent.catalog_edition_id = $1::uuid
          AND parent.official_code = payload.parent_code`,
        [
          editionId,
          JSON.stringify(
            chunk.map((entry) => ({
              official_code: entry.officialCode,
              description: entry.description,
              parent_code: entry.parentCode,
              metadata: entry.metadata,
            })),
          ),
        ],
      );
      entriesInserted += result.rowCount ?? 0;
    }
    for (const entry of ready) {
      insertedCodes.add(entry.officialCode);
      pending.delete(entry.officialCode);
    }
  }

  if (entriesInserted !== input.entries.length) {
    throw new Error(
      `CATALOG_ENTRY_COUNT_MISMATCH:${entriesInserted}:${input.entries.length}`,
    );
  }

  return { catalogId, editionId, editionCode, created: true, entriesInserted };
}

export interface CatalogDiff {
  currentEditionCode: string | null;
  upToDate: boolean;
  added: number;
  removed: number;
  descriptionChanged: number;
  samples: {
    added: string[];
    removed: string[];
    descriptionChanged: string[];
  };
}

export async function diffAgainstCurrentEdition(
  client: PoolClient,
  catalogCode: string,
  sourceSha256: string,
  entries: readonly CatalogEntryInput[],
): Promise<CatalogDiff> {
  const current = await client.query<{
    id: string;
    edition_code: string;
    source_sha256: string | null;
  }>(
    `SELECT ed.id, ed.edition_code, ed.source_sha256
     FROM official_catalog_editions ed
     JOIN official_catalogs oc ON oc.id = ed.catalog_id
     WHERE oc.code = $1 AND ed.status = 'CURRENT'
     ORDER BY ed.created_at DESC LIMIT 1`,
    [catalogCode],
  );
  const edition = current.rows[0];
  if (!edition) {
    return {
      currentEditionCode: null,
      upToDate: false,
      added: entries.length,
      removed: 0,
      descriptionChanged: 0,
      samples: {
        added: entries.slice(0, 10).map((entry) => entry.officialCode),
        removed: [],
        descriptionChanged: [],
      },
    };
  }

  const existing = await client.query<{ official_code: string; description: string }>(
    `SELECT official_code, description FROM official_catalog_entries
     WHERE catalog_edition_id = $1::uuid`,
    [edition.id],
  );
  const before = new Map(existing.rows.map((row) => [row.official_code, row.description]));
  const after = new Map(entries.map((entry) => [entry.officialCode, entry.description]));

  const added = [...after.keys()].filter((code) => !before.has(code));
  const removed = [...before.keys()].filter((code) => !after.has(code));
  const changed = [...after.entries()]
    .filter(([code, description]) => before.has(code) && before.get(code) !== description)
    .map(([code]) => code);

  return {
    currentEditionCode: edition.edition_code,
    upToDate: edition.source_sha256 === sourceSha256,
    added: added.length,
    removed: removed.length,
    descriptionChanged: changed.length,
    samples: {
      added: added.slice(0, 10),
      removed: removed.slice(0, 10),
      descriptionChanged: changed.slice(0, 10),
    },
  };
}
