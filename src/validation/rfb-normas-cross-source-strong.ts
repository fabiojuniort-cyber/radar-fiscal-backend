import 'dotenv/config';

import { Pool } from 'pg';

import {
  canonicalizeRfbActType,
  canonicalizeRfbAgency,
  normalizeRfbActNumber,
  parseCanonicalRfbFormalAct,
} from '../modules/collection/rfb-normas.identity.js';

const databaseUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_ADMIN_URL or DATABASE_URL is required.');

type CandidateRow = {
  rfb_publication_id: string;
  rfb_agency: string | null;
  rfb_act_type: string | null;
  rfb_act_number: string | null;
  rfb_title: string;
  rfb_published_on: Date | string;
  rfb_external_id: string | null;
  rfb_official_url: string;
  rfb_version_id: string | null;
  rfb_version_count: number;
  rfb_content_hash: string | null;
  rfb_source_metadata: unknown;
  dou_publication_id: string;
  dou_agency: string | null;
  dou_act_type: string | null;
  dou_act_number: string | null;
  dou_title: string;
  dou_published_on: Date | string;
  dou_external_id: string | null;
  dou_official_url: string;
  dou_version_id: string | null;
  dou_version_count: number;
  dou_content_hash: string | null;
};

function dateOnly(value: Date | string): string {
  return (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);
}

function normalizeStoredActNumber(value: string | null, publishedOn: string): string | undefined {
  if (!value) return undefined;
  const match = /^(\d+)[\/-](\d{4})$/.exec(value.replaceAll('.', '').trim());
  if (match?.[1] && match[2]) return normalizeRfbActNumber(match[1], match[2]);
  return normalizeRfbActNumber(value, publishedOn.slice(0, 4));
}

function canonicalDou(row: CandidateRow) {
  const published = dateOnly(row.dou_published_on);
  const parsed = parseCanonicalRfbFormalAct(
    row.dou_title,
    row.dou_agency ?? '',
    row.dou_act_type ?? undefined,
    Number(published.slice(0, 4)),
  );
  return {
    agency: parsed?.agency ?? (row.dou_agency ? canonicalizeRfbAgency(row.dou_agency) : undefined),
    actType: parsed?.actType ?? (row.dou_act_type ? canonicalizeRfbActType(row.dou_act_type) : undefined),
    actNumber: parsed?.actNumber ?? normalizeStoredActNumber(row.dou_act_number, published),
    publishedOn: published,
  };
}

function canonicalRfb(row: CandidateRow) {
  const published = dateOnly(row.rfb_published_on);
  return {
    agency: row.rfb_agency ? canonicalizeRfbAgency(row.rfb_agency) ?? row.rfb_agency : undefined,
    actType: row.rfb_act_type ? canonicalizeRfbActType(row.rfb_act_type) ?? row.rfb_act_type : undefined,
    actNumber: normalizeStoredActNumber(row.rfb_act_number, published),
    publishedOn: published,
  };
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });

