import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Pool, type PoolClient } from 'pg';

import { DIMENSIONS } from '../src/modules/taxonomy/baseline/baseline.constants.js';
import {
  createTaxonomyV11DraftInTransaction,
  dryRunTaxonomyV11Successor,
  publishTaxonomyV11InTransaction,
} from '../src/modules/taxonomy/release/taxonomy-successor-v1-1.database.js';
import { RETIRED_DIMENSION_CODES } from '../src/modules/taxonomy/release/taxonomy-successor-v1-1.js';

const databaseUrl = process.env.DATABASE_ADMIN_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_ADMIN_URL is required for taxonomy v1.1 integration test.');
}

async function insertFixtureSource(client: PoolClient): Promise<{
  releaseId: string;
  firstConceptByDimension: Map<string, string>;
}> {
  const release = await client.query<{ id: string }>(`
    INSERT INTO taxonomy_releases (
      version_major, version_minor, version_patch,
      status, manifest, change_notes, created_by_actor
    ) VALUES (
      1, 0, 0,
      'DRAFT', '{"fixture":"tax-10"}'::jsonb,
      'TAX-10 integration fixture', 'tax-10-integration-test'
    ) RETURNING id
  `);
  const releaseId = release.rows[0]?.id;
  if (!releaseId) throw new Error('fixture release insert failed');

  const firstConceptByDimension = new Map<string, string>();
  const dimensionIds = new Map<string, string>();

  for (const [dimensionCode, dimensionName, conceptCount] of DIMENSIONS) {
    const dimension = await client.query<{ id: string }>(
      `INSERT INTO taxonomy_dimensions (code, identity_status)
       VALUES ($1, 'CURRENT') RETURNING id`,
      [dimensionCode],
    );
    const dimensionId = dimension.rows[0]?.id;
    if (!dimensionId) throw new Error('fixture dimension insert failed');
    dimensionIds.set(dimensionCode, dimensionId);

    const dimensionRevision = await client.query<{ id: string }>(
      `INSERT INTO taxonomy_dimension_revisions (
         dimension_id, revision_no, name, governance_status, constraints
       ) VALUES ($1::uuid, 1, $2, 'APPROVED', '{}'::jsonb)
       RETURNING id`,
      [dimensionId, dimensionName],
    );
    const dimensionRevisionId = dimensionRevision.rows[0]?.id;
    if (!dimensionRevisionId) throw new Error('fixture dimension revision failed');

    await client.query(
      `INSERT INTO taxonomy_release_dimensions (
         release_id, dimension_id, dimension_revision_id, membership_status
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'INCLUDED')`,
      [releaseId, dimensionId, dimensionRevisionId],
    );

    for (let index = 1; index <= conceptCount; index += 1) {
      const suffix = String(index).padStart(3, '0');
      const conceptCode = `${dimensionCode}.tax10_fixture_${suffix}`;
      const concept = await client.query<{ id: string }>(
        `INSERT INTO taxonomy_concepts (
           code, dimension_id, identity_status
         ) VALUES ($1, $2::uuid, 'CURRENT')
         RETURNING id`,
        [conceptCode, dimensionId],
      );
      const conceptId = concept.rows[0]?.id;
      if (!conceptId) throw new Error('fixture concept insert failed');

      const conceptRevision = await client.query<{ id: string }>(
        `INSERT INTO taxonomy_concept_revisions (
           concept_id, revision_no, label, definition,
           governance_status, evidence_status, source_metadata
         ) VALUES (
           $1::uuid, 1, $2, $3,
           'APPROVED', 'DOCUMENTED', '{"fixture":"tax-10"}'::jsonb
         ) RETURNING id`,
        [
          conceptId,
          `${dimensionName} ${suffix}`,
          `TAX-10 fixture concept ${conceptCode}`,
        ],
      );
      const conceptRevisionId = conceptRevision.rows[0]?.id;
      if (!conceptRevisionId) throw new Error('fixture concept revision failed');

      const releaseConcept = await client.query<{ id: string }>(
        `INSERT INTO taxonomy_release_concepts (
           release_id, concept_id, concept_revision_id, membership_status
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'INCLUDED')
         RETURNING id`,
        [releaseId, conceptId, conceptRevisionId],
      );
      const releaseConceptId = releaseConcept.rows[0]?.id;
      if (!releaseConceptId) throw new Error('fixture release concept failed');
      if (index === 1) {
        firstConceptByDimension.set(dimensionCode, releaseConceptId);
      }
    }
  }

  const retainedConcept = firstConceptByDimension.get('theme');
  const retainedTargetConcept = firstConceptByDimension.get('subject');
  const retiredConcept = firstConceptByDimension.get('event');
  if (!retainedConcept || !retainedTargetConcept || !retiredConcept) {
    throw new Error('fixture concept references unavailable');
  }

  const aliasRetained = await client.query<{ id: string }>(
    `INSERT INTO taxonomy_aliases (text, normalized_text, language)
     VALUES ('TAX10 retained', 'tax10 retained', 'pt-BR') RETURNING id`,
  );
  const aliasRetired = await client.query<{ id: string }>(
    `INSERT INTO taxonomy_aliases (text, normalized_text, language)
     VALUES ('TAX10 retired', 'tax10 retired', 'pt-BR') RETURNING id`,
  );

  const bindingRetained = await client.query<{ id: string }>(
    `INSERT INTO taxonomy_release_alias_bindings (
       release_id, alias_id, release_concept_id,
       alias_type, decision_status, evidence_status
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'SEARCH_RELATED', 'APPROVED', 'DOCUMENTED')
     RETURNING id`,
    [releaseId, aliasRetained.rows[0]!.id, retainedConcept],
  );
  const bindingRetired = await client.query<{ id: string }>(
    `INSERT INTO taxonomy_release_alias_bindings (
       release_id, alias_id, release_concept_id,
       alias_type, decision_status, evidence_status
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'SEARCH_RELATED', 'APPROVED', 'DOCUMENTED')
     RETURNING id`,
    [releaseId, aliasRetired.rows[0]!.id, retiredConcept],
  );

  const relationType = await client.query<{ id: string }>(`
    INSERT INTO taxonomy_relation_types (
      code, directed, acyclic, hierarchical,
      canonical_storage_code, description
    ) VALUES (
      'tax10_fixture_related', true, false, false,
      'tax10_fixture_related', 'TAX-10 integration relation'
    ) RETURNING id
  `);
  const relationTypeId = relationType.rows[0]!.id;
  const themeDimensionId = dimensionIds.get('theme')!;
  const subjectDimensionId = dimensionIds.get('subject')!;
  const eventDimensionId = dimensionIds.get('event')!;

  await client.query(
    `INSERT INTO taxonomy_release_relation_rules (
       release_id, relation_type_id,
       source_dimension_id, target_dimension_id,
       allowed, requires_evidence
     ) VALUES
       ($1::uuid, $2::uuid, $3::uuid, $4::uuid, true, true),
       ($1::uuid, $2::uuid, $3::uuid, $5::uuid, true, true)`,
    [
      releaseId,
      relationTypeId,
      themeDimensionId,
      subjectDimensionId,
      eventDimensionId,
    ],
  );

  const relationRetained = await client.query<{ id: string }>(
    `INSERT INTO taxonomy_concept_relations (
       release_id, source_release_concept_id,
       target_release_concept_id, relation_type_id,
       status, evidence_status
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'APPROVED', 'DOCUMENTED')
     RETURNING id`,
    [releaseId, retainedConcept, retainedTargetConcept, relationTypeId],
  );
  const relationRetired = await client.query<{ id: string }>(
    `INSERT INTO taxonomy_concept_relations (
       release_id, source_release_concept_id,
       target_release_concept_id, relation_type_id,
       status, evidence_status
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'APPROVED', 'DOCUMENTED')
     RETURNING id`,
    [releaseId, retainedConcept, retiredConcept, relationTypeId],
  );

  const evidence = await client.query<{ id: string }>(`
    INSERT INTO taxonomy_evidence (
      basis_type, maintainer, document_title,
      interpretation_note, metadata
    ) VALUES (
      'TRIBUSCA', 'TriBusca', 'TAX-10 integration evidence',
      'Evidence used only inside a rolled-back integration fixture.',
      '{"fixture":"tax-10"}'::jsonb
    ) RETURNING id
  `);
  const evidenceId = evidence.rows[0]!.id;

  await client.query(
    `INSERT INTO taxonomy_alias_binding_evidence (
       alias_binding_id, evidence_id, role
     ) VALUES
       ($1::uuid, $3::uuid, 'PRIMARY'),
       ($2::uuid, $3::uuid, 'PRIMARY')`,
    [bindingRetained.rows[0]!.id, bindingRetired.rows[0]!.id, evidenceId],
  );
  await client.query(
    `INSERT INTO taxonomy_relation_evidence (
       relation_id, evidence_id, role
     ) VALUES
       ($1::uuid, $3::uuid, 'PRIMARY'),
       ($2::uuid, $3::uuid, 'PRIMARY')`,
    [relationRetained.rows[0]!.id, relationRetired.rows[0]!.id, evidenceId],
  );

  const catalog = await client.query<{ id: string }>(`
    INSERT INTO official_catalogs (code, name, maintainer, description)
    VALUES ('TAX10_FIXTURE', 'TAX-10 Fixture', 'TriBusca', 'Rolled-back fixture')
    RETURNING id
  `);
  const edition = await client.query<{ id: string }>(
    `INSERT INTO official_catalog_editions (
       catalog_id, edition_code, valid_from, status, source_url
     ) VALUES ($1::uuid, 'fixture-2026', DATE '2026-01-01', 'CURRENT', 'https://example.invalid/tax10')
     RETURNING id`,
    [catalog.rows[0]!.id],
  );
  const entries = await client.query<{ id: string; official_code: string }>(
    `INSERT INTO official_catalog_entries (
       catalog_edition_id, official_code, description
     ) VALUES
       ($1::uuid, 'RETAINED', 'Retained mapping fixture'),
       ($1::uuid, 'RETIRED', 'Retired mapping fixture')
     RETURNING id, official_code`,
    [edition.rows[0]!.id],
  );
  const retainedEntry = entries.rows.find((row) => row.official_code === 'RETAINED')!;
  const retiredEntry = entries.rows.find((row) => row.official_code === 'RETIRED')!;

  const mappingRetained = await client.query<{ id: string }>(
    `INSERT INTO taxonomy_official_mappings (
       release_id, release_concept_id, official_catalog_entry_id,
       mapping_type, evidence_status
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'EXACT', 'DOCUMENTED')
     RETURNING id`,
    [releaseId, retainedConcept, retainedEntry.id],
  );
  const mappingRetired = await client.query<{ id: string }>(
    `INSERT INTO taxonomy_official_mappings (
       release_id, release_concept_id, official_catalog_entry_id,
       mapping_type, evidence_status
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'EXACT', 'DOCUMENTED')
     RETURNING id`,
    [releaseId, retiredConcept, retiredEntry.id],
  );
  await client.query(
    `INSERT INTO taxonomy_official_mapping_evidence (
       official_mapping_id, evidence_id, role
     ) VALUES
       ($1::uuid, $3::uuid, 'PRIMARY'),
       ($2::uuid, $3::uuid, 'PRIMARY')`,
    [mappingRetained.rows[0]!.id, mappingRetired.rows[0]!.id, evidenceId],
  );

  await client.query(
    `UPDATE taxonomy_releases
     SET status = 'PUBLISHED',
         approved_at = now(),
         published_at = now(),
         artifact_repository = 'fabiojuniort-cyber/radar-fiscal-backend',
         artifact_path = 'test/taxonomy.v1-1.integration.test.ts',
         artifact_git_sha = $2,
         artifact_sha256 = $3
     WHERE id = $1::uuid`,
    [releaseId, 'a'.repeat(40), 'b'.repeat(64)],
  );

  return { releaseId, firstConceptByDimension };
}

