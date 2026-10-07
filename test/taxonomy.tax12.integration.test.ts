import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool, type PoolClient } from 'pg';

import { buildApp } from '../src/app.js';
import {
  retireDimension,
  validateReleaseView,
  withCuratorTransaction,
} from '../src/modules/taxonomy/curation/curation.draft.js';
import { mergeDimension } from '../src/modules/taxonomy/curation/curation.merge-dimension.js';
import {
  findOpenDraft,
  loadReleaseView,
  pgRunner,
} from '../src/modules/taxonomy/curation/curation.read.js';
import { parseTaxonomyCodeCompatibility } from '../src/modules/taxonomy/taxonomy-code-compatibility.js';

const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) throw new Error('DATABASE_ADMIN_URL is required');
if (!process.env.DB_CURATOR_RUNTIME_PASSWORD) {
  throw new Error('DB_CURATOR_RUNTIME_PASSWORD is required');
}

interface FixtureConcept {
  code: string;
  dimensionCode: string;
  label: string;
  membership?: 'INCLUDED' | 'RETIRED';
  groupId?: string | null;
  officialCodes?: string[];
}

async function dimension(
  client: PoolClient,
  releaseId: string,
  code: string,
  name: string,
  officialCodeType: string | null = null,
): Promise<string> {
  const identity = await client.query<{ id: string }>(
    `INSERT INTO taxonomy_dimensions (code)
     VALUES ($1)
     ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code
     RETURNING id`,
    [code],
  );
  const id = identity.rows[0]!.id;
  const revision = await client.query<{ id: string }>(
    `INSERT INTO taxonomy_dimension_revisions (
       dimension_id, revision_no, name, governance_status
     )
     SELECT $1::uuid, COALESCE(max(revision_no), 0) + 1, $2, 'APPROVED'
     FROM taxonomy_dimension_revisions
     WHERE dimension_id = $1::uuid
     RETURNING id`,
    [id, name],
  );
  await client.query(
    `INSERT INTO taxonomy_release_dimensions (
       release_id, dimension_id, dimension_revision_id,
       membership_status, profile_visible, official_code_type
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'INCLUDED', false, $4)`,
    [releaseId, id, revision.rows[0]!.id, officialCodeType],
  );
  return id;
}

