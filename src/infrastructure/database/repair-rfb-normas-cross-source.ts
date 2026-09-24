import 'dotenv/config';

import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';

import { normalizePublication } from '../../modules/collection/publication.normalizer.js';
import {
  canonicalizeRfbActType,
  canonicalizeRfbAgency,
  normalizeRfbActNumber,
  parseCanonicalRfbFormalAct,
} from '../../modules/collection/rfb-normas.identity.js';

const databaseUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_ADMIN_URL or DATABASE_URL is required.');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const EXPECTED = new Map<string, string>([
  ['153678', '2026-09-23:DO1:180:24398395'],
  ['153667', '2026-09-23:DO1:180:24398396'],
  ['153640', '2026-09-22:DO1:179:24392992'],
  ['153663', '2026-09-22:DO1E:179-B:24391984'],
  ['153636', '2026-09-21:DO1E:178-B:24386620'],
  ['153191', '2026-08-31:DO1:164:24304745'],
  ['153192', '2026-08-31:DO1:164:24302161'],
  ['153193', '2026-08-31:DO1:164:24302159'],
  ['153120', '2026-08-26:DO1:161:24286739'],
  ['153046', '2026-08-24:DO1:159:24272929'],
  ['153059', '2026-08-24:DO1E:159-B:24280394'],
]);

type PubRow = {
  id: string;
  identity_hash: string;
  identity_strength: string;
  identity_basis: unknown;
  agency: string | null;
  act_type: string | null;
  act_number: string | null;
  title: string;
  published_on: Date | string | null;
  effective_on: Date | string | null;
  primary_official_url: string | null;
  last_seen_at: Date | string;
};
type OriginRow = {
  id: string;
  publication_id: string;
  source_id: string;
  external_id: string | null;
  official_url: string;
  metadata: unknown;
};
type VersionRow = {
  id: string;
  publication_id: string;
  version_no: number;
  content_hash: string;
  content_text: string | null;
  source_metadata: unknown;
  is_current: boolean;
};

function dateOnly(value: Date | string | null): string | undefined {
  if (!value) return undefined;
  return (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);
}

function canonicalFromRows(dou: PubRow, rfb: PubRow) {
  const published = dateOnly(dou.published_on);
  if (!published || published !== dateOnly(rfb.published_on)) {
    throw new Error('Publication dates do not match.');
  }
  const parsedDou = parseCanonicalRfbFormalAct(
    dou.title,
    dou.agency ?? '',
    dou.act_type ?? undefined,
    Number(published.slice(0, 4)),
  );
  const rfbAgency = rfb.agency ? canonicalizeRfbAgency(rfb.agency) ?? rfb.agency : undefined;
  const rfbType = rfb.act_type ? canonicalizeRfbActType(rfb.act_type) ?? rfb.act_type : undefined;
  const rfbNumberMatch = /^(\d+)[\/-](\d{4})$/.exec((rfb.act_number ?? '').replaceAll('.', ''));
  const rfbNumber = rfbNumberMatch?.[1] && rfbNumberMatch[2]
    ? normalizeRfbActNumber(rfbNumberMatch[1], rfbNumberMatch[2])
    : undefined;

  if (
    !parsedDou?.agency || !parsedDou.actType || !parsedDou.actNumber ||
    parsedDou.agency !== rfbAgency ||
    parsedDou.actType !== rfbType ||
    parsedDou.actNumber !== rfbNumber
  ) {
    throw new Error(
      'Canonical identity mismatch: ' +
      JSON.stringify({ parsedDou, rfbAgency, rfbType, rfbNumber, published }),
    );
  }
  return {
    agency: parsedDou.agency,
    actType: parsedDou.actType,
    actNumber: parsedDou.actNumber,
    publishedOn: published,
  };
}

async function one<T>(client: PoolClient, sql: string, params: unknown[], label: string): Promise<T> {
  const result = await client.query(sql, params);
  if (result.rowCount !== 1) throw new Error(`${label}: expected 1 row, got ${result.rowCount ?? 0}`);
  return result.rows[0] as T;
}

