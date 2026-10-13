import type { PoolClient } from 'pg';

import {
  canonicalJson,
  compareCanonicalText,
} from './baseline.canonical-json.js';
import {
  FORBIDDEN_MIT_CODES,
} from './baseline.constants.js';
import {
  expectedConceptRevision,
  expectedDimensionRevision,
} from './baseline.planner.js';
import type {
  BaselineManifest,
  BaselineReadback,
} from './baseline.types.js';

export async function readBaselineState(
  client: PoolClient,
): Promise<BaselineReadback> {
  const release = await client.query<{
    id: string;
    version: string;
    status: string;
    manifest: Record<string, unknown>;
  }>(
    [
      'SELECT id, version, status, manifest',
      'FROM taxonomy_releases',
      'WHERE version_major = 1',
      '  AND version_minor = 0',
      '  AND version_patch = 0',
      'LIMIT 1',
    ].join('\n'),
  );

  const releaseRow = release.rows[0];

  if (!releaseRow) {
    return {
      dimensions: 0,
      concepts: 0,
      needsEvidence: 0,
      lexicalAliases: 0,
      aliasBindings: 0,
      relationTypes: 0,
      relationRules: 0,
      relations: 0,
      creditAliasIdentities: 0,
      creditAmbiguousBindings: 0,
      forbiddenMit: 0,
      releaseVersion: null,
      releaseStatus: null,
      manifestSha256: null,
      derivationFingerprint: null,
    };
  }

  const [
    dimensions,
    concepts,
    needs,
    aliases,
    bindings,
    relationTypes,
    relationRules,
    relations,
    creditAliases,
    creditBindings,
    forbidden,
  ] = await Promise.all([
    client.query<{ count: string }>(
      [
        'SELECT count(*)::text AS count',
        'FROM taxonomy_release_dimensions',
        'WHERE release_id = $1',
      ].join('\n'),
      [releaseRow.id],
    ),
    client.query<{ count: string }>(
      [
        'SELECT count(*)::text AS count',
        'FROM taxonomy_release_concepts',
        'WHERE release_id = $1',
      ].join('\n'),
      [releaseRow.id],
    ),
    client.query<{ count: string }>(
      [
        'SELECT count(*)::text AS count',
        'FROM taxonomy_release_concepts rc',
        'JOIN taxonomy_concept_revisions cr',
        '  ON cr.id = rc.concept_revision_id',
        'WHERE rc.release_id = $1',
        "  AND cr.evidence_status = 'NEEDS_EVIDENCE'",
      ].join('\n'),
      [releaseRow.id],
    ),
    client.query<{ count: string }>(
      [
        'SELECT count(DISTINCT alias_id)::text AS count',
        'FROM taxonomy_release_alias_bindings',
        'WHERE release_id = $1',
      ].join('\n'),
      [releaseRow.id],
    ),
    client.query<{ count: string }>(
      [
        'SELECT count(*)::text AS count',
        'FROM taxonomy_release_alias_bindings',
        'WHERE release_id = $1',
      ].join('\n'),
      [releaseRow.id],
    ),
    client.query<{ count: string }>(
      [
        'SELECT count(*)::text AS count',
        'FROM taxonomy_relation_types',
        'WHERE code = ANY($1::text[])',
      ].join('\n'),
      [[
        'narrower_than',
        'broader_than',
        'part_of',
        'related_to',
        'replaced_by',
        'supersedes',
        'applies_to',
      ]],
    ),
    client.query<{ count: string }>(
      [
        'SELECT count(*)::text AS count',
        'FROM taxonomy_release_relation_rules',
        'WHERE release_id = $1',
      ].join('\n'),
      [releaseRow.id],
    ),
    client.query<{ count: string }>(
      [
        'SELECT count(*)::text AS count',
        'FROM taxonomy_concept_relations',
        'WHERE release_id = $1',
      ].join('\n'),
      [releaseRow.id],
    ),
    client.query<{ count: string }>(
      [
        'SELECT count(*)::text AS count',
        'FROM taxonomy_aliases',
        "WHERE normalized_text = 'credito'",
        "  AND language = 'pt-BR'",
      ].join('\n'),
    ),
    client.query<{ count: string }>(
      [
        'SELECT count(*)::text AS count',
        'FROM taxonomy_release_alias_bindings b',
        'JOIN taxonomy_aliases a',
        '  ON a.id = b.alias_id',
        'WHERE b.release_id = $1',
        "  AND a.normalized_text = 'credito'",
        "  AND a.language = 'pt-BR'",
        "  AND b.alias_type = 'AMBIGUOUS'",
      ].join('\n'),
      [releaseRow.id],
    ),
    client.query<{ count: string }>(
      [
        'SELECT count(*)::text AS count',
        'FROM taxonomy_release_concepts rc',
        'JOIN taxonomy_concepts c',
        '  ON c.id = rc.concept_id',
        'WHERE rc.release_id = $1',
        '  AND c.code = ANY($2::text[])',
      ].join('\n'),
      [releaseRow.id, [...FORBIDDEN_MIT_CODES]],
    ),
  ]);

  const storedManifest = releaseRow.manifest;

  return {
    dimensions: Number(dimensions.rows[0]?.count ?? 0),
    concepts: Number(concepts.rows[0]?.count ?? 0),
    needsEvidence: Number(needs.rows[0]?.count ?? 0),
    lexicalAliases: Number(aliases.rows[0]?.count ?? 0),
    aliasBindings: Number(bindings.rows[0]?.count ?? 0),
    relationTypes: Number(
      relationTypes.rows[0]?.count ?? 0,
    ),
    relationRules: Number(
      relationRules.rows[0]?.count ?? 0,
    ),
    relations: Number(relations.rows[0]?.count ?? 0),
    creditAliasIdentities: Number(
      creditAliases.rows[0]?.count ?? 0,
    ),
    creditAmbiguousBindings: Number(
      creditBindings.rows[0]?.count ?? 0,
    ),
    forbiddenMit: Number(forbidden.rows[0]?.count ?? 0),
    releaseVersion: releaseRow.version,
    releaseStatus: releaseRow.status,
    manifestSha256:
      typeof storedManifest.manifestSha256 === 'string'
        ? storedManifest.manifestSha256
        : null,
    derivationFingerprint:
      typeof storedManifest.derivationFingerprint === 'string'
        ? storedManifest.derivationFingerprint
        : null,
  };
}

