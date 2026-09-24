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

type Row = {
  id: string;
  agency: string | null;
  act_type: string | null;
  act_number: string | null;
  title: string;
  published_on: Date | string | null;
  external_id: string | null;
  official_url: string;
  version_id: string | null;
  version_count: number;
  source_metadata: unknown;
  content_hash: string | null;
  content_text: string | null;
};

function dateOnly(value: Date | string | null): string | undefined {
  if (!value) return undefined;
  return (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);
}

function normalizeStoredActNumber(value: string | null, publishedOn: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^(\d+)[\/-](\d{4})$/.exec(value.replaceAll('.', '').trim());
  if (match?.[1] && match[2]) return normalizeRfbActNumber(match[1], match[2]);
  if (!publishedOn) return undefined;
  return normalizeRfbActNumber(value, publishedOn.slice(0, 4));
}

function canonicalDou(row: Row) {
  const published = dateOnly(row.published_on);
  const parsed = parseCanonicalRfbFormalAct(
    row.title,
    row.agency ?? '',
    row.act_type ?? undefined,
    published ? Number(published.slice(0, 4)) : undefined,
  );
  return {
    agency: parsed?.agency ?? (row.agency ? canonicalizeRfbAgency(row.agency) : undefined),
    actType: parsed?.actType ?? (row.act_type ? canonicalizeRfbActType(row.act_type) : undefined),
    actNumber: parsed?.actNumber ?? normalizeStoredActNumber(row.act_number, published),
    publishedOn: published,
  };
}

function canonicalRfb(row: Row) {
  const published = dateOnly(row.published_on);
  return {
    agency: row.agency ? canonicalizeRfbAgency(row.agency) ?? row.agency : undefined,
    actType: row.act_type ? canonicalizeRfbActType(row.act_type) ?? row.act_type : undefined,
    actNumber: normalizeStoredActNumber(row.act_number, published),
    publishedOn: published,
  };
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });

try {
  const result = await pool.query<Row>(`
    WITH current_version AS (
      SELECT DISTINCT ON (pv.publication_id)
             pv.publication_id,
             pv.id AS version_id,
             pv.content_hash,
             pv.content_text,
             pv.source_metadata,
             count(*) OVER (PARTITION BY pv.publication_id)::int AS version_count
        FROM publication_versions pv
       ORDER BY pv.publication_id, pv.is_current DESC, pv.version_no DESC
    )
    SELECT
      p.id, p.agency, p.act_type, p.act_number, p.title, p.published_on,
      po.external_id, po.official_url,
      cv.version_id, COALESCE(cv.version_count,0)::int AS version_count,
      cv.source_metadata, cv.content_hash, cv.content_text,
      s.code AS source_code
    FROM publications p
    JOIN publication_origins po ON po.publication_id = p.id
    JOIN sources s ON s.id = po.source_id
    LEFT JOIN current_version cv ON cv.publication_id = p.id
    WHERE s.code IN ('dou','rfb-normas')
      AND p.act_number IS NOT NULL
      AND p.published_on IS NOT NULL
    ORDER BY p.published_on, p.id
  `);

  const dou = result.rows.filter((row: any) => row.source_code === 'dou');
  const rfb = result.rows.filter((row: any) => row.source_code === 'rfb-normas');
  const candidates: any[] = [];

  for (const r of rfb) {
    const rc = canonicalRfb(r);
    if (!rc.agency || !rc.actType || !rc.actNumber || !rc.publishedOn) continue;

    for (const d of dou) {
      const dc = canonicalDou(d);
      if (
        dc.agency !== rc.agency ||
        dc.actType !== rc.actType ||
        dc.actNumber !== rc.actNumber ||
        dc.publishedOn !== rc.publishedOn
      ) continue;

      candidates.push({
        canonical: rc,
        rfb: {
          publicationId: r.id,
          title: r.title,
          agency: r.agency,
          actType: r.act_type,
          actNumber: r.act_number,
          externalId: r.external_id,
          officialUrl: r.official_url,
          versionId: r.version_id,
          versionCount: r.version_count,
          contentHash: r.content_hash,
          fileCount: Array.isArray((r.source_metadata as any)?.files)
            ? (r.source_metadata as any).files.length
            : 0,
        },
        dou: {
          publicationId: d.id,
          title: d.title,
          agency: d.agency,
          actType: d.act_type,
          actNumber: d.act_number,
          externalId: d.external_id,
          officialUrl: d.official_url,
          versionId: d.version_id,
          versionCount: d.version_count,
          contentHash: d.content_hash,
        },
      });
    }
  }

  const duplicateRfb = candidates.reduce<Record<string, number>>((acc, candidate) => {
    const id = candidate.rfb.publicationId as string;
    acc[id] = (acc[id] ?? 0) + 1;
    return acc;
  }, {});
  const ambiguous = Object.entries(duplicateRfb)
    .filter(([, count]) => count !== 1)
    .map(([publicationId, count]) => ({ publicationId, count }));

  console.log('RFB_NORMAS_DOU_STRONG_CANDIDATES=' + JSON.stringify({
    rfbPublications: rfb.length,
    douPublications: dou.length,
    candidateCount: candidates.length,
    ambiguous,
    candidates,
  }));
} finally {
  await pool.end();
}
