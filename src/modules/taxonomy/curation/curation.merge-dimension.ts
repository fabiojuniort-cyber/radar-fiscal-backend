import type { PoolClient } from 'pg';

import { normalizeAliasText } from '../baseline/baseline.parser.js';
import {
  createConcept,
  createDraft,
  retireDimension,
  updateConcept,
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
  action: 'MERGE' | 'CREATE';
  into: string;
  /** Target group code (CREATE only). */
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

export function planDimensionMerge(
  view: Pick<ReleaseView, 'concepts' | 'groups'>,
  from: string,
  into: string,
  groupMap: Readonly<Record<string, string>> = {},
): MergeStep[] {
  const included = view.concepts.filter((concept) => concept.membershipStatus === 'INCLUDED');
  const targets = included.filter((concept) => concept.dimensionCode === into);
  const targetGroups = new Set(view.groups.filter((group) => group.dimensionCode === into).map((group) => group.code));

  return included
    .filter((concept) => concept.dimensionCode === from)
    .map((source) => {
      const target =
        targets.find((concept) => suffix(concept.code) === suffix(source.code)) ??
        targets.find((concept) => sameLabel(concept.label, source.label)) ??
        null;
      const sourceGroup = source.groupCode ?? '';
      const mappedGroup = groupMap[sourceGroup] ?? sourceGroup;
      return {
        from: source.code,
        label: source.label,
        action: target ? 'MERGE' : 'CREATE',
        into: target?.code ?? `${into}.${suffix(source.code)}`,
        group: target ? null : targetGroups.has(mappedGroup) ? mappedGroup : null,
        addedAliases: missingAliases(source, target).map((alias) => alias.text),
        addedOfficialCodes: source.officialCodes.filter((code) => !target?.officialCodes.includes(code)),
      } satisfies MergeStep;
    });
}

export async function mergeDimension(
  client: PoolClient,
  actor: CuratorActor,
  from: string,
  into: string,
  groupMap: Readonly<Record<string, string>> = {},
): Promise<{ draftVersion: string; draftCreated: boolean; steps: MergeStep[]; retired: string[] }> {
  let draft = await findOpenDraft(pgRunner(client));
  let draftCreated = false;
  if (!draft) {
    draft = (await createDraft(client, actor)).draft;
    draftCreated = true;
  }
  const view = await loadReleaseView(pgRunner(client), draft.id);
  if (!view) throw new Error('DRAFT_NOT_FOUND');

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
      if (aliases.length === 0 && step.addedOfficialCodes.length === 0 && (target.classifyByLabel || !source.classifyByLabel)) {
        continue;
      }
      await updateConcept(client, actor, target.code, {
        aliases: [
          ...target.aliases.map((alias) => ({ text: alias.text, aliasType: alias.aliasType as ConceptAliasInput['aliasType'] })),
          ...aliases,
        ],
        officialCodes: [...target.officialCodes, ...step.addedOfficialCodes],
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

  const { retiredConcepts } = await retireDimension(client, actor, from);
  return { draftVersion: draft.version, draftCreated, steps, retired: retiredConcepts };
}
