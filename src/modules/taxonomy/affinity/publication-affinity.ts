import type { PublicationTaxonomyView } from '../curation/curation.tags.js';

/**
 * Affinity between a legislation and a company's tax profile, from the
 * act's taxonomy tags (including segments derived from its products) and
 * the canonical codes the company chose in its tax profile.
 *
 * Each coinciding item weighs by what it says about the company: products
 * and segments are specific (3), taxes, regimes, operations and benefits are
 * relevant (2), documents, obligations and themes are context (1).
 */

export type AffinityLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

export type AffinityStatus =
  | 'OK'
  | 'NO_PROFILE'
  | 'NOT_CLASSIFIED';

export interface AffinityMatch {
  code: string;
  label: string;
  dimensionCode: string;
  weight: number;
  /** "PRODUCT_GROUP": the act cites the group of a product in the profile. */
  via: 'SAME_ITEM' | 'PRODUCT_GROUP';
}

export interface PublicationAffinity {
  status: AffinityStatus;
  level: AffinityLevel | null;
  score: number;
  matches: AffinityMatch[];
}

export const DIMENSION_WEIGHTS: Record<string, number> = {
  product: 3,
  sector: 3,
  tax: 2,
  regime: 2,
  operation: 2,
  operation_purpose: 2,
  treatment: 2,
  tax_species: 1,
  document: 1,
  obligation: 1,
  theme: 1,
};

/** An NCM of the company mentioned in the act is as specific as a product. */
export const NCM_WEIGHT = 3;

const STRONG_DIMENSIONS = new Set(['product', 'sector', 'ncm']);

export function affinityLevel(score: number, strong: boolean): AffinityLevel {
  if (score >= 5 && strong) return 'HIGH';
  if (score >= 3) return 'MEDIUM';
  if (score > 0) return 'LOW';
  return 'NONE';
}

export function computePublicationAffinity(input: {
  view: PublicationTaxonomyView;
  profileCodes: readonly string[];
  /** The company has some tax-profile parameter, even without taxonomy codes. */
  hasProfile?: boolean;
  /** Product concept code -> its group code, for the profile's products. */
  profileProductGroups: ReadonlyMap<string, string>;
  /** NCMs of the company (8 digits): profile, CNAEs and products. */
  profileNcms?: readonly string[];
  /** NCMs mentioned in the act, with their catalog description. */
  publicationNcms?: ReadonlyArray<{ code: string; description: string | null }>;
}): PublicationAffinity {
  const profile = new Set(input.profileCodes);
  const companyNcms = new Set(input.profileNcms ?? []);
  if (profile.size === 0 && companyNcms.size === 0 && !input.hasProfile) {
    return { status: 'NO_PROFILE', level: null, score: 0, matches: [] };
  }

  const matches = new Map<string, AffinityMatch>();
  // NCMs do not depend on the taxonomy classification of the act.
  for (const ncm of input.publicationNcms ?? []) {
    if (!companyNcms.has(ncm.code) || matches.has(`ncm:${ncm.code}`)) continue;
    const formatted = `${ncm.code.slice(0, 4)}.${ncm.code.slice(4, 6)}.${ncm.code.slice(6)}`;
    matches.set(`ncm:${ncm.code}`, {
      code: ncm.code,
      label: ncm.description ? `${formatted} · ${ncm.description}` : formatted,
      dimensionCode: 'ncm',
      weight: NCM_WEIGHT,
      via: 'SAME_ITEM',
    });
  }
  if (input.view.status !== 'CLASSIFIED' && matches.size === 0) {
    return { status: 'NOT_CLASSIFIED', level: null, score: 0, matches: [] };
  }

  const profileGroups = new Set(input.profileProductGroups.values());
  for (const section of input.view.status === 'CLASSIFIED' ? input.view.sections : []) {
    for (const tag of section.tags) {
      if (tag.removed) continue;
      const weight = DIMENSION_WEIGHTS[tag.dimensionCode] ?? 0;
      if (weight === 0) continue;
      if (tag.kind === 'CONCEPT' && tag.conceptCode && profile.has(tag.conceptCode)) {
        matches.set(tag.conceptCode, {
          code: tag.conceptCode,
          label: tag.label,
          dimensionCode: tag.dimensionCode,
          weight,
          via: 'SAME_ITEM',
        });
      } else if (tag.kind === 'GROUP' && tag.groupCode && profileGroups.has(tag.groupCode)) {
        matches.set(`group:${tag.groupCode}`, {
          code: tag.groupCode,
          label: tag.label,
          dimensionCode: tag.dimensionCode,
          weight,
          via: 'PRODUCT_GROUP',
        });
      }
    }
  }

  const list = [...matches.values()].sort(
    (a, b) => b.weight - a.weight || a.label.localeCompare(b.label, 'pt-BR'),
  );
  const score = list.reduce((sum, match) => sum + match.weight, 0);
  const strong = list.some((match) => STRONG_DIMENSIONS.has(match.dimensionCode));
  return { status: 'OK', level: affinityLevel(score, strong), score, matches: list };
}
