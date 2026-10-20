import type { PoolClient } from 'pg';

import {
  expectedConceptRevision,
  expectedDimensionRevision,
} from './baseline.planner.js';
import type {
  BaselineAlias,
  BaselineConcept,
  BaselineDimension,
  BaselineManifest,
  RelationTypeSeed,
} from './baseline.types.js';
import { canonicalJson } from './baseline.canonical-json.js';

export interface PersistedBaselineContext {
  releaseId: string;
  dimensionIds: Map<string, string>;
  dimensionRevisionIds: Map<string, string>;
  conceptIds: Map<string, string>;
  conceptRevisionIds: Map<string, string>;
  releaseConceptIds: Map<string, string>;
  relationTypeIds: Map<string, string>;
  aliasIds: Map<string, string>;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

async function ensureDimension(
  client: PoolClient,
  dimension: BaselineDimension,
): Promise<{ identityId: string; revisionId: string }> {
  const identity = await client.query<{
    id: string;
    identity_status: string;
  }>(
    [
      'SELECT id, identity_status',
      'FROM taxonomy_dimensions',
      'WHERE code = $1',
    ].join('\n'),
    [dimension.code],
  );

  let identityId: string;

  if (!identity.rows[0]) {
    const inserted = await client.query<{ id: string }>(
      [
        'INSERT INTO taxonomy_dimensions (',
        '  code, identity_status',
        ') VALUES ($1, $2)',
        'RETURNING id',
      ].join('\n'),
      [dimension.code, dimension.identityStatus],
    );
    identityId = inserted.rows[0]?.id ?? '';

    if (!identityId) {
      throw new Error(
        'BASELINE_PERSISTENCE_FAILURE: dimension identity insert returned no id',
      );
    }
  } else {
    identityId = identity.rows[0].id;

    if (
      identity.rows[0].identity_status !==
      dimension.identityStatus
    ) {
      throw new Error(
        'DIMENSION_IDENTITY_CONFLICT: ' + dimension.code,
      );
    }
  }

  const revision = await client.query<{
    id: string;
    revision_no: number;
    name: string;
    description: string | null;
    governance_status: string;
    constraints: Record<string, unknown>;
  }>(
    [
      'SELECT',
      '  id, revision_no, name, description,',
      '  governance_status, constraints',
      'FROM taxonomy_dimension_revisions',
      'WHERE dimension_id = $1',
      'ORDER BY revision_no DESC',
      'LIMIT 1',
    ].join('\n'),
    [identityId],
  );

  const expected = expectedDimensionRevision(dimension);
  const current = revision.rows[0];

  if (
    current &&
    sameJson(
      {
        name: current.name,
        description: current.description ?? '',
        governance_status: current.governance_status,
        constraints: current.constraints,
      },
      expected,
    )
  ) {
    return {
      identityId,
      revisionId: current.id,
    };
  }

  const insertedRevision = await client.query<{
    id: string;
  }>(
    [
      'INSERT INTO taxonomy_dimension_revisions (',
      '  dimension_id, revision_no, name, description,',
      '  governance_status, constraints',
      ') VALUES (',
      '  $1, $2, $3, $4, $5, $6::jsonb',
      ') RETURNING id',
    ].join('\n'),
    [
      identityId,
      (current?.revision_no ?? 0) + 1,
      expected.name,
      expected.description,
      expected.governance_status,
      JSON.stringify(expected.constraints),
    ],
  );

  const revisionId = insertedRevision.rows[0]?.id;

  if (!revisionId) {
    throw new Error(
      'BASELINE_PERSISTENCE_FAILURE: dimension revision insert returned no id',
    );
  }

  return { identityId, revisionId };
}

async function ensureConcept(
  client: PoolClient,
  concept: BaselineConcept,
  dimensionId: string,
): Promise<{ identityId: string; revisionId: string }> {
  const identity = await client.query<{
    id: string;
    dimension_id: string;
    identity_status: string;
  }>(
    [
      'SELECT id, dimension_id, identity_status',
      'FROM taxonomy_concepts',
      'WHERE code = $1',
    ].join('\n'),
    [concept.code],
  );

  let identityId: string;

  if (!identity.rows[0]) {
    const inserted = await client.query<{ id: string }>(
      [
        'INSERT INTO taxonomy_concepts (',
        '  code, dimension_id, identity_status',
        ') VALUES ($1, $2, $3)',
        'RETURNING id',
      ].join('\n'),
      [
        concept.code,
        dimensionId,
        'CURRENT',
      ],
    );

    identityId = inserted.rows[0]?.id ?? '';

    if (!identityId) {
      throw new Error(
        'BASELINE_PERSISTENCE_FAILURE: concept identity insert returned no id',
      );
    }
  } else {
    identityId = identity.rows[0].id;

    if (
      identity.rows[0].dimension_id !== dimensionId ||
      identity.rows[0].identity_status !== 'CURRENT'
    ) {
      throw new Error(
        'CONCEPT_IDENTITY_CONFLICT: ' + concept.code,
      );
    }
  }

  const revision = await client.query<{
    id: string;
    revision_no: number;
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
      '  id, revision_no, label, definition,',
      '  positive_example, negative_example,',
      '  governance_status, evidence_status, notes,',
      '  source_metadata',
      'FROM taxonomy_concept_revisions',
      'WHERE concept_id = $1',
      'ORDER BY revision_no DESC',
      'LIMIT 1',
    ].join('\n'),
    [identityId],
  );