try {
  const result = await pool.query<CandidateRow>(`
    WITH current_version AS (
      SELECT DISTINCT ON (pv.publication_id)
             pv.publication_id,
             pv.id AS version_id,
             pv.content_hash,
             pv.source_metadata,
             count(*) OVER (PARTITION BY pv.publication_id)::int AS version_count
        FROM publication_versions pv
       ORDER BY pv.publication_id, pv.is_current DESC, pv.version_no DESC
    ),
    rfb AS (
      SELECT p.id AS publication_id, p.agency, p.act_type, p.act_number,
             p.title, p.published_on, po.external_id, po.official_url,
             cv.version_id, COALESCE(cv.version_count,0)::int AS version_count,
             cv.content_hash, cv.source_metadata
        FROM publications p
        JOIN publication_origins po ON po.publication_id = p.id
        JOIN sources s ON s.id = po.source_id AND s.code = 'rfb-normas'
        LEFT JOIN current_version cv ON cv.publication_id = p.id
       WHERE p.act_number IS NOT NULL AND p.published_on IS NOT NULL
    ),
    dou AS (
      SELECT p.id AS publication_id, p.agency, p.act_type, p.act_number,
             p.title, p.published_on, po.external_id, po.official_url,
             cv.version_id, COALESCE(cv.version_count,0)::int AS version_count,
             cv.content_hash
        FROM publications p
        JOIN publication_origins po ON po.publication_id = p.id
        JOIN sources s ON s.id = po.source_id AND s.code = 'dou'
        LEFT JOIN current_version cv ON cv.publication_id = p.id
       WHERE p.act_number IS NOT NULL AND p.published_on IS NOT NULL
    )
    SELECT
      rfb.publication_id AS rfb_publication_id,
      rfb.agency AS rfb_agency,
      rfb.act_type AS rfb_act_type,
      rfb.act_number AS rfb_act_number,
      rfb.title AS rfb_title,
      rfb.published_on AS rfb_published_on,
      rfb.external_id AS rfb_external_id,
      rfb.official_url AS rfb_official_url,
      rfb.version_id AS rfb_version_id,
      rfb.version_count AS rfb_version_count,
      rfb.content_hash AS rfb_content_hash,
      rfb.source_metadata AS rfb_source_metadata,
      dou.publication_id AS dou_publication_id,
      dou.agency AS dou_agency,
      dou.act_type AS dou_act_type,
      dou.act_number AS dou_act_number,
      dou.title AS dou_title,
      dou.published_on AS dou_published_on,
      dou.external_id AS dou_external_id,
      dou.official_url AS dou_official_url,
      dou.version_id AS dou_version_id,
      dou.version_count AS dou_version_count,
      dou.content_hash AS dou_content_hash
    FROM rfb
    JOIN dou
      ON regexp_replace(rfb.act_number, '^0+', '') = regexp_replace(dou.act_number, '^0+', '')
     AND rfb.published_on = dou.published_on
     AND rfb.publication_id <> dou.publication_id
    ORDER BY rfb.published_on DESC, rfb.act_number, dou.title
    LIMIT 500
  `);

  const candidates = [];
  for (const row of result.rows) {
    const rc = canonicalRfb(row);
    const dc = canonicalDou(row);
    if (
      !rc.agency || !rc.actType || !rc.actNumber ||
      dc.agency !== rc.agency ||
      dc.actType !== rc.actType ||
      dc.actNumber !== rc.actNumber ||
      dc.publishedOn !== rc.publishedOn
    ) continue;

    candidates.push({
      canonical: rc,
      rfb: {
        publicationId: row.rfb_publication_id,
        title: row.rfb_title,
        agency: row.rfb_agency,
        actType: row.rfb_act_type,
        actNumber: row.rfb_act_number,
        externalId: row.rfb_external_id,
        officialUrl: row.rfb_official_url,
        versionId: row.rfb_version_id,
        versionCount: row.rfb_version_count,
        contentHash: row.rfb_content_hash,
        fileCount: Array.isArray((row.rfb_source_metadata as any)?.files)
          ? (row.rfb_source_metadata as any).files.length
          : 0,
      },
      dou: {
        publicationId: row.dou_publication_id,
        title: row.dou_title,
        agency: row.dou_agency,
        actType: row.dou_act_type,
        actNumber: row.dou_act_number,
        externalId: row.dou_external_id,
        officialUrl: row.dou_official_url,
        versionId: row.dou_version_id,
        versionCount: row.dou_version_count,
        contentHash: row.dou_content_hash,
      },
    });
  }

  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    counts.set(candidate.rfb.publicationId, (counts.get(candidate.rfb.publicationId) ?? 0) + 1);
  }
  const ambiguous = [...counts.entries()]
    .filter(([, count]) => count !== 1)
    .map(([publicationId, count]) => ({ publicationId, count }));

  console.log('RFB_NORMAS_DOU_STRONG_CANDIDATES=' + JSON.stringify({
    prefilteredRows: result.rowCount ?? result.rows.length,
    candidateCount: candidates.length,
    ambiguous,
    candidates,
  }));
} finally {
  await pool.end();
}
