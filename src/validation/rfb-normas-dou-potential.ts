import 'dotenv/config';

import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_ADMIN_URL or DATABASE_URL is required.');

const pool = new Pool({ connectionString: databaseUrl, max: 1 });

try {
  const result = await pool.query(`
    WITH rfb AS (
      SELECT p.id, p.agency, p.act_type, p.act_number, p.title, p.published_on,
             po.external_id, po.official_url
      FROM publications p
      JOIN publication_origins po ON po.publication_id = p.id
      JOIN sources s ON s.id = po.source_id
      WHERE s.code = 'rfb-normas'
        AND p.act_number IS NOT NULL
        AND p.published_on IS NOT NULL
    ),
    dou AS (
      SELECT p.id, p.agency, p.act_type, p.act_number, p.title, p.published_on,
             po.external_id, po.official_url
      FROM publications p
      JOIN publication_origins po ON po.publication_id = p.id
      JOIN sources s ON s.id = po.source_id
      WHERE s.code = 'dou'
        AND p.act_number IS NOT NULL
        AND p.published_on IS NOT NULL
    )
    SELECT
      rfb.id AS rfb_publication_id,
      dou.id AS dou_publication_id,
      rfb.agency AS rfb_agency,
      dou.agency AS dou_agency,
      rfb.act_type AS rfb_type,
      dou.act_type AS dou_type,
      rfb.act_number,
      rfb.published_on,
      rfb.title AS rfb_title,
      dou.title AS dou_title,
      rfb.external_id AS rfb_external_id,
      dou.external_id AS dou_external_id,
      rfb.official_url AS rfb_url,
      dou.official_url AS dou_url
    FROM rfb
    JOIN dou
      ON regexp_replace(rfb.act_number, '^0+', '') = regexp_replace(dou.act_number, '^0+', '')
     AND rfb.published_on = dou.published_on
    WHERE rfb.id <> dou.id
    ORDER BY rfb.published_on DESC, rfb.act_number
    LIMIT 200
  `);

  const sourceStats = await pool.query(`
    SELECT s.code, count(DISTINCT po.publication_id)::int AS publications,
           min(p.published_on) AS min_published_on,
           max(p.published_on) AS max_published_on
    FROM sources s
    LEFT JOIN publication_origins po ON po.source_id = s.id
    LEFT JOIN publications p ON p.id = po.publication_id
    WHERE s.code IN ('dou','rfb-normas')
    GROUP BY s.code
    ORDER BY s.code
  `);

  console.log('RFB_NORMAS_DOU_POTENTIAL=' + JSON.stringify({
    sourceStats: sourceStats.rows,
    count: result.rowCount ?? result.rows.length,
    rows: result.rows,
  }));
} finally {
  await pool.end();
}