  const expected = expectedConceptRevision(concept);
  const current = revision.rows[0];

  if (
    current &&
    sameJson(
      {
        label: current.label,
        definition: current.definition,
        positive_example:
          current.positive_example ?? '',
        negative_example:
          current.negative_example ?? '',
        governance_status: current.governance_status,
        evidence_status: current.evidence_status,
        notes: current.notes,
        source_metadata: current.source_metadata,
      },
      expected,
    )
  ) {
    return {
      identityId,
      revisionId: current.id,
    };
  }

  const insertedRevision = await client.query<{
    id: string;
  }>(
    [
      'INSERT INTO taxonomy_concept_revisions (',
      '  concept_id, revision_no, label, definition,',
      '  positive_example, negative_example,',
      '  governance_status, evidence_status, notes,',
      '  source_metadata',
      ') VALUES (',
      '  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb',
      ') RETURNING id',
    ].join('\n'),
    [
      identityId,
      (current?.revision_no ?? 0) + 1,
      expected.label,
      expected.definition,
      expected.positive_example,
      expected.negative_example,
      expected.governance_status,
      expected.evidence_status,
      expected.notes,
      JSON.stringify(expected.source_metadata),
    ],
  );

  const revisionId = insertedRevision.rows[0]?.id;

  if (!revisionId) {
    throw new Error(
      'BASELINE_PERSISTENCE_FAILURE: concept revision insert returned no id',
    );
  }

  return { identityId, revisionId };
}

async function ensureRelationType(
  client: PoolClient,
  seed: RelationTypeSeed,
): Promise<string> {
  const existing = await client.query<{
    id: string;
    inverse_code: string | null;
    directed: boolean;
    acyclic: boolean;
    hierarchical: boolean;
    canonical_storage_code: string;
  }>(
    [
      'SELECT',
      '  id, inverse_code, directed, acyclic,',
      '  hierarchical, canonical_storage_code',
      'FROM taxonomy_relation_types',
      'WHERE code = $1',
    ].join('\n'),
    [seed.code],
  );

  const row = existing.rows[0];

  if (row) {
    if (
      row.inverse_code !== seed.inverseCode ||
      row.directed !== seed.directed ||
      row.acyclic !== seed.acyclic ||
      row.hierarchical !== seed.hierarchical ||
      row.canonical_storage_code !==
        seed.canonicalStorageCode
    ) {
      throw new Error(
        'RELATION_TYPE_CONFLICT: ' + seed.code,
      );
    }

    return row.id;
  }

  const inserted = await client.query<{ id: string }>(
    [
      'INSERT INTO taxonomy_relation_types (',
      '  code, inverse_code, directed, acyclic,',
      '  hierarchical, canonical_storage_code, description',
      ') VALUES ($1, $2, $3, $4, $5, $6, $7)',
      'RETURNING id',
    ].join('\n'),
    [
      seed.code,
      seed.inverseCode,
      seed.directed,
      seed.acyclic,
      seed.hierarchical,
      seed.canonicalStorageCode,
      'relation-seed-contract/v1',
    ],
  );

  const id = inserted.rows[0]?.id;

  if (!id) {
    throw new Error(
      'BASELINE_PERSISTENCE_FAILURE: relation type insert returned no id',
    );
  }

  return id;
}

