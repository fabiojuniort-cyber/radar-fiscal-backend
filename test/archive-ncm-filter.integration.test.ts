import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

import { buildApp } from '../src/app.js';

const PASSWORD = ['Archive', 'Ncm', '2026', '!'].join('-');

test('archive v2 filters current publications by catalog-matched NCM mentions', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required.');

  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  const app = await buildApp();
  let publicationId: string | undefined;
  let versionId: string | undefined;

  try {
    await app.ready();

    const suffix = randomUUID();
    const email = `archive-ncm-${suffix}@example.test`;
    const register = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        name: 'Archive NCM Owner',
        email,
        company: `Archive NCM ${suffix}`,
        password: PASSWORD,
        confirmPassword: PASSWORD,
        acceptedTerms: true,
      },
    });
    assert.equal(register.statusCode, 201);

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: PASSWORD },
    });
    assert.equal(login.statusCode, 200);
    const accessToken = login.json<{ accessToken: string }>().accessToken;
    const headers = { authorization: `Bearer ${accessToken}` };

    const publication = await admin.query<{ id: string }>(
      `INSERT INTO publications (
         identity_hash, identity_strength, identity_basis,
         jurisdiction_level, title, published_on
       ) VALUES (
         $1, 'STRONG', '{}'::jsonb,
         'FEDERAL', 'Norma para filtro NCM', DATE '2099-12-29'
       )
       RETURNING id`,
      [createHash('sha256').update(randomUUID()).digest('hex')],
    );
    publicationId = publication.rows[0]!.id;

    const version = await admin.query<{ id: string }>(
      `INSERT INTO publication_versions (
         publication_id, version_no, content_hash,
         content_text, relevant_excerpt, is_current
       ) VALUES (
         $1::uuid, 1, $2,
         'Tabela legal menciona NCM 1006.30.11.',
         'NCM 1006.30.11', TRUE
       )
       RETURNING id`,
      [
        publicationId,
        createHash('sha256').update(randomUUID()).digest('hex'),
      ],
    );
    versionId = version.rows[0]!.id;

    await admin.query(
      `UPDATE publications
       SET current_version_id = $2::uuid
       WHERE id = $1::uuid`,
      [publicationId, versionId],
    );

    await admin.query(
      `INSERT INTO publication_ncm_mentions (
         publication_version_id, ncm_code,
         verification_status, method_type,
         detector_key, detector_version,
         confidence, span_start, span_end, excerpt, metadata
       ) VALUES (
         $1::uuid, '10063011',
         'CATALOG_MATCHED', 'EXTRACTOR',
         'archive-filter-fixture', '1.0.0',
         1.0, 27, 37, 'NCM 1006.30.11', '{}'::jsonb
       )`,
      [versionId],
    );

    const formatted = await app.inject({
      method: 'GET',
      url: '/api/v2/archive?ncm=1006.30.11&limit=10&page=1',
      headers,
    });
    assert.equal(formatted.statusCode, 200);
    const formattedBody = formatted.json<{
      totalItems: number;
      items: Array<{ id: string }>;
    }>();
    assert.ok(formattedBody.totalItems >= 1);
    assert.ok(formattedBody.items.some((item) => item.id === publicationId));

    const plain = await app.inject({
      method: 'GET',
      url: '/api/v2/archive?ncm=10063011&limit=10&page=1',
      headers,
    });
    assert.equal(plain.statusCode, 200);
    assert.ok(
      plain
        .json<{ items: Array<{ id: string }> }>()
        .items.some((item) => item.id === publicationId),
    );

    const other = await app.inject({
      method: 'GET',
      url: '/api/v2/archive?ncm=10062099&limit=50&page=1',
      headers,
    });
    assert.equal(other.statusCode, 200);
    assert.equal(
      other
        .json<{ items: Array<{ id: string }> }>()
        .items.some((item) => item.id === publicationId),
      false,
    );

    const malformed = await app.inject({
      method: 'GET',
      url: '/api/v2/archive?ncm=123&limit=10&page=1',
      headers,
    });
    assert.equal(malformed.statusCode, 400);
  } finally {
    await app.close();

    if (versionId) {
      await admin.query(
        'DELETE FROM publication_ncm_mentions WHERE publication_version_id = $1::uuid',
        [versionId],
      );
      await admin.query(
        'DELETE FROM publication_ncm_scans WHERE publication_version_id = $1::uuid',
        [versionId],
      );
    }
    if (publicationId) {
      await admin.query(
        'UPDATE publications SET current_version_id = NULL WHERE id = $1::uuid',
        [publicationId],
      );
      await admin.query(
        'DELETE FROM publication_versions WHERE publication_id = $1::uuid',
        [publicationId],
      );
      await admin.query(
        'DELETE FROM publications WHERE id = $1::uuid',
        [publicationId],
      );
    }

    await admin.end();
  }
});
