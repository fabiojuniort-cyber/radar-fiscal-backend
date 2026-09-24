import 'dotenv/config';

import { createHash } from 'node:crypto';
import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_ADMIN_URL or DATABASE_URL is required.');

function normalize(value: string | null): string {
  return (value ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const targets = ['2344/2026','180/2026','74/2026','2340/2026','164/2026','154/2026'];
const pool = new Pool({ connectionString: databaseUrl, max: 1 });

try {
  const rows = await pool.query(`
    SELECT
      p.id, p.agency, p.act_type, p.act_number, p.title, p.published_on,
      s.code AS source_code, po.external_id, po.official_url,
      pv.id AS version_id, pv.version_no, pv.content_hash, pv.content_text,
      pv.source_metadata
    FROM publications p
    JOIN publication_origins po ON po.publication_id = p.id
    JOIN sources s ON s.id = po.source_id
    LEFT JOIN publication_versions pv ON pv.publication_id = p.id AND pv.is_current = TRUE
    WHERE p.act_number = ANY($1::text[])
      AND s.code IN ('dou','rfb-normas')
    ORDER BY p.act_number, p.published_on, s.code, p.id
  `, [targets]);

  const grouped = new Map<string, unknown[]>();
  for (const row of rows.rows) {
    const text = normalize(row.content_text);
    const key = `${row.act_number}|${row.published_on?.toISOString?.().slice(0,10) ?? row.published_on}`;
    const list = grouped.get(key) ?? [];
    list.push({
      publicationId: row.id,
      sourceCode: row.source_code,
      agency: row.agency,
      actType: row.act_type,
      actNumber: row.act_number,
      title: row.title,
      publishedOn: row.published_on,
      externalId: row.external_id,
      versionId: row.version_id,
      contentHash: row.content_hash,
      normalizedTextHash: hash(text),
      normalizedTextLength: text.length,
      textStart: text.slice(0, 260),
      sourceRole: row.source_metadata?.sourceRole ?? null,
      fileCount: Array.isArray(row.source_metadata?.files) ? row.source_metadata.files.length : 0,
    });
    grouped.set(key, list);
  }

  console.log('RFB_NORMAS_CROSS_SOURCE_DETAIL=' + JSON.stringify({
    groups: Object.fromEntries(grouped),
  }));
} finally {
  await pool.end();
}
