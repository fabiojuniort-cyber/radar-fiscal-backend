import 'dotenv/config';

import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_ADMIN_URL or DATABASE_URL is required.');

const pool = new Pool({ connectionString: databaseUrl, max: 1 });

try {
  const result = await pool.query(`
    SELECT
      p.id,
      p.agency,
      p.act_type,
      p.act_number,
      p.title,
      p.published_on,
      count(DISTINCT po.source_id)::int AS source_count,
      jsonb_agg(DISTINCT s.code ORDER BY s.code) AS source_codes,
      jsonb_agg(
        jsonb_build_object(
          'sourceCode', s.code,
          'externalId', po.external_id,
          'officialUrl', po.official_url
        )
        ORDER BY s.code, po.external_id
      ) AS origins,
      (SELECT count(*)::int FROM publication_versions pv WHERE pv.publication_id = p.id) AS version_count,
      (SELECT count(*)::int FROM publication_versions pv WHERE pv.publication_id = p.id AND pv.is_current) AS current_version_count
    FROM publications p
    JOIN publication_origins po ON po.publication_id = p.id
    JOIN sources s ON s.id = po.source_id
    WHERE p.id IN (
      SELECT publication_id
      FROM publication_origins po2
      JOIN sources s2 ON s2.id = po2.source_id
      WHERE s2.code = 'rfb-normas'
    )
    GROUP BY p.id, p.agency, p.act_type, p.act_number, p.title, p.published_on
    HAVING bool_or(s.code = 'rfb-normas')
       AND bool_or(s.code = 'dou')
    ORDER BY p.published_on DESC NULLS LAST, p.act_type, p.act_number
    LIMIT 100
  `);

  console.log('RFB_NORMAS_DOU_CROSS_SOURCE=' + JSON.stringify({
    count: result.rowCount ?? result.rows.length,
    rows: result.rows,
  }));
} finally {
  await pool.end();
}
