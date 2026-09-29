import { ConnectorError } from './connector.error.js';
import { DOE_SP_LEGACY_ORIGIN } from './doe-sp-legacy.client.js';

/*
 * Parsers and URL builders for the legacy DOE-SP archive (Imprensa Oficial,
 * "BuscaDO2001" result pages). Measured on the source 09/2026 (Issue #20,
 * DOE-SP-LEGACY-02/03):
 * - the same result page lists a whole edition (empty keyword, mode FE) or a
 *   keyword search over a period (mode UP), 15 page-documents per screen,
 *   paginated by `xhitlist_vpc=<n>` (`first` for the first screen);
 * - keyword search only covers editions from 2003 on; older editions are
 *   listed whole (per date) and filtered locally;
 * - every item links to `BuscaDO2001Documento_11_4.aspx?link=<path>&pagina=
 *   &data=&caderno=&paginaordenacao=` (public viewer) and the page PDF is
 *   served by `GatewayPDF.aspx` with the same parameters;
 * - a search without hits redirects to `BuscaDO2001ResultadoNegativo_11_3a`.
 * Unknown shapes fail with a PROCESSING_ERROR instead of an empty result.
 */

function invalid(code: string, metadata?: Record<string, unknown>): ConnectorError {
  return new ConnectorError(code, {
    code,
    kind: 'PROCESSING_ERROR',
    retryable: false,
    ...(metadata ? { metadata } : {}),
  });
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

function plainText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' '),
  ).replace(/\s+/g, ' ').trim();
}

/** `DD/MM/YYYY` -> `YYYY-MM-DD`. */
export function isoFromBr(value: string): string | undefined {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!match) return undefined;
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  return new Date(iso + 'T00:00:00Z').toISOString().slice(0, 10) === iso ? iso : undefined;
}

