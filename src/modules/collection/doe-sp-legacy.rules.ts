import { isIsoDate } from './doe-sp-legacy.parser.js';
import { asciiUpper } from './doe-sp.parser.js';

/*
 * Tax scope of the legacy DOE-SP archive (Issue #20, decision of 2026-09-29:
 * "só páginas com termos fiscais"). The unit is a page of the gazette, not an
 * act: a page is kept when its text contains tax vocabulary.
 *
 * One vocabulary drives both steps, so discovery is a superset of what is kept
 * (review DOE-SP-LEGACY-04, B1):
 * - every term is sent to the portal's keyword index (Executivo II and III,
 *   from 2003 on; Executivo I is read whole) as a separate query (the index
 *   matches words; a multi-word query behaves like AND, which only widens
 *   the hits); spelling variants that the index
 *   might treat as different words (without accents, without hyphen) are
 *   queried too;
 * - every downloaded page is kept only when its text contains one of these
 *   same terms (accent- and case-insensitive, whole words). A page kept
 *   locally therefore always contains a term that was queried.
 *
 * The list covers every family of DOE_SP_TAX_TERMS (the vocabulary of the
 * current DOE-SP connector; the test suite checks each family) plus terms of
 * the pre-2023 administration. Ambiguous words stay out on purpose, as in
 * DOE_SP_TAX_TERMS: a bare "taxa" ("taxa de inscrição") or "Secretaria da
 * Fazenda" (personnel acts) alone does not make a page fiscal.
 */
export const DOE_SP_LEGACY_TAX_VOCABULARY: readonly string[] = [
  // Taxes and bodies.
  'ICMS', 'ICM', 'IPVA', 'ITCMD', 'ITCD', 'IPI', 'IBS', 'CBS', 'RICMS', 'CONFAZ', 'DIFAL',
  'Simples Nacional',
  // Tributo / tributação / tributário (TRIBUTAR*, TRIBUTO*, TRIBUTAC*).
  'tributo', 'tributos', 'tributar', 'tributação', 'tributações',
  'tributária', 'tributárias', 'tributário', 'tributários',
  'imposto', 'impostos',
  // Fiscal documents and obligations.
  'nota fiscal', 'notas fiscais', 'NF-e', 'NFC-e', 'CT-e', 'MDF-e', 'EFD', 'SPED',
  'documento fiscal', 'documentos fiscais',
  'obrigação acessória', 'obrigações acessórias',
  // Benefits, credits, debt, registry.
  'benefício fiscal', 'benefícios fiscais', 'incentivo fiscal', 'incentivos fiscais',
  'crédito outorgado', 'créditos outorgados', 'crédito presumido', 'créditos presumidos',
  'crédito acumulado', 'créditos acumulados',
  'dívida ativa', 'cadastro de contribuintes', 'Receita Estadual',
  // Legacy administration.
  'Portaria CAT', 'Portarias CAT',
  'taxa estadual', 'taxas estaduais', 'taxa judiciária', 'taxas judiciárias',
  'taxa de fiscalização', 'taxas de fiscalização', 'taxa de polícia', 'taxas de polícia',
];

/** Bumped whenever the vocabulary or its rules change (restarts an unfinished listing). */
export const DOE_SP_LEGACY_VOCABULARY_VERSION = 3;

/**
 * Acronyms that only name a tax from a given date (decision of the owner after
 * the dry pilot P1, DOE-SP-LEGACY-09): CT-e from 2007, IBS from 2019, CBS from
 * 2020. On an older page the acronym alone is another word ("Cte.", an
 * unrelated body or company) and does not keep the page; any other term still
 * does. Keys are the matched term without spaces/hyphens (ASCII upper).
 */
export const DOE_SP_LEGACY_TERM_SINCE: Readonly<Record<string, string>> = {
  CTE: '2007-01-01',
  IBS: '2019-01-01',
  CBS: '2020-01-01',
};

function stripAccents(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Queries sent to the keyword index: every term, plus its spelling without
 * accents and without hyphen when different (the index may not fold them).
 */
export const DOE_SP_LEGACY_SEARCH_TERMS: readonly string[] = (() => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const term of DOE_SP_LEGACY_TAX_VOCABULARY) {
    for (const variant of [term, stripAccents(term), term.replace(/-/g, ''), stripAccents(term).replace(/-/g, '')]) {
      const key = variant.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(variant);
    }
  }
  return out;
})();

function termSource(term: string): string {
  return asciiUpper(term)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/ /g, '\\s+')
    .replace(/-/g, '-?');
}

/** Local confirmation pattern, generated from the vocabulary (ASCII upper text). */
export const DOE_SP_LEGACY_TAX_PATTERN = new RegExp(
  '(?<![A-Z0-9])(?:' +
    // Longest first, so "NOTAS FISCAIS" wins over a shorter overlapping term.
    [...DOE_SP_LEGACY_TAX_VOCABULARY].sort((a, b) => b.length - a.length).map(termSource).join('|') +
    ')(?![A-Z0-9])',
  'g',
);

const MAX_MATCHED_TERMS = 20;

/**
 * Distinct tax terms found in the text of a page of `date` (YYYY-MM-DD), ASCII
 * upper, in order of appearance. Acronyms of DOE_SP_LEGACY_TERM_SINCE count
 * only on pages from their date on.
 */
export function doeSpLegacyTaxTerms(text: string, date: string): string[] {
  if (!isIsoDate(date)) throw new RangeError(`invalid page date ${date}`);
  const upper = asciiUpper(text);
  const found = new Set<string>();
  for (const match of upper.matchAll(new RegExp(DOE_SP_LEGACY_TAX_PATTERN))) {
    const term = match[0].replace(/\s+/g, ' ');
    const since = DOE_SP_LEGACY_TERM_SINCE[term.replace(/[\s-]/g, '')];
    if (since !== undefined && date < since) continue;
    found.add(term);
    if (found.size >= MAX_MATCHED_TERMS) break;
  }
  return [...found];
}

/**
 * "pagnot_" pages are the government news section (noticiário) printed in
 * Executivo I from ~2004; they are journalism, not official acts.
 */
export function isDoeSpLegacyNewsPage(link: string): boolean {
  return /\/pagnot_[^/]*$/i.test(link);
}
