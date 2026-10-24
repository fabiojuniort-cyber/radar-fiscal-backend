import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

import {
  F2_ACTUACAO_SEED,
  F2_ACTUACAO_SOURCE_SHA256,
  initializeF2Actuacao,
  persistF2ActuacaoCnaeOrigins,
  validateF2ActuacaoOrigins,
} from '../src/modules/taxonomy/curation/curation.actuacao.js';
import { withCuratorTransaction } from '../src/modules/taxonomy/curation/curation.draft.js';

const adminUrl = process.env.DATABASE_ADMIN_URL;
const curatorPassword = process.env.DB_CURATOR_RUNTIME_PASSWORD;
if (!adminUrl || !curatorPassword) {
  throw new Error('DATABASE_ADMIN_URL and DB_CURATOR_RUNTIME_PASSWORD required');
}

test('F2-T02 on isolated PostgreSQL 18: draft Atuação and source origins are durable, guarded and isolated', async () => {
  const url = new URL(adminUrl);
  url.username = 'radar_taxonomy_curator_runtime';
  url.password = curatorPassword;
  const admin = new Pool({ connectionString: adminUrl, max: 2 });
  const curator = new Pool({ connectionString: url.toString(), max: 1 });
  try {
    const release = await admin.query<{ id: string }>(
      "INSERT INTO taxonomy_releases (version_major, version_minor, version_patch, status, manifest, created_by_actor) SELECT COALESCE(max(version_major), 0) + 100, 0, 0, 'DRAFT', '{\"kind\":\"TAX-11_CURATED_RELEASE\"}'::jsonb, 'f2-t02-test' FROM taxonomy_releases RETURNING id",
    );
    const releaseId = release.rows[0]!.id;
    const actor = { userId: randomUUID(), justification: 'Prova F2 de persistência e origem' };

    const first = await withCuratorTransaction(curator, client => initializeF2Actuacao(client, actor));
    assert.equal(first.sourceRows, 1332);
    assert.equal(first.seededCodes.length, 12);
    assert.equal(first.classificationPublished, false);
    assert.equal(first.sourceSha256, F2_ACTUACAO_SOURCE_SHA256);
    const second = await withCuratorTransaction(curator, client => initializeF2Actuacao(client, actor));
    assert.deepEqual(second.seededCodes, []);
    const concepts = await admin.query<{ code: string; classify_by_label: boolean }>(
      "SELECT c.code, rc.classify_by_label FROM taxonomy_release_concepts rc JOIN taxonomy_concepts c ON c.id = rc.concept_id WHERE rc.release_id = $1::uuid AND c.code LIKE 'actuacao.%' ORDER BY c.code",
      [releaseId],
    );
    assert.equal(concepts.rows.length, F2_ACTUACAO_SEED.length);
    assert.ok(concepts.rows.every(row => row.classify_by_label === false));

    const forged = Array.from({ length: 1332 }, (_, i) => ({
      sourceLine: i + 2,
      cnaeCode: String(i).padStart(7, '0'),
      atuacaoLabel: 'Serviço',
    }));
    assert.throws(() => validateF2ActuacaoOrigins(forged), /F2_ORIGINS/);
    await assert.rejects(
      withCuratorTransaction(curator, client =>
        persistF2ActuacaoCnaeOrigins(client, actor, forged, F2_ACTUACAO_SOURCE_SHA256)),
      /F2_ORIGINS/,
    );
    const zero = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM taxonomy_release_actuacao_cnae_origins WHERE release_id = $1::uuid',
      [releaseId],
    );
    assert.equal(zero.rows[0]?.n, 0);

    // A curator may persist an explicitly sourced row, and PostgreSQL keeps
    // both the release and the referenced concept identity consistent.
    await withCuratorTransaction(curator, async client => {
      const target = await client.query<{ id: string }>(
        "SELECT rc.id FROM taxonomy_release_concepts rc JOIN taxonomy_concepts c ON c.id = rc.concept_id WHERE rc.release_id = $1::uuid AND c.code = 'actuacao.servico'",
        [releaseId],
      );
      assert.equal(target.rows.length, 1);
      const inserted = await client.query<{ cnae_code: string }>(
        'INSERT INTO taxonomy_release_actuacao_cnae_origins (release_id, release_concept_id, cnae_code, source_line, source_sha256) VALUES ($1::uuid, $2::uuid, $3, 2, $4) RETURNING cnae_code',
        [releaseId, target.rows[0]!.id, '0111301', F2_ACTUACAO_SOURCE_SHA256],
      );
      assert.deepEqual(inserted.rows.map(row => row.cnae_code), ['0111301']);
    });
    const one = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM taxonomy_release_actuacao_cnae_origins WHERE release_id = $1::uuid',
      [releaseId],
    );
    assert.equal(one.rows[0]?.n, 1);

    await admin.query(
      "UPDATE taxonomy_releases SET status = 'PUBLISHED', approved_at = now(), published_at = now(), artifact_repository = 'test', artifact_path = 'f2-t02', artifact_git_sha = $2, artifact_sha256 = $3 WHERE id = $1::uuid",
      [releaseId, '0'.repeat(40), '0'.repeat(64)],
    );
    await assert.rejects(
      withCuratorTransaction(curator, client => client.query(
        'DELETE FROM taxonomy_release_actuacao_cnae_origins WHERE release_id = $1::uuid',
        [releaseId],
      )),
      /immutable/,
      'Published provenance cannot be altered by curator',
    );
  } finally {
    await curator.end();
    await admin.end();
  }
});

test('F2-T03: XLSX into isolated PG18 and second pass with zero changes', async () => {
  if (new URL(adminUrl).pathname !== '/radar_fiscal_test') {
    throw new Error('This integration test requires the isolated radar_fiscal_test database');
  }
  const previous = process.env.F2_IMPORT_SCOPE;
  process.env.F2_IMPORT_SCOPE = 'ISOLATED_POSTGRES18_ONLY';
  try {
    await import('./f2-t03-xlsx-pg18-double.integration.mjs');
  } finally {
    if (previous === undefined) delete process.env.F2_IMPORT_SCOPE;
    else process.env.F2_IMPORT_SCOPE = previous;
  }
});
