import { asciiUpper } from './doe-sp.parser.js';
import { DOE_SP_TAX_TERMS } from './doe-sp.rules.js';

/*
 * Tax scope of the legacy DOE-SP archive (Issue #20, decision of 2026-09-29:
 * "só páginas com termos fiscais"). The unit is a page of the gazette, not an
 * act: a page is kept when its text contains tax vocabulary.
 *
 * - Search terms are sent to the portal's keyword index (editions from 2003
 *   on) to find candidate pages; the index matches words, so each term is a
 *   separate query and results are merged.
 * - Every downloaded page is confirmed locally with DOE_SP_TAX_TERMS (the
 *   vocabulary of the current DOE-SP connector) plus terms of the pre-2023
 *   administration. Ambiguous words stay out on purpose, as in
 *   DOE_SP_TAX_TERMS: a bare "taxa" ("taxa de inscrição") or "Secretaria da
 *   Fazenda" (personnel acts) alone does not make a page fiscal.
 */
export const DOE_SP_LEGACY_SEARCH_TERMS: readonly string[] = [
  'ICMS', 'ICM', 'IPVA', 'ITCMD', 'ITCD', 'RICMS', 'CONFAZ', 'IPI', 'DIFAL',
  'tributária', 'tributário', 'tributação', 'tributo', 'tributos',
  'imposto', 'impostos', 'Simples Nacional',
  'nota fiscal', 'notas fiscais', 'NF-e', 'documento fiscal', 'EFD', 'SPED',
  'dívida ativa', 'benefício fiscal', 'incentivo fiscal',
  'crédito outorgado', 'crédito presumido', 'crédito acumulado',
  'Portaria CAT',
];

/** Legacy administration vocabulary (ASCII upper), on top of DOE_SP_TAX_TERMS. */
export const DOE_SP_LEGACY_EXTRA_TAX_TERMS = new RegExp(
  '\\b(?:' + [
    // ICM: the state tax before the 1988 Constitution (ICMS from 03/1989).
    'ICM',
    'PORTARIAS? CAT', 'COORDENA\\w* DA ADMINISTRACAO TRIBUTARIA', 'ADMINISTRACAO TRIBUTARIA',
    'TRIBUNAL DE IMPOSTOS E TAXAS',
    'TAXAS? (?:ESTADUA\\w*|JUDICIARIA|DE FISCALIZACAO|DE POLICIA)',
  ].join('|') + ')\\b',
);

const MAX_MATCHED_TERMS = 20;

function globalCopy(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
}

/** Distinct tax terms found in the page text (ASCII upper), in order of appearance. */
export function doeSpLegacyTaxTerms(text: string): string[] {
  const upper = asciiUpper(text);
  const found = new Set<string>();
  for (const pattern of [DOE_SP_TAX_TERMS, DOE_SP_LEGACY_EXTRA_TAX_TERMS]) {
    for (const match of upper.matchAll(globalCopy(pattern))) {
      found.add(match[0]);
      if (found.size >= MAX_MATCHED_TERMS) return [...found];
    }
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
