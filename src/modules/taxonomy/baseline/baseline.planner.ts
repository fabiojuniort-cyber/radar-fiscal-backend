import type { PoolClient } from 'pg';

import { canonicalJson } from './baseline.canonical-json.js';
import type {
  BaselineConcept,
  BaselineDimension,
  BaselineManifest,
  BaselinePersistencePlan,
  EntityPlan,
} from './baseline.types.js';

export function expectedDimensionRevision(
  dimension: BaselineDimension,
): {
  name: string;
  description: string | null;
  governance_status: string;
  constraints: Record<string, unknown>;
} {
  return {
    name: dimension.name,
    description: dimension.description,
    governance_status: dimension.governanceStatus,
    constraints: {
      manifestVersion:
        'tribusca.taxonomy.baseline-manifest/v1',
      expectedConceptCount:
        dimension.expectedConceptCount,
    },
  };
}

export function expectedConceptRevision(
  concept: BaselineConcept,
): {
  label: string;
  definition: string;
  positive_example: string;
  negative_example: string;
  governance_status: string;
  evidence_status: string;
  notes: null;
  source_metadata: Record<string, unknown>;
} {
  return {
    label: concept.label,
    definition: concept.definition,
    positive_example: concept.positiveExample,
    negative_example: concept.negativeExample,
    governance_status: concept.governanceStatus,
    evidence_status: concept.evidenceStatus,
    notes: null,
    source_metadata: concept.sourceMetadata,
  };
}