async function ensureAlias(
  client: PoolClient,
  alias: BaselineAlias,
): Promise<string> {
  const existing = await client.query<{
    id: string;
    text: string;
  }>(
    [
      'SELECT id, text',
      'FROM taxonomy_aliases',
      'WHERE normalized_text = $1',
      '  AND language = $2',
    ].join('\n'),
    [alias.normalizedText, alias.language],
  );

  const row = existing.rows[0];

  if (row) {
    if (row.text !== alias.text) {
      throw new Error(
        'ALIAS_IDENTITY_CONFLICT: ' + alias.normalizedText,
      );
    }

    return row.id;
  }

  const inserted = await client.query<{ id: string }>(
    [
      'INSERT INTO taxonomy_aliases (',
      '  text, normalized_text, language',
      ') VALUES ($1, $2, $3)',
      'RETURNING id',
    ].join('\n'),
    [
      alias.text,
      alias.normalizedText,
      alias.language,
    ],
  );

  const id = inserted.rows[0]?.id;

  if (!id) {
    throw new Error(
      'BASELINE_PERSISTENCE_FAILURE: alias insert returned no id',
    );
  }

  return id;
}

export async function ensureBaselineIdentities(
  client: PoolClient,
  manifest: BaselineManifest,
): Promise<Omit<
  PersistedBaselineContext,
  'releaseId' | 'releaseConceptIds' | 'aliasIds'
>> {
  const dimensionIds = new Map<string, string>();
  const dimensionRevisionIds = new Map<string, string>();

  for (const dimension of manifest.dimensions) {
    const persisted = await ensureDimension(
      client,
      dimension,
    );
    dimensionIds.set(
      dimension.code,
      persisted.identityId,
    );
    dimensionRevisionIds.set(
      dimension.code,
      persisted.revisionId,
    );
  }

  const conceptIds = new Map<string, string>();
  const conceptRevisionIds = new Map<string, string>();

  for (const concept of manifest.concepts) {
    const dimensionId = dimensionIds.get(
      concept.dimensionCode,
    );

    if (!dimensionId) {
      throw new Error(
        'BASELINE_PERSISTENCE_FAILURE: missing dimension id for ' +
          concept.code,
      );
    }

    const persisted = await ensureConcept(
      client,
      concept,
      dimensionId,
    );
    conceptIds.set(concept.code, persisted.identityId);
    conceptRevisionIds.set(
      concept.code,
      persisted.revisionId,
    );
  }

  const relationTypeIds = new Map<string, string>();

  for (const relationType of manifest.relationTypes) {
    relationTypeIds.set(
      relationType.code,
      await ensureRelationType(client, relationType),
    );
  }

  return {
    dimensionIds,
    dimensionRevisionIds,
    conceptIds,
    conceptRevisionIds,
    relationTypeIds,
  };
}

