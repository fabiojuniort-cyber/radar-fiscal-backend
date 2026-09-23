import 'dotenv/config';

import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_ADMIN_URL or DATABASE_URL is required.');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const BAD_EXTERNAL_ID = '/upload/arquivos/202603/11173011-resolucao-cgibs-n-3-de-10-de-marco-de-2026-altera-resolucao-n-1.pdf';
const BAD_URL = 'https://www.cgibs.gov.br' + BAD_EXTERNAL_ID;
const GOOD_EXTERNAL_ID = '/upload/arquivos/202603/11173106-resolucao-cgibs-n-2-de-10-de-marco-de-2026-regimento-eleitoral.pdf';
const GOOD_URL = 'https://www.cgibs.gov.br' + GOOD_EXTERNAL_ID;

function fileMatches(metadata: unknown, url: string): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const files = (metadata as Record<string, unknown>).files;
  if (!Array.isArray(files)) return false;
  return files.some((file) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) return false;
    const record = file as Record<string, unknown>;
    return record.url === url || record.externalId === new URL(url).pathname;
  });
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const client = await pool.connect();

try {
  await client.query('BEGIN');

  const sourceResult = await client.query(
    `SELECT id FROM sources WHERE code = 'cgibs' FOR UPDATE`,
  );
  if (sourceResult.rowCount !== 1) throw new Error('Expected exactly one CGIBS source.');
  const sourceId = sourceResult.rows[0].id as string;

  const badOriginResult = await client.query(
    `SELECT po.id AS origin_id, po.publication_id, p.act_type, p.act_number, p.title,
            p.primary_official_url
       FROM publication_origins po
       JOIN publications p ON p.id = po.publication_id
      WHERE po.source_id = $1 AND po.external_id = $2
      FOR UPDATE OF po, p`,
    [sourceId, BAD_EXTERNAL_ID],
  );

  if (badOriginResult.rowCount === 0) {
    const repaired = await client.query(
      `SELECT p.id, p.act_type, p.act_number, p.title
         FROM publication_origins po
         JOIN publications p ON p.id = po.publication_id
        WHERE po.source_id = $1 AND po.official_url = $2`,
      [sourceId, BAD_URL],
    );
    await client.query('ROLLBACK');
    console.log('CGIBS_RESOLUTION_3_REPAIR=' + JSON.stringify({
      apply: APPLY,
      state: repaired.rows.some((row) => row.act_number === '3/2026') ? 'ALREADY_REPAIRED' : 'BAD_ORIGIN_NOT_FOUND',
      repaired: repaired.rows,
    }));
    process.exit(repaired.rows.some((row) => row.act_number === '3/2026') ? 0 : 1);
  }

  if (badOriginResult.rowCount !== 1) throw new Error('Expected exactly one bad Resolution 3 origin.');
  const badOrigin = badOriginResult.rows[0];
  if (badOrigin.act_number !== '2/2026') {
    throw new Error(`Safety gate failed: bad origin is linked to ${badOrigin.act_number ?? 'NULL'}, not 2/2026.`);
  }
  const publicationId = badOrigin.publication_id as string;

  const goodOriginResult = await client.query(
    `SELECT id, publication_id, external_id, official_url
       FROM publication_origins
      WHERE source_id = $1 AND external_id = $2
      FOR UPDATE`,
    [sourceId, GOOD_EXTERNAL_ID],
  );
  if (goodOriginResult.rowCount !== 1 || goodOriginResult.rows[0].publication_id !== publicationId) {
    throw new Error('Safety gate failed: canonical Resolution 2 origin is not linked to the affected publication.');
  }

  const versionsResult = await client.query(
    `SELECT id, version_no, content_hash, is_current, source_metadata
       FROM publication_versions
      WHERE publication_id = $1
      ORDER BY version_no
      FOR UPDATE`,
    [publicationId],
  );

  const badVersions = versionsResult.rows.filter((row) => fileMatches(row.source_metadata, BAD_URL));
  const goodVersions = versionsResult.rows.filter((row) => fileMatches(row.source_metadata, GOOD_URL));
  if (badVersions.length !== 1 || goodVersions.length !== 1) {
    throw new Error(`Safety gate failed: expected one good and one bad version, got good=${goodVersions.length}, bad=${badVersions.length}.`);
  }

  const badVersion = badVersions[0];
  const goodVersion = goodVersions[0];
  if (!badVersion.is_current || goodVersion.is_current) {
    throw new Error('Safety gate failed: expected bad Resolution 3 content current and Resolution 2 content historical.');
  }

  const before = {
    publicationId,
    publication: badOrigin,
    goodOrigin: goodOriginResult.rows[0],
    versions: versionsResult.rows.map((row) => ({
      id: row.id,
      versionNo: row.version_no,
      contentHash: row.content_hash,
      isCurrent: row.is_current,
      matchesResolution2: row.id === goodVersion.id,
      matchesResolution3: row.id === badVersion.id,
    })),
  };

  if (!APPLY) {
    await client.query('ROLLBACK');
    console.log('CGIBS_RESOLUTION_3_REPAIR=' + JSON.stringify({
      apply: false,
      state: 'DRY_RUN_OK',
      before,
    }));
    process.exit(0);
  }

  await client.query(
    `UPDATE publication_versions SET is_current = FALSE WHERE id = $1`,
    [badVersion.id],
  );
  await client.query(
    `UPDATE publication_versions SET is_current = TRUE WHERE id = $1`,
    [goodVersion.id],
  );
  await client.query(
    `DELETE FROM publication_origins WHERE id = $1`,
    [badOrigin.origin_id],
  );
  await client.query(
    `DELETE FROM publication_versions WHERE id = $1`,
    [badVersion.id],
  );
  await client.query(
    `UPDATE publications
        SET title = 'RESOLUÇÃO CGIBS Nº 2, DE 10 DE MARÇO DE 2026',
            act_type = 'RESOLUÇÃO CGIBS',
            act_number = '2/2026',
            published_on = DATE '2026-03-11',
            primary_official_url = $2,
            updated_at = now()
      WHERE id = $1`,
    [publicationId, GOOD_URL],
  );

  const afterResult = await client.query(
    `SELECT p.id, p.act_type, p.act_number, p.title, p.primary_official_url,
            (SELECT count(*)::int FROM publication_origins po WHERE po.publication_id = p.id) AS origin_count,
            (SELECT count(*)::int FROM publication_versions pv WHERE pv.publication_id = p.id) AS version_count,
            (SELECT count(*)::int FROM publication_versions pv WHERE pv.publication_id = p.id AND pv.is_current) AS current_version_count
       FROM publications p WHERE p.id = $1`,
    [publicationId],
  );

  await client.query('COMMIT');
  console.log('CGIBS_RESOLUTION_3_REPAIR=' + JSON.stringify({
    apply: true,
    state: 'APPLIED',
    before,
    after: afterResult.rows[0],
  }));
} catch (error) {
  await client.query('ROLLBACK');
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
