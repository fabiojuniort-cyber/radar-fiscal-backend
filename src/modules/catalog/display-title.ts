/**
 * Title shown for a publication. Acts collected from the DOU often carry
 * only their heading as title ("CONVÊNIO ICMS Nº 114, DE 30 DE SETEMBRO DE
 * 2026"), which repeats the act number shown next to it. Every act opens
 * with its summary (ementa) right after that heading, before the preamble
 * ("O Conselho Nacional de Política Fazendária ..."): that summary is the
 * title people need, so it is read from the act's own text.
 */

const HEADING_ONLY =
  /^(CONV[ÊE]NIO|AJUSTE|PROTOCOLO|ATO\s+COTEPE)\b[^.]{0,110}?(\bDE\s+\d{4}|\d+\s*\/\s*\d{2,4})\s*\.?$/i;
const PREAMBLE =
  /\s(?:O\s+Conselho\s+Nacional|O\s+Ministro\s+de\s+Estado|Os?\s+Secret[áa]rios?\s+(?:de|Executivos?)|O\s+Presidente\s+do|A\s+Comiss[ãa]o\s+T[ée]cnica|Cl[áa]usula\s+primeira)\b/;
const NOT_A_SUMMARY =
  /^(Publicad|Republicad|Retifica|Ratifica|Alterad|Revogad|Prorrogad|Vide\b|Nova\s+reda|Reda[çc][ãa]o)/i;

/** Characters of the act text needed to find its summary. */
export const DISPLAY_TITLE_CONTENT_CHARS = 4000;

const fold = (value: string) =>
  value.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** The act's summary when its stored title is only its heading. */
export function actSummaryFromText(title: string, contentText: string | null | undefined): string | null {
  const heading = title.replace(/\s+/g, ' ').trim();
  if (!contentText || heading.length > 140 || !HEADING_ONLY.test(heading)) return null;

  const text = contentText.slice(0, DISPLAY_TITLE_CONTENT_CHARS).replace(/\s+/g, ' ').trim();
  // Locate the heading at the start of the text (case/accents may differ).
  const folded = fold(text);
  const at = folded.indexOf(fold(heading));
  if (at < 0 || at > 300) return null;
  // fold() keeps one character per input character after whitespace
  // normalization, so positions match the normalized text.
  const afterHeading = text.slice(at + heading.length).replace(/^[\s.,;:–-]+/, '');

  const end = PREAMBLE.exec(` ${afterHeading}`);
  if (!end) return null;
  const summary = afterHeading.slice(0, Math.max(0, end.index - 1)).trim();
  if (summary.length < 15 || summary.length > 800 || NOT_A_SUMMARY.test(summary)) return null;
  return summary;
}

export function publicationDisplayTitle(title: string, contentText: string | null | undefined): string {
  return actSummaryFromText(title, contentText) ?? title;
}
