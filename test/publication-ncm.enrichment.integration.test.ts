import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { sql } from 'kysely';
import { Pool } from 'pg';

import { createStandaloneDatabase } from '../src/infrastructure/database/standalone-client.js';
import {
  PUBLICATION_NCM_DETECTOR_KEY,
  PUBLICATION_NCM_DETECTOR_VERSION,
  processPublicationNcmEnrichmentBatch,
} from '../src/modules/taxonomy/ncm/publication-ncm.detector.js';

const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) throw new Error('DATABASE_ADMIN_URL is required');

const workerPassword =
  process.env.DB_WORKER_RUNTIME_PASSWORD ?? process.env.DB_RUNTIME_PASSWORD;
if (!workerPassword) {
  throw new Error('DB worker runtime password is required');
}

function runtimeUrl(databaseUrl: string, password: string): string {
  const url = new URL(databaseUrl);
  url.username = 'radar_worker_runtime';
  url.password = password;
  return url.toString();
}

async function createPublicationFixture(
  admin: Pool,
  input: { title: string; publishedOn: string; text: string },
): Promise<{ publicationId: string; versionId: string }> {
  const publication = await admin.query<{ id: string }>(
    `INSERT INTO publications (
       identity_hash, identity_strength, identity_basis,
       jurisdiction_level, title, published_on
     ) VALUES ($1, 'STRONG', '{}'::jsonb, 'FEDERAL', $2, $3::date)
     RETURNING id`,
    [
      createHash('sha256').update(randomUUID()).digest('hex'),
      input.title,
      input.publishedOn,
    ],
  );
  const publicationId = publication.rows[0]!.id;

  const version = await admin.query<{ id: string }>(
    `INSERT INTO publication_versions (
       publication_id, version_no, content_hash, content_text, is_current
     ) VALUES ($1::uuid, 1, $2, $3, TRUE)
     RETURNING id`,
    [
      publicationId,
      createHash('sha256').update(input.text).digest('hex'),
      input.text,
    ],
  );
  const versionId = version.rows[0]!.id;

  await admin.query(
    `UPDATE publications
     SET current_version_id = $2::uuid
     WHERE id = $1::uuid`,
    [publicationId, versionId],
  );

  return { publicationId, versionId };
}