export async function createBaselineRelease(
  client: PoolClient,
  manifest: BaselineManifest,
  manifestHash: string,
): Promise<string> {
  const releaseManifest = {
    manifestVersion: manifest.manifestVersion,
    manifestSha256: manifestHash,
    derivationFingerprint:
      manifest.derivation.fingerprint,
    parserVersion: manifest.derivation.parserVersion,
    relationSeedContractVersion:
      manifest.derivation.relationSeedContractVersion,
    source: manifest.source,
    technicalContract: manifest.technicalContract,
    counts: {
      dimensions: manifest.expected.dimensions,
      concepts: manifest.expected.concepts,
      needsEvidence: manifest.expected.needsEvidence,
      lexicalAliases:
        manifest.expected.lexicalAliasCount,
      aliasBindings:
        manifest.expected.aliasBindingCount,
    },
  };

  const result = await client.query<{ id: string }>(
    [
      'INSERT INTO taxonomy_releases (',
      '  version_major, version_minor, version_patch,',
      '  status,',
      '  artifact_repository, artifact_path,',
      '  artifact_git_sha, artifact_sha256,',
      '  manifest, change_notes, created_by_actor',
      ') VALUES (',
      '  1, 0, 0,',
      "  'DRAFT',",
      '  $1, $2, $3, $4, $5::jsonb, $6, $7',
      ') RETURNING id',
    ].join('\n'),
    [
      manifest.source.repository,
      manifest.source.path,
      manifest.source.gitSha,
      manifest.source.sha256,
      JSON.stringify(releaseManifest),
      'TriBusca taxonomy baseline R6',
      'system:taxonomy-baseline-importer',
    ],
  );

  const id = result.rows[0]?.id;

  if (!id) {
    throw new Error(
      'BASELINE_PERSISTENCE_FAILURE: release insert returned no id',
    );
  }

  return id;
}

export async function persistReleaseMemberships(
  client: PoolClient,
  manifest: BaselineManifest,
  context: {
    releaseId: string;
    dimensionIds: Map<string, string>;
    dimensionRevisionIds: Map<string, string>;
    conceptIds: Map<string, string>;
    conceptRevisionIds: Map<string, string>;
  },
): Promise<Map<string, string>> {
  for (const dimension of manifest.dimensions) {
    const dimensionId = context.dimensionIds.get(
      dimension.code,
    );
    const revisionId =
      context.dimensionRevisionIds.get(dimension.code);

    if (!dimensionId || !revisionId) {
      throw new Error(
        'BASELINE_PERSISTENCE_FAILURE: incomplete dimension persistence context',
      );
    }

    await client.query(
      [
        'INSERT INTO taxonomy_release_dimensions (',
        '  release_id, dimension_id, dimension_revision_id',
        ') VALUES ($1, $2, $3)',
      ].join('\n'),
      [context.releaseId, dimensionId, revisionId],
    );
  }

  const releaseConceptIds = new Map<string, string>();

  for (const concept of manifest.concepts) {
    const conceptId = context.conceptIds.get(
      concept.code,
    );
    const revisionId =
      context.conceptRevisionIds.get(concept.code);

    if (!conceptId || !revisionId) {
      throw new Error(
        'BASELINE_PERSISTENCE_FAILURE: incomplete concept persistence context',
      );
    }

    const result = await client.query<{ id: string }>(
      [
        'INSERT INTO taxonomy_release_concepts (',
        '  release_id, concept_id, concept_revision_id',
        ') VALUES ($1, $2, $3)',
        'RETURNING id',
      ].join('\n'),
      [context.releaseId, conceptId, revisionId],
    );

    const releaseConceptId = result.rows[0]?.id;

    if (!releaseConceptId) {
      throw new Error(
        'BASELINE_PERSISTENCE_FAILURE: release concept insert returned no id',
      );
    }

    releaseConceptIds.set(
      concept.code,
      releaseConceptId,
    );
  }

  return releaseConceptIds;
}

