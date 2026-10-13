import {
  DIMENSIONS,
  EXPECTED,
  type DimensionCode,
} from '../baseline/baseline.constants.js';

export const TAXONOMY_V1_1_VERSION = 'v1.1.0' as const;

export const RETIRED_DIMENSION_CODES = [
  'operation_scope',
  'operation_channel',
  'event',
  'impact_operational',
  'impact_system',
] as const satisfies readonly DimensionCode[];

export const REQUIRED_PRESERVED_DIMENSION_CODES = [
  'theme',
  'treatment',
  'subject',
] as const satisfies readonly DimensionCode[];

export interface TaxonomySuccessorDimensionInput {
  code: string;
  conceptCount: number;
}

export interface TaxonomyV11Plan {
  targetVersion: typeof TAXONOMY_V1_1_VERSION;
  sourceDimensions: number;
  sourceConcepts: number;
  retainedDimensions: number;
  retainedConcepts: number;
  retiredDimensions: number;
  retiredConcepts: number;
  retainedDimensionCodes: string[];
  retiredDimensionCodes: string[];
}

const retiredCodes = new Set<string>(
  RETIRED_DIMENSION_CODES,
);

export function isRetiredV11DimensionCode(
  code: string,
): boolean {
  return retiredCodes.has(code);
}

export function planTaxonomyV11Successor(
  dimensions: readonly TaxonomySuccessorDimensionInput[],
): TaxonomyV11Plan {
  const seen = new Set<string>();

  for (const dimension of dimensions) {
    if (seen.has(dimension.code)) {
      throw new Error(
        'TAXONOMY_V1_1_DUPLICATE_DIMENSION:' + dimension.code,
      );
    }
    seen.add(dimension.code);

    if (
      !Number.isInteger(dimension.conceptCount) ||
      dimension.conceptCount < 0
    ) {
      throw new Error(
        'TAXONOMY_V1_1_INVALID_CONCEPT_COUNT:' + dimension.code,
      );
    }
  }

  for (const code of RETIRED_DIMENSION_CODES) {
    if (!seen.has(code)) {
      throw new Error(
        'TAXONOMY_V1_1_SOURCE_MISSING_RETIRED_DIMENSION:' + code,
      );
    }
  }

  for (const code of REQUIRED_PRESERVED_DIMENSION_CODES) {
    if (!seen.has(code)) {
      throw new Error(
        'TAXONOMY_V1_1_SOURCE_MISSING_REQUIRED_DIMENSION:' + code,
      );
    }

    if (retiredCodes.has(code)) {
      throw new Error(
        'TAXONOMY_V1_1_REQUIRED_DIMENSION_RETIRED:' + code,
      );
    }
  }

  const retired = dimensions.filter(
    (dimension) => retiredCodes.has(dimension.code),
  );
  const retained = dimensions.filter(
    (dimension) => !retiredCodes.has(dimension.code),
  );

  const sourceConcepts = dimensions.reduce(
    (total, dimension) => total + dimension.conceptCount,
    0,
  );
  const retiredConcepts = retired.reduce(
    (total, dimension) => total + dimension.conceptCount,
    0,
  );
  const retainedConcepts = retained.reduce(
    (total, dimension) => total + dimension.conceptCount,
    0,
  );

  return {
    targetVersion: TAXONOMY_V1_1_VERSION,
    sourceDimensions: dimensions.length,
    sourceConcepts,
    retainedDimensions: retained.length,
    retainedConcepts,
    retiredDimensions: retired.length,
    retiredConcepts,
    retainedDimensionCodes: retained.map(
      (dimension) => dimension.code,
    ),
    retiredDimensionCodes: retired.map(
      (dimension) => dimension.code,
    ),
  };
}

export function planTaxonomyV11FromCanonicalV1(): TaxonomyV11Plan {
  if (DIMENSIONS.length !== EXPECTED.dimensions) {
    throw new Error('TAXONOMY_V1_1_CANONICAL_DIMENSION_COUNT_MISMATCH');
  }

  const sourceConcepts = DIMENSIONS.reduce(
    (total, [, , conceptCount]) => total + conceptCount,
    0,
  );

  if (sourceConcepts !== EXPECTED.concepts) {
    throw new Error('TAXONOMY_V1_1_CANONICAL_CONCEPT_COUNT_MISMATCH');
  }

  return planTaxonomyV11Successor(
    DIMENSIONS.map(([code, , conceptCount]) => ({
      code,
      conceptCount,
    })),
  );
}
