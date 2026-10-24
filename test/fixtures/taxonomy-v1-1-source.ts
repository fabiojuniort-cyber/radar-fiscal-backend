import type { PoolClient } from 'pg';
import { DIMENSIONS } from '../../src/modules/taxonomy/baseline/baseline.constants.js';

export async function insertFixtureSource(client: PoolClient): Promise<{
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
