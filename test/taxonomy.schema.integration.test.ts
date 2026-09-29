import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

function code(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

test('taxonomy core schema enforces identity, revisions and release lifecycle', async (t) => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required');

  const pool = new Pool({ connectionString: adminUrl, max: 1 });

  try {
    const dimensionId = randomUUID();
    const otherDimensionId = randomUUID();
    const dimensionRevisionId = randomUUID();
    const otherDimensionRevisionId = randomUUID();
    const releaseId = randomUUID();
    const otherReleaseId = randomUUID();
    const conceptId = randomUUID();
    const otherConceptId = randomUUID();
    const conceptRevisionId = randomUUID();
    const otherConceptRevisionId = randomUUID();

    const dimensionCode = code('taxdim');
    const otherDimensionCode = code('otherdim');
    const conceptCode = `${dimensionCode}.concept`;
    const otherConceptCode = `${otherDimensionCode}.concept`;

    await pool.query(
      `
        INSERT INTO taxonomy_dimensions (id, code)
        VALUES ($1, $2), ($3, $4)
      `,
      [dimensionId, dimensionCode, otherDimensionId, otherDimensionCode],
    );

    await pool.query(
      `
        INSERT INTO taxonomy_dimension_revisions (
          id, dimension_id, revision_no, name
        )
        VALUES
          ($1, $2, 1, 'Dimension Test'),
          ($3, $4, 1, 'Other Dimension Test')
      `,
      [
        dimensionRevisionId,
        dimensionId,
        otherDimensionRevisionId,
        otherDimensionId,
      ],
    );

    await pool.query(
      `
        INSERT INTO taxonomy_releases (
          id,
          version_major,
          version_minor,
          version_patch,
          created_by_actor
        )
        VALUES
          ($1, 90, 0, 1, 'taxonomy-test'),
          ($2, 90, 0, 2, 'taxonomy-test')
      `,
      [releaseId, otherReleaseId],
    );

    await pool.query(
      `
        INSERT INTO taxonomy_release_dimensions (
          release_id,
          dimension_id,
          dimension_revision_id
        )
        VALUES ($1, $2, $3)
      `,
      [releaseId, dimensionId, dimensionRevisionId],
    );

    await pool.query(
      `
        INSERT INTO taxonomy_concepts (id, code, dimension_id)
        VALUES ($1, $2, $3), ($4, $5, $6)
      `,
      [
        conceptId,
        conceptCode,
        dimensionId,
        otherConceptId,
        otherConceptCode,
        otherDimensionId,
      ],
    );

    await pool.query(
      `
        INSERT INTO taxonomy_concept_revisions (
          id,
          concept_id,
          revision_no,
          label,
          definition,
          evidence_status
        )
        VALUES
          ($1, $2, 1, 'Concept Test', 'Definition', 'NEEDS_EVIDENCE'),
          ($3, $4, 1, 'Other Concept Test', 'Other Definition', 'DOCUMENTED')
      `,
      [
        conceptRevisionId,
        conceptId,
        otherConceptRevisionId,
        otherConceptId,
      ],
    );

    await t.test('semver uniqueness is enforced', async () => {
      await assert.rejects(
        pool.query(
          `
            INSERT INTO taxonomy_releases (
              version_major,
              version_minor,
              version_patch,
              created_by_actor
            )
            VALUES (90, 0, 1, 'duplicate-test')
          `,
        ),
      );
    });

    await t.test('dimension code is unique and immutable', async () => {
      await assert.rejects(
        pool.query(
          `
            INSERT INTO taxonomy_dimensions (code)
            VALUES ($1)
          `,
          [dimensionCode],
        ),
      );

      await assert.rejects(
        pool.query(
          `
            UPDATE taxonomy_dimensions
            SET code = $2
            WHERE id = $1
          `,
          [dimensionId, code('changed')],
        ),
        /immutable/,
      );
    });

    await t.test('concept code and dimension are immutable', async () => {
      await assert.rejects(
        pool.query(
          `
            INSERT INTO taxonomy_concepts (code, dimension_id)
            VALUES ($1, $2)
          `,
          [conceptCode, dimensionId],
        ),
      );

      await assert.rejects(
        pool.query(
          `
            UPDATE taxonomy_concepts
            SET code = $2
            WHERE id = $1
          `,
          [conceptId, `${dimensionCode}.changed`],
        ),
        /immutable/,
      );

      await assert.rejects(
        pool.query(
          `
            UPDATE taxonomy_concepts
            SET dimension_id = $2
            WHERE id = $1
          `,
          [conceptId, otherDimensionId],
        ),
        /immutable/,
      );
    });

    await t.test('revisions are append-only and identity-safe', async () => {
      await assert.rejects(
        pool.query(
          `
            UPDATE taxonomy_concept_revisions
            SET label = 'Changed'
            WHERE id = $1
          `,
          [conceptRevisionId],
        ),
        /append-only/,
      );

      await assert.rejects(
        pool.query(
          `
            INSERT INTO taxonomy_release_concepts (
              release_id,
              concept_id,
              concept_revision_id
            )
            VALUES ($1, $2, $3)
          `,
          [releaseId, conceptId, otherConceptRevisionId],
        ),
      );
    });

    await t.test(
      'concept dimension must belong to the same release',
      async () => {
        await assert.rejects(
          pool.query(
            `
              INSERT INTO taxonomy_release_concepts (
                release_id,
                concept_id,
                concept_revision_id
              )
              VALUES ($1, $2, $3)
            `,
            [releaseId, otherConceptId, otherConceptRevisionId],
          ),
          /dimension must belong/,
        );
      },
    );

    await t.test(
      'NEEDS_EVIDENCE is representable without evidence rows',
      async () => {
        const result = await pool.query<{
          evidence_status: string;
          evidence_count: string;
        }>(
          `
            SELECT
              cr.evidence_status,
              count(cre.id)::text AS evidence_count
            FROM taxonomy_concept_revisions cr
            LEFT JOIN taxonomy_concept_revision_evidence cre
              ON cre.concept_revision_id = cr.id
            WHERE cr.id = $1
            GROUP BY cr.evidence_status
          `,
          [conceptRevisionId],
        );

        assert.equal(result.rows[0]?.evidence_status, 'NEEDS_EVIDENCE');
        assert.equal(result.rows[0]?.evidence_count, '0');
      },
    );

    await pool.query(
      `
        INSERT INTO taxonomy_release_concepts (
          release_id,
          concept_id,
          concept_revision_id
        )
        VALUES ($1, $2, $3)
      `,
      [releaseId, conceptId, conceptRevisionId],
    );

    await t.test('release membership is unique', async () => {
      await assert.rejects(
        pool.query(
          `
            INSERT INTO taxonomy_release_concepts (
              release_id,
              concept_id,
              concept_revision_id
            )
            VALUES ($1, $2, $3)
          `,
          [releaseId, conceptId, conceptRevisionId],
        ),
      );
    });

    await t.test('release ancestry rejects self/cycle', async () => {
      await assert.rejects(
        pool.query(
          `
            UPDATE taxonomy_releases
            SET previous_release_id = id
            WHERE id = $1
          `,
          [releaseId],
        ),
        /cannot reference itself/,
      );

      await pool.query(
        `
          UPDATE taxonomy_releases
          SET previous_release_id = $1
          WHERE id = $2
        `,
        [releaseId, otherReleaseId],
      );

      await assert.rejects(
        pool.query(
          `
            UPDATE taxonomy_releases
            SET previous_release_id = $1
            WHERE id = $2
          `,
          [otherReleaseId, releaseId],
        ),
        /cycle/,
      );
    });

    await t.test(
      'published snapshot is immutable and withdrawal is governed',
      async () => {
        await pool.query(
          `
            UPDATE taxonomy_releases
            SET
              status = 'PUBLISHED',
              approved_at = now(),
              published_at = now(),
              artifact_repository = 'test/repo',
              artifact_path = 'taxonomy.md',
              artifact_git_sha = repeat('a', 40),
              artifact_sha256 = repeat('b', 64)
            WHERE id = $1
          `,
          [releaseId],
        );

        await assert.rejects(
          pool.query(
            `
              INSERT INTO taxonomy_release_dimensions (
                release_id,
                dimension_id,
                dimension_revision_id
              )
              VALUES ($1, $2, $3)
            `,
            [releaseId, otherDimensionId, otherDimensionRevisionId],
          ),
          /snapshot is immutable/,
        );

        await assert.rejects(
          pool.query(
            `
              UPDATE taxonomy_releases
              SET change_notes = 'silent rewrite'
              WHERE id = $1
            `,
            [releaseId],
          ),
          /only allows PUBLISHED -> WITHDRAWN/,
        );

        await pool.query(
          `
            UPDATE taxonomy_releases
            SET
              status = 'WITHDRAWN',
              withdrawn_at = now(),
              withdrawn_by_actor = 'taxonomy-test',
              withdrawal_reason = 'integration test'
            WHERE id = $1
          `,
          [releaseId],
        );

        await assert.rejects(
          pool.query(
            `
              UPDATE taxonomy_releases
              SET withdrawal_reason = 'changed'
              WHERE id = $1
            `,
            [releaseId],
          ),
          /immutable/,
        );

        await assert.rejects(
          pool.query(
            `
              DELETE FROM taxonomy_releases
              WHERE id = $1
            `,
            [releaseId],
          ),
          /cannot be deleted/,
        );
      },
    );
  } finally {
    await pool.end();
  }
});
