import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

function suffix(): string {
  return randomUUID().replaceAll('-', '').slice(0, 12);
}

test('taxonomy aliases, relations and catalogs enforce scoped integrity', async (t) => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required');

  const pool = new Pool({ connectionString: adminUrl, max: 1 });
  const seed = suffix();
  const versionBase =
    700000 + Number.parseInt(seed.slice(0, 5), 16) % 100000;

  const dimensionId = randomUUID();
  const otherDimensionId = randomUUID();
  const dimensionRevisionId = randomUUID();
  const otherDimensionRevisionId = randomUUID();
  const releaseAId = randomUUID();
  const releaseBId = randomUUID();

  const conceptIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const revisionIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const memberIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const memberBId = randomUUID();

  try {
    await pool.query(
      `
        INSERT INTO taxonomy_dimensions (id, code)
        VALUES ($1, $2), ($3, $4)
      `,
      [
        dimensionId,
        `rel_${seed}`,
        otherDimensionId,
        `rel_other_${seed}`,
      ],
    );

    await pool.query(
      `
        INSERT INTO taxonomy_dimension_revisions (
          id, dimension_id, revision_no, name
        )
        VALUES
          ($1, $2, 1, 'Relation Dimension'),
          ($3, $4, 1, 'Relation Other Dimension')
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
          id, version_major, version_minor, version_patch, created_by_actor
        )
        VALUES
          ($1, $3, 0, 1, 'relations-test'),
          ($2, $3, 0, 2, 'relations-test')
      `,
      [releaseAId, releaseBId, versionBase],
    );

    for (const releaseId of [releaseAId, releaseBId]) {
      await pool.query(
        `
          INSERT INTO taxonomy_release_dimensions (
            release_id, dimension_id, dimension_revision_id
          )
          VALUES ($1, $2, $3), ($1, $4, $5)
        `,
        [
          releaseId,
          dimensionId,
          dimensionRevisionId,
          otherDimensionId,
          otherDimensionRevisionId,
        ],
      );
    }

    for (let index = 0; index < conceptIds.length; index += 1) {
      const dim = index === 3 ? otherDimensionId : dimensionId;
      await pool.query(
        `
          INSERT INTO taxonomy_concepts (id, code, dimension_id)
          VALUES ($1, $2, $3)
        `,
        [
          conceptIds[index],
          `${index === 3 ? 'rel_other' : 'rel'}_${seed}.c${index}`,
          dim,
        ],
      );

      await pool.query(
        `
          INSERT INTO taxonomy_concept_revisions (
            id, concept_id, revision_no, label, definition
          )
          VALUES ($1, $2, 1, $3, 'Relation test concept')
        `,
        [revisionIds[index], conceptIds[index], `Concept ${index}`],
      );

      await pool.query(
        `
          INSERT INTO taxonomy_release_concepts (
            id, release_id, concept_id, concept_revision_id
          )
          VALUES ($1, $2, $3, $4)
        `,
        [
          memberIds[index],
          releaseAId,
          conceptIds[index],
          revisionIds[index],
        ],
      );
    }

    await pool.query(
      `
        INSERT INTO taxonomy_release_concepts (
          id, release_id, concept_id, concept_revision_id
        )
        VALUES ($1, $2, $3, $4)
      `,
      [memberBId, releaseBId, conceptIds[0], revisionIds[0]],
    );

    const aliasId = randomUUID();
    await pool.query(
      `
        INSERT INTO taxonomy_aliases (id, text, normalized_text)
        VALUES ($1, $2, $3)
      `,
      [aliasId, `Alias ${seed}`, `alias ${seed}`],
    );

    await t.test('alias binding rejects cross-release target', async () => {
      await assert.rejects(
        pool.query(
          `
            INSERT INTO taxonomy_release_alias_bindings (
              release_id, alias_id, release_concept_id, alias_type
            )
            VALUES ($1, $2, $3, 'AMBIGUOUS')
          `,
          [releaseAId, aliasId, memberBId],
        ),
      );

      await pool.query(
        `
          INSERT INTO taxonomy_release_alias_bindings (
            release_id, alias_id, release_concept_id, alias_type
          )
          VALUES ($1, $2, $3, 'AMBIGUOUS')
        `,
        [releaseAId, aliasId, memberIds[0]],
      );
    });

    const relationTypeId = randomUUID();
    await pool.query(
      `
        INSERT INTO taxonomy_relation_types (
          id, code, directed, acyclic, hierarchical, canonical_storage_code
        )
        VALUES ($1, $2, true, true, true, $2)
      `,
      [relationTypeId, `narrower_${seed}`],
    );

    await pool.query(
      `
        INSERT INTO taxonomy_release_relation_rules (
          release_id,
          relation_type_id,
          source_dimension_id,
          target_dimension_id,
          allowed
        )
        VALUES ($1, $2, $3, $3, true)
      `,
      [releaseAId, relationTypeId, dimensionId],
    );

    await t.test('relation rejects cross-release endpoint', async () => {
      await assert.rejects(
        pool.query(
          `
            INSERT INTO taxonomy_concept_relations (
              release_id,
              source_release_concept_id,
              target_release_concept_id,
              relation_type_id
            )
            VALUES ($1, $2, $3, $4)
          `,
          [releaseAId, memberIds[0], memberBId, relationTypeId],
        ),
      );
    });

    await t.test('relation rejects self-loop', async () => {
      await assert.rejects(
        pool.query(
          `
            INSERT INTO taxonomy_concept_relations (
              release_id,
              source_release_concept_id,
              target_release_concept_id,
              relation_type_id
            )
            VALUES ($1, $2, $2, $3)
          `,
          [releaseAId, memberIds[0], relationTypeId],
        ),
      );
    });

    await t.test('relation requires compatible dimension rule', async () => {
      await assert.rejects(
        pool.query(
          `
            INSERT INTO taxonomy_concept_relations (
              release_id,
              source_release_concept_id,
              target_release_concept_id,
              relation_type_id
            )
            VALUES ($1, $2, $3, $4)
          `,
          [releaseAId, memberIds[0], memberIds[3], relationTypeId],
        ),
        /not allowed/,
      );
    });

    await t.test(
      'deferred acyclic trigger rejects A-B-C-A at commit',
      async () => {
        const client = await pool.connect();

        try {
          await client.query('BEGIN');

          await client.query(
            `
              INSERT INTO taxonomy_concept_relations (
                release_id,
                source_release_concept_id,
                target_release_concept_id,
                relation_type_id
              )
              VALUES
                ($1, $2, $3, $5),
                ($1, $3, $4, $5),
                ($1, $4, $2, $5)
            `,
            [
              releaseAId,
              memberIds[0],
              memberIds[1],
              memberIds[2],
              relationTypeId,
            ],
          );

          await assert.rejects(
            client.query('COMMIT'),
            /would form a cycle/,
          );

          await client.query('ROLLBACK');
        } finally {
          client.release();
        }
      },
    );

    await pool.query(
      `
        INSERT INTO taxonomy_concept_relations (
          release_id,
          source_release_concept_id,
          target_release_concept_id,
          relation_type_id
        )
        VALUES ($1, $2, $3, $4), ($1, $3, $5, $4)
      `,
      [
        releaseAId,
        memberIds[0],
        memberIds[1],
        relationTypeId,
        memberIds[2],
      ],
    );

    await t.test('evidence links use real foreign keys', async () => {
      const evidenceId = randomUUID();

      await pool.query(
        `
          INSERT INTO taxonomy_evidence (
            id, basis_type, maintainer
          )
          VALUES ($1, 'TRIBUSCA', 'TriBusca')
        `,
        [evidenceId],
      );

      await assert.rejects(
        pool.query(
          `
            INSERT INTO taxonomy_concept_revision_evidence (
              concept_revision_id, evidence_id, role
            )
            VALUES ($1, $2, 'PRIMARY')
          `,
          [randomUUID(), evidenceId],
        ),
      );

      await pool.query(
        `
          INSERT INTO taxonomy_concept_revision_evidence (
            concept_revision_id, evidence_id, role
          )
          VALUES ($1, $2, 'PRIMARY')
        `,
        [revisionIds[0], evidenceId],
      );
    });

    const catalogId = randomUUID();
    const editionAId = randomUUID();
    const editionBId = randomUUID();
    const entryAId = randomUUID();
    const entryBId = randomUUID();

    await pool.query(
      `
        INSERT INTO official_catalogs (id, code, name, maintainer)
        VALUES ($1, $2, 'Catalog Test', 'Maintainer Test')
      `,
      [catalogId, `CAT_${seed.toUpperCase()}`],
    );

    await pool.query(
      `
        INSERT INTO official_catalog_editions (
          id, catalog_id, edition_code
        )
        VALUES ($1, $3, '2026-A'), ($2, $3, '2026-B')
      `,
      [editionAId, editionBId, catalogId],
    );

    await pool.query(
      `
        INSERT INTO official_catalog_entries (
          id, catalog_edition_id, official_code, description
        )
        VALUES
          ($1, $3, '001', 'Entry A'),
          ($2, $4, '001', 'Entry B')
      `,
      [entryAId, entryBId, editionAId, editionBId],
    );

    await t.test('official code is scoped to catalog edition', async () => {
      await assert.rejects(
        pool.query(
          `
            INSERT INTO official_catalog_entries (
              catalog_edition_id, official_code, description
            )
            VALUES ($1, '001', 'Duplicate')
          `,
          [editionAId],
        ),
      );

      const sameCode = await pool.query(
        `
          SELECT id
          FROM official_catalog_entries
          WHERE official_code = '001'
            AND catalog_edition_id = ANY($1::uuid[])
        `,
        [[editionAId, editionBId]],
      );

      assert.equal(sameCode.rowCount, 2);
    });

    await t.test('parent entry must belong to same edition', async () => {
      await assert.rejects(
        pool.query(
          `
            INSERT INTO official_catalog_entries (
              catalog_edition_id,
              official_code,
              description,
              parent_entry_id
            )
            VALUES ($1, '002', 'Cross edition child', $2)
          `,
          [editionBId, entryAId],
        ),
      );
    });

    await t.test('official mapping rejects cross-release concept', async () => {
      await assert.rejects(
        pool.query(
          `
            INSERT INTO taxonomy_official_mappings (
              release_id,
              release_concept_id,
              official_catalog_entry_id,
              mapping_type
            )
            VALUES ($1, $2, $3, 'EXACT')
          `,
          [releaseAId, memberBId, entryAId],
        ),
      );

      await pool.query(
        `
          INSERT INTO taxonomy_official_mappings (
            release_id,
            release_concept_id,
            official_catalog_entry_id,
            mapping_type
          )
          VALUES ($1, $2, $3, 'CONCEPT_BROADER_THAN_ENTRY')
        `,
        [releaseAId, memberIds[0], entryAId],
      );
    });
  } finally {
    await pool.end();
  }
});