export async function persistAliases(
  client: PoolClient,
  manifest: BaselineManifest,
  releaseId: string,
  releaseConceptIds: Map<string, string>,
): Promise<Map<string, string>> {
  const aliasIds = new Map<string, string>();

  for (const alias of manifest.aliases) {
    const aliasId = await ensureAlias(client, alias);
    aliasIds.set(
      alias.normalizedText + '|' + alias.language,
      aliasId,
    );

    for (const binding of alias.bindings) {
      const releaseConceptId = releaseConceptIds.get(
        binding.targetConceptCode,
      );

      if (!releaseConceptId) {
        throw new Error(
          'BASELINE_PERSISTENCE_FAILURE: unresolved alias target ' +
            binding.targetConceptCode,
        );
      }

      await client.query(
        [
          'INSERT INTO taxonomy_release_alias_bindings (',
          '  release_id, alias_id, release_concept_id,',
          '  alias_type, decision_status, context,',
          '  justification, evidence_status',
          ') VALUES (',
          '  $1, $2, $3, $4, $5, $6::jsonb, $7, $8',
          ')',
        ].join('\n'),
        [
          releaseId,
          aliasId,
          releaseConceptId,
          binding.aliasType,
          alias.decisionStatus,
          JSON.stringify(alias.context),
          alias.justification,
          alias.evidenceStatus,
        ],
      );
    }
  }

  return aliasIds;
}

export async function persistRelations(
  client: PoolClient,
  manifest: BaselineManifest,
  context: {
    releaseId: string;
    dimensionIds: Map<string, string>;
    releaseConceptIds: Map<string, string>;
    relationTypeIds: Map<string, string>;
  },
): Promise<void> {
  for (const rule of manifest.relationRules) {
    const relationTypeId =
      context.relationTypeIds.get(rule.relationType);
    const sourceDimensionId =
      context.dimensionIds.get(rule.sourceDimension);
    const targetDimensionId =
      context.dimensionIds.get(rule.targetDimension);

    if (
      !relationTypeId ||
      !sourceDimensionId ||
      !targetDimensionId
    ) {
      throw new Error(
        'BASELINE_PERSISTENCE_FAILURE: unresolved relation rule',
      );
    }

    await client.query(
      [
        'INSERT INTO taxonomy_release_relation_rules (',
        '  release_id, relation_type_id,',
        '  source_dimension_id, target_dimension_id,',
        '  allowed, requires_evidence,',
        '  acyclic_override, notes',
        ') VALUES (',
        '  $1, $2, $3, $4, $5, $6, $7, $8',
        ')',
      ].join('\n'),
      [
        context.releaseId,
        relationTypeId,
        sourceDimensionId,
        targetDimensionId,
        rule.allowed,
        rule.requiresEvidence,
        rule.acyclicOverride,
        rule.derivation.sourceLocator,
      ],
    );
  }

  for (const relation of manifest.relations) {
    const relationTypeId =
      context.relationTypeIds.get(
        relation.relationType,
      );
    const sourceReleaseConceptId =
      context.releaseConceptIds.get(
        relation.sourceConceptCode,
      );
    const targetReleaseConceptId =
      context.releaseConceptIds.get(
        relation.targetConceptCode,
      );

    if (
      !relationTypeId ||
      !sourceReleaseConceptId ||
      !targetReleaseConceptId
    ) {
      throw new Error(
        'BASELINE_PERSISTENCE_FAILURE: unresolved relation endpoint/type',
      );
    }

    await client.query(
      [
        'INSERT INTO taxonomy_concept_relations (',
        '  release_id,',
        '  source_release_concept_id,',
        '  target_release_concept_id,',
        '  relation_type_id,',
        '  status, qualifiers, justification, evidence_status',
        ') VALUES (',
        '  $1, $2, $3, $4,',
        '  $5, $6::jsonb, $7, $8',
        ')',
      ].join('\n'),
      [
        context.releaseId,
        sourceReleaseConceptId,
        targetReleaseConceptId,
        relationTypeId,
        relation.status,
        JSON.stringify(relation.qualifiers),
        relation.sourceLocator,
        relation.evidenceStatus,
      ],
    );
  }
}
