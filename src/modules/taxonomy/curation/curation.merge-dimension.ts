import type { PoolClient } from 'pg';

import { normalizeAliasText } from '../baseline/baseline.parser.js';
import {
  createConcept,
  createDraft,
  CurationError,
  retireDimension,
  updateConcept,
  updateDimension,
  type ConceptAliasInput,
  type CuratorActor,
} from './curation.draft.js';
import {
  findOpenDraft,
  loadReleaseView,
  pgRunner,
  type ConceptView,
  type ReleaseView,
} from './curation.read.js';
import {
  loadTaxonomyCodeCompatibility,
  updateDraftTaxonomyCodeCompatibility,
} from '../taxonomy-code-compatibility.js';

/**
 * Folds one dimension into another inside the open DRAFT (creates one when
 * none is open): "Tratamento" repeats most of "Tema" (Isenção, Redução de
 * base de cálculo, Crédito presumido...), so the same benefit showed twice
 * among a legislation's tags. Each item of the source dimension either merges
 * into the target item with the same code or label (aliases and official
 * codes are added to it) or is recreated in the target with the same code.
 * The source dimension is then retired. Nothing is published: the curator
 * reviews and publishes.
 */

export interface MergeStep {
  from: string;
  label: string;
  action: 'MERGE' | 'RESTORE' | 'CREATE';
  into: string;
  /** Target group code (CREATE only). RESTORE keeps the historical target group. */
  group: string | null;
  addedAliases: string[];
  addedOfficialCodes: string[];
}

function sameLabel(a: string, b: string): boolean {
  return normalizeAliasText(a) === normalizeAliasText(b);
}

function suffix(code: string): string {
  return code.slice(code.indexOf('.') + 1);
}

/** Aliases of `source` (and its label) that `target` does not carry yet. */
function missingAliases(source: ConceptView, target: ConceptView | null): ConceptAliasInput[] {
  const known = new Set(
    target ? [target.label, ...target.aliases.map((alias) => alias.text)].map(normalizeAliasText) : [],
  );
  const result: ConceptAliasInput[] = [];
  const candidates: ConceptAliasInput[] = [
    ...(target && !sameLabel(source.label, target.label)
      ? [{ text: source.label, aliasType: 'HISTORICAL_LABEL' as const }]
      : []),
    ...source.aliases.map((alias) => ({ text: alias.text, aliasType: alias.aliasType as ConceptAliasInput['aliasType'] })),
  ];
  for (const alias of candidates) {
    const key = normalizeAliasText(alias.text);
    if (!key || known.has(key)) continue;
    known.add(key);
    result.push(alias);
  }
  return result;
}

function matchingTarget(
  source: Pick<ConceptView, 'code' | 'label'>,
  targets: readonly ConceptView[],
): ConceptView | null {
  const suffixMatches = targets.filter(
    (concept) => suffix(concept.code) === suffix(source.code),
  );
  if (suffixMatches.length > 1) {
    throw new CurationError(
      'AMBIGUOUS_DIMENSION_MERGE_TARGET',
      409,
      `Mais de um alvo compartilha o sufixo de ${source.code}: ${suffixMatches
        .map((concept) => concept.code)
        .join(', ')}.`,
    );
  }
  if (suffixMatches.length === 1) return suffixMatches[0]!;

  const labelMatches = targets.filter((concept) =>
    sameLabel(concept.label, source.label),
  );
  if (labelMatches.length > 1) {
    throw new CurationError(
      'AMBIGUOUS_DIMENSION_MERGE_TARGET',
      409,
      `Mais de um alvo compartilha o rótulo de ${source.code}: ${labelMatches
        .map((concept) => concept.code)
        .join(', ')}.`,
    );
  }
  return labelMatches[0] ?? null;
}

