/**
 * Taxonomic NCM prefix matching (F2-T03).
 *
 * Both the company/product NCM and the legislation NCM can be a chapter
 * (2), heading (4), subheading (6) or item (8). Dots are display masks,
 * NOT semantic delimiters. Reject everything except digits and dots.
 *
 * A prefix hit is potential relevance, never proof of fiscal incidence.
 */
export function normalizeNcmPrefix(value: string): string | null {
  const raw = value.trim();
  if (!raw || !/^[0-9.]+$/.test(raw)) return null;
  const digits = raw.replace(/\./g, '');
  return /^(?:\d{2}|\d{4}|\d{6}|\d{8})$/.test(digits) ? digits : null;
}

export function ncmMatchesEitherPrefix(left: string, right: string): boolean {
  const a = normalizeNcmPrefix(left);
  const b = normalizeNcmPrefix(right);
  return a !== null && b !== null && (a.startsWith(b) || b.startsWith(a));
}