test('TAX-10 creates, validates and publishes v1.1 without retired dimensions', async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(`
      TRUNCATE TABLE
        taxonomy_releases,
        taxonomy_dimensions,
        taxonomy_concepts,
        taxonomy_aliases,
        taxonomy_relation_types,
        taxonomy_evidence,
        official_catalogs
      CASCADE
    `);
    await client.query('SET LOCAL ROLE radar_taxonomy_curator');

    const fixture = await insertFixtureSource(client);

    const dryRun = await dryRunTaxonomyV11Successor(client);
    assert.equal(dryRun.action, 'CREATE_DRAFT');
    assert.deepEqual(dryRun.blockers, []);
    assert.equal(dryRun.sourceReleaseId, fixture.releaseId);
    assert.equal(dryRun.plan?.sourceDimensions, 20);
    assert.equal(dryRun.plan?.sourceConcepts, 628);
    assert.equal(dryRun.plan?.retainedDimensions, 15);
    assert.equal(dryRun.plan?.retainedConcepts, 590);
    assert.equal(dryRun.copyable?.aliasBindings, 1);
    assert.equal(dryRun.copyable?.relationRules, 1);
    assert.equal(dryRun.copyable?.relations, 1);
    assert.equal(dryRun.copyable?.officialMappings, 1);
    assert.equal(dryRun.copyable?.aliasEvidence, 1);
    assert.equal(dryRun.copyable?.relationEvidence, 1);
    assert.equal(dryRun.copyable?.mappingEvidence, 1);

    const created = await createTaxonomyV11DraftInTransaction(client);
    assert.equal(created.disposition, 'CREATED_DRAFT');
    assert.equal(created.snapshot.status, 'DRAFT');
    assert.equal(created.snapshot.dimensions, 15);
    assert.equal(created.snapshot.concepts, 590);
    assert.equal(created.snapshot.retiredDimensionsPresent, 0);
    assert.equal(created.snapshot.retiredConceptsPresent, 0);
    assert.deepEqual(
      [...created.snapshot.preservedDimensionCodes].sort(),
      ['subject', 'theme', 'treatment'],
    );
    assert.equal(created.snapshot.aliasBindings, 1);
    assert.equal(created.snapshot.relationRules, 1);
    assert.equal(created.snapshot.relations, 1);
    assert.equal(created.snapshot.officialMappings, 1);
    assert.equal(created.snapshot.aliasEvidence, 1);
    assert.equal(created.snapshot.relationEvidence, 1);
    assert.equal(created.snapshot.mappingEvidence, 1);

    await client.query('SET CONSTRAINTS ALL IMMEDIATE');

    const replay = await createTaxonomyV11DraftInTransaction(client);
    assert.equal(replay.disposition, 'IDEMPOTENT_DRAFT');
    assert.equal(replay.releaseId, created.releaseId);

    const sourceBeforePublish = await client.query<{
      status: string;
      dimensions: number;
      concepts: number;
    }>(
      `SELECT
         r.status,
         (SELECT count(*)::int FROM taxonomy_release_dimensions WHERE release_id = r.id) AS dimensions,
         (SELECT count(*)::int FROM taxonomy_release_concepts WHERE release_id = r.id) AS concepts
       FROM taxonomy_releases r
       WHERE r.id = $1::uuid`,
      [fixture.releaseId],
    );
    assert.equal(sourceBeforePublish.rows[0]?.status, 'PUBLISHED');
    assert.equal(sourceBeforePublish.rows[0]?.dimensions, 20);
    assert.equal(sourceBeforePublish.rows[0]?.concepts, 628);

    const published = await publishTaxonomyV11InTransaction(client, {
      artifactRepository: 'fabiojuniort-cyber/radar-fiscal-backend',
      artifactPath: 'docs/taxonomy/TAXONOMY_V1_1_RELEASE_POLICY.json',
      artifactGitSha: 'c'.repeat(40),
      artifactSha256: 'd'.repeat(64),
      actor: 'tax-10-integration-test',
    });
    assert.equal(published.disposition, 'PUBLISHED');
    assert.equal(published.snapshot.status, 'PUBLISHED');

    const publishReplay = await publishTaxonomyV11InTransaction(client, {
      artifactRepository: 'fabiojuniort-cyber/radar-fiscal-backend',
      artifactPath: 'docs/taxonomy/TAXONOMY_V1_1_RELEASE_POLICY.json',
      artifactGitSha: 'c'.repeat(40),
      artifactSha256: 'd'.repeat(64),
      actor: 'tax-10-integration-test',
    });
    assert.equal(publishReplay.disposition, 'ALREADY_PUBLISHED');

    const retiredTarget = await client.query<{ code: string }>(
      `SELECT d.code
       FROM taxonomy_release_dimensions rd
       JOIN taxonomy_dimensions d ON d.id = rd.dimension_id
       WHERE rd.release_id = $1::uuid
         AND d.code = ANY($2::text[])`,
      [created.releaseId, [...RETIRED_DIMENSION_CODES]],
    );
    assert.deepEqual(retiredTarget.rows, []);

    const sourceAfterPublish = await client.query<{ status: string }>(
      `SELECT status FROM taxonomy_releases WHERE id = $1::uuid`,
      [fixture.releaseId],
    );
    assert.equal(sourceAfterPublish.rows[0]?.status, 'PUBLISHED');
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    await pool.end();
  }
});