export function planDimensionMerge(
  view: Pick<ReleaseView, 'concepts' | 'groups'>,
  from: string,
  into: string,
  groupMap: Readonly<Record<string, string>> = {},
): MergeStep[] {
  const included = view.concepts.filter((concept) => concept.membershipStatus === 'INCLUDED');
  // Retired target concepts keep their immutable identity/code. They must be
  // restored instead of recreated, otherwise explicit createConcept(code)
  // correctly rejects the duplicate historical identity.
  const targets = view.concepts.filter((concept) => concept.dimensionCode === into);
  const targetGroups = new Set(view.groups.filter((group) => group.dimensionCode === into).map((group) => group.code));

  const steps = included
    .filter((concept) => concept.dimensionCode === from)
    .map((source) => {
      const target = matchingTarget(source, targets);
      const sourceGroup = source.groupCode ?? '';
      const mappedGroup = groupMap[sourceGroup] ?? sourceGroup;
      return {
        from: source.code,
        label: source.label,
        action: target
          ? target.membershipStatus === 'INCLUDED'
            ? 'MERGE'
            : 'RESTORE'
          : 'CREATE',
        into: target?.code ?? `${into}.${suffix(source.code)}`,
        group: target ? null : targetGroups.has(mappedGroup) ? mappedGroup : null,
        addedAliases: missingAliases(source, target).map((alias) => alias.text),
        addedOfficialCodes: source.officialCodes.filter((code) => !target?.officialCodes.includes(code)),
      } satisfies MergeStep;
    });

  const sourcesByTarget = new Map<string, string[]>();
  for (const step of steps) {
    sourcesByTarget.set(step.into, [
      ...(sourcesByTarget.get(step.into) ?? []),
      step.from,
    ]);
  }
  const manyToOne = [...sourcesByTarget.entries()].filter(
    ([, sources]) => sources.length > 1,
  );
  if (manyToOne.length > 0) {
    throw new CurationError(
      'AMBIGUOUS_DIMENSION_MERGE_MANY_TO_ONE',
      409,
      'Mais de um conceito de origem foi direcionado ao mesmo alvo: ' +
        manyToOne
          .map(([target, sources]) => `${sources.join(' + ')} → ${target}`)
          .join('; ') +
        '.',
    );
  }

  return steps;
}

export interface DimensionMergeCompatibilityPlan {
  redirects: Record<string, string>;
  retiredCodes: string[];
}

export interface HistoricalConceptIdentity {
  code: string;
  label: string;
}

/**
 * Completes treatment -> theme compatibility for historical concept identities
 * that are not materialized in the current release. They must use the same
 * suffix/label matching semantics as materialized concepts before falling
 * back to explicit retirement.
 */
export function planDetachedHistoricalMergeCompatibility(
  historicalSources: readonly HistoricalConceptIdentity[],
  activeTargets: readonly ConceptView[],
  coveredCodes: ReadonlySet<string>,
): DimensionMergeCompatibilityPlan {
  const redirects: Record<string, string> = {};
  const retiredCodes: string[] = [];

  for (const source of historicalSources) {
    if (coveredCodes.has(source.code)) continue;
    const target = matchingTarget(source, activeTargets);
    if (target) {
      redirects[source.code] = target.code;
    } else {
      retiredCodes.push(source.code);
    }
  }

  return {
    redirects: Object.fromEntries(
      Object.entries(redirects).sort(([left], [right]) => left.localeCompare(right)),
    ),
    retiredCodes: [...new Set(retiredCodes)].sort(),
  };
}

/**
 * Builds a complete compatibility outcome for every code carried by the
 * source dimension, including concepts already RETIRED before the merge.
 *
 * A historical source code redirects only when its semantic target will be
 * active after this merge. Otherwise the code is explicitly retired so
 * runtime matching resolves it to NO_MATCH instead of leaking a stale code.
 */
