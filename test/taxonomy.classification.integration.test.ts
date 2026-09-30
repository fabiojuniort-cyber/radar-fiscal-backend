import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

import {
  classifyPublicationVersionLexically,
} from '../src/modules/taxonomy/classification/classification.repository.js';

function hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

test('TAX-07 classification schema preserves lineage, release scope and idempotency', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required');
  const pool = new Pool({ connectionString: adminUrl, max: 2 });

  try {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const versionMajor = 970000 + Number.parseInt(suffix.slice(0, 4), 16) % 10000;

    const publicationId = randomUUID();
    const publicationVersionId = randomUUID();
    await pool.query(
      `
        INSERT INTO publications (
          id, identity_hash, identity_strength, identity_basis,
          jurisdiction_level, title
        )
        VALUES ($1, $2, 'SOURCE_SCOPED', '{}'::jsonb, 'FEDERAL', 'Teste ICMS')
      `,
      [publicationId, hex('pub-' + suffix)],
    );
    await pool.query(
      `
        INSERT INTO publication_versions (
          id, publication_id, version_no, content_hash, content_text
        )
        VALUES ($1, $2, 1, $3, 'ICMS e substituição tributária')
      `,
      [publicationVersionId, publicationId, hex('content-' + suffix)],
    );

    const dimensionId = randomUUID();
    const dimensionRevisionId = randomUUID();
    const conceptAId = randomUUID();
    const conceptARevisionId = randomUUID();
    const conceptBId = randomUUID();
    const conceptBRevisionId = randomUUID();
    const releaseId = randomUUID();
    const draftReleaseId = randomUUID();

    await pool.query(
      `INSERT INTO taxonomy_dimensions (id, code) VALUES ($1, $2)`,
      [dimensionId, 'class_' + suffix],
    );
    await pool.query(
      `
        INSERT INTO taxonomy_dimension_revisions (
          id, dimension_id, revision_no, name
        ) VALUES ($1, $2, 1, 'Classification Test')
      `,
      [dimensionRevisionId, dimensionId],
    );
    await pool.query(
      `
        INSERT INTO taxonomy_concepts (id, code, dimension_id)
        VALUES
          ($1, $2, $5),
          ($3, $4, $5)
      `,
      [
        conceptAId,
        'class_' + suffix + '.icms',
        conceptBId,
        'class_' + suffix + '.st',
        dimensionId,
      ],
    );
    await pool.query(
      `
        INSERT INTO taxonomy_concept_revisions (
          id, concept_id, revision_no, label, definition
        )
        VALUES
          ($1, $2, 1, 'ICMS', 'ICMS test'),
          ($3, $4, 1, 'Substituição tributária', 'ST test')
      `,
      [conceptARevisionId, conceptAId, conceptBRevisionId, conceptBId],
    );

    for (const [id, patch] of [[releaseId, 1], [draftReleaseId, 2]] as const) {
      await pool.query(
        `
          INSERT INTO taxonomy_releases (
            id, version_major, version_minor, version_patch, created_by_actor
          ) VALUES ($1, $2, 0, $3, 'tax07-test')
        `,
        [id, versionMajor, patch],
      );
      await pool.query(
        `
          INSERT INTO taxonomy_release_dimensions (
            release_id, dimension_id, dimension_revision_id
          ) VALUES ($1, $2, $3)
        `,
        [id, dimensionId, dimensionRevisionId],
      );
      await pool.query(
        `
          INSERT INTO taxonomy_release_concepts (
            release_id, concept_id, concept_revision_id
          )
          VALUES
            ($1, $2, $4),
            ($1, $3, $5)
        `,
        [id, conceptAId, conceptBId, conceptARevisionId, conceptBRevisionId],
      );
    }

    const releaseConcepts = await pool.query<{
      id: string;
      concept_id: string;
      release_id: string;
    }>(
      `
        SELECT id, concept_id, release_id
        FROM taxonomy_release_concepts
        WHERE release_id = ANY($1::uuid[])
      `,
      [[releaseId, draftReleaseId]],
    );
    const rc = (release: string, concept: string) =>
      releaseConcepts.rows.find(
        (row) => row.release_id === release && row.concept_id === concept,
      )!.id;

    await pool.query(
      `
        UPDATE taxonomy_releases
        SET status='PUBLISHED',
            approved_at=now(),
            published_at=now(),
            artifact_repository='test/repo',
            artifact_path='tax07.json',
            artifact_git_sha=$2,
            artifact_sha256=$3
        WHERE id=$1
      `,
      [releaseId, 'a'.repeat(40), 'b'.repeat(64)],
    );

    await assert.rejects(
      pool.query(
        `
          INSERT INTO publication_taxonomy_runs (
            publication_version_id, taxonomy_release_id, method_type,
            engine_key, engine_version, config_snapshot, config_sha256,
            input_sha256, run_fingerprint, status, started_at
          )
          VALUES ($1,$2,'RULE','test','1','{}',$3,$4,$5,'RUNNING',now())
        `,
        [
          publicationVersionId,
          draftReleaseId,
          hex('{}'),
          hex('input'),
          hex('draft-run'),
        ],
      ),
      /PUBLISHED/,
    );

    const run1 = randomUUID();
    await pool.query(
      `
        INSERT INTO publication_taxonomy_runs (
          id, publication_version_id, taxonomy_release_id, method_type,
          engine_key, engine_version, config_snapshot, config_sha256,
          input_sha256, run_fingerprint, status, started_at
        )
        VALUES ($1,$2,$3,'RULE','test','1','{}',$4,$5,$6,'RUNNING',now())
      `,
      [run1, publicationVersionId, releaseId, hex('{}'), hex('input-1'), hex('run-1-' + suffix)],
    );

    await assert.rejects(
      pool.query(
        `UPDATE publication_taxonomy_runs SET engine_version='2' WHERE id=$1`,
        [run1],
      ),
      /material identity is immutable/,
    );

    await pool.query(
      `
        UPDATE publication_taxonomy_runs
        SET status='SUCCESS', finished_at=now()
        WHERE id=$1
      `,
      [run1],
    );

    const assertion1 = randomUUID();
    await pool.query(
      `
        INSERT INTO publication_taxonomy_assertions (
          id, run_id, taxonomy_release_id, release_concept_id,
          assertion_status, confidence, decision_origin
        )
        VALUES ($1,$2,$3,$4,'CONFIRMED',0.9,'TEST')
      `,
      [assertion1, run1, releaseId, rc(releaseId, conceptAId)],
    );

    await assert.rejects(
      pool.query(
        `
          UPDATE publication_taxonomy_assertions
          SET reason_code='rewrite'
          WHERE id=$1
        `,
        [assertion1],
      ),
      /append-only/,
    );

    await assert.rejects(
      pool.query(
        `
          INSERT INTO publication_taxonomy_assertions (
            run_id, taxonomy_release_id, release_concept_id,
            assertion_status, decision_origin
          )
          VALUES ($1,$2,$3,'CONFIRMED','TEST')
        `,
        [run1, releaseId, rc(draftReleaseId, conceptBId)],
      ),
    );

    const run2 = randomUUID();
    await pool.query(
      `
        INSERT INTO publication_taxonomy_runs (
          id, publication_version_id, taxonomy_release_id, method_type,
          engine_key, engine_version, config_snapshot, config_sha256,
          input_sha256, run_fingerprint, status, started_at, finished_at
        )
        VALUES ($1,$2,$3,'HUMAN','human','1','{}',$4,$5,$6,'SUCCESS',now(),now())
      `,
      [run2, publicationVersionId, releaseId, hex('{}'), hex('input-2'), hex('run-2-' + suffix)],
    );

    const assertion2 = randomUUID();
    await pool.query(
      `
        INSERT INTO publication_taxonomy_assertions (
          id, run_id, taxonomy_release_id, release_concept_id,
          supersedes_assertion_id, assertion_status, decision_origin
        )
        VALUES ($1,$2,$3,$4,$5,'CONFIRMED','HUMAN')
      `,
      [assertion2, run2, releaseId, rc(releaseId, conceptBId), assertion1],
    );

    let effective = await pool.query<{ assertion_id: string }>(
      `
        SELECT assertion_id
        FROM v_publication_taxonomy_effective_assertions
        WHERE publication_version_id=$1 AND taxonomy_release_id=$2
      `,
      [publicationVersionId, releaseId],
    );
    assert.deepEqual(effective.rows.map((row) => row.assertion_id), [assertion2]);

    const reviewId = randomUUID();
    await pool.query(
      `
        INSERT INTO publication_taxonomy_reviews (
          id, assertion_id, decision, reviewer_actor_id, rationale
        )
        VALUES ($1,$2,'REJECT','reviewer','test rejection')
      `,
      [reviewId, assertion2],
    );

    await assert.rejects(
      pool.query(
        `UPDATE publication_taxonomy_reviews SET rationale='rewrite' WHERE id=$1`,
        [reviewId],
      ),
      /append-only/,
    );

    effective = await pool.query<{ assertion_id: string }>(
      `
        SELECT assertion_id
        FROM v_publication_taxonomy_effective_assertions
        WHERE publication_version_id=$1 AND taxonomy_release_id=$2
      `,
      [publicationVersionId, releaseId],
    );
    assert.deepEqual(effective.rows.map((row) => row.assertion_id), [assertion1]);

    const first = await classifyPublicationVersionLexically(pool, {
      publicationVersionId,
      taxonomyReleaseId: releaseId,
      codeGitSha: 'c'.repeat(40),
    });
    const second = await classifyPublicationVersionLexically(pool, {
      publicationVersionId,
      taxonomyReleaseId: releaseId,
      codeGitSha: 'c'.repeat(40),
    });

    assert.equal(first.disposition, 'CREATED');
    assert.equal(first.status, 'SUCCESS');
    assert.equal(first.assertionCount, 2);
    assert.equal(second.disposition, 'EXISTING');
    assert.equal(second.runId, first.runId);
    assert.equal(second.runFingerprint, first.runFingerprint);
  } finally {
    await pool.end();
  }
});