async function group(
  client: PoolClient,
  releaseId: string,
  dimensionId: string,
  code: string,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO taxonomy_release_groups (
       release_id, dimension_id, code, label, display_order
     ) VALUES ($1::uuid, $2::uuid, $3, $3, 1)
     RETURNING id`,
    [releaseId, dimensionId, code],
  );
  return result.rows[0]!.id;
}

async function concept(
  client: PoolClient,
  releaseId: string,
  dimensions: Map<string, string>,
  input: FixtureConcept,
): Promise<{ conceptId: string; releaseConceptId: string }> {
  const dimensionId = dimensions.get(input.dimensionCode);
  assert.ok(dimensionId);
  const identity = await client.query<{ id: string }>(
    `INSERT INTO taxonomy_concepts (code, dimension_id)
     VALUES ($1, $2::uuid)
     ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code
     RETURNING id`,
    [input.code, dimensionId],
  );
  const conceptId = identity.rows[0]!.id;
  const revision = await client.query<{ id: string }>(
    `INSERT INTO taxonomy_concept_revisions (
       concept_id, revision_no, label, definition,
       governance_status, evidence_status
     )
     SELECT $1::uuid, COALESCE(max(revision_no), 0) + 1,
            $2, $2, 'APPROVED', 'DOCUMENTED'
     FROM taxonomy_concept_revisions
     WHERE concept_id = $1::uuid
     RETURNING id`,
    [conceptId, input.label],
  );
  const releaseConcept = await client.query<{ id: string }>(
    `INSERT INTO taxonomy_release_concepts (
       release_id, concept_id, concept_revision_id,
       membership_status, group_id, profile_visible,
       classify_by_label, official_codes
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4,
       $5::uuid, true, true, $6::text[]
     )
     RETURNING id`,
    [
      releaseId,
      conceptId,
      revision.rows[0]!.id,
      input.membership ?? 'INCLUDED',
      input.groupId ?? null,
      input.officialCodes ?? [],
    ],
  );
  return { conceptId, releaseConceptId: releaseConcept.rows[0]!.id };
}

test('TAX-12 merge keeps concept identity and retires dimensions without graph residue', async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 2 });
  const app = await buildApp();
  assert.ok(app.curatorPool, 'curator pool must be configured');

  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  try {
    const max = await admin.query<{ major: number }>(
      'SELECT COALESCE(max(version_major), 0)::int AS major FROM taxonomy_releases',
    );
    const major = (max.rows[0]?.major ?? 0) + 1;
    const source = await admin.query<{ id: string }>(
      `INSERT INTO taxonomy_releases (
         version_major, version_minor, version_patch, status,
         manifest, change_notes, created_by_actor
       ) VALUES (
         $1, 0, 0, 'DRAFT', $2::jsonb, 'TAX-12 source fixture', 'tax-12-test'
       ) RETURNING id`,
      [major, JSON.stringify({ fixture: 'tax-12' })],
    );
    const sourceId = source.rows[0]!.id;

    const client = await admin.connect();
    let restoredConceptId = '';
    let treatmentCode = '';
    let retiredTreatmentCode = '';
    let redirectedRetiredTreatmentCode = '';
    let targetThemeCode = '';
    let platformCode = '';
    let taxSpeciesCode = '';
    try {
      await client.query('BEGIN');
      const dimensions = new Map<string, string>();
      for (const [code, name, official] of [
        ['theme', 'Tema', null],
        ['treatment', 'Tratamento', 'CCLASSTRIB'],
        ['platform', 'Plataforma', null],
        ['tax_species', 'Espécie Tributária', null],
        ['obligation', 'Obrigação', null],
      ] as const) {
        dimensions.set(
          code,
          await dimension(client, sourceId, code, name, official),
        );
      }

      const themeGroup = await group(
        client,
        sourceId,
        dimensions.get('theme')!,
        `target_${suffix}`,
      );
      const treatmentGroup = await group(
        client,
        sourceId,
        dimensions.get('treatment')!,
        `source_${suffix}`,
      );
      const platformGroup = await group(
        client,
        sourceId,
        dimensions.get('platform')!,
        `platform_${suffix}`,
      );

      targetThemeCode = `theme.tax12_restore_${suffix}`;
      treatmentCode = `treatment.tax12_restore_${suffix}`;
      retiredTreatmentCode = `treatment.tax12_retired_${suffix}`;
      redirectedRetiredTreatmentCode = `treatment.tax12_retired_alias_${suffix}`;
      platformCode = `platform.tax12_sped_${suffix}`;
      taxSpeciesCode = `tax_species.tax12_tax_${suffix}`;

      const target = await concept(client, sourceId, dimensions, {
        code: targetThemeCode,
        dimensionCode: 'theme',
        label: 'Benefício restaurado',
        membership: 'RETIRED',
        groupId: themeGroup,
      });
      restoredConceptId = target.conceptId;

      const anchor = await concept(client, sourceId, dimensions, {
        code: `theme.tax12_anchor_${suffix}`,
        dimensionCode: 'theme',
        label: 'Tema ativo',
        groupId: themeGroup,
      });
      const treatment = await concept(client, sourceId, dimensions, {
        code: treatmentCode,
        dimensionCode: 'treatment',
        label: 'Benefício restaurado',
        groupId: treatmentGroup,
        officialCodes: ['200001'],
      });
      await concept(client, sourceId, dimensions, {
        code: retiredTreatmentCode,
        dimensionCode: 'treatment',
        label: 'Tratamento legado sem sucessor',
        membership: 'RETIRED',
        groupId: treatmentGroup,
      });
      await concept(client, sourceId, dimensions, {
        code: redirectedRetiredTreatmentCode,
        dimensionCode: 'treatment',
        label: 'Benefício restaurado',
        membership: 'RETIRED',
        groupId: treatmentGroup,
      });
      const platform = await concept(client, sourceId, dimensions, {
        code: platformCode,
        dimensionCode: 'platform',
        label: 'SPED legado',
        groupId: platformGroup,
      });
      const obligation = await concept(client, sourceId, dimensions, {
        code: `obligation.tax12_efd_${suffix}`,
        dimensionCode: 'obligation',
        label: 'EFD',
      });
      await concept(client, sourceId, dimensions, {
        code: taxSpeciesCode,
        dimensionCode: 'tax_species',
        label: 'Imposto',
      });

      const relationType = await client.query<{ id: string }>(
        `SELECT id FROM taxonomy_relation_types
         WHERE code = 'related_to'
         LIMIT 1`,
      );
      assert.ok(relationType.rows[0]?.id, 'related_to relation type is required');
      const relationTypeId = relationType.rows[0]!.id;

      for (const [sourceDimension, targetDimension] of [
        ['theme', 'treatment'],
        ['obligation', 'platform'],
      ] as const) {
        await client.query(
          `INSERT INTO taxonomy_release_relation_rules (
             release_id, relation_type_id,
             source_dimension_id, target_dimension_id, allowed
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, true)`,
          [
            sourceId,
            relationTypeId,
            dimensions.get(sourceDimension),
            dimensions.get(targetDimension),
          ],
        );
      }

      await client.query(
        `INSERT INTO taxonomy_concept_relations (
           release_id, source_release_concept_id, target_release_concept_id,
           relation_type_id, status
         ) VALUES
           ($1::uuid, $2::uuid, $3::uuid, $6::uuid, 'APPROVED'),
           ($1::uuid, $4::uuid, $5::uuid, $6::uuid, 'APPROVED')`,
        [
          sourceId,
          anchor.releaseConceptId,
          treatment.releaseConceptId,
          obligation.releaseConceptId,
          platform.releaseConceptId,
          relationTypeId,
        ],
      );

      await client.query(
        `UPDATE taxonomy_releases
         SET status = 'PUBLISHED', approved_at = now(), published_at = now(),
             artifact_repository = 'test', artifact_path = 'tax-12',
             artifact_git_sha = $2, artifact_sha256 = $3
         WHERE id = $1::uuid`,
        [sourceId, 'a'.repeat(40), 'b'.repeat(64)],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const actor = {
      userId: 'ops:tax-12-test',
      justification: 'TAX-12 integration gate',
    };

    await withCuratorTransaction(app.curatorPool!, async (curator) => {
      const merged = await mergeDimension(
        curator,
        actor,
        'treatment',
        'theme',
        { [`source_${suffix}`]: `target_${suffix}` },
      );
      assert.equal(
        merged.steps.find((step) => step.from === treatmentCode)?.action,
        'RESTORE',
      );
    });

    const draftAfterMerge = await findOpenDraft(pgRunner(admin));
    assert.ok(draftAfterMerge);

    const platformReleaseConcept = await admin.query<{ id: string }>(
      `SELECT rc.id
       FROM taxonomy_release_concepts rc
       JOIN taxonomy_concepts c ON c.id = rc.concept_id
       WHERE rc.release_id = $1::uuid AND c.code = $2`,
      [draftAfterMerge!.id, platformCode],
    );
    assert.ok(platformReleaseConcept.rows[0]?.id);

    const catalog = await admin.query<{ id: string }>(
      `INSERT INTO official_catalogs (code, name, maintainer, description)
       VALUES ($1, 'TAX-12 Fixture', 'TriFaros', 'TAX-12 official mapping fixture')
       RETURNING id`,
      [`TAX12_${suffix.toUpperCase()}`],
    );
    const edition = await admin.query<{ id: string }>(
      `INSERT INTO official_catalog_editions (
         catalog_id, edition_code, valid_from, status, source_url
       ) VALUES ($1::uuid, 'fixture', DATE '2026-01-01', 'CURRENT', 'https://example.invalid/tax12')
       RETURNING id`,
      [catalog.rows[0]!.id],
    );
    const entry = await admin.query<{ id: string }>(
      `INSERT INTO official_catalog_entries (
         catalog_edition_id, official_code, description
       ) VALUES ($1::uuid, 'TAX12', 'TAX-12 mapping fixture')
       RETURNING id`,
      [edition.rows[0]!.id],
    );

    await admin.query(
      `INSERT INTO taxonomy_official_mappings (
         release_id, release_concept_id, official_catalog_entry_id,
         mapping_type, evidence_status
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'EXACT', 'NOT_ASSESSED')`,
      [draftAfterMerge!.id, platformReleaseConcept.rows[0]!.id, entry.rows[0]!.id],
    );

    await withCuratorTransaction(app.curatorPool!, async (curator) => {
      const platformRetirement = await retireDimension(curator, actor, 'platform');
      assert.equal(
        platformRetirement.removedOfficialMappings,
        1,
        'retireDimension removes official mappings of the retired dimension',
      );
      await retireDimension(curator, actor, 'tax_species');
    });

    const draft = await findOpenDraft(pgRunner(admin));
    assert.ok(draft);
    const activeView = await loadReleaseView(pgRunner(admin), draft!.id);
    assert.ok(activeView);
    assert.ok(
      !activeView!.dimensions.some((item) =>
        ['treatment', 'platform', 'tax_species'].includes(item.code),
      ),
    );
    assert.ok(
      !activeView!.groups.some((item) =>
        ['treatment', 'platform', 'tax_species'].includes(item.dimensionCode),
      ),
    );
    assert.equal(
      activeView!.dimensions.find((item) => item.code === 'theme')?.officialCodeType,
      'CCLASSTRIB',
    );

    const restored = await admin.query<{
      concept_id: string;
      membership_status: string;
      official_codes: string[];
    }>(
      `SELECT rc.concept_id, rc.membership_status, rc.official_codes
       FROM taxonomy_release_concepts rc
       JOIN taxonomy_concepts c ON c.id = rc.concept_id
       WHERE rc.release_id = $1::uuid AND c.code = $2`,
      [draft!.id, targetThemeCode],
    );
    assert.equal(restored.rows[0]?.concept_id, restoredConceptId);
    assert.equal(restored.rows[0]?.membership_status, 'INCLUDED');
    assert.deepEqual(restored.rows[0]?.official_codes, ['200001']);

    const manifest = await admin.query<{ manifest: unknown }>(
      'SELECT manifest FROM taxonomy_releases WHERE id = $1::uuid',
      [draft!.id],
    );
    const compatibility = parseTaxonomyCodeCompatibility(manifest.rows[0]?.manifest);
    assert.equal(compatibility.redirects[treatmentCode], targetThemeCode);
    assert.equal(
      compatibility.redirects[redirectedRetiredTreatmentCode],
      targetThemeCode,
      'historical retired treatment codes redirect when an active successor exists',
    );
    assert.ok(
      compatibility.retiredCodes.includes(retiredTreatmentCode),
      'historical retired treatment codes without successor are explicitly retired',
    );
    assert.ok(compatibility.retiredCodes.includes(platformCode));
    assert.ok(compatibility.retiredCodes.includes(taxSpeciesCode));

    const mappingsAfterRetirement = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM taxonomy_official_mappings
       WHERE release_id = $1::uuid
         AND release_concept_id = $2::uuid`,
      [draft!.id, platformReleaseConcept.rows[0]!.id],
    );
    assert.equal(
      mappingsAfterRetirement.rows[0]?.count,
      0,
      'retireDimension must remove official mappings for retired concepts',
    );

    const leakedMapping = await admin.query<{ id: string }>(
      `INSERT INTO taxonomy_official_mappings (
         release_id, release_concept_id, official_catalog_entry_id,
         mapping_type, evidence_status
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'EXACT', 'NOT_ASSESSED')
       RETURNING id`,
      [draft!.id, platformReleaseConcept.rows[0]!.id, entry.rows[0]!.id],
    );

    const validationClient = await admin.connect();
    try {
      const validationView = await loadReleaseView(pgRunner(validationClient), draft!.id);
      assert.ok(validationView);
      const issues = await validateReleaseView(validationClient, validationView!);
      assert.ok(
        issues.some(
          (issue) =>
            issue.severity === 'BLOCKER' &&
            issue.code === 'RETIRED_DIMENSION_OFFICIAL_MAPPINGS',
        ),
        'publish validation must block official mappings that point to retired concepts/dimensions',
      );
    } finally {
      validationClient.release();
    }

    await admin.query(
      'DELETE FROM taxonomy_official_mappings WHERE id = $1::uuid',
      [leakedMapping.rows[0]!.id],
    );

    const residue = await admin.query<{
      concepts: number;
      groups: number;
      rules: number;
      relations: number;
      mappings: number;
    }>(
      `SELECT
         (
           SELECT count(*)::int
           FROM taxonomy_release_concepts rc
           JOIN taxonomy_concepts c ON c.id = rc.concept_id
           JOIN taxonomy_release_dimensions rd
             ON rd.release_id = rc.release_id AND rd.dimension_id = c.dimension_id
           WHERE rc.release_id = $1::uuid
             AND rc.membership_status = 'INCLUDED'
             AND rd.membership_status <> 'INCLUDED'
         ) AS concepts,
         (
           SELECT count(*)::int
           FROM taxonomy_release_groups g
           JOIN taxonomy_release_dimensions rd
             ON rd.release_id = g.release_id AND rd.dimension_id = g.dimension_id
           WHERE g.release_id = $1::uuid
             AND rd.membership_status <> 'INCLUDED'
         ) AS groups,
         (
           SELECT count(*)::int
           FROM taxonomy_release_relation_rules rr
           JOIN taxonomy_release_dimensions s
             ON s.release_id = rr.release_id AND s.dimension_id = rr.source_dimension_id
           JOIN taxonomy_release_dimensions t
             ON t.release_id = rr.release_id AND t.dimension_id = rr.target_dimension_id
           WHERE rr.release_id = $1::uuid
             AND (s.membership_status <> 'INCLUDED' OR t.membership_status <> 'INCLUDED')
         ) AS rules,
         (
           SELECT count(*)::int
           FROM taxonomy_concept_relations r
           JOIN taxonomy_release_concepts s ON s.id = r.source_release_concept_id
           JOIN taxonomy_release_concepts t ON t.id = r.target_release_concept_id
           WHERE r.release_id = $1::uuid
             AND (s.membership_status <> 'INCLUDED' OR t.membership_status <> 'INCLUDED')
         ) AS relations,
         (
           SELECT count(*)::int
           FROM taxonomy_official_mappings m
           JOIN taxonomy_release_concepts rc ON rc.id = m.release_concept_id
           JOIN taxonomy_concepts c ON c.id = rc.concept_id
           JOIN taxonomy_release_dimensions rd
             ON rd.release_id = m.release_id AND rd.dimension_id = c.dimension_id
           WHERE m.release_id = $1::uuid
             AND (
               rc.membership_status <> 'INCLUDED'
               OR rd.membership_status <> 'INCLUDED'
             )
         ) AS mappings`,
      [draft!.id],
    );
    assert.deepEqual(residue.rows[0], {
      concepts: 0,
      groups: 0,
      rules: 0,
      relations: 0,
      mappings: 0,
    });

    // Applying the same merge again is a no-op, not DIMENSION_NOT_FOUND.
    await withCuratorTransaction(app.curatorPool!, async (curator) => {
      const again = await mergeDimension(
        curator,
        actor,
        'treatment',
        'theme',
        { [`source_${suffix}`]: `target_${suffix}` },
      );
      assert.equal(again.steps.length, 0);
    });

    // Respect the real release lifecycle even in the fixture: DRAFT is not
    // withdrawable. Finalize the isolated draft, then withdraw the published
    // fixture so no editable curated draft leaks into later CI gates.
    await admin.query(
      `UPDATE taxonomy_releases
       SET status = 'PUBLISHED',
           approved_at = now(),
           published_at = now(),
           artifact_repository = 'test',
           artifact_path = 'tax-12-cleanup',
           artifact_git_sha = $2,
           artifact_sha256 = $3
       WHERE id = $1::uuid AND status = 'DRAFT'`,
      [draft!.id, 'c'.repeat(40), 'd'.repeat(64)],
    );
    await admin.query(
      `UPDATE taxonomy_releases
       SET status = 'WITHDRAWN', withdrawn_at = now(),
           withdrawal_reason = 'TAX-12 integration completed',
           withdrawn_by_actor = 'tax-12-test'
       WHERE id = $1::uuid AND status = 'PUBLISHED'`,
      [draft!.id],
    );
  } finally {
    await app.close();
    await admin.end();
  }
});
