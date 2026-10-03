import type { SqlRunner } from './curation.read.js';
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

export async function suggestSegmentsForCompany(
  run: SqlRunner,
  releaseId: string,
  companyId: string,
): Promise<SegmentSuggestion[]> {
  const cnaes = await run<{ cnae_code: string; is_primary: boolean }>(
    `SELECT cnae_code, is_primary FROM company_cnaes WHERE company_id = $1::uuid`,
    [companyId],
  );
  if (cnaes.length === 0) return [];

  const view = await loadReleaseView(run, releaseId);
  if (!view) return [];
  const sector = view.dimensions.find((d) => d.officialCodeType === 'CNAE');
  if (!sector) return [];

  return matchSegmentsByCnae(
    cnaes.map((row) => ({ code: row.cnae_code, isPrimary: row.is_primary })),
    view.concepts
      .filter((c) => c.dimensionCode === sector.code && c.officialCodes.length > 0)
      .map((c) => ({ code: c.code, label: c.label, prefixes: c.officialCodes })),
  );
}
