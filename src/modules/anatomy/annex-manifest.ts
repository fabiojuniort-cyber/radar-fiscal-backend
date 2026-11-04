import { createHash } from 'node:crypto';
import type { AnatomyReaderResult } from './readers.js';

/**
 * ANAT-EXT-01: annexes as documents of their own. `buildAnnexManifest` lists every annex of a read act (inline in the
 * body) with its span, label, part count and the SHA-256 of its exact canonical text, so an annex can be cited, hashed
 * and compared on its own. `linkSeparateAnnexes` binds annexes published as SEPARATE files (own representation) to the
 * main act: each one keeps its own hash and anatomy, and the link is made only by an explicit declared label — never by
 * guessing. An inline annex with no separate file, or a separate file with no inline heading, is reported, not invented.
 * No validity is inferred: legal status stays as the reader left it.
 */
export interface AnnexEntry {
  partId: string; label: string; span: { start: number; end: number }; textSha256: string; partCount: number;
  context: string; origin: 'inline';
}
export interface SeparateAnnexInput { declaredLabel: string; representationId: string; bytesSha256: string; result: AnatomyReaderResult }
export interface SeparateAnnexEntry { declaredLabel: string; representationId: string; bytesSha256: string; textSha256: string; partCount: number; origin: 'separate'; inlinePartId: string | null }
export interface AnnexManifest { inline: AnnexEntry[]; separate: SeparateAnnexEntry[]; issues: { code: 'annex_separate_without_heading' | 'annex_label_duplicate'; label: string }[] }

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
/** Label comparison key: whitespace collapsed, case folded, accents kept (ANEXO I ≠ ANEXO Í is not an issue here). */
export const annexKey = (label: string) => label.normalize('NFC').replace(/\s+/gu, ' ').trim().toLocaleUpperCase('pt-BR');

export function buildAnnexManifest(result: AnatomyReaderResult): AnnexEntry[] {
  const children = new Map<string | null, string[]>();
  for (const p of result.parts) children.set(p.parentId, [...(children.get(p.parentId) ?? []), p.id]);
  const count = (id: string): number => (children.get(id) ?? []).reduce((n, c) => n + 1 + count(c), 0);
  return result.parts.filter((p) => p.type === 'annex').map((p) => ({
    partId: p.id, label: p.label.replace(/\s+/gu, ' ').trim(), span: { ...p.span },
    textSha256: sha(result.canonicalText.slice(p.span.start, p.span.end)), partCount: count(p.id),
    context: p.context, origin: 'inline' as const,
  }));
}

export function linkSeparateAnnexes(main: AnatomyReaderResult, separate: readonly SeparateAnnexInput[]): AnnexManifest {
  const inline = buildAnnexManifest(main);
  const issues: AnnexManifest['issues'] = [];
  const byKey = new Map<string, AnnexEntry[]>();
  // The heading may carry a title after a dash ("ANEXO I - MODELO"); only the designation is the link key.
  for (const a of inline) { const k = annexKey(a.label.split(/\s[-–—]\s/u)[0]!); byKey.set(k, [...(byKey.get(k) ?? []), a]); }
  // R2-06: decide ambiguity on the WHOLE set before linking, so the result never depends on file order. Every separate
  // file of a repeated designation stays listed with its own hashes, none of them is linked, and the group is flagged.
  const declared = new Map<string, number>();
  for (const s of separate) declared.set(annexKey(s.declaredLabel), (declared.get(annexKey(s.declaredLabel)) ?? 0) + 1);
  const flagged = new Set<string>();
  const out = separate.map((s) => {
    const key = annexKey(s.declaredLabel);
    const matches = byKey.get(key) ?? [];
    const ambiguous = (declared.get(key) ?? 0) > 1 || matches.length > 1;
    if (ambiguous && !flagged.has(key)) { flagged.add(key); issues.push({ code: 'annex_label_duplicate', label: key }); }
    else if (!ambiguous && matches.length === 0) issues.push({ code: 'annex_separate_without_heading', label: s.declaredLabel });
    return { declaredLabel: s.declaredLabel, representationId: s.representationId, bytesSha256: s.bytesSha256, textSha256: sha(s.result.canonicalText),
      partCount: s.result.parts.length, origin: 'separate' as const, inlinePartId: !ambiguous && matches.length === 1 ? matches[0]!.partId : null };
  });
  return { inline, separate: out, issues };
}
