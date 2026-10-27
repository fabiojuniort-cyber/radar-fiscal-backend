import type { AssistantUnit, CardSelection } from './assistant.model.js';

export const legacyFieldNames = ['taxes', 'products', 'operations', 'documents', 'obligations', 'keywords', 'segments', 'activities'] as const;
export type LegacyField = typeof legacyFieldNames[number];
export type LegacyFields = Record<LegacyField, string[]>;
export type UnitSelection = { establishmentId: string; taxRegime: string; conceptCodes: string[]; ncmCodes: string[]; releaseId?: string; releaseVersion?: string };
export type ProfileInput = { tax_regime: string; segments: string[]; activities: unknown; personalization: Record<string, unknown> };
export type EffectiveSelection = UnitSelection & { name: string; isHeadOffice: boolean; legacyFields: LegacyFields; cnaeSegments: { cnaeCode: string; segmentCode: string | null }[] };
export const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
export const unique = (values: string[]) => [...new Set(values)].sort();
export const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Read-only projection. Company-level choices belong to the matrix, never a later branch. */
export function effectiveSelections(profile: ProfileInput | undefined, units: { id: string; name: string; is_head_office: boolean }[]): EffectiveSelection[] {
  const p = profile?.personalization ?? {}, taxonomy = record(p.taxonomy);
  const overrides = Array.isArray(p.establishmentOverrides) ? p.establishmentOverrides as UnitSelection[] : [];
  return units.map(unit => {
    const saved = overrides.find(o => o.establishmentId === unit.id);
    const globalCodes = unit.is_head_office ? strings(taxonomy.conceptCodes) : [];
    const globalNcms = unit.is_head_office ? strings(p.ncmCodes) : [];
    const legacyFields = Object.fromEntries(legacyFieldNames.map(key => [key, unit.is_head_office ? strings(key === 'segments' ? profile?.segments : key === 'activities' ? profile?.activities : p[key]) : []])) as LegacyFields;
    const cnaeSegments = unit.is_head_office && Array.isArray(taxonomy.cnaeSegments) ? taxonomy.cnaeSegments as EffectiveSelection['cnaeSegments'] : [];
    const sourceId = saved?.releaseId ?? (typeof taxonomy.releaseId === 'string' ? taxonomy.releaseId : undefined);
    const sourceVersion = saved?.releaseVersion ?? (typeof taxonomy.releaseVersion === 'string' ? taxonomy.releaseVersion : undefined);
    return { establishmentId: unit.id, name: unit.name, isHeadOffice: unit.is_head_office,
      taxRegime: saved?.taxRegime ?? (unit.is_head_office ? profile?.tax_regime ?? 'NAO_INFORMADO' : 'NAO_INFORMADO'),
      conceptCodes: unique([...globalCodes, ...strings(saved?.conceptCodes)]), ncmCodes: unique([...globalNcms, ...strings(saved?.ncmCodes)]),
      ...(sourceId ? { releaseId: sourceId } : {}), ...(sourceVersion ? { releaseVersion: sourceVersion } : {}), legacyFields, cnaeSegments };
  });
}

/** Official product codes of the PUBLISHED release are evidence; a CNAE's independent NCM links are not. */
export function productNcmCodes(concept: { dimensionCode: string; officialCodes: string[] }): string[] {
  if (concept.dimensionCode !== 'product') return [];
  return unique(concept.officialCodes.map(code => code.trim()).filter(code => /^[0-9.]+$/.test(code)).map(code => code.replace(/\./g, '')).filter(code => /^[0-9]{1,8}$/.test(code)));
}

/** The explicit effective snapshot is authoritative; stale provenance can never resurrect removed choices. */
export function synchronizeUnit(previous: AssistantUnit | undefined, cardId: string, status: CardSelection['status'], chosen: { conceptCodes: string[]; ncmCodes: string[] }, targets: Set<string>): AssistantUnit {
  const unit = structuredClone(previous ?? { baseConceptCodes: [], baseNcmCodes: [], cards: {} });
  const concepts = new Set(chosen.conceptCodes), ncms = new Set(chosen.ncmCodes);
  for (const card of Object.values(unit.cards)) {
    card.conceptCodes = card.conceptCodes.filter(c => concepts.has(c));
    card.ncmCodes = card.ncmCodes.filter(c => ncms.has(c));
  }
  const prior = unit.cards[cardId];
  const attributable = new Set([...targets, ...(prior?.conceptCodes ?? []), ...(prior?.ncmCodes ?? [])]);
  unit.cards[cardId] = { status, conceptCodes: chosen.conceptCodes.filter(c => attributable.has(c)), ncmCodes: chosen.ncmCodes.filter(c => attributable.has(c)) };
  const confirmed = Object.values(unit.cards).filter(c => c.status === 'CONFIRMED');
  const linkedConcepts = new Set(confirmed.flatMap(c => c.conceptCodes)), linkedNcms = new Set(confirmed.flatMap(c => c.ncmCodes));
  unit.baseConceptCodes = chosen.conceptCodes.filter(c => !linkedConcepts.has(c));
  unit.baseNcmCodes = chosen.ncmCodes.filter(c => !linkedNcms.has(c));
  return unit;
}