function assertSemanticEqual(
  label: string,
  actual: unknown,
  expected: unknown,
): void {
  const actualJson = canonicalJson(actual);
  const expectedJson = canonicalJson(expected);

  if (actualJson !== expectedJson) {
    let detail = '';

    if (Array.isArray(actual) && Array.isArray(expected)) {
      const limit = Math.max(actual.length, expected.length);

      for (let index = 0; index < limit; index += 1) {
        const actualItem = actual[index];
        const expectedItem = expected[index];

        if (
          canonicalJson(actualItem) !==
          canonicalJson(expectedItem)
        ) {
          detail =
            ' firstDifferenceIndex=' +
            String(index) +
            ' actual=' +
            canonicalJson(actualItem) +
            ' expected=' +
            canonicalJson(expectedItem);
          break;
        }
      }
    }

    throw new Error(
      'BASELINE_SEMANTIC_READBACK_MISMATCH: ' +
        label +
        detail,
    );
  }
}

export async function assertBaselineSemanticReadback(
  client: PoolClient,
  manifest: BaselineManifest,
  releaseId: string,
): Promise<void> {
  const dimensionRows = await client.query<{
    code: string;
    name: string;
    description: string | null;
    governance_status: string;
    constraints: Record<string, unknown>;
  }>(
    [
      'SELECT',
      '  d.code, dr.name, dr.description,',
      '  dr.governance_status, dr.constraints',
      'FROM taxonomy_release_dimensions rd',
      'JOIN taxonomy_dimensions d ON d.id = rd.dimension_id',
      'JOIN taxonomy_dimension_revisions dr',
      '  ON dr.id = rd.dimension_revision_id',
      'WHERE rd.release_id = $1',
      'ORDER BY d.code',
    ].join('\n'),
    [releaseId],
  );

  const actualDimensions = dimensionRows.rows
    .map((row) => ({
      code: row.code,
      ...{
        name: row.name,
        description: row.description,
        governance_status: row.governance_status,
        constraints: row.constraints,
      },
    }))
    .sort((left, right) =>
      compareCanonicalText(left.code, right.code),
    );
  const expectedDimensions = manifest.dimensions
    .map((dimension) => ({
      code: dimension.code,
      ...expectedDimensionRevision(dimension),
    }))
    .sort((left, right) =>
      compareCanonicalText(left.code, right.code),
    );

  assertSemanticEqual(
    'release dimensions/revisions',
    actualDimensions,
    expectedDimensions,
  );

  const conceptRows = await client.query<{
    code: string;
    dimension_code: string;
    label: string;
    definition: string;
    positive_example: string | null;
    negative_example: string | null;
    governance_status: string;
    evidence_status: string;
    notes: string | null;
    source_metadata: Record<string, unknown>;
  }>(
    [
      'SELECT',
      '  c.code, d.code AS dimension_code,',
      '  cr.label, cr.definition,',
      '  cr.positive_example, cr.negative_example,',
      '  cr.governance_status, cr.evidence_status,',
      '  cr.notes, cr.source_metadata',
      'FROM taxonomy_release_concepts rc',
      'JOIN taxonomy_concepts c ON c.id = rc.concept_id',
      'JOIN taxonomy_dimensions d ON d.id = c.dimension_id',
      'JOIN taxonomy_concept_revisions cr',
      '  ON cr.id = rc.concept_revision_id',
      'WHERE rc.release_id = $1',
      'ORDER BY c.code',
    ].join('\n'),
    [releaseId],
  );

  const actualConcepts = conceptRows.rows
    .map((row) => ({
      code: row.code,
      dimensionCode: row.dimension_code,
      revision: {
        label: row.label,
        definition: row.definition,
        positive_example: row.positive_example ?? '',
        negative_example: row.negative_example ?? '',
        governance_status: row.governance_status,
        evidence_status: row.evidence_status,
        notes: row.notes,
        source_metadata: row.source_metadata,
      },
    }))
    .sort((left, right) =>
      compareCanonicalText(left.code, right.code),
    );
  const expectedConcepts = manifest.concepts
    .map((concept) => ({
      code: concept.code,
      dimensionCode: concept.dimensionCode,
      revision: expectedConceptRevision(concept),
    }))
    .sort((left, right) =>
      compareCanonicalText(left.code, right.code),
    );

  assertSemanticEqual(
    'release concepts/revisions',
    actualConcepts,
    expectedConcepts,
  );

  const aliasRows = await client.query<{
    text: string;
    normalized_text: string;
    language: string;
    target_code: string;
    alias_type: string;
    decision_status: string;
    context: Record<string, unknown>;
    justification: string | null;
    evidence_status: string;
  }>(
    [
      'SELECT',
      '  a.text, a.normalized_text, a.language,',
      '  c.code AS target_code,',
      '  b.alias_type, b.decision_status, b.context,',
      '  b.justification, b.evidence_status',
      'FROM taxonomy_release_alias_bindings b',
      'JOIN taxonomy_aliases a ON a.id = b.alias_id',
      'JOIN taxonomy_release_concepts rc',
      '  ON rc.id = b.release_concept_id',
      ' AND rc.release_id = b.release_id',
      'JOIN taxonomy_concepts c ON c.id = rc.concept_id',
      'WHERE b.release_id = $1',
    ].join('\n'),
    [releaseId],
  );

  const actualAliases = aliasRows.rows
    .map((row) => ({
      text: row.text,
      normalizedText: row.normalized_text,
      language: row.language,
      targetConceptCode: row.target_code,
      aliasType: row.alias_type,
      decisionStatus: row.decision_status,
      context: row.context,
      justification: row.justification ?? '',
      evidenceStatus: row.evidence_status,
    }))
    .sort((left, right) =>
      compareCanonicalText(
        [
          left.normalizedText,
          left.language,
          left.targetConceptCode,
          left.aliasType,
        ].join('|'),
        [
          right.normalizedText,
          right.language,
          right.targetConceptCode,
          right.aliasType,
        ].join('|'),
      ),
    );

  const expectedAliases = manifest.aliases
    .flatMap((alias) =>
      alias.bindings.map((binding) => ({
        text: alias.text,
        normalizedText: alias.normalizedText,
        language: alias.language,
        targetConceptCode: binding.targetConceptCode,
        aliasType: binding.aliasType,
        decisionStatus: alias.decisionStatus,
        context: alias.context,
        justification: alias.justification,
        evidenceStatus: alias.evidenceStatus,
      })),
    )
    .sort((left, right) =>
      compareCanonicalText(
        [
          left.normalizedText,
          left.language,
          left.targetConceptCode,
          left.aliasType,
        ].join('|'),
        [
          right.normalizedText,
          right.language,
          right.targetConceptCode,
          right.aliasType,
        ].join('|'),
      ),
    );

  assertSemanticEqual(
    'release alias bindings',
    actualAliases,
    expectedAliases,
  );

  const relationTypeRows = await client.query<{
    code: string;
    inverse_code: string | null;
    directed: boolean;
    acyclic: boolean;
    hierarchical: boolean;
    canonical_storage_code: string;
  }>(
    [
      'SELECT',
      '  code, inverse_code, directed, acyclic,',
      '  hierarchical, canonical_storage_code',
      'FROM taxonomy_relation_types',
      'WHERE code = ANY($1::text[])',
    ].join('\n'),
    [manifest.relationTypes.map((type) => type.code)],
  );

  const actualRelationTypes = relationTypeRows.rows
    .map((row) => ({
      code: row.code,
      inverseCode: row.inverse_code,
      directed: row.directed,
      acyclic: row.acyclic,
      hierarchical: row.hierarchical,
      canonicalStorageCode: row.canonical_storage_code,
    }))
    .sort((left, right) =>
      compareCanonicalText(left.code, right.code),
    );
  const expectedRelationTypes = [...manifest.relationTypes]
    .sort((left, right) =>
      compareCanonicalText(left.code, right.code),
    );

  assertSemanticEqual(
    'relation types',
    actualRelationTypes,
    expectedRelationTypes,
  );

  const ruleRows = await client.query<{
    relation_type: string;
    source_dimension: string;
    target_dimension: string;
    allowed: boolean;
    requires_evidence: boolean;
    acyclic_override: boolean | null;
    notes: string | null;
  }>(
    [
      'SELECT',
      '  rt.code AS relation_type,',
      '  sd.code AS source_dimension,',
      '  td.code AS target_dimension,',
      '  rr.allowed, rr.requires_evidence,',
      '  rr.acyclic_override, rr.notes',
      'FROM taxonomy_release_relation_rules rr',
      'JOIN taxonomy_relation_types rt',
      '  ON rt.id = rr.relation_type_id',
      'JOIN taxonomy_dimensions sd',
      '  ON sd.id = rr.source_dimension_id',
      'JOIN taxonomy_dimensions td',
      '  ON td.id = rr.target_dimension_id',
      'WHERE rr.release_id = $1',
    ].join('\n'),
    [releaseId],
  );

  const actualRules = ruleRows.rows
    .map((row) => ({
      relationType: row.relation_type,
      sourceDimension: row.source_dimension,
      targetDimension: row.target_dimension,
      allowed: row.allowed,
      requiresEvidence: row.requires_evidence,
      acyclicOverride: row.acyclic_override,
      sourceLocator: row.notes ?? '',
    }))
    .sort((left, right) =>
      compareCanonicalText(
        [
          left.relationType,
          left.sourceDimension,
          left.targetDimension,
        ].join('|'),
        [
          right.relationType,
          right.sourceDimension,
          right.targetDimension,
        ].join('|'),
      ),
    );
  const expectedRules = manifest.relationRules
    .map((rule) => ({
      relationType: rule.relationType,
      sourceDimension: rule.sourceDimension,
      targetDimension: rule.targetDimension,
      allowed: rule.allowed,
      requiresEvidence: rule.requiresEvidence,
      acyclicOverride: rule.acyclicOverride,
      sourceLocator: rule.derivation.sourceLocator,
    }))
    .sort((left, right) =>
      compareCanonicalText(
        [
          left.relationType,
          left.sourceDimension,
          left.targetDimension,
        ].join('|'),
        [
          right.relationType,
          right.sourceDimension,
          right.targetDimension,
        ].join('|'),
      ),
    );

  assertSemanticEqual(
    'release relation rules',
    actualRules,
    expectedRules,
  );

  const relationRows = await client.query<{
    source_code: string;
    relation_type: string;
    target_code: string;
    status: string;
    qualifiers: Record<string, unknown>;
    justification: string | null;
    evidence_status: string;
  }>(
    [
      'SELECT',
      '  sc.code AS source_code,',
      '  rt.code AS relation_type,',
      '  tc.code AS target_code,',
      '  cr.status, cr.qualifiers,',
      '  cr.justification, cr.evidence_status',
      'FROM taxonomy_concept_relations cr',
      'JOIN taxonomy_relation_types rt',
      '  ON rt.id = cr.relation_type_id',
      'JOIN taxonomy_release_concepts src',
      '  ON src.id = cr.source_release_concept_id',
      ' AND src.release_id = cr.release_id',
      'JOIN taxonomy_concepts sc ON sc.id = src.concept_id',
      'JOIN taxonomy_release_concepts dst',
      '  ON dst.id = cr.target_release_concept_id',
      ' AND dst.release_id = cr.release_id',
      'JOIN taxonomy_concepts tc ON tc.id = dst.concept_id',
      'WHERE cr.release_id = $1',
    ].join('\n'),
    [releaseId],
  );

  const actualRelations = relationRows.rows
    .map((row) => ({
      sourceConceptCode: row.source_code,
      relationType: row.relation_type,
      targetConceptCode: row.target_code,
      status: row.status,
      qualifiers: row.qualifiers,
      justification: row.justification ?? '',
      evidenceStatus: row.evidence_status,
    }))
    .sort((left, right) =>
      compareCanonicalText(
        [
          left.relationType,
          left.sourceConceptCode,
          left.targetConceptCode,
          canonicalJson(left.qualifiers),
        ].join('|'),
        [
          right.relationType,
          right.sourceConceptCode,
          right.targetConceptCode,
          canonicalJson(right.qualifiers),
        ].join('|'),
      ),
    );
  const expectedRelations = manifest.relations
    .map((relation) => ({
      sourceConceptCode: relation.sourceConceptCode,
      relationType: relation.relationType,
      targetConceptCode: relation.targetConceptCode,
      status: relation.status,
      qualifiers: relation.qualifiers,
      justification: relation.sourceLocator,
      evidenceStatus: relation.evidenceStatus,
    }))
    .sort((left, right) =>
      compareCanonicalText(
        [
          left.relationType,
          left.sourceConceptCode,
          left.targetConceptCode,
          canonicalJson(left.qualifiers),
        ].join('|'),
        [
          right.relationType,
          right.sourceConceptCode,
          right.targetConceptCode,
          canonicalJson(right.qualifiers),
        ].join('|'),
      ),
    );

  assertSemanticEqual(
    'release relations',
    actualRelations,
    expectedRelations,
  );

  const mappingCount = await client.query<{ count: string }>(
    [
      'SELECT count(*)::text AS count',
      'FROM taxonomy_official_mappings',
      'WHERE release_id = $1',
    ].join('\n'),
    [releaseId],
  );

  assertSemanticEqual(
    'release official mappings',
    Number(mappingCount.rows[0]?.count ?? 0),
    0,
  );
}
