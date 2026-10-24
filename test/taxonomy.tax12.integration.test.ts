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
import { resolveCuratorDecisions } from '../src/modules/taxonomy/curation/curation.tags.js';
import { buildAcceptedCodes } from '../src/modules/taxonomy/matching/taxonomy-matching.service.js';
import {
  canonicalizeTaxonomyConceptCodes,
  loadTaxonomyCodeCompatibility,
  parseTaxonomyCodeCompatibility,
} from '../src/modules/taxonomy/taxonomy-code-compatibility.js';

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
    let revisionPinnedTreatmentCode = '';
    let revisionPinnedActiveThemeCode = '';
    let suffixShadowTreatmentCode = '';
    let suffixShadowRetiredThemeCode = '';
    let suffixShadowActiveThemeCode = '';
    let combinedTreatmentCode = '';
    let combinedRetiredThemeCode = '';
    let combinedActiveThemeCode = '';
    let createSourceTreatmentCode = '';
    let createHistoricalTreatmentCode = '';
    let createdThemeCode = '';
    let detachedHistoricalTreatmentCode = '';
    let detachedHistoricalRedirectTreatmentCode = '';
    let detachedHistoricalRedirectThemeCode = '';
    let detachedHistoricalPlatformCode = '';
    let detachedHistoricalTaxSpeciesCode = '';
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
      revisionPinnedTreatmentCode = `treatment.tax12_revision_source_${suffix}`;
      revisionPinnedActiveThemeCode = `theme.tax12_revision_target_${suffix}`;
      suffixShadowTreatmentCode = `treatment.tax12_suffix_shadow_${suffix}`;
      suffixShadowRetiredThemeCode = `theme.tax12_suffix_shadow_${suffix}`;
      suffixShadowActiveThemeCode = `theme.tax12_active_reduction_${suffix}`;
      combinedTreatmentCode = `treatment.tax12_combined_${suffix}`;
      combinedRetiredThemeCode = `theme.tax12_combined_${suffix}`;
      combinedActiveThemeCode = `theme.tax12_active_credit_${suffix}`;
      createSourceTreatmentCode = `treatment.tax12_create_${suffix}`;
      createHistoricalTreatmentCode = `treatment.tax12_legacy_create_${suffix}`;
      createdThemeCode = `theme.tax12_create_${suffix}`;
      detachedHistoricalTreatmentCode = `treatment.tax12_detached_${suffix}`;
      detachedHistoricalRedirectTreatmentCode =
        `treatment.tax12_detached_redirect_${suffix}`;
      detachedHistoricalRedirectThemeCode =
        `theme.tax12_detached_redirect_${suffix}`;
      detachedHistoricalPlatformCode = `platform.tax12_detached_${suffix}`;
      detachedHistoricalTaxSpeciesCode = `tax_species.tax12_detached_${suffix}`;
      platformCode = `platform.tax12_sped_${suffix}`;
      taxSpeciesCode = `tax_species.tax12_tax_${suffix}`;

      // Reproduce the fifth-review blocker: this detached Treatment was
      // retired in an older release when no successor was available. The
      // current merge must re-evaluate it after Theme becomes active and
      // promote retiredCode -> redirect.
      await client.query(
        `UPDATE taxonomy_releases
         SET manifest = jsonb_set(
           COALESCE(manifest, '{}'::jsonb),
           '{taxonomyCompatibility}',
           $2::jsonb,
           true
         )
         WHERE id = $1::uuid`,
        [
          sourceId,
          JSON.stringify({
            version: 1,
            redirects: {},
            retiredCodes: [
              detachedHistoricalRedirectTreatmentCode,
              redirectedRetiredTreatmentCode,
              revisionPinnedTreatmentCode,
              suffixShadowTreatmentCode,
              combinedTreatmentCode,
              createHistoricalTreatmentCode,
            ],
          }),
        ],
      );

      const target = await concept(client, sourceId, dimensions, {
        code: targetThemeCode,
        dimensionCode: 'theme',
        label: 'Benefício restaurado',
        membership: 'RETIRED',
        groupId: themeGroup,
      });
      restoredConceptId = target.conceptId;


      await concept(client, sourceId, dimensions, {
        code: revisionPinnedActiveThemeCode,
        dimensionCode: 'theme',
        label: 'Isenção revisionada',
        groupId: themeGroup,
      });
      await concept(client, sourceId, dimensions, {
        code: suffixShadowRetiredThemeCode,
        dimensionCode: 'theme',
        label: 'Tema retirado por sufixo',
        membership: 'RETIRED',
        groupId: themeGroup,
      });
      await concept(client, sourceId, dimensions, {
        code: suffixShadowActiveThemeCode,
        dimensionCode: 'theme',
        label: 'Redução de base',
        groupId: themeGroup,
      });
      await concept(client, sourceId, dimensions, {
        code: combinedRetiredThemeCode,
        dimensionCode: 'theme',
        label: 'Tema combinado retirado',
        membership: 'RETIRED',
        groupId: themeGroup,
      });
      await concept(client, sourceId, dimensions, {
        code: combinedActiveThemeCode,
        dimensionCode: 'theme',
        label: 'Crédito presumido',
        groupId: themeGroup,
      });

      for (const [historicalCode, dimensionCode, label] of [
        [
          detachedHistoricalTreatmentCode,
          'treatment',
          'Tratamento histórico fora da release',
        ],
        [
          detachedHistoricalRedirectTreatmentCode,
          'treatment',
          'Tratamento histórico com sucessor ativo',
        ],
        [
          detachedHistoricalPlatformCode,
          'platform',
          'Plataforma histórica fora da release',
        ],
        [
          detachedHistoricalTaxSpeciesCode,
          'tax_species',
          'Espécie tributária histórica fora da release',
        ],
      ] as const) {
        const detachedHistorical = await client.query<{ id: string }>(
          `INSERT INTO taxonomy_concepts (code, dimension_id)
           VALUES ($1, $2::uuid)
           RETURNING id`,
          [historicalCode, dimensions.get(dimensionCode)],
        );
        await client.query(
          `INSERT INTO taxonomy_concept_revisions (
             concept_id, revision_no, label, definition,
             governance_status, evidence_status
           ) VALUES (
             $1::uuid, 1, $2,
             'Identidade histórica sem membership na release corrente',
             'DEPRECATED', 'DOCUMENTED'
           )`,
          [detachedHistorical.rows[0]!.id, label],
        );
      }

      await concept(client, sourceId, dimensions, {
        code: detachedHistoricalRedirectThemeCode,
        dimensionCode: 'theme',
        label: 'Tratamento histórico com sucessor ativo',
        groupId: themeGroup,
      });

      const revisionPinned = await concept(client, sourceId, dimensions, {
        code: revisionPinnedTreatmentCode,
        dimensionCode: 'treatment',
        label: 'Isenção revisionada',
        membership: 'RETIRED',
        groupId: treatmentGroup,
      });
      await client.query(
        `INSERT INTO taxonomy_concept_revisions (
           concept_id, revision_no, label, definition,
           governance_status, evidence_status
         ) VALUES (
           $1::uuid, 2, 'Tratamento antigo sem correspondência',
           'Revisão posterior que não pertence à release',
           'DEPRECATED', 'DOCUMENTED'
         )`,
        [revisionPinned.conceptId],
      );

      await concept(client, sourceId, dimensions, {
        code: suffixShadowTreatmentCode,
        dimensionCode: 'treatment',
        label: 'Redução de base',
        membership: 'RETIRED',
        groupId: treatmentGroup,
      });

      const combined = await concept(client, sourceId, dimensions, {
        code: combinedTreatmentCode,
        dimensionCode: 'treatment',
        label: 'Crédito presumido',
        membership: 'RETIRED',
        groupId: treatmentGroup,
      });
      await client.query(
        `INSERT INTO taxonomy_concept_revisions (
           concept_id, revision_no, label, definition,
           governance_status, evidence_status
         ) VALUES (
           $1::uuid, 2, 'Tratamento combinado sem correspondência',
           'Revisão posterior que não pertence à release',
           'DEPRECATED', 'DOCUMENTED'
         )`,
        [combined.conceptId],
      );

      await concept(client, sourceId, dimensions, {
        code: createHistoricalTreatmentCode,
        dimensionCode: 'treatment',
        label: 'Benefício criado',
        membership: 'RETIRED',
        groupId: treatmentGroup,
      });
      await concept(client, sourceId, dimensions, {
        code: createSourceTreatmentCode,
        dimensionCode: 'treatment',
        label: 'Benefício criado',
        groupId: treatmentGroup,
      });

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
      userId: randomUUID(),
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
      const created = merged.steps.find(
        (step) => step.from === createSourceTreatmentCode,
      );
      assert.equal(created?.action, 'CREATE');
      assert.equal(created?.into, createdThemeCode);
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
      'inherited retired Treatment redirects after its Theme is restored',
    );
    assert.equal(
      compatibility.retiredCodes.includes(redirectedRetiredTreatmentCode),
      false,
      'RESTORE removes the inherited retiredCode when the successor becomes active',
    );
    assert.equal(
      compatibility.redirects[revisionPinnedTreatmentCode],
      revisionPinnedActiveThemeCode,
      'materialized historical Treatment matches with the revision pinned to the release',
    );
    assert.equal(
      compatibility.retiredCodes.includes(revisionPinnedTreatmentCode),
      false,
    );
    assert.equal(
      compatibility.redirects[suffixShadowTreatmentCode],
      suffixShadowActiveThemeCode,
      'a RETIRED suffix Theme must not block fallback to an active Theme by label',
    );
    assert.equal(
      compatibility.retiredCodes.includes(suffixShadowTreatmentCode),
      false,
    );
    assert.equal(
      compatibility.redirects[combinedTreatmentCode],
      combinedActiveThemeCode,
      'revision pinning and active-target fallback work together',
    );
    assert.equal(
      compatibility.retiredCodes.includes(combinedTreatmentCode),
      false,
    );
    assert.equal(
      compatibility.redirects[createSourceTreatmentCode],
      createdThemeCode,
      'the included Treatment source redirects to the Theme created by the merge',
    );
    assert.equal(
      compatibility.redirects[createHistoricalTreatmentCode],
      createdThemeCode,
      'inherited retired Treatment redirects after CREATE makes its Theme successor active',
    );
    assert.equal(
      compatibility.retiredCodes.includes(createHistoricalTreatmentCode),
      false,
      'CREATE removes the inherited retiredCode when the successor becomes active',
    );
    assert.ok(
      compatibility.retiredCodes.includes(retiredTreatmentCode),
      'historical retired treatment codes without successor are explicitly retired',
    );
    assert.ok(
      compatibility.retiredCodes.includes(detachedHistoricalTreatmentCode),
      'detached historical treatment without successor is explicitly retired',
    );
    assert.equal(
      compatibility.redirects[detachedHistoricalRedirectTreatmentCode],
      detachedHistoricalRedirectThemeCode,
      'detached historical treatment with an active Theme successor redirects instead of retiring',
    );
    assert.equal(
      compatibility.retiredCodes.includes(detachedHistoricalRedirectTreatmentCode),
      false,
      'a pre-existing retiredCode must be removed when a Theme successor now exists',
    );
    assert.ok(
      compatibility.retiredCodes.includes(detachedHistoricalPlatformCode),
      'historical platform identities outside the current release are explicitly retired',
    );
    assert.ok(
      compatibility.retiredCodes.includes(detachedHistoricalTaxSpeciesCode),
      'historical tax-species identities outside the current release are explicitly retired',
    );
    assert.ok(compatibility.retiredCodes.includes(platformCode));
    assert.ok(compatibility.retiredCodes.includes(taxSpeciesCode));


    // Defense in depth: even if a future retirement implementation forgets
    // one detached historical identity, publication validation must fail closed.
    const originalManifest = manifest.rows[0]?.manifest;
    const incompleteManifest = JSON.parse(
      JSON.stringify(originalManifest),
    ) as {
      taxonomyCompatibility?: {
        retiredCodes?: string[];
      };
    };
    assert.ok(incompleteManifest.taxonomyCompatibility?.retiredCodes);
    incompleteManifest.taxonomyCompatibility!.retiredCodes =
      incompleteManifest.taxonomyCompatibility!.retiredCodes!.filter(
        (code) => code !== detachedHistoricalPlatformCode,
      );
    await admin.query(
      'UPDATE taxonomy_releases SET manifest = $2::jsonb WHERE id = $1::uuid',
      [draft!.id, JSON.stringify(incompleteManifest)],
    );
    const compatibilityValidationClient = await admin.connect();
    try {
      const compatibilityValidationView = await loadReleaseView(
        pgRunner(compatibilityValidationClient),
        draft!.id,
      );
      assert.ok(compatibilityValidationView);
      const issues = await validateReleaseView(
        compatibilityValidationClient,
        compatibilityValidationView!,
      );
      assert.ok(
        issues.some(
          (issue) =>
            issue.severity === 'BLOCKER' &&
            issue.code === 'INCOMPLETE_RETIRED_DIMENSION_COMPATIBILITY',
        ),
        'publish validation must block an uncovered historical code from a retired dimension',
      );
    } finally {
      compatibilityValidationClient.release();
    }
    await admin.query(
      'UPDATE taxonomy_releases SET manifest = $2::jsonb WHERE id = $1::uuid',
      [draft!.id, JSON.stringify(originalManifest)],
    );

    const expectStaleRetiredBlocked = async (
      sourceCode: string,
      targetCode: string,
      reason: string,
    ): Promise<void> => {
      const staleManifest = JSON.parse(
        JSON.stringify(originalManifest),
      ) as {
        taxonomyCompatibility?: {
          version?: number;
          redirects?: Record<string, string>;
          retiredCodes?: string[];
        };
      };
      assert.ok(staleManifest.taxonomyCompatibility);
      delete staleManifest.taxonomyCompatibility!.redirects?.[sourceCode];
      staleManifest.taxonomyCompatibility!.retiredCodes = [
        ...new Set([
          ...(staleManifest.taxonomyCompatibility!.retiredCodes ?? []),
          sourceCode,
        ]),
      ].sort();
      await admin.query(
        'UPDATE taxonomy_releases SET manifest = $2::jsonb WHERE id = $1::uuid',
        [draft!.id, JSON.stringify(staleManifest)],
      );
      const staleClient = await admin.connect();
      try {
        const staleView = await loadReleaseView(
          pgRunner(staleClient),
          draft!.id,
        );
        assert.ok(staleView);
        const issues = await validateReleaseView(staleClient, staleView!);
        assert.ok(
          issues.some(
            (issue) =>
              issue.severity === 'BLOCKER' &&
              issue.code === 'RETIRED_TREATMENT_HAS_ACTIVE_SUCCESSOR' &&
              issue.message.includes(sourceCode) &&
              issue.message.includes(targetCode),
          ),
          reason,
        );
      } finally {
        staleClient.release();
      }
      await admin.query(
        'UPDATE taxonomy_releases SET manifest = $2::jsonb WHERE id = $1::uuid',
        [draft!.id, JSON.stringify(originalManifest)],
      );
    };

    await expectStaleRetiredBlocked(
      detachedHistoricalRedirectTreatmentCode,
      detachedHistoricalRedirectThemeCode,
      'publish validation must reject a stale detached retired Treatment',
    );
    await expectStaleRetiredBlocked(
      revisionPinnedTreatmentCode,
      revisionPinnedActiveThemeCode,
      'validator must use the release-pinned revision, not a later global revision',
    );
    await expectStaleRetiredBlocked(
      combinedTreatmentCode,
      combinedActiveThemeCode,
      'validator must still block stale retirement when revision pinning and retired-suffix fallback are combined',
    );

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
    const finalValidationClient = await admin.connect();
    try {
      const finalView = await loadReleaseView(
        pgRunner(finalValidationClient),
        draft!.id,
      );
      assert.ok(finalView);
      const finalIssues = await validateReleaseView(
        finalValidationClient,
        finalView!,
      );
      assert.deepEqual(
        finalIssues.filter((issue) => issue.severity === 'BLOCKER'),
        [],
        'the repaired merge-produced manifest must pass the publish gate',
      );
    } finally {
      finalValidationClient.release();
    }

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

    // Reload the exact manifest from the now-PUBLISHED isolated fixture and
    // consume it through the same runtime helpers used by monitoring profiles,
    // company tax profiles/affinity preparation, and curator history.
    const publishedCompatibility = await loadTaxonomyCodeCompatibility(
      pgRunner(admin),
      draft!.id,
    );
    const publishedAcceptedCodes = buildAcceptedCodes(
      {
        releasePolicy: 'CURRENT_PUBLISHED',
        anyOf: [combinedTreatmentCode],
        allOf: [],
        noneOf: [],
        includeDescendants: false,
      },
      activeView!.concepts.map((item) => ({
        release_concept_id: item.releaseConceptId,
        code: item.code,
      })),
      [],
      publishedCompatibility,
    );
    assert.deepEqual(
      [...(publishedAcceptedCodes.get(combinedTreatmentCode) ?? [])],
      [combinedActiveThemeCode],
      'monitoring profile criteria must resolve through the published merge-produced map',
    );

    const publishedProfileCodes = canonicalizeTaxonomyConceptCodes(
      [combinedTreatmentCode, createHistoricalTreatmentCode],
      publishedCompatibility,
    );
    assert.deepEqual(
      publishedProfileCodes,
      [combinedActiveThemeCode, createdThemeCode].sort(),
      'company tax profile codes must canonicalize through the published merge-produced map',
    );

    const publishedCuratorDecisions = resolveCuratorDecisions(
      [
        {
          concept_code: combinedTreatmentCode,
          action: 'ADD',
          rationale: 'TAX-12 published runtime compatibility fixture',
          created_at: new Date('2026-10-07T00:00:00Z'),
          id: 'tax12-published-runtime-fixture',
        },
      ],
      publishedCompatibility,
    );
    assert.equal(
      publishedCuratorDecisions.get(combinedActiveThemeCode)?.concept_code,
      combinedActiveThemeCode,
      'historical curator decisions must resolve through the published merge-produced map',
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
