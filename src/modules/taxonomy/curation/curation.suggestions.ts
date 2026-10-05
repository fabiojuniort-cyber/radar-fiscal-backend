import { isCnaeActivity } from './curation.constants.js';
import type { ReleaseView, SqlRunner } from './curation.read.js';
import { loadReleaseView } from './curation.read.js';

export interface SegmentSuggestion {
  conceptCode: string;
  label: string;
  /** PRIMARY: from the main CNAE (pre-selected); SECONDARY: suggestion only. */
  strength: 'PRIMARY' | 'SECONDARY';
  cnaeCodes: string[];
}

/**
 * CNAE -> Segmento association (TAX-11). Segments (sector concepts) carry
 * CNAE prefixes as official codes. For each company CNAE only the most
 * specific matching prefix wins; ties keep every segment at that length.
 */
export function matchSegmentsByCnae(
  cnaes: ReadonlyArray<{ code: string; isPrimary: boolean }>,
  segments: ReadonlyArray<{ code: string; label: string; prefixes: string[] }>,
): SegmentSuggestion[] {
  const result = new Map<string, SegmentSuggestion>();

  for (const cnae of cnaes) {
    const digits = cnae.code.replace(/\D/g, '');
    let best = 0;
    const winners: Array<(typeof segments)[number]> = [];
    for (const segment of segments) {
      const length = Math.max(
        0,
        ...segment.prefixes
          .filter((prefix) => digits.startsWith(prefix))
          .map((prefix) => prefix.length),
      );
      if (length === 0) continue;
      if (length > best) {
        best = length;
        winners.length = 0;
      }
      if (length === best) winners.push(segment);
    }

    for (const segment of winners) {
      const current = result.get(segment.code);
      const strength = cnae.isPrimary ? 'PRIMARY' : 'SECONDARY';
      if (!current) {
        result.set(segment.code, {
          conceptCode: segment.code,
          label: segment.label,
          strength,
          cnaeCodes: [digits],
        });
      } else {
        if (strength === 'PRIMARY') current.strength = 'PRIMARY';
        if (!current.cnaeCodes.includes(digits)) current.cnaeCodes.push(digits);
      }
    }
  }

  return [...result.values()].sort(
    (left, right) =>
      Number(right.strength === 'PRIMARY') - Number(left.strength === 'PRIMARY') ||
      left.label.localeCompare(right.label, 'pt-BR'),
  );
}

export interface CnaeSegments {
  cnaeCode: string;
  isPrimary: boolean;
  segments: Array<{ code: string; label: string }>;
}

/**
 * Segment of a CNAE: the most specific Segmento-table item for it. A CNAE
 * activity (7-digit item) is not itself a segment: it answers with the
 * segment(s) of its subsegment; any other item (CNAE prefix) is a segment.
 */
export function segmentsForCnaes(
  cnaes: ReadonlyArray<{ code: string; isPrimary: boolean }>,
  view: Pick<ReleaseView, 'concepts' | 'groups'>,
  sectorCode: string,
): CnaeSegments[] {
  const sectorConcepts = view.concepts.filter((c) => c.dimensionCode === sectorCode);
  const byCode = new Map(sectorConcepts.map((c) => [c.code, c]));
  const groupById = new Map(view.groups.map((g) => [g.id, g]));
  const segmentsOf = (code: string): Array<{ code: string; label: string }> => {
    const concept = byCode.get(code);
    if (!concept) return [];
    if (!isCnaeActivity(concept.officialCodes)) return [{ code: concept.code, label: concept.label }];
    const group = concept.groupId ? groupById.get(concept.groupId) : undefined;
    return (group?.segmentCodes ?? []).flatMap((segmentCode) => {
      const segment = byCode.get(segmentCode);
      return segment ? [{ code: segment.code, label: segment.label }] : [];
    });
  };
  const candidates = sectorConcepts
    .filter((c) => c.officialCodes.length > 0)
    .map((c) => ({ code: c.code, label: c.label, prefixes: c.officialCodes.map((p) => p.replace(/\D/g, '')) }));

  return cnaes.map((cnae) => {
    const digits = cnae.code.replace(/\D/g, '');
    const matched = matchSegmentsByCnae([{ code: digits, isPrimary: cnae.isPrimary }], candidates);
    const segments = new Map<string, { code: string; label: string }>();
    for (const match of matched) {
      for (const segment of segmentsOf(match.conceptCode)) segments.set(segment.code, segment);
    }
    return {
      cnaeCode: digits,
      isPrimary: cnae.isPrimary,
      segments: [...segments.values()].sort((a, b) => a.label.localeCompare(b.label, 'pt-BR')),
    };
  });
}

/** Company CNAEs (registry and establishments) and the segments they imply. */
export async function suggestSegmentsForCompany(
  run: SqlRunner,
  releaseId: string,
  companyId: string,
): Promise<{ segments: SegmentSuggestion[]; cnaes: CnaeSegments[] }> {
  const cnaes = await run<{ cnae_code: string; is_primary: boolean }>(
    `SELECT cnae_code::text AS cnae_code, bool_or(is_primary) AS is_primary
     FROM (
       SELECT cnae_code, is_primary FROM company_cnaes WHERE company_id = $1::uuid
       UNION ALL
       SELECT ec.cnae_code, FALSE
       FROM establishment_cnaes ec
       JOIN establishments e ON e.id = ec.establishment_id
       WHERE e.company_id = $1::uuid AND e.is_active = TRUE
     ) all_cnaes
     GROUP BY cnae_code
     ORDER BY cnae_code`,
    [companyId],
  );
  if (cnaes.length === 0) return { segments: [], cnaes: [] };

  const view = await loadReleaseView(run, releaseId);
  if (!view) return { segments: [], cnaes: [] };
  const sector = view.dimensions.find((d) => d.officialCodeType === 'CNAE');
  if (!sector) return { segments: [], cnaes: [] };

  const byCnae = segmentsForCnaes(
    cnaes.map((row) => ({ code: row.cnae_code, isPrimary: row.is_primary })),
    view,
    sector.code,
  );
  const result = new Map<string, SegmentSuggestion>();
  for (const cnae of byCnae) {
    for (const segment of cnae.segments) {
      const current = result.get(segment.code);
      const strength = cnae.isPrimary ? 'PRIMARY' : 'SECONDARY';
      if (!current) {
        result.set(segment.code, { conceptCode: segment.code, label: segment.label, strength, cnaeCodes: [cnae.cnaeCode] });
      } else {
        if (strength === 'PRIMARY') current.strength = 'PRIMARY';
        if (!current.cnaeCodes.includes(cnae.cnaeCode)) current.cnaeCodes.push(cnae.cnaeCode);
      }
    }
  }
  const segments = [...result.values()].sort(
    (left, right) =>
      Number(right.strength === 'PRIMARY') - Number(left.strength === 'PRIMARY') ||
      left.label.localeCompare(right.label, 'pt-BR'),
  );
  return { segments, cnaes: byCnae };
}
