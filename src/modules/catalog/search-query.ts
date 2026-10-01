const MAX_SEARCH_TERMS = 12;

/**
 * Turns what a user typed in the Acervo search box into a PostgreSQL
 * tsquery string for the `public.pt_unaccent` configuration.
 *
 * - Only letters and digits survive, so tsquery operators typed by the user
 *   cannot change the query shape.
 * - Every term must match (AND).
 * - The last term matches as a prefix when it contains a letter, because it
 *   is usually still being typed ("Conv" -> Convênio). Numbers stay exact so
 *   "Portaria 1216" does not match 12160.
 *
 * Returns null when nothing searchable remains.
 */
export function buildSearchTsquery(input: string): string | null {
  const terms = (input.normalize('NFC').match(/[\p{L}\p{N}]+/gu) ?? [])
    .slice(0, MAX_SEARCH_TERMS)
    .map((term) => term.toLowerCase());

  if (terms.length === 0) {
    return null;
  }

  return terms
    .map((term, index) =>
      index === terms.length - 1 && /\p{L}/u.test(term)
        ? `${term}:*`
        : term,
    )
    .join(' & ');
}