async function count(client: PoolClient, sql: string, params: unknown[]): Promise<number> {
  const result = await client.query(sql, params);
  return Number(result.rows[0]?.count ?? 0);
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const client = await pool.connect();
const correlationId = randomUUID();

try {
  await client.query('BEGIN');

  const douSource = await one<{ id: string }>(
    client, `SELECT id FROM sources WHERE code = 'dou' FOR UPDATE`, [], 'DOU source',
  );
  const rfbSource = await one<{ id: string }>(
    client, `SELECT id FROM sources WHERE code = 'rfb-normas' FOR UPDATE`, [], 'RFB source',
  );

  const previews: Record<string, unknown>[] = [];

  for (const [rfbExternalId, douExternalId] of EXPECTED) {
    const rfbOrigin = await one<OriginRow>(
      client,
      `SELECT * FROM publication_origins
        WHERE source_id = $1 AND external_id = $2
        FOR UPDATE`,
      [rfbSource.id, rfbExternalId],
      `RFB origin ${rfbExternalId}`,
    );
    const douOrigin = await one<OriginRow>(
      client,
      `SELECT * FROM publication_origins
        WHERE source_id = $1 AND external_id = $2
        FOR UPDATE`,
      [douSource.id, douExternalId],
      `DOU origin ${douExternalId}`,
    );

    if (rfbOrigin.publication_id === douOrigin.publication_id) {
      previews.push({
        rfbExternalId,
        douExternalId,
        state: 'ALREADY_MERGED',
        publicationId: douOrigin.publication_id,
      });
      continue;
    }

    const [rfbPub, douPub] = await Promise.all([
      one<PubRow>(
        client, `SELECT * FROM publications WHERE id = $1 FOR UPDATE`,
        [rfbOrigin.publication_id], `RFB publication ${rfbExternalId}`,
      ),
      one<PubRow>(
        client, `SELECT * FROM publications WHERE id = $1 FOR UPDATE`,
        [douOrigin.publication_id], `DOU publication ${douExternalId}`,
      ),
    ]);

    const canonical = canonicalFromRows(douPub, rfbPub);
    const publishedAt = new Date(canonical.publishedOn + 'T00:00:00Z');
    const normalized = normalizePublication({
      sourceId: douSource.id,
      publication: {
        title: douPub.title,
        sphere: 'FEDERAL',
        agency: canonical.agency,
        actType: canonical.actType,
        actNumber: canonical.actNumber,
        publishedAt,
        ...(douPub.effective_on
          ? { effectiveAt: new Date(dateOnly(douPub.effective_on)! + 'T00:00:00Z') }
          : {}),
        officialUrl: douOrigin.official_url,
        ...(douOrigin.external_id ? { externalId: douOrigin.external_id } : {}),
        metadata: { sourceRole: 'PRIMARY' },
      },
    });

    if (normalized.identityHash !== rfbPub.identity_hash) {
      throw new Error(
        `RFB identity hash is not canonical for ${rfbExternalId}: ` +
        JSON.stringify({ expected: normalized.identityHash, actual: rfbPub.identity_hash }),
      );
    }

    const collisions = await client.query(
      `SELECT id FROM publications
        WHERE identity_hash = $1
          AND id NOT IN ($2, $3)
        FOR UPDATE`,
      [normalized.identityHash, douPub.id, rfbPub.id],
    );
    if (collisions.rowCount) {
      throw new Error(`Unexpected canonical identity collision for ${rfbExternalId}`);
    }

    const originCounts = await Promise.all([
      count(client, `SELECT count(*) FROM publication_origins WHERE publication_id = $1`, [rfbPub.id]),
      count(client, `SELECT count(*) FROM publication_origins WHERE publication_id = $1`, [douPub.id]),
    ]);
    if (originCounts[0] !== 1 || originCounts[1] !== 1) {
      throw new Error(
        `Origin-count safety gate failed for ${rfbExternalId}: ${originCounts.join('/')}`,
      );
    }

    const rfbVersion = await one<VersionRow>(
      client,
      `SELECT * FROM publication_versions
        WHERE publication_id = $1
        FOR UPDATE`,
      [rfbPub.id],
      `RFB version ${rfbExternalId}`,
    );
    const douVersion = await one<VersionRow>(
      client,
      `SELECT * FROM publication_versions
        WHERE publication_id = $1
        FOR UPDATE`,
      [douPub.id],
      `DOU version ${douExternalId}`,
    );
    if (!rfbVersion.is_current || !douVersion.is_current) {
      throw new Error(`Current-version safety gate failed for ${rfbExternalId}`);
    }
    if ((rfbVersion.source_metadata as any)?.sourceRole !== 'ENRICHMENT') {
      throw new Error(`RFB version is not ENRICHMENT for ${rfbExternalId}`);
    }
    if ((douVersion.source_metadata as any)?.sourceRole !== 'PRIMARY') {
      throw new Error(`DOU version is not PRIMARY for ${douExternalId}`);
    }

    const [companyRefs, runConflicts] = await Promise.all([
      count(
        client,
        `SELECT count(*) FROM company_publications
          WHERE publication_id IN ($1,$2)`,
        [rfbPub.id, douPub.id],
      ),
      count(
        client,
        `SELECT count(*)
           FROM collection_run_publications src
           JOIN collection_run_publications dst
             ON dst.collection_run_id = src.collection_run_id
            AND dst.publication_id = $2
          WHERE src.publication_id = $1`,
        [rfbPub.id, douPub.id],
      ),
    ]);
    if (companyRefs !== 0) {
      throw new Error(`Company-publication safety gate failed for ${rfbExternalId}: ${companyRefs}`);
    }
    if (runConflicts !== 0) {
      throw new Error(`Run-publication collision for ${rfbExternalId}: ${runConflicts}`);
    }

    const refCounts = {
      collectionItems: await count(
        client, `SELECT count(*) FROM collection_items WHERE publication_id = $1`, [rfbPub.id],
      ),
      runPublications: await count(
        client, `SELECT count(*) FROM collection_run_publications WHERE publication_id = $1`, [rfbPub.id],
      ),
      storedFiles: await count(
        client, `SELECT count(*) FROM publication_files WHERE publication_version_id = $1`, [rfbVersion.id],
      ),
    };

    previews.push({
      rfbExternalId,
      douExternalId,
      state: APPLY ? 'WILL_APPLY' : 'DRY_RUN_OK',
      canonical,
      targetPublicationId: douPub.id,
      sourcePublicationId: rfbPub.id,
      targetVersionId: douVersion.id,
      sourceVersionId: rfbVersion.id,
      targetIdentityBefore: douPub.identity_hash,
      canonicalIdentity: normalized.identityHash,
      refCounts,
    });

    if (!APPLY) continue;

    await client.query(
      `UPDATE publication_origins
          SET publication_id = $2,
              metadata = COALESCE(metadata, '{}'::jsonb)
                || jsonb_build_object(
                    'historicalCrossSourceMerge',
                    jsonb_build_object(
                      'primarySource', 'dou',
                      'mergedAt', now(),
                      'correlationId', $3::text
                    )
                  ),
              last_seen_at = now()
        WHERE id = $1`,
      [rfbOrigin.id, douPub.id, correlationId],
    );

    await client.query(
      `DELETE FROM publication_files pf
        USING publication_files target
        WHERE pf.publication_version_id = $1
          AND target.publication_version_id = $2
          AND target.raw_sha256 = pf.raw_sha256`,
      [rfbVersion.id, douVersion.id],
    );
    await client.query(
      `UPDATE publication_files
          SET publication_version_id = $2
        WHERE publication_version_id = $1`,
      [rfbVersion.id, douVersion.id],
    );

    await client.query(
      `UPDATE collection_run_publications
          SET publication_id = $2,
              publication_version_id = $3,
              disposition = 'EXISTING_PUBLICATION'
        WHERE publication_id = $1`,
      [rfbPub.id, douPub.id, douVersion.id],
    );

    await client.query(
      `UPDATE collection_items
          SET publication_id = $2,
              status = CASE
                WHEN status IN ('PROCESSED_NEW','NEW_VERSION') THEN 'PROCESSED_EXISTING'
                ELSE status
              END,
              updated_at = now()
        WHERE publication_id = $1`,
      [rfbPub.id, douPub.id],
    );

    await client.query(
      `DELETE FROM publication_versions WHERE id = $1`,
      [rfbVersion.id],
    );
    await client.query(
      `DELETE FROM publications WHERE id = $1`,
      [rfbPub.id],
    );

    await client.query(
      `UPDATE publications
          SET identity_hash = $2,
              identity_version = 1,
              identity_strength = $3,
              identity_basis = $4::jsonb,
              agency = $5,
              act_type = $6,
              act_number = $7,
              effective_on = COALESCE(effective_on, $8::date),
              last_seen_at = GREATEST(last_seen_at, $9::timestamptz),
              updated_at = now()
        WHERE id = $1`,
      [
        douPub.id,
        normalized.identityHash,
        normalized.identityStrength,
        JSON.stringify(normalized.identityBasis),
        canonical.agency,
        canonical.actType,
        canonical.actNumber,
        dateOnly(rfbPub.effective_on) ?? null,
        rfbPub.last_seen_at,
      ],
    );

    await client.query(
      `INSERT INTO audit_log (
          actor_type, actor_id, action, entity_type, entity_id,
          before_data, after_data, correlation_id
        )
        VALUES (
          'ADMIN', 'rfb-normas-cross-source-repair',
          'MERGE_RFB_NORMAS_DOU_HISTORICAL',
          'publication', $1,
          $2::jsonb, $3::jsonb, $4::uuid
        )`,
      [
        douPub.id,
        JSON.stringify({
          douPublicationId: douPub.id,
          rfbPublicationId: rfbPub.id,
          douIdentityHash: douPub.identity_hash,
          rfbIdentityHash: rfbPub.identity_hash,
        }),
        JSON.stringify({
          publicationId: douPub.id,
          identityHash: normalized.identityHash,
          rfbExternalId,
          douExternalId,
          origins: ['dou', 'rfb-normas'],
        }),
        correlationId,
      ],
    );
  }

  if (previews.filter((row: any) => row.state !== 'ALREADY_MERGED').length !== EXPECTED.size) {
    const already = previews.filter((row: any) => row.state === 'ALREADY_MERGED').length;
    if (already === 0) {
      throw new Error(
        `Expected ${EXPECTED.size} repairable pairs, got ` +
        previews.filter((row: any) => row.state !== 'ALREADY_MERGED').length,
      );
    }
  }

  if (APPLY) await client.query('COMMIT');
  else await client.query('ROLLBACK');

  console.log('RFB_NORMAS_CROSS_SOURCE_REPAIR=' + JSON.stringify({
    apply: APPLY,
    correlationId,
    expectedPairs: EXPECTED.size,
    rows: previews,
  }));
} catch (error) {
  await client.query('ROLLBACK');
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
