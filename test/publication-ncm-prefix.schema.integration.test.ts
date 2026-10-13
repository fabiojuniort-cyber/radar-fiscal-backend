import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';

/** F2: new 2/4/6-digit mentions must fit the DB without loosening 8-digit rules. */
test('F2 contextual short NCM evidence: PostgreSQL accepts only 2/4/6/8 digits', async () => {
  const connectionString = process.env.DATABASE_ADMIN_URL;
  if (!connectionString) throw new Error('DATABASE_ADMIN_URL missing');
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const publication = await pool.query<{ id: string }>(
      "INSERT INTO publications (identity_hash, identity_strength, identity_basis, jurisdiction_level, title, published_on) VALUES ($1, 'STRONG', '{}'::jsonb, 'FEDERAL', 'F2 short NCM fixture', CURRENT_DATE) RETURNING id",
      [createHash('sha256').update(randomUUID()).digest('hex')],
    );
    const version = await pool.query<{ id: string }>(
      "INSERT INTO publication_versions (publication_id, version_no, content_hash, content_text, is_current) VALUES ($1::uuid, 1, $2, 'NCM 10. Posição 1006. Subposição 1006.30.', true) RETURNING id",
      [publication.rows[0]!.id, createHash('sha256').update(randomUUID()).digest('hex')],
    );
    const versionId = version.rows[0]!.id;
    for (const code of ['10', '1006', '100630', '10063011']) {
      await pool.query(
        "INSERT INTO publication_ncm_mentions (publication_version_id, ncm_code, method_type, detector_key, detector_version, verification_status) VALUES ($1::uuid, $2, 'EXTRACTOR', 'f2-test', '1.2.0', 'UNVERIFIED')",
        [versionId, code],
      );
    }
    const values = await pool.query<{ ncm_code: string }>(
      "SELECT ncm_code FROM publication_ncm_mentions WHERE publication_version_id = $1::uuid AND detector_key = 'f2-test' ORDER BY length(ncm_code), ncm_code",
      [versionId],
    );
    assert.deepEqual(values.rows.map((row) => row.ncm_code), ['10', '1006', '100630', '10063011']);
    for (const invalid of ['1', '123', '12345', '1234567', '123456789']) {
      await assert.rejects(
        pool.query(
          "INSERT INTO publication_ncm_mentions (publication_version_id, ncm_code, method_type, detector_key, detector_version) VALUES ($1::uuid, $2, 'EXTRACTOR', 'f2-test', '1.2.0')",
          [versionId, invalid],
        ),
      );
    }
    await pool.query("DELETE FROM publication_ncm_mentions WHERE publication_version_id = $1::uuid AND detector_key = 'f2-test'", [versionId]);
    await pool.query('DELETE FROM publication_versions WHERE id = $1::uuid', [versionId]);
    await pool.query('DELETE FROM publications WHERE id = $1::uuid', [publication.rows[0]!.id]);
  } finally {
    await pool.end();
  }
});