export function planDimensionMergeCompatibility(
  view: Pick<ReleaseView, 'concepts'>,
  from: string,
  into: string,
  steps: readonly MergeStep[],
): DimensionMergeCompatibilityPlan {
  const sources = view.concepts.filter((concept) => concept.dimensionCode === from);
  const targets = view.concepts.filter((concept) => concept.dimensionCode === into);
  const finalActiveTargets = new Set(
    targets
      .filter((concept) => concept.membershipStatus === 'INCLUDED')
      .map((concept) => concept.code),
  );
  for (const step of steps) finalActiveTargets.add(step.into);

  // Historical sources may only redirect to targets that are actually active
  // after this merge. A RETIRED Theme with a matching suffix must not consume
  // the search and prevent label fallback to a different active Theme.
  const activeTargets = targets.filter((concept) =>
    finalActiveTargets.has(concept.code),
  );

  const stepBySource = new Map(steps.map((step) => [step.from, step]));
  const redirects: Record<string, string> = {};
  const retiredCodes: string[] = [];

  for (const source of sources) {
    const step = stepBySource.get(source.code);
    if (step) {
      redirects[source.code] = step.into;
      continue;
    }

    const target = matchingTarget(source, activeTargets);
    if (target) {
      redirects[source.code] = target.code;
    } else {
      retiredCodes.push(source.code);
    }
  }

  return {
    redirects: Object.fromEntries(
      Object.entries(redirects).sort(([left], [right]) => left.localeCompare(right)),
    ),
    retiredCodes: [...new Set(retiredCodes)].sort(),
  };
}