test('publication NCM enrichment stores only CURRENT catalog matches and marks zero-match scans', async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  const db = createStandaloneDatabase({
    connectionString: runtimeUrl(adminUrl, workerPassword),
    poolMax: 1,
    idleTimeoutMs: 5_000,
    connectionTimeoutMs: 5_000,
  });
  const fixtures: Array<{ publicationId: string; versionId: string }> = [];

  try {
    const currentEntries = await admin.query<{ code: string }>(
      `SELECT regexp_replace(e.official_code, '[^0-9]', '', 'g') AS code
       FROM official_catalog_entries e
       JOIN official_catalog_editions ed ON ed.id = e.catalog_edition_id
       JOIN official_catalogs c ON c.id = ed.catalog_id
       WHERE c.code = 'NCM'
         AND ed.status = 'CURRENT'
         AND COALESCE(e.metadata ->> 'assignable', 'false') = 'true'
         AND regexp_replace(e.official_code, '[^0-9]', '', 'g')
             = ANY($1::text[])
       ORDER BY code`,
      [['10063011', '10062099']],
    );
    assert.deepEqual(
      currentEntries.rows.map((row) => row.code),
      ['10062099', '10063011'],
      'NCM catalog fixture must be imported by the preceding CI gate',
    );

    const runtimePolicy = await sql<{
      current_user: string;
      can_read_catalogs: boolean;
      can_read_editions: boolean;
      can_read_entries: boolean;
    }>`
      SELECT
        current_user,
        has_table_privilege(
          current_user,
          'public.official_catalogs',
          'SELECT'
        ) AS can_read_catalogs,
        has_table_privilege(
          current_user,
          'public.official_catalog_editions',
          'SELECT'
        ) AS can_read_editions,
        has_table_privilege(
          current_user,
          'public.official_catalog_entries',
          'SELECT'
        ) AS can_read_entries
    `.execute(db);

    assert.deepEqual(runtimePolicy.rows[0], {
      current_user: 'radar_worker_runtime',
      can_read_catalogs: true,
      can_read_editions: true,
      can_read_entries: true,
    });

    const matched = await createPublicationFixture(admin, {
      title: 'NCM detector matched fixture',
      publishedOn: '2099-12-31',
      text: 'Tabela: NCM 1006.30.11 e 10062099. Repete 1006.30.11. Ignorar 9999.99.99.',
    });
    fixtures.push(matched);

    const first = await processPublicationNcmEnrichmentBatch(db, { limit: 1 });
    assert.equal(first.selected, 1);
    assert.equal(first.succeeded, 1);
    assert.equal(first.failed, 0);
    assert.equal(first.candidates, 3);
    assert.equal(first.matches, 2);

    const mentions = await admin.query<{
      ncm_code: string;
      verification_status: string;
      method_type: string;
      excerpt: string | null;
      metadata: { occurrenceCount?: number; interpretation?: string };
    }>(
      `SELECT ncm_code, verification_status, method_type, excerpt, metadata
       FROM publication_ncm_mentions
       WHERE publication_version_id = $1::uuid
       ORDER BY ncm_code`,
      [matched.versionId],
    );

    assert.deepEqual(
      mentions.rows.map((row) => row.ncm_code),
      ['10062099', '10063011'],
    );
    assert.ok(mentions.rows.every((row) => row.verification_status === 'CATALOG_MATCHED'));
    assert.ok(mentions.rows.every((row) => row.method_type === 'EXTRACTOR'));
    assert.ok(mentions.rows.every((row) => Boolean(row.excerpt)));
    assert.equal(
      mentions.rows.find((row) => row.ncm_code === '10063011')?.metadata.occurrenceCount,
      2,
    );
    assert.equal(
      mentions.rows[0]?.metadata.interpretation,
      'CATALOG_CODE_MENTION_ONLY',
    );

    const matchedScan = await admin.query<{
      status: string;
      source_field: string;
      candidate_count: number;
      match_count: number;
    }>(
      `SELECT status, source_field, candidate_count, match_count
       FROM publication_ncm_scans
       WHERE publication_version_id = $1::uuid
         AND detector_key = $2
         AND detector_version = $3`,
      [
        matched.versionId,
        PUBLICATION_NCM_DETECTOR_KEY,
        PUBLICATION_NCM_DETECTOR_VERSION,
      ],
    );
    assert.deepEqual(matchedScan.rows[0], {
      status: 'SUCCESS',
      source_field: 'CONTENT_TEXT',
      candidate_count: 3,
      match_count: 2,
    });

    const zeroMatch = await createPublicationFixture(admin, {
      title: 'NCM detector zero-match fixture',
      publishedOn: '2099-12-30',
      text: 'Texto com candidato 9999.99.99 que não existe na edição CURRENT da fixture.',
    });
    fixtures.push(zeroMatch);

    const second = await processPublicationNcmEnrichmentBatch(db, { limit: 1 });
    assert.equal(second.selected, 1);
    assert.equal(second.succeeded, 1);
    assert.equal(second.matches, 0);

    const zeroScan = await admin.query<{
      status: string;
      candidate_count: number;
      match_count: number;
    }>(
      `SELECT status, candidate_count, match_count
       FROM publication_ncm_scans
       WHERE publication_version_id = $1::uuid
         AND detector_key = $2
         AND detector_version = $3`,
      [
        zeroMatch.versionId,
        PUBLICATION_NCM_DETECTOR_KEY,
        PUBLICATION_NCM_DETECTOR_VERSION,
      ],
    );
    assert.deepEqual(zeroScan.rows[0], {
      status: 'SUCCESS',
      candidate_count: 1,
      match_count: 0,
    });

    // A later global batch may legitimately select another CI publication.
    // Our already-successful version must nevertheless remain idempotent.
    await processPublicationNcmEnrichmentBatch(db, { limit: 1 });

    const duplicateCount = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM publication_ncm_mentions
       WHERE publication_version_id = $1::uuid`,
      [matched.versionId],
    );
    assert.equal(duplicateCount.rows[0]?.count, 2);
  } finally {
    await db.destroy();

    for (const fixture of fixtures.reverse()) {
      await admin.query(
        'DELETE FROM publication_ncm_mentions WHERE publication_version_id = $1::uuid',
        [fixture.versionId],
      );
      await admin.query(
        'DELETE FROM publication_ncm_scans WHERE publication_version_id = $1::uuid',
        [fixture.versionId],
      );
      await admin.query(
        'UPDATE publications SET current_version_id = NULL WHERE id = $1::uuid',
        [fixture.publicationId],
      );
      await admin.query(
        'DELETE FROM publication_versions WHERE id = $1::uuid',
        [fixture.versionId],
      );
      await admin.query(
        'DELETE FROM publications WHERE id = $1::uuid',
        [fixture.publicationId],
      );
    }

    await admin.end();
  }
});