export function brFromIso(date: string): string {
  return `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
}

function compactFromIso(date: string): string {
  return date.replace(/-/g, '');
}

// ---------------------------------------------------------------- cadernos

export interface DoeSpLegacyCaderno { id: string; name: string }

/**
 * AjaxPro `GetCadernos` answers a JavaScript array literal with single-quoted
 * keys: `[{'ID':'ex1','texto':'Executivo I'},...]`; `[]` = no edition.
 */
export function parseDoeSpLegacyCadernos(raw: string): DoeSpLegacyCaderno[] {
  const body = raw.trim().replace(/;\s*\/\*[\s\S]*$/, '').replace(/;$/, '');
  if (!body.startsWith('[') || !body.endsWith(']')) throw invalid('DOE_SP_LEGACY_INVALID_CADERNOS');
  const out: DoeSpLegacyCaderno[] = [];
  for (const match of body.matchAll(/'ID'\s*:\s*'([^']*)'\s*,\s*'texto'\s*:\s*'([^']*)'/g)) {
    const id = match[1]!.trim();
    const name = match[2]!.trim();
    if (/^[a-z0-9]{2,8}$/i.test(id) && name) out.push({ id, name });
  }
  if (!out.length && body.replace(/\s/g, '') !== '[]') throw invalid('DOE_SP_LEGACY_INVALID_CADERNOS');
  return out;
}

// ---------------------------------------------------------------- page refs

export interface DoeSpLegacyPageRef {
  /** Canonical archive path, e.g. `/1995/executivo secao i/setembro/06/pag_0001_<id>.pdf`. */
  link: string;
  /** Page label as printed (arabic, or roman numerals for news pages). */
  pagina: string;
  /** DOE date (YYYY-MM-DD). */
  date: string;
  /** Caderno name as used by the portal (e.g. `Executivo I`). */
  caderno: string;
  paginaOrdenacao: string;
}

/** Fully decodes the `link` parameter (the portal double-encodes spaces). */
export function canonicalLegacyLink(value: string): string {
  let current = value.replace(/\+/g, ' ');
  for (let i = 0; i < 3; i += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      break;
    }
    if (next === current) break;
    current = next;
  }
  return current.trim();
}

function refFromHref(href: string): DoeSpLegacyPageRef | undefined {
  let params: URLSearchParams;
  try {
    params = new URL(decodeEntities(href), DOE_SP_LEGACY_ORIGIN).searchParams;
  } catch {
    return undefined;
  }
  const rawLink = params.get('link');
  const pagina = params.get('pagina')?.trim();
  const date = isoFromBr(params.get('data') ?? '');
  const caderno = params.get('caderno')?.trim();
  const paginaOrdenacao = params.get('paginaordenacao')?.trim();
  if (!rawLink || !pagina || !date || !caderno || !paginaOrdenacao) return undefined;
  const link = canonicalLegacyLink(rawLink);
  if (!/^\/\d{4}\/[^?#]+\.pdf$/i.test(link) || link.includes('..')) return undefined;
  return { link, pagina, date, caderno, paginaOrdenacao };
}

export interface DoeSpLegacyResultPage {
  /** false = the portal answered "no results" (negative page). */
  found: boolean;
  total: number;
  items: DoeSpLegacyPageRef[];
  /** Number of result links that could not be parsed. */
  malformed: number;
}

/** Documents per result screen (measured). */
export const DOE_SP_LEGACY_RESULTS_PER_SCREEN = 15;

export function parseDoeSpLegacyResults(html: string, finalUrl: string): DoeSpLegacyResultPage {
  const text = plainText(html);
  if (/ResultadoNegativo/i.test(finalUrl) || /n[ãa]o houve resultados/i.test(text)) {
    return { found: false, total: 0, items: [], malformed: 0 };
  }
  const total = /Documentos encontrados:\s*(\d+)/i.exec(text);
  if (!total) throw invalid('DOE_SP_LEGACY_INVALID_RESULT_PAGE', { path: new URL(finalUrl).pathname });
  const items: DoeSpLegacyPageRef[] = [];
  const seen = new Set<string>();
  let malformed = 0;
  for (const match of html.matchAll(/href="([^"]*BuscaDO2001Documento_11_4\.aspx\?[^"]*)"/gi)) {
    const ref = refFromHref(match[1]!);
    if (!ref) { malformed += 1; continue; }
    if (seen.has(ref.link)) continue;
    seen.add(ref.link);
    items.push(ref);
  }
  return { found: true, total: Number(total[1]), items, malformed };
}

// ---------------------------------------------------------------- urls

export type DoeSpLegacyKeywordMode =
  /** Whole edition: empty keyword, "frase exata". */
  | 'FE'
  /** Keyword search. */
  | 'UP';

export function doeSpLegacyResultUrl(input: {
  from: string;
  to: string;
  caderno: DoeSpLegacyCaderno;
  keyword?: string;
}): string {
  const keyword = input.keyword?.trim();
  const params = new URLSearchParams({
    filtrotipopalavraschavesalvar: keyword ? 'UP' : 'FE',
    filtrodatainiciosalvar: compactFromIso(input.from),
    filtrodatafimsalvar: compactFromIso(input.to),
    filtroperiodo: `${brFromIso(input.from)} a ${brFromIso(input.to)}`,
    filtrocadernos: input.caderno.name,
    filtrocadernossalvar: input.caderno.id,
    filtropalavraschave: keyword || ' ',
    xhitlist_vpc: 'first',
    filtrotodoscadernos: ' ',
  });
  return `${DOE_SP_LEGACY_ORIGIN}/DO/BuscaDO2001Resultado_11_3.aspx?${params}`;
}

/** Result screen `n` (1-based) of a result URL built by doeSpLegacyResultUrl. */
export function doeSpLegacyResultScreenUrl(firstUrl: string, screen: number): string {
  const url = new URL(firstUrl);
  url.searchParams.set('xhitlist_vpc', screen <= 1 ? 'first' : String(screen));
  return url.toString();
}

function linkParam(link: string): string {
  // The portal keeps spaces as %20 inside the `link` value.
  return link.replace(/ /g, '%20');
}

/** Public viewer of the page (the link preserved for the user). */
export function doeSpLegacyViewerUrl(ref: DoeSpLegacyPageRef): string {
  const params = new URLSearchParams({
    link: linkParam(ref.link),
    pagina: ref.pagina,
    data: brFromIso(ref.date),
    caderno: ref.caderno,
    paginaordenacao: ref.paginaOrdenacao,
  });
  return `${DOE_SP_LEGACY_ORIGIN}/DO/BuscaDO2001Documento_11_4.aspx?${params}`;
}

/** Direct page PDF (downloaded in memory, never stored). */
export function doeSpLegacyPdfUrl(ref: DoeSpLegacyPageRef): string {
  return `${DOE_SP_LEGACY_ORIGIN}/DO/GatewayPDF.aspx?pagina=${encodeURIComponent(ref.pagina)}` +
    `&caderno=${encodeURIComponent(ref.caderno)}&data=${brFromIso(ref.date)}` +
    `&link=${linkParam(ref.link)}&paginaordenacao=${encodeURIComponent(ref.paginaOrdenacao)}`;
}

export function isIsoDate(value: string): boolean {
  return ISO_DATE.test(value) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}