export async function mergeDimension(
  client: PoolClient,
  actor: CuratorActor,
  from: string,
  into: string,
  groupMap: Readonly<Record<string, string>> = {},
): Promise<{
  draftVersion: string;
  draftCreated: boolean;
  steps: MergeStep[];
  retired: string[];
  transferredOfficialCodeType: string | null;
}> {
  let draft = await findOpenDraft(pgRunner(client));
  let draftCreated = false;
  if (!draft) {
    draft = (await createDraft(client, actor)).draft;
    draftCreated = true;
  }
  const view = await loadReleaseView(pgRunner(client), draft.id, { includeRetired: true });
  if (!view) throw new Error('DRAFT_NOT_FOUND');

  const sourceDimension = view.dimensions.find((dimension) => dimension.code === from);
  const targetDimension = view.dimensions.find((dimension) => dimension.code === into);
  if (!sourceDimension || !targetDimension) throw new Error('DIMENSION_NOT_FOUND');

  // Official-code semantics belong to the merged table after the fold. This
  // is critical for treatment -> theme: cClassTrib must keep classifying the
  // same concepts after Treatment is retired.
  let transferredOfficialCodeType: string | null = null;
  if (sourceDimension.officialCodeType) {
    if (
      targetDimension.officialCodeType &&
      targetDimension.officialCodeType !== sourceDimension.officialCodeType
    ) {
      throw new Error('OFFICIAL_CODE_TYPE_CONFLICT');
    }
    if (!targetDimension.officialCodeType) {
      await updateDimension(client, actor, into, {
        officialCodeType: sourceDimension.officialCodeType,
      });
      transferredOfficialCodeType = sourceDimension.officialCodeType;
    }
  }

  const steps = planDimensionMerge(view, from, into, groupMap);
  const byCode = new Map(view.concepts.map((concept) => [concept.code, concept]));
  const groupIds = new Map(
    view.groups.filter((group) => group.dimensionCode === into).map((group) => [group.code, group.id]),
  );

  for (const step of steps) {
    const source = byCode.get(step.from)!;
    const target = byCode.get(step.into) ?? null;
    const aliases = missingAliases(source, target);
    if (target) {
      const restore = step.action === 'RESTORE';
      if (
        !restore &&
        aliases.length === 0 &&
        step.addedOfficialCodes.length === 0 &&
        (target.classifyByLabel || !source.classifyByLabel)
      ) {
        continue;
      }
      await updateConcept(client, actor, target.code, {
        ...(restore ? { membershipStatus: 'INCLUDED' as const } : {}),
        aliases: [
          ...target.aliases.map((alias) => ({ text: alias.text, aliasType: alias.aliasType as ConceptAliasInput['aliasType'] })),
          ...aliases,
        ],
        officialCodes: [...new Set([...target.officialCodes, ...step.addedOfficialCodes])],
        classifyByLabel: target.classifyByLabel || source.classifyByLabel,
      });
    } else {
      await createConcept(client, actor, into, {
        code: step.into,
        label: source.label,
        definition: source.definition,
        positiveExample: source.positiveExample,
        negativeExample: source.negativeExample,
        governanceStatus: source.governanceStatus,
        evidenceStatus: source.evidenceStatus,
        notes: source.notes,
        groupId: step.group ? groupIds.get(step.group) ?? null : null,
        profileVisible: source.profileVisible,
        classifyByLabel: source.classifyByLabel,
        officialCodes: source.officialCodes,
        aliases,
      });
    }
  }

  // Reload after MERGE/RESTORE/CREATE so detached historical Treatment
  // identities are matched against the actual active Theme set of the draft.
  const postMergeView = await loadReleaseView(
    pgRunner(client),
    draft.id,
    { includeRetired: true },
  );
  if (!postMergeView) throw new Error('DRAFT_NOT_FOUND');

  const compatibility = planDimensionMergeCompatibility(
    postMergeView,
    from,
    into,
    steps,
  );
  const existingCompatibility = await loadTaxonomyCodeCompatibility(
    pgRunner(client),
    draft.id,
  );

  // Close compatibility over the entire historical identity space, including
  // concepts that have no taxonomy_release_concepts membership in this draft.
  // Before retiring a detached Treatment code, apply the exact same suffix /
  // label matching semantics used by the normal merge against active Themes.
  const historicalSources = await client.query<HistoricalConceptIdentity>(
    `SELECT c.code, latest.label
     FROM taxonomy_concepts c
     JOIN taxonomy_dimensions d ON d.id = c.dimension_id
     JOIN LATERAL (
       SELECT r.label
       FROM taxonomy_concept_revisions r
       WHERE r.concept_id = c.id
       ORDER BY r.revision_no DESC
       LIMIT 1
     ) latest ON true
     WHERE d.code = $1
       AND NOT EXISTS (
         SELECT 1
         FROM taxonomy_release_concepts rc
         WHERE rc.release_id = $2::uuid
           AND rc.concept_id = c.id
       )
     ORDER BY c.code`,
    [from, draft.id],
  );
  // Existing redirects are already semantically resolved and can be
  // preserved. Existing retiredCodes are different: they may be stale if a
  // Theme successor became active in this merge (including RESTORE/CREATE).
  // Re-evaluate those detached historical identities before keeping them
  // retired. Compatibility computed from the current post-merge view is
  // already fresh and can remain covered.
  const coveredCodes = new Set([
    ...Object.keys(existingCompatibility.redirects),
    ...Object.keys(compatibility.redirects),
    ...compatibility.retiredCodes,
  ]);
  const activeTargets = postMergeView.concepts.filter(
    (concept) =>
      concept.dimensionCode === into &&
      concept.membershipStatus === 'INCLUDED',
  );
  const detachedCompatibility = planDetachedHistoricalMergeCompatibility(
    historicalSources.rows,
    activeTargets,
    coveredCodes,
  );
  const completeCompatibility = {
    redirects: {
      ...compatibility.redirects,
      ...detachedCompatibility.redirects,
    },
    retiredCodes: [
      ...new Set([
        ...compatibility.retiredCodes,
        ...detachedCompatibility.retiredCodes,
      ]),
    ].sort(),
  };
  await updateDraftTaxonomyCodeCompatibility(client, draft.id, completeCompatibility);

  const retirement = await retireDimension(client, actor, from, {
    recordRetiredCodes: false,
  });
  return {
    draftVersion: draft.version,
    draftCreated,
    steps,
    retired: retirement.retiredConcepts,
    transferredOfficialCodeType,
  };
}
