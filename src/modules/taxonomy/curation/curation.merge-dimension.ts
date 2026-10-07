import type { PoolClient } from 'pg';

import { normalizeAliasText } from '../baseline/baseline.parser.js';
import {
  createConcept,
  createDraft,
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
import { updateDraftTaxonomyCodeCompatibility } from '../taxonomy-code-compatibility.js';

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
  source: ConceptView,
  targets: readonly ConceptView[],
): ConceptView | null {
  return (
    targets.find((concept) => suffix(concept.code) === suffix(source.code)) ??
    targets.find((concept) => sameLabel(concept.label, source.label)) ??
    null
  );
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

  return included
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
}

export interface DimensionMergeCompatibilityPlan {
  redirects: Record<string, string>;
  retiredCodes: string[];
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

  const stepBySource = new Map(steps.map((step) => [step.from, step]));
  const redirects: Record<string, string> = {};
  const retiredCodes: string[] = [];

  for (const source of sources) {
    const step = stepBySource.get(source.code);
    if (step) {
      redirects[source.code] = step.into;
      continue;
    }

    const target = matchingTarget(source, targets);
    if (target && finalActiveTargets.has(target.code)) {
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

  const compatibility = planDimensionMergeCompatibility(view, from, into, steps);
  await updateDraftTaxonomyCodeCompatibility(client, draft.id, compatibility);

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
