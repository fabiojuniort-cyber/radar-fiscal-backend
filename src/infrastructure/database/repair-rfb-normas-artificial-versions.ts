import 'dotenv/config';

import { Pool, type PoolClient } from 'pg';

import type { ConnectorPublication } from '../../modules/collection/connector.contract.js';
import { normalizePublication } from '../../modules/collection/publication.normalizer.js';

const databaseUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_ADMIN_URL or DATABASE_URL is required.');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');

const SOURCE_CODE = 'rfb-normas';
const loaded.publicationId = '4d1acd59-edb8-4e9f-bfe8-21744481cbdd';
const PORTARIA_619_KEEP = '148881';
const PORTARIA_619_DROP = '148882';
const loaded.publicationId = '4175edbb-f2c8-419b-bed2-dbbca28ad94b';
const PORTARIA_140_KEEP = '151936';
const PORTARIA_140_DROP = '151937';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return structuredClone(value as JsonRecord);
  }
  return {};
}

function isoDate(value: unknown, field: string): Date | undefined {
  if (value === null || value === undefined) return undefined;
  const raw = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  const parsed = new Date(raw + 'T00:00:00Z');
  if (!Number.isFinite(parsed.getTime())) throw new Error('Invalid ' + field + ': ' + String(value));
  return parsed;
}

async function sourceId(client: PoolClient): Promise<string> {
  const result = await client.query(
    `SELECT id FROM sources WHERE code = $1 FOR UPDATE`,
    [SOURCE_CODE],
  );
  if (result.rowCount !== 1) throw new Error('Expected exactly one rfb-normas source.');
  return result.rows[0].id as string;
}

async function loadCase(
  client: PoolClient,
  source: string,
  keepExternalId: string,
  dropExternalId: string,
) {
  const keepResult = await client.query(
    `SELECT po.id AS origin_id, po.publication_id, po.external_id, po.official_url,
            po.metadata AS origin_metadata,
            p.identity_hash, p.identity_strength, p.identity_basis,
            p.jurisdiction_level, p.uf, p.agency, p.act_type, p.act_number,
            p.title, p.published_on, p.effective_on, p.primary_official_url
       FROM publication_origins po
       JOIN publications p ON p.id = po.publication_id
      WHERE po.source_id = $1
        AND po.external_id = $2
      FOR UPDATE OF po, p`,
    [source, keepExternalId],
  );
  if (keepResult.rowCount !== 1) {
    throw new Error('Expected one keep origin for external_id=' + keepExternalId);
  }

  const publication = keepResult.rows[0];
  const publicationId = publication.publication_id as string;

  const dropResult = await client.query(
    `SELECT id, publication_id, external_id, official_url, metadata
       FROM publication_origins
      WHERE source_id = $1
        AND external_id = $2
      FOR UPDATE`,
    [source, dropExternalId],
  );

  const versionsResult = await client.query(
    `SELECT id, publication_id, version_no, content_hash, content_text,
            source_metadata, is_current, captured_at,
            source_metadata->'rfbNormas'->>'idAto' AS source_id_ato
       FROM publication_versions
      WHERE publication_id = $1
      ORDER BY version_no
      FOR UPDATE`,
    [publicationId],
  );

  return {
    publicationId,
    publication,
    keepOrigin: {
      id: publication.origin_id,
      publication_id: publicationId,
      source_id: source,
      external_id: keepExternalId,
      official_url: publication.official_url,
      metadata: publication.origin_metadata,
    },
    dropOrigin: dropResult.rows[0] ?? null,
    versions: versionsResult.rows,
    keepVersion: versionsResult.rows.find((row) => row.source_id_ato === keepExternalId) ?? null,
    dropVersion: versionsResult.rows.find((row) => row.source_id_ato === dropExternalId) ?? null,
  };
}

async function redirectVersionReferences(
  client: PoolClient,
  dropVersionId: string,
  keepVersionId: string,
): Promise<number> {
  const result = await client.query(
    `UPDATE collection_run_publications
        SET publication_version_id = $2
      WHERE publication_version_id = $1`,
    [dropVersionId, keepVersionId],
  );
  return result.rowCount ?? 0;
}

async function detachDuplicateCollectionItems(
  client: PoolClient,
  publicationId: string,
  externalId: string,
  reason: string,
): Promise<number> {
  const result = await client.query(
    `UPDATE collection_items
        SET publication_id = NULL,
            status = 'DISCOVERED',
            error_code = NULL,
            error_message = NULL,
            raw_metadata = COALESCE(raw_metadata, '{}'::jsonb)
              || jsonb_build_object(
                   'repair',
                   jsonb_build_object(
                     'code', $3::text,
                     'repairedAt', now()
                   )
                 ),
            updated_at = now()
      WHERE publication_id = $1
        AND external_id = $2`,
    [publicationId, externalId, reason],
  );
  return result.rowCount ?? 0;
}

