import { z } from 'zod';

const conceptCodeSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/,
  );

const taxonomyCriteriaSchema = z
  .object({
    releasePolicy:
      z.literal('CURRENT_PUBLISHED'),
    anyOf:
      z.array(conceptCodeSchema).default([]),
    allOf:
      z.array(conceptCodeSchema).default([]),
    noneOf:
      z.array(conceptCodeSchema).default([]),
    includeDescendants:
      z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (
      value.anyOf.length === 0 &&
      value.allOf.length === 0 &&
      value.noneOf.length === 0
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'taxonomy criteria must contain at least one concept code',
      });
    }
  })
  .transform((value) => ({
    ...value,
    anyOf: [...new Set(value.anyOf)].sort(),
    allOf: [...new Set(value.allOf)].sort(),
    noneOf: [...new Set(value.noneOf)].sort(),
  }));

export type TaxonomyMonitoringCriteria =
  z.output<typeof taxonomyCriteriaSchema>;

export function parseTaxonomyMonitoringCriteria(
  criteria: unknown,
  schemaVersion: number,
): TaxonomyMonitoringCriteria | null {
  if (
    !criteria ||
    typeof criteria !== 'object' ||
    Array.isArray(criteria)
  ) {
    return null;
  }

  const taxonomy =
    (criteria as Record<string, unknown>)
      .taxonomy;

  if (taxonomy === undefined) {
    return null;
  }

  if (schemaVersion !== 2) {
    throw new Error(
      'TAXONOMY_CRITERIA_REQUIRES_SCHEMA_VERSION_2',
    );
  }

  const parsed =
    taxonomyCriteriaSchema.safeParse(
      taxonomy,
    );

  if (!parsed.success) {
    throw new Error(
      'INVALID_TAXONOMY_CRITERIA:' +
        parsed.error.issues
          .map(
            (issue) =>
              issue.path.join('.') +
              ':' +
              issue.message,
          )
          .join('|'),
    );
  }

  return parsed.data;
}

export interface TaxonomyCriteriaEvaluation {
  matched: boolean;
  matchedCriteriaCodes: string[];
  matchedAssertionCodes: string[];
  failedAllOfCodes: string[];
  blockedNoneOfCodes: string[];
}

export function evaluateTaxonomyCriteria(
  criteria: TaxonomyMonitoringCriteria,
  assertedCodes: ReadonlySet<string>,
  acceptedCodesByCriterion:
    ReadonlyMap<string, ReadonlySet<string>>,
): TaxonomyCriteriaEvaluation {
  const matchesCriterion = (
    code: string,
  ): string[] => {
    const accepted =
      acceptedCodesByCriterion.get(code);

    if (!accepted) {
      throw new Error(
        'UNRESOLVED_TAXONOMY_CRITERION:' +
          code,
      );
    }

    return [...accepted].filter(
      (candidate) =>
        assertedCodes.has(candidate),
    );
  };

  const anyMatches =
    criteria.anyOf.flatMap(
      (code) =>
        matchesCriterion(code).map(
          (assertionCode) => ({
            criterionCode: code,
            assertionCode,
          }),
        ),
    );

  const allResults =
    criteria.allOf.map((code) => ({
      code,
      assertions:
        matchesCriterion(code),
    }));

  const noneResults =
    criteria.noneOf.map((code) => ({
      code,
      assertions:
        matchesCriterion(code),
    }));

  const anyOk =
    criteria.anyOf.length === 0 ||
    anyMatches.length > 0;
  const failedAllOfCodes =
    allResults
      .filter(
        (item) =>
          item.assertions.length === 0,
      )
      .map((item) => item.code);
  const blockedNoneOfCodes =
    noneResults
      .filter(
        (item) =>
          item.assertions.length > 0,
      )
      .map((item) => item.code);

  const positivePairs = [
    ...anyMatches,
    ...allResults.flatMap(
      (item) =>
        item.assertions.map(
          (assertionCode) => ({
            criterionCode: item.code,
            assertionCode,
          }),
        ),
    ),
  ];

  return {
    matched:
      anyOk &&
      failedAllOfCodes.length === 0 &&
      blockedNoneOfCodes.length === 0,
    matchedCriteriaCodes: [
      ...new Set(
        positivePairs.map(
          (pair) =>
            pair.criterionCode,
        ),
      ),
    ].sort(),
    matchedAssertionCodes: [
      ...new Set(
        positivePairs.map(
          (pair) =>
            pair.assertionCode,
        ),
      ),
    ].sort(),
    failedAllOfCodes:
      failedAllOfCodes.sort(),
    blockedNoneOfCodes:
      blockedNoneOfCodes.sort(),
  };
}
