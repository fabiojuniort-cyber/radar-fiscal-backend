import type { PoolClient } from 'pg';

import { createDraft, updateConcept, updateGroup, type CuratorActor } from './curation.draft.js';
import { findOpenDraft, loadReleaseView, pgRunner, type ReleaseView } from './curation.read.js';

/**
 * Retires the 45 sector items of the TAX-10 baseline ("Agronegócio",
 * "Atacado", ...) once the TriFaros Segmento table replaced them. Every
 * group linked to an old item (product groups, subsegments) is first moved
 * to the matching TriFaros segment, so no link points to a retired item.
 * Runs in the open DRAFT (creates one when none is open); nothing is
 * published: the curator reviews and publishes.
 */

/** Old baseline item → TriFaros segment id (sector.trifaros_<id>). */
export const LEGACY_SEGMENT_TARGETS: Readonly<Record<string, string>> = {
  agribusiness: 'agro',
  rural_production: 'agro',
  automotive_industry: 'aut',
  aviation: 'log',
  banking: 'fin',
  beverages: 'ali',
  chemical_industry: 'qui',
  cold_storage: 'log',
  construction: 'con',
  ecommerce: 'com',
  education: 'edu',
  energy: 'ene',
  export_trade: 'com',
  food_industry: 'ali',
  food_service: 'res',
  fuels: 'ene',
  gaming_betting: 'cul',
  health: 'sau',
  health_plans: 'sau',
  import_trade: 'com',
  insurance: 'fin',
  manufacturing: 'ind',
  maritime_ports: 'log',
  meat_distribution: 'ali',
  meat_products: 'ali',
  meatpacking: 'ali',
  media_advertising: 'mkt',
  metallurgy: 'min',
  mining: 'min',
  oil_gas: 'ene',
  pharmaceutical_industry: 'sau',
  professional_services: 'cons',
  pulp_paper: 'pap',
  real_estate: 'imo',
  retail: 'com',
  sanitation: 'amb',
  slaughterhouse: 'ali',
  software_saas: 'tec',
  sports: 'cul',
  telecom: 'tec',
  textiles_apparel: 'mod',
  tobacco: 'ali',
  tourism_hospitality: 'tur',
  transport: 'log',
  wholesale: 'com',
};

const legacyCode = (key: string) => `sector.${key}`;
const targetCode = (id: string) => `sector.trifaros_${id}`;

export interface LegacySegmentPlan {
  groupUpdates: Array<{ groupId: string; group: string; from: string[]; to: string[] }>;
  retire: string[];
  /** TriFaros segments a link needs but the draft does not include. */
  missingTargets: string[];
}

export function planLegacySegmentRetirement(view: Pick<ReleaseView, 'concepts' | 'groups'>): LegacySegmentPlan {
  const included = new Set(
    view.concepts.filter((concept) => concept.membershipStatus === 'INCLUDED').map((concept) => concept.code),
  );
  const mapping = new Map(
    Object.entries(LEGACY_SEGMENT_TARGETS).map(([key, id]) => [legacyCode(key), targetCode(id)]),
  );
  const missing = new Set<string>();
  const groupUpdates: LegacySegmentPlan['groupUpdates'] = [];
  for (const group of view.groups) {
    if (!group.segmentCodes.some((code) => mapping.has(code))) continue;
    const to = [...new Set(group.segmentCodes.map((code) => mapping.get(code) ?? code))];
    for (const code of to) if (!included.has(code)) missing.add(code);
    groupUpdates.push({ groupId: group.id, group: group.label, from: group.segmentCodes, to });
  }
  return {
    groupUpdates,
    retire: [...mapping.keys()].filter((code) => included.has(code)).sort(),
    missingTargets: [...missing].sort(),
  };
}

export interface LegacySegmentResult extends LegacySegmentPlan {
  draftVersion: string;
  draftCreated: boolean;
}

export async function retireLegacySegments(
  client: PoolClient,
  actor: CuratorActor,
): Promise<LegacySegmentResult> {
  let draft = await findOpenDraft(pgRunner(client));
  let draftCreated = false;
  if (!draft) {
    draft = (await createDraft(client, actor)).draft;
    draftCreated = true;
  }
  const view = await loadReleaseView(pgRunner(client), draft.id);
  if (!view) throw new Error('draft_not_found');
  const plan = planLegacySegmentRetirement(view);
  if (plan.missingTargets.length > 0) {
    return { ...plan, draftVersion: draft.version, draftCreated };
  }
  for (const update of plan.groupUpdates) {
    await updateGroup(client, actor, update.groupId, { segmentCodes: update.to });
  }
  for (const code of plan.retire) {
    await updateConcept(client, actor, code, { membershipStatus: 'RETIRED' });
  }
  return { ...plan, draftVersion: draft.version, draftCreated };
}