async function repairPortaria619(
  client: PoolClient,
  source: string,
): Promise<JsonRecord> {
  const loaded = await loadCase(
    client,
    source,
    PORTARIA_619_KEEP,
    PORTARIA_619_DROP,
  );

  const publication = loaded.publication;
  if (
    publication.act_type === 'RETIFICAÇÃO' &&
    publication.act_number === null &&
    loaded.dropOrigin === null &&
    loaded.versions.length === 1 &&
    loaded.keepVersion
  ) {
    return {
      publicationId: loaded.publicationId,
      state: 'ALREADY_REPAIRED',
      keepExternalId: PORTARIA_619_KEEP,
    };
  }
  if (
    publication.act_type !== 'PORTARIA' ||
    publication.act_number !== '619/2025' ||
    publication.agency !== 'RFB' ||
    !loaded.dropOrigin ||
    !loaded.keepVersion ||
    !loaded.dropVersion ||
    loaded.versions.length !== 2
  ) {
    throw new Error('Portaria 619 safety gate failed: unexpected pre-repair state.');
  }

  const sourceMetadata = asRecord(loaded.keepVersion.source_metadata);
  const rfbNormas = asRecord(sourceMetadata.rfbNormas);
  const targetAct = {
    agency: 'RFB',
    actType: 'PORTARIA',
    actNumber: '619/2025',
  };
  sourceMetadata.sourceRole = 'ENRICHMENT';
  sourceMetadata.representationSourceRole = 'PRIMARY';
  sourceMetadata.rfbNormas = {
    ...rfbNormas,
    idAto: PORTARIA_619_KEEP,
    revisionKind: 'RETIFICATION',
    targetAct,
  };

  const publishedAt = isoDate(publication.published_on, 'published_on');
  if (!publishedAt) throw new Error('Portaria 619 is missing published_on.');
  const effectiveAt = isoDate(publication.effective_on, 'effective_on');
  const sourceTitle = String(rfbNormas.sourceTitle ?? publication.title);
  const identityKey = [
    'RFB_NORMAS',
    'RETIFICATION',
    'RFB',
    'PORTARIA',
    '619/2025',
    publishedAt.toISOString().slice(0, 10),
  ].join('|');

  const connectorPublication: ConnectorPublication = {
    title: 'RETIFICAÇÃO — ' + sourceTitle.toLocaleUpperCase('pt-BR'),
    sphere: 'FEDERAL',
    agency: 'RFB',
    actType: 'RETIFICAÇÃO',
    publishedAt,
    ...(effectiveAt ? { effectiveAt } : {}),
    content: String(loaded.keepVersion.content_text ?? ''),
    officialUrl: String(loaded.keepOrigin.official_url),
    externalId: PORTARIA_619_KEEP,
    identityKey,
    metadata: sourceMetadata,
  };

  const normalized = normalizePublication({
    sourceId: source,
    publication: connectorPublication,
  });

  const collision = await client.query(
    `SELECT id FROM publications WHERE identity_hash = $1 AND id <> $2`,
    [normalized.identityHash, loaded.publicationId],
  );
  if (collision.rowCount) {
    throw new Error('Retification identity already belongs to another publication: ' + collision.rows[0].id);
  }

  const preview = {
    publicationId: loaded.publicationId,
    before: {
      actType: publication.act_type,
      actNumber: publication.act_number,
      title: publication.title,
      identityHash: publication.identity_hash,
      versions: loaded.versions.map((row) => ({
        id: row.id,
        versionNo: row.version_no,
        sourceIdAto: row.source_id_ato,
        isCurrent: row.is_current,
        contentHash: row.content_hash,
      })),
    },
    after: {
      actType: normalized.actType,
      actNumber: normalized.actNumber ?? null,
      title: normalized.title,
      identityHash: normalized.identityHash,
      contentHash: normalized.contentHash,
      identityBasis: normalized.identityBasis,
      keepExternalId: PORTARIA_619_KEEP,
      dropExternalId: PORTARIA_619_DROP,
    },
  };

  if (!APPLY) return { ...preview, applied: false };

  const redirected = await redirectVersionReferences(
    client,
    loaded.dropVersion.id as string,
    loaded.keepVersion.id as string,
  );
  const detached = await detachDuplicateCollectionItems(
    client,
    loaded.publicationId,
    PORTARIA_619_DROP,
    'DUPLICATE_PUBLICATION_REFERENCE',
  );

  await client.query(
    `DELETE FROM publication_origins WHERE id = $1`,
    [loaded.dropOrigin.id],
  );
  await client.query(
    `DELETE FROM publication_versions WHERE id = $1`,
    [loaded.dropVersion.id],
  );

  await client.query(
    `UPDATE publication_versions
        SET version_no = 1,
            content_hash = $2,
            content_text = $3,
            source_metadata = $4::jsonb,
            is_current = TRUE
      WHERE id = $1`,
    [
      loaded.keepVersion.id,
      normalized.contentHash,
      normalized.contentText ?? null,
      JSON.stringify(normalized.metadata),
    ],
  );

  await client.query(
    `UPDATE publication_origins
        SET official_url = $2,
            metadata = $3::jsonb,
            last_seen_at = now()
      WHERE id = $1`,
    [
      loaded.keepOrigin.id,
      normalized.officialUrl,
      JSON.stringify(normalized.metadata),
    ],
  );

  await client.query(
    `UPDATE publications
        SET identity_hash = $2,
            identity_version = 1,
            identity_strength = $3,
            identity_basis = $4::jsonb,
            agency = $5,
            act_type = $6,
            act_number = NULL,
            title = $7,
            published_on = $8,
            effective_on = $9,
            primary_official_url = $10,
            updated_at = now()
      WHERE id = $1`,
    [
      loaded.publicationId,
      normalized.identityHash,
      normalized.identityStrength,
      JSON.stringify(normalized.identityBasis),
      normalized.agency ?? null,
      normalized.actType ?? null,
      normalized.title,
      normalized.publishedOn ?? null,
      normalized.effectiveOn ?? null,
      normalized.officialUrl,
    ],
  );

  return {
    ...preview,
    applied: true,
    redirectedRunPublicationReferences: redirected,
    detachedDuplicateItems: detached,
  };
}