function sameRecord(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

interface DimensionRow {
  id: string;
  code: string;
  identity_status: string;
  revision_id: string | null;
  revision_no: number | null;
  name: string | null;
  description: string | null;
  governance_status: string | null;
  constraints: Record<string, unknown> | null;
}

interface ConceptRow {
  id: string;
  code: string;
  dimension_code: string;
  identity_status: string;
  revision_id: string | null;
  revision_no: number | null;
  label: string | null;
  definition: string | null;
  positive_example: string | null;
  negative_example: string | null;
  governance_status: string | null;
  evidence_status: string | null;
  notes: string | null;
  source_metadata: Record<string, unknown> | null;
}

export async function planBaselinePersistence(
  client: PoolClient,
  manifest: BaselineManifest,
  manifestHash: string,
): Promise<BaselinePersistencePlan> {
  const release = await client.query<{
    id: string;
    manifest: Record<string, unknown>;
  }>(
    [
      'SELECT id, manifest',
      'FROM taxonomy_releases',
      'WHERE version_major = 1',
      '  AND version_minor = 0',
      '  AND version_patch = 0',
    ].join('\n'),
  );

  let releaseAction:
    BaselinePersistencePlan['releaseAction'] =
    'CREATE_RELEASE';
  const conflicts: string[] = [];

  if (release.rows[0]) {
    const stored = release.rows[0].manifest;
    const storedHash =
      typeof stored.manifestSha256 === 'string'
        ? stored.manifestSha256
        : null;
    const storedFingerprint =
      typeof stored.derivationFingerprint === 'string'
        ? stored.derivationFingerprint
        : null;

    if (
      storedFingerprint === manifest.derivation.fingerprint &&
      storedHash === manifestHash
    ) {
      releaseAction = 'IDEMPOTENT_EXISTING_RELEASE';
    } else {
      releaseAction = 'VERSION_CONFLICT';
      conflicts.push('TARGET_VERSION_ALREADY_BOUND');
    }

  }

  const dimensionCodes = manifest.dimensions.map(
    (dimension) => dimension.code,
  );
  const dimensionRows = await client.query<DimensionRow>(
    [
      'SELECT',
      '  d.id,',
      '  d.code,',
      '  d.identity_status,',
      '  r.id AS revision_id,',
      '  r.revision_no,',
      '  r.name,',
      '  r.description,',
      '  r.governance_status,',
      '  r.constraints',
      'FROM taxonomy_dimensions d',
      'LEFT JOIN LATERAL (',
      '  SELECT *',
      '  FROM taxonomy_dimension_revisions dr',
      '  WHERE dr.dimension_id = d.id',
      '  ORDER BY dr.revision_no DESC',
      '  LIMIT 1',
      ') r ON true',
      'WHERE d.code = ANY($1::text[])',
    ].join('\n'),
    [dimensionCodes],
  );
  const dimensionByCode = new Map(
    dimensionRows.rows.map((row) => [row.code, row]),
  );

  const dimensions: EntityPlan[] =
    manifest.dimensions.map((dimension) => {
      const existing = dimensionByCode.get(dimension.code);

      if (!existing) {
        return {
          code: dimension.code,
          identityAction: 'CREATE_IDENTITY',
          revisionAction: 'CREATE_REVISION',
          reason: 'identity absent',
        };
      }

      if (existing.identity_status === 'RETIRED') {
        conflicts.push(
          'retired dimension identity: ' + dimension.code,
        );

        return {
          code: dimension.code,
          identityAction: 'CONFLICT',
          revisionAction: 'CONFLICT',
          reason: 'identity retired',
        };
      }

      if (!existing.revision_id) {
        return {
          code: dimension.code,
          identityAction: 'REUSE_IDENTITY',
          revisionAction: 'CREATE_REVISION',
          reason: 'identity exists without revision',
        };
      }

      const current = {
        name: existing.name ?? '',
        description: existing.description,
        governance_status:
          existing.governance_status ?? '',
        constraints: existing.constraints ?? {},
      };
      const expected = expectedDimensionRevision(dimension);

      return {
        code: dimension.code,
        identityAction: 'REUSE_IDENTITY',
        revisionAction: sameRecord(current, expected)
          ? 'REUSE_REVISION'
          : 'CREATE_REVISION',
        reason: sameRecord(current, expected)
          ? 'latest revision matches manifest'
          : 'latest revision differs from manifest',
      };
    });

  const conceptCodes = manifest.concepts.map(
    (concept) => concept.code,
  );
  const conceptRows = await client.query<ConceptRow>(
    [
      'SELECT',
      '  c.id,',
      '  c.code,',
      '  d.code AS dimension_code,',
      '  c.identity_status,',
      '  r.id AS revision_id,',
      '  r.revision_no,',
      '  r.label,',
      '  r.definition,',
      '  r.positive_example,',
      '  r.negative_example,',
      '  r.governance_status,',
      '  r.evidence_status,',
      '  r.notes,',
      '  r.source_metadata',
      'FROM taxonomy_concepts c',
      'JOIN taxonomy_dimensions d',
      '  ON d.id = c.dimension_id',
      'LEFT JOIN LATERAL (',
      '  SELECT *',
      '  FROM taxonomy_concept_revisions cr',
      '  WHERE cr.concept_id = c.id',
      '  ORDER BY cr.revision_no DESC',
      '  LIMIT 1',
      ') r ON true',
      'WHERE c.code = ANY($1::text[])',
    ].join('\n'),
    [conceptCodes],
  );
  const conceptByCode = new Map(
    conceptRows.rows.map((row) => [row.code, row]),
  );

  const concepts: EntityPlan[] = manifest.concepts.map(
    (concept) => {
      const existing = conceptByCode.get(concept.code);

      if (!existing) {
        return {
          code: concept.code,
          identityAction: 'CREATE_IDENTITY',
          revisionAction: 'CREATE_REVISION',
          reason: 'identity absent',
        };
      }

      if (
        existing.dimension_code !== concept.dimensionCode ||
        existing.identity_status === 'RETIRED'
      ) {
        conflicts.push(
          'concept identity conflict: ' + concept.code,
        );

        return {
          code: concept.code,
          identityAction: 'CONFLICT',
          revisionAction: 'CONFLICT',
          reason:
            existing.dimension_code !==
            concept.dimensionCode
              ? 'dimension mismatch'
              : 'identity retired',
        };
      }

      if (!existing.revision_id) {
        return {
          code: concept.code,
          identityAction: 'REUSE_IDENTITY',
          revisionAction: 'CREATE_REVISION',
          reason: 'identity exists without revision',
        };
      }

      const current = {
        label: existing.label ?? '',
        definition: existing.definition ?? '',
        positive_example:
          existing.positive_example ?? '',
        negative_example:
          existing.negative_example ?? '',
        governance_status:
          existing.governance_status ?? '',
        evidence_status: existing.evidence_status ?? '',
        notes: existing.notes,
        source_metadata: existing.source_metadata ?? {},
      };
      const expected = expectedConceptRevision(concept);

      return {
        code: concept.code,
        identityAction: 'REUSE_IDENTITY',
        revisionAction: sameRecord(current, expected)
          ? 'REUSE_REVISION'
          : 'CREATE_REVISION',
        reason: sameRecord(current, expected)
          ? 'latest revision matches manifest'
          : 'latest revision differs from manifest',
      };
    },
  );

  return {
    releaseAction,
    dimensions,
    concepts,
    conflicts,
    summary: {
      newIdentities:
        dimensions.filter(
          (item) =>
            item.identityAction === 'CREATE_IDENTITY',
        ).length +
        concepts.filter(
          (item) =>
            item.identityAction === 'CREATE_IDENTITY',
        ).length,
      reusedIdentities:
        dimensions.filter(
          (item) =>
            item.identityAction === 'REUSE_IDENTITY',
        ).length +
        concepts.filter(
          (item) =>
            item.identityAction === 'REUSE_IDENTITY',
        ).length,
      newRevisions:
        dimensions.filter(
          (item) =>
            item.revisionAction === 'CREATE_REVISION',
        ).length +
        concepts.filter(
          (item) =>
            item.revisionAction === 'CREATE_REVISION',
        ).length,
      reusedRevisions:
        dimensions.filter(
          (item) =>
            item.revisionAction === 'REUSE_REVISION',
        ).length +
        concepts.filter(
          (item) =>
            item.revisionAction === 'REUSE_REVISION',
        ).length,
    },
  };
}
