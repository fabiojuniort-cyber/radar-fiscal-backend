import type { AnatomyGold } from '../../src/modules/anatomy/gold.js';

/**
 * Static breakdown of nomenclature-code occurrences in a gold file, used by the measurement matrix
 * (docs/anatomy/GOLD-COVERAGE.md). It reads only the gold; it never runs the engine or measures anything.
 * Role priority: chapter (2 digits) > range member > exception target > standalone.
 */
export type CodeRole = 'chapter' | 'range_member' | 'exception_target' | 'standalone';
export interface CodeBreakdown {
  total: number;
  byContext: Record<string, number>;
  operative: { total: number; byRole: Record<CodeRole, number>; standaloneInCodeColumn: number; standaloneInText: number; rangeAndException: number };
  /** Occurrences that must never receive a positive `ncm` selection (S1 denominator). */
  nonCandidates: number;
  structuralPositiveCandidates: { NCM: number; NBM: number };
}

export function codeBreakdown(gold: AnatomyGold): CodeBreakdown {
  const parts = new Map(gold.parts.map((p) => [p.id, p]));
  const range = new Set(gold.relations.filter((r) => r.kind === 'range').flatMap((r) => r.memberEntityIds));
  const exception = new Set(gold.relations.filter((r) => r.kind === 'exception').flatMap((r) => r.targetEntityIds));
  const codes = gold.entities.filter((e) => e.domain === 'NCM' || e.domain === 'NBM');
  const byContext: Record<string, number> = {};
  const byRole: Record<CodeRole, number> = { chapter: 0, range_member: 0, exception_target: 0, standalone: 0 };
  let inColumn = 0; let inText = 0; let both = 0; let operative = 0; const candidates = { NCM: 0, NBM: 0 };
  for (const e of codes) {
    const part = parts.get(e.partId)!;
    byContext[part.context] = (byContext[part.context] ?? 0) + 1;
    if (part.context !== 'operative_candidate') continue;
    operative++;
    const digits = e.literal.replace(/\D/g, '').length;
    const role: CodeRole = digits === 2 ? 'chapter' : range.has(e.id) ? 'range_member' : exception.has(e.id) ? 'exception_target' : 'standalone';
    byRole[role]++;
    if (range.has(e.id) && exception.has(e.id)) both++;
    if (role === 'standalone') {
      if (part.type === 'cell' && part.table?.headerDomain) inColumn++; else inText++;
      candidates[e.domain as 'NCM' | 'NBM']++;
    }
  }
  return { total: codes.length, byContext, operative: { total: operative, byRole, standaloneInCodeColumn: inColumn, standaloneInText: inText, rangeAndException: both },
    // Non-candidates for the `ncm` channel: an NBM code is never an NCM catalogue selection.
    nonCandidates: codes.length - candidates.NCM, structuralPositiveCandidates: candidates };
}