async function repairPortaria140(
  client: PoolClient,
  source: string,
): Promise<JsonRecord> {
  const loaded = await loadCase(
    client,
    source,
    PORTARIA_140_KEEP,
    PORTARIA_140_DROP,
  );

  const publication = loaded.publication;
  if (
    publication.act_type === 'PORTARIA CONJUNTA' &&
    publication.act_number === '140/2026' &&
    loaded.dropOrigin === null &&
    loaded.versions.length === 1 &&
    loaded.keepVersion
  ) {
    return {
      publicationId: loaded.publicationId,
      state: 'ALREADY_REPAIRED',
      keepExternalId: PORTARIA_140_KEEP,
    };
  }
  if (
    publication.act_type !== 'PORTARIA CONJUNTA' ||
    publication.act_number !== '140/2026' ||
    !loaded.dropOrigin ||
    !loaded.keepVersion ||
    !loaded.dropVersion ||
    loaded.versions.length !== 2
  ) {
    throw new Error('Portaria Conjunta 140 safety gate failed: unexpected pre-repair state.');
  }
  if (loaded.keepVersion.is_current !== true) {
    throw new Error('Portaria Conjunta 140 safety gate failed: substantive 151936 version must be current.');
  }

  const preview = {
    publicationId: loaded.publicationId,
    before: {
      actType: publication.act_type,
      actNumber: publication.act_number,
      title: publication.title,
      versions: loaded.versions.map((row) => ({
        id: row.id,
        versionNo: row.version_no,
        sourceIdAto: row.source_id_ato,
        isCurrent: row.is_current,
        contentHash: row.content_hash,
      })),
    },
    after: {
      keepExternalId: PORTARIA_140_KEEP,
      dropExternalId: PORTARIA_140_DROP,
      keepVersionId: loaded.keepVersion.id,
      keepContentHash: loaded.keepVersion.content_hash,
    },
  };

  if (!APPLY) return { ...preview, applied: false };

  const redirected = await redirectVersionReferences(
    client,
    loaded.dropVersion.id as string,
    loaded.keepVersion.id as string,
  );
  const detached = await detachDuplicateCollectionItems(
    client,
    loaded.publicationId,
    PORTARIA_140_DROP,
    'DUPLICATE_PUBLICATION_REFERENCE',
  );

  await client.query(
    `DELETE FROM publication_origins WHERE id = $1`,
    [loaded.dropOrigin.id],
  );
  await client.query(
    `DELETE FROM publication_versions WHERE id = $1`,
    [loaded.dropVersion.id],
  );
  await client.query(
    `UPDATE publication_versions
        SET version_no = 1,
            is_current = TRUE
      WHERE id = $1`,
    [loaded.keepVersion.id],
  );
  await client.query(
    `UPDATE publications
        SET primary_official_url = $2,
            updated_at = now()
      WHERE id = $1`,
    [loaded.publicationId, loaded.keepOrigin.official_url],
  );

  return {
    ...preview,
    applied: true,
    redirectedRunPublicationReferences: redirected,
    detachedDuplicateItems: detached,
  };
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const client = await pool.connect();

try {
  await client.query('BEGIN');
  const source = await sourceId(client);

  const portaria619 = await repairPortaria619(client, source);
  const portaria140 = await repairPortaria140(client, source);

  if (APPLY) await client.query('COMMIT');
  else await client.query('ROLLBACK');

  console.log('RFB_NORMAS_ARTIFICIAL_VERSION_REPAIR=' + JSON.stringify({
    apply: APPLY,
    sourceId: source,
    portaria619,
    portaria140,
  }));
} catch (error) {
  await client.query('ROLLBACK');
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
