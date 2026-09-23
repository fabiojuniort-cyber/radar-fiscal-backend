import { Parser } from 'htmlparser2';

export type SpedModule =
  | 'EFD_ICMS_IPI'
  | 'EFD_CONTRIBUICOES'
  | 'EFD_REINF'
  | 'DERE';

export type SpedDocumentKind =
  | 'GUIDE'
  | 'TECHNICAL_NOTE'
  | 'ORIENTATION_NOTE'
  | 'LAYOUT'
  | 'XSD_SCHEMA'
  | 'TABLE'
  | 'SOFTWARE_RELEASE'
  | 'MANUAL'
  | 'EVOLUTION_DOCUMENT'
  | 'OPERATIONAL_NOTICE';

export type SpedRevisionKind =
  | 'ORIGINAL'
  | 'OFFICIAL_VERSION'
  | 'REPUBLICATION'
  | 'UPDATE';

export type SpedDocumentStatus =
  | 'DRAFT'
  | 'FINAL'
  | 'UNKNOWN';

export interface SpedParsedLink {
  url: string;
  text: string;
  path: string;
}

export interface SpedPage {
  url: string;
  /** Visible page text. Never includes <script>/<style> payloads. */
  text: string;
  /**
   * Canonical document text used for publication content (and therefore
   * content_hash). For gov.br pages it is derived from the structured Volto
   * object (description, rich text and slate blocks in layout order), so
   * portal chrome, navigation and per-request state never enter it.
   */
  documentText: string;
  documentTextSource: 'VOLTO_CONTENT' | 'VISIBLE_TEXT';
  headings: string[];
  title: string;
  publishedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  itemId?: string;
  links: SpedParsedLink[];
  fileLinks: SpedParsedLink[];
  legacyLinks: SpedParsedLink[];
}

export type SpedDocumentCarrier = 'DOCUMENT' | 'ANNOUNCEMENT';

export interface SpedDocumentDescriptor {
  module: SpedModule;
  kind: SpedDocumentKind;
  /**
   * DOCUMENT: the official document/page itself.
   * ANNOUNCEMENT: a gov.br "comunicado" about a document. It is a distinct
   * official object (own text/date) and must not share identity with the
   * document it announces.
   */
  carrier: SpedDocumentCarrier;
  /** Stable portal path (gov.br) or legacy item reference; identity fallback. */
  canonicalPath: string;
  documentTextSource: 'VOLTO_CONTENT' | 'VISIBLE_TEXT';
  title: string;
  itemId: string;
  externalId: string;
  officialUrl: string;
  publishedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  officialVersion?: string;
  documentNumber?: string;
  actNumber?: string;
  documentFamily: string;
  revisionKind: SpedRevisionKind;
  republication: boolean;
  documentStatus: SpedDocumentStatus;
  description?: string;
  relatedTaxes: string[];
  affectedRecords: string[];
  linkedArtifactExternalIds?: string[];
  legacyReferences?: string[];
  files: Array<{
    url: string;
    externalId: string;
    name?: string;
  }>;
}

const SPED_LEGACY_ORIGIN = 'https://sped.rfb.gov.br';
const SPED_GOVBR_ORIGIN = 'https://www.gov.br';
const SPED_GOVBR_PREFIX = '/sped/pt-br/';
const NON_VISIBLE_TAGS = new Set(['script', 'style', 'noscript', 'template']);
const MODULE_TITLES = new Set([
  'EFD ICMS IPI',
  'EFD-ICMS/IPI',
  'EFD CONTRIBUIÇÕES',
  'EFD CONTRIBUICOES',
  'EFD-REINF',
  'DERE',
  'DECLARAÇÃO DE REGIMES ESPECÍFICOS',
  'DECLARACAO DE REGIMES ESPECIFICOS',
  'DESTAQUES',
  'DOWNLOADS',
]);

function normalizeSpace(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeCompare(value: string): string {
  return normalizeSpace(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleUpperCase('pt-BR');
}

function parseBrDate(value: string): Date | undefined {
  const match = /(\d{2})\/(\d{2})\/(\d{4})/.exec(value);
  if (!match) return undefined;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return undefined;
  return date;
}

function linkPath(url: string): string {
  try {
    const parsed = new URL(url, SPED_LEGACY_ORIGIN);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}

function isGovBrSpedUrl(url: URL): boolean {
  return url.origin.toLowerCase() === SPED_GOVBR_ORIGIN &&
    (url.pathname === '/sped/pt-br' || url.pathname.startsWith(SPED_GOVBR_PREFIX));
}

function samePortalUrl(candidate: URL, pageUrl: URL): boolean {
  if (pageUrl.origin.toLowerCase() === SPED_LEGACY_ORIGIN) {
    return candidate.origin.toLowerCase() === SPED_LEGACY_ORIGIN;
  }
  if (isGovBrSpedUrl(pageUrl)) return isGovBrSpedUrl(candidate);
  return false;
}

function stableGovPath(url: URL): string {
  return url.pathname.replace(/\/$/, '') || '/';
}

function isGovBrSystemResource(url: URL): boolean {
  if (!isGovBrSpedUrl(url)) return false;
  const segments = url.pathname.split('/').filter(Boolean);
  return segments.some((segment) => {
    if (/^@@(?:display-file|download)$/i.test(segment)) return false;
    return segment === 'object_copy' || segment.startsWith('@');
  });
}

function documentPageIdFromUrl(url: string): { id: string; type: 'item' | 'arquivo' | 'pagina' | 'govbr' } | undefined {
  const parsed = new URL(url, SPED_LEGACY_ORIGIN);
  const path = parsed.pathname + parsed.search;
  const item = /\/item\/show\/(\d+)/i.exec(path)?.[1];
  if (item) return { id: item, type: 'item' };
  const archive = /\/arquivo\/show\/(\d+)/i.exec(path)?.[1];
  if (archive) return { id: archive, type: 'arquivo' };
  const page = /\/pagina\/show\/(\d+)/i.exec(path)?.[1];
  if (page) return { id: page, type: 'pagina' };
  if (isGovBrSpedUrl(parsed)) return { id: stableGovPath(parsed), type: 'govbr' };
  return undefined;
}

function itemIdFromUrl(url: string): string | undefined {
  return documentPageIdFromUrl(url)?.id;
}

function fileIdFromUrl(url: string): string | undefined {
  const parsed = new URL(url, SPED_LEGACY_ORIGIN);
  const path = parsed.pathname + parsed.search;
  const legacy = /\/arquivo\/(?:download|show)\/(\d+)/i.exec(path)?.[1]
    ?? /\/estatico\/([^/]+)\/([^/?#]+)/i.exec(path)?.slice(1).join(':');
  if (legacy) return legacy;
  if (isGovBrSpedUrl(parsed)) {
    return 'govbr:' + stableGovPath(parsed).replace(/\/@@(?:display-file|download)\/file$/i, '');
  }
  return undefined;
}

function headingTitle(headings: string[], fallbackText: string): string {
  const candidates = headings
    .map(normalizeSpace)
    .filter(Boolean)
    .filter((heading) => !MODULE_TITLES.has(normalizeCompare(heading)))
    .filter((heading) => !/^SPED\s*[—-]\s*SISTEMA P[ÚU]BLICO DE ESCRITURA[ÇC][ÃA]O DIGITAL$/i.test(heading));
  const first = candidates[0];
  if (first) return first;
  const firstLine = normalizeSpace(fallbackText).slice(0, 240);
  return firstLine || 'Portal SPED';
}


function parseVoltoState(html: string): unknown {
  const match = /<script[^>]*>\s*window\.__data\s*=\s*([\s\S]*?)<\/script>/i.exec(html);
  if (!match?.[1]) return undefined;
  const raw = match[1].trim().replace(/;\s*$/, '').replace(/\bundefined\b/g, 'null');
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function embeddedLinks(html: string, pageUrl: string): SpedParsedLink[] {
  const state = parseVoltoState(html);
  if (!state) return [];
  const page = new URL(pageUrl);
  const found = new Map<string, SpedParsedLink>();
  const visited = new Set<object>();

  const add = (rawUrl: string, text = '') => {
    try {
      const candidate = rawUrl.trim();
      if (!candidate || /^(?:URL|URI|HREF)$/i.test(candidate)) return;
      const absolute = new URL(candidate, page);
      if (!samePortalUrl(absolute, page) && absolute.origin.toLowerCase() !== SPED_LEGACY_ORIGIN) return;
      if (isGovBrSystemResource(absolute)) return;
      absolute.hash = '';
      const key = absolute.toString();
      const existing = found.get(key);
      if (!existing || (!existing.text && text)) {
        found.set(key, {
          url: key,
          path: absolute.pathname + absolute.search,
          text: normalizeSpace(text),
        });
      }
    } catch {}
  };

  const walk = (value: unknown): void => {
    if (typeof value === 'string') return;
    if (!value || typeof value !== 'object') return;
    if (visited.has(value)) return;
    visited.add(value);

    const record = value as Record<string, unknown>;
    const candidateUrl = typeof record['@id'] === 'string'
      ? record['@id']
      : typeof record.href === 'string'
        ? record.href
        : typeof record.url === 'string'
          ? record.url
          : undefined;
    const title = typeof record.title === 'string'
      ? record.title
      : typeof record.name === 'string'
        ? record.name
        : '';
    if (candidateUrl) add(candidateUrl, title);

    for (const nested of Object.values(record)) walk(nested);
  };

  walk(state);
  return [...found.values()];
}

function stripHtml(value: string): string {
  let text = '';
  const parser = new Parser({
    ontext(chunk) {
      text += chunk + ' ';
    },
  }, { decodeEntities: true });
  parser.end(value);
  return normalizeSpace(text);
}

function slateText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(slateText).join(' ');
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  const own = typeof record.text === 'string' ? record.text : '';
  return own + ' ' + slateText(record.children);
}

/**
 * Stable document text from the Volto content object (window.__data.content).
 *
 * Only editorial fields are used. Router keys, redux state, navigation,
 * breadcrumbs, timestamps and any other per-request/portal data are ignored.
 */
function voltoDocumentText(state: unknown): string | undefined {
  if (!state || typeof state !== 'object') return undefined;
  const content = (state as Record<string, unknown>).content;
  if (!content || typeof content !== 'object') return undefined;
  const contentRecord = content as Record<string, unknown>;
  const data = (contentRecord.data && typeof contentRecord.data === 'object'
    ? contentRecord.data
    : contentRecord) as Record<string, unknown>;
  if (typeof data['@type'] !== 'string' && typeof data.title !== 'string') return undefined;

  const parts: string[] = [];
  if (typeof data.description === 'string') parts.push(data.description);

  const richText = data.text;
  if (richText && typeof richText === 'object' && typeof (richText as Record<string, unknown>).data === 'string') {
    parts.push(stripHtml((richText as Record<string, unknown>).data as string));
  } else if (typeof richText === 'string') {
    parts.push(stripHtml(richText));
  }

  const blocks = data.blocks && typeof data.blocks === 'object'
    ? data.blocks as Record<string, unknown>
    : undefined;
  if (blocks) {
    const layout = data.blocks_layout && typeof data.blocks_layout === 'object'
      ? (data.blocks_layout as Record<string, unknown>).items
      : undefined;
    const order = Array.isArray(layout)
      ? layout.filter((id): id is string => typeof id === 'string')
      : Object.keys(blocks).sort();
    for (const id of order) {
      const block = blocks[id];
      if (!block || typeof block !== 'object') continue;
      const record = block as Record<string, unknown>;
      if (record['@type'] !== 'slate' && record['@type'] !== 'text') continue;
      if (typeof record.plaintext === 'string' && record.plaintext.trim()) {
        parts.push(record.plaintext);
      } else if (record.value !== undefined) {
        parts.push(slateText(record.value));
      } else if (record.text && typeof record.text === 'object') {
        parts.push(slateText((record.text as Record<string, unknown>).blocks));
      }
    }
  }

  const file = data.file && typeof data.file === 'object'
    ? data.file as Record<string, unknown>
    : undefined;
  if (file && typeof file.filename === 'string') parts.push('Arquivo: ' + file.filename);

  return normalizeSpace(parts.join(' '));
}

function isDirectFileLink(link: SpedParsedLink): boolean {
  return /\/arquivo\/download\/\d+/i.test(link.path) ||
    /\/estatico\//i.test(link.path) ||
    /\/@@(?:display-file|download)\/file(?:$|[?#])/i.test(link.path);
}

export function parseSpedPage(html: string, url: string): SpedPage {
  const links: SpedParsedLink[] = [];
  const legacyLinks: SpedParsedLink[] = [];
  const headings: string[] = [];
  const pageUrl = new URL(url, SPED_LEGACY_ORIGIN);
  const allText: string[] = [];
  let currentLink: { href: string; text: string } | undefined;
  let currentHeading: { tag: string; text: string } | undefined;
  let hiddenDepth = 0;

  const parser = new Parser({
    onopentag(name, attrs) {
      const tag = name.toLowerCase();
      if (NON_VISIBLE_TAGS.has(tag)) hiddenDepth += 1;
      if (tag === 'a' && attrs.href) currentLink = { href: attrs.href, text: '' };
      if (/^h[1-4]$/.test(tag)) currentHeading = { tag, text: '' };
    },
    ontext(text) {
      if (hiddenDepth > 0) return;
      allText.push(text);
      if (currentLink) currentLink.text += text;
      if (currentHeading) currentHeading.text += text;
    },
    onclosetag(name) {
      const tag = name.toLowerCase();
      if (NON_VISIBLE_TAGS.has(tag) && hiddenDepth > 0) hiddenDepth -= 1;
      if (tag === 'a' && currentLink) {
        try {
          const absolute = new URL(currentLink.href, url);
          const parsedLink = {
            url: absolute.toString(),
            path: absolute.pathname + absolute.search,
            text: normalizeSpace(currentLink.text),
          };
          if (samePortalUrl(absolute, pageUrl)) {
            links.push(parsedLink);
          } else if (absolute.origin.toLowerCase() === SPED_LEGACY_ORIGIN) {
            legacyLinks.push(parsedLink);
          }
        } catch {}
        currentLink = undefined;
      }
      if (/^h[1-4]$/.test(tag) && currentHeading) {
        const value = normalizeSpace(currentHeading.text);
        if (value) headings.push(value);
        currentHeading = undefined;
      }
    },
  }, { decodeEntities: true });
  parser.end(html);

  for (const embedded of embeddedLinks(html, url)) {
    const absolute = new URL(embedded.url);
    if (samePortalUrl(absolute, pageUrl)) {
      if (!links.some((link) => link.url === embedded.url)) links.push(embedded);
    } else if (
      absolute.origin.toLowerCase() === SPED_LEGACY_ORIGIN &&
      !legacyLinks.some((link) => link.url === embedded.url)
    ) {
      legacyLinks.push(embedded);
    }
  }

  const text = normalizeSpace(allText.join(' '));
  const publishedMatch = /Publicado\s+em\s+(\d{2}\/\d{2}\/\d{4})/i.exec(text);
  const dataMatch = /\bData\s+(\d{2}\/\d{2}\/\d{4})(?:\s+\d{2}:\d{2}:\d{2})?/i.exec(text);
  const createdMatch = /Criado\s+em\s+(\d{2}\/\d{2}\/\d{4})/i.exec(text);
  const updateMatch = /(?:Atualiza(?:ção|cao)|Atualizado\s+em|Atualizada\s+em|Modificado\s+em)\s*[:\-]?\s*(\d{2}\/\d{2}\/\d{4})/i.exec(text);
  const publishedAt = parseBrDate(publishedMatch?.[1] ?? dataMatch?.[1] ?? '');
  const createdAt = parseBrDate(createdMatch?.[1] ?? '');
  const updatedAt = parseBrDate(updateMatch?.[1] ?? '');
  const title = headingTitle(headings, text);
  const fileLinks = links.filter(isDirectFileLink);

  const documentPage = documentPageIdFromUrl(url);
  const volto = isGovBrSpedUrl(pageUrl) ? voltoDocumentText(parseVoltoState(html)) : undefined;
  return {
    url,
    text,
    documentText: volto ?? text,
    documentTextSource: volto !== undefined ? 'VOLTO_CONTENT' : 'VISIBLE_TEXT',
    headings,
    title,
    ...(publishedAt ? { publishedAt } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(documentPage ? { itemId: documentPage.id } : {}),
    links,
    fileLinks,
    legacyLinks,
  };
}

function moduleLabel(module: SpedModule): string {
  switch (module) {
    case 'EFD_ICMS_IPI': return 'EFD ICMS/IPI';
    case 'EFD_CONTRIBUICOES': return 'EFD-Contribuições';
    case 'EFD_REINF': return 'EFD-Reinf';
    case 'DERE': return 'DeRE';
  }
}

export function moduleTextMatches(module: SpedModule, value: string): boolean {
  const normalized = normalizeCompare(value);
  switch (module) {
    case 'EFD_ICMS_IPI': return /EFD[ -]?ICMS|ICMS[ /-]?IPI|GUIA PRATICO EFD/.test(normalized);
    case 'EFD_CONTRIBUICOES': return /EFD[ -]?CONTRIBUICOES|PIS[ /-]?COFINS/.test(normalized);
    case 'EFD_REINF': return /EFD[ -]?REINF|\bREINF\b/.test(normalized);
    case 'DERE': return /\bDERE\b|DECLARACAO DE REGIMES ESPECIFICOS/.test(normalized);
  }
}

export function isTechnicalNavigationText(value: string): boolean {
  const normalized = normalizeCompare(value);
  return /GUIA|MANUAL|NOTA TECNICA|NOTA ORIENTATIVA|ORIENTA|LEIAUTE|LAYOUT|XSD|SCHEMA|ESQUEMA|TABELA|VALIDADOR|PVA|PGE|PROGRAMA|DOCUMENTACAO EVOLUTIVA|DOWNLOAD|HISTORICO/.test(normalized);
}

function documentKind(title: string, text: string): SpedDocumentKind | undefined {
  const normalized = normalizeCompare(title);
  const combined = normalizeCompare(title + ' ' + text.slice(0, 1200));
  if (/INDISPONIBILIDADE|INTERRUPCAO|MANUTENCAO/.test(normalized)) return 'OPERATIONAL_NOTICE';
  if (/NOTA TECNICA/.test(normalized)) return 'TECHNICAL_NOTE';
  if (/NOTA ORIENTATIVA/.test(normalized)) return 'ORIENTATION_NOTE';
  if (/DOCUMENTACAO EVOLUTIVA|DOCUMENTO EVOLUTIVO/.test(normalized)) return 'EVOLUTION_DOCUMENT';
  if (/GUIA PRATICO/.test(normalized)) return 'GUIDE';
  if (/DOCUMENTACAO TECNICA/.test(normalized) && /MANUAL/.test(combined)) return 'MANUAL';
  if (/XSD|SCHEMA|ESQUEMA/.test(normalized)) return 'XSD_SCHEMA';
  if (/LEIAUTE|LAYOUT/.test(normalized)) return 'LAYOUT';
  if (/TABELA/.test(normalized)) return 'TABLE';
  if (/MANUAL/.test(normalized)) return 'MANUAL';
  if (/PVA|PGE|VALIDADOR|PROGRAMA/.test(normalized) && /VERSAO|VERSÃO|PUBLICACAO|PUBLICAÇÃO|BETA/.test(combined)) {
    return 'SOFTWARE_RELEASE';
  }
  return undefined;
}

function versionFromTitle(title: string, kind: SpedDocumentKind): string | undefined {
  const normalized = normalizeSpace(title);
  if (kind === 'TECHNICAL_NOTE' || kind === 'ORIENTATION_NOTE') {
    return /NOTA\s+(?:T[EÉ]CNICA|ORIENTATIVA).*?\b(?:\d{1,4}[.\/_-]?\d{0,4}).*?\bv\s*\.?\s*(\d+(?:\.\d+){1,3})\b/i.exec(normalized)?.[1];
  }
  const direct = /\b(?:vers(?:ão|ao)|v)\s*\.?\s*(\d+(?:\.\d+){1,3})\b/i.exec(normalized)?.[1];
  if (direct) return direct;
  if (kind === 'GUIDE' || kind === 'SOFTWARE_RELEASE' || kind === 'TABLE' || kind === 'MANUAL' || kind === 'LAYOUT' || kind === 'XSD_SCHEMA') {
    return /\b(\d+(?:\.\d+){1,3})\b/.exec(normalized)?.[1];
  }
  return undefined;
}

function versionFromBody(text: string, kind: SpedDocumentKind): string | undefined {
  if (!['MANUAL', 'LAYOUT', 'XSD_SCHEMA', 'EVOLUTION_DOCUMENT'].includes(kind)) return undefined;
  return /\b(?:pacote(?:\s+de\s+integração)?\s+)?vers(?:ão|ao)\s*\.?\s*(\d+(?:\.\d+){1,3})\b/i.exec(text)?.[1];
}

function noteNumber(title: string): string | undefined {
  const normalized = normalizeSpace(title);
  const full = /NOTA\s+(?:T[EÉ]CNICA|ORIENTATIVA)[^0-9]{0,12}(\d{1,3})[\s_\/-]+(20\d{2})/i.exec(normalized);
  if (full) return String(Number(full[1]!)).padStart(2, '0') + '/' + full[2];
  const yearDotCode = /NOTA\s+(?:T[EÉ]CNICA|ORIENTATIVA)[^0-9]{0,12}(20\d{2})\.(\d{3})/i.exec(normalized);
  if (yearDotCode) return yearDotCode[1] + '.' + yearDotCode[2];
  const alt = /NOTA\s+(?:T[EÉ]CNICA|ORIENTATIVA)[^0-9]{0,12}(20\d{2})[\/_-](\d{1,3})/i.exec(normalized);
  if (alt) return String(Number(alt[2]!)).padStart(2, '0') + '/' + alt[1];
  return undefined;
}

function tableNumber(title: string): string | undefined {
  return /\bTABELA\s+(\d+(?:\.\d+)+)/i.exec(title)?.[1];
}

function revisionKind(title: string): SpedRevisionKind {
  const normalized = normalizeCompare(title);
  if (/REPUBLICAD/.test(normalized)) return 'REPUBLICATION';
  if (/ATUALIZACAO|ATUALIZADA|ATUALIZADO/.test(normalized)) return 'UPDATE';
  if (/VERSAO|VERSÃO|\bV\s*\d/.test(title)) return 'OFFICIAL_VERSION';
  return 'ORIGINAL';
}

function documentStatus(title: string, text: string): SpedDocumentStatus {
  const normalized = normalizeCompare(title + ' ' + text.slice(0, 2000));
  if (/\bMINUTA\b|\bMINUTAS\b/.test(normalized)) return 'DRAFT';
  if (/\bOFICIAL\b|\bDEFINITIV[AO]\b/.test(normalized)) return 'FINAL';
  return 'UNKNOWN';
}

function actNumberFor(
  kind: SpedDocumentKind,
  title: string,
  version: string | undefined,
  revision: SpedRevisionKind,
): { documentNumber?: string; actNumber?: string } {
  if (kind === 'TECHNICAL_NOTE' || kind === 'ORIENTATION_NOTE') {
    const number = noteNumber(title);
    if (!number) return {};
    const versionSuffix = version ? ' v' + version : '';
    const revisionSuffix = revision === 'REPUBLICATION'
      ? ' - REPUBLICAÇÃO'
      : revision === 'UPDATE'
        ? ' - ATUALIZAÇÃO'
        : '';
    return {
      documentNumber: number,
      actNumber: number + versionSuffix + revisionSuffix,
    };
  }
  if (kind === 'TABLE') {
    const number = tableNumber(title);
    const act = [number, version ? 'v' + version : undefined].filter(Boolean).join(' ');
    return {
      ...(number ? { documentNumber: number } : {}),
      ...(act ? { actNumber: act } : {}),
    };
  }
  if (version) return { actNumber: 'v' + version };
  return {};
}

function familyStem(title: string): string {
  return normalizeSpace(title)
    .replace(/\brepublicad[ao]\b/gi, '')
    .replace(/\batualiza(?:ção|cao|da|do)\b/gi, '')
    .replace(/\bvers(?:ão|ao)\s*\.?\s*\d+(?:\.\d+){1,3}\b/gi, '')
    .replace(/\bv\s*\.?\s*\d+(?:\.\d+){1,3}\b/gi, '')
    .replace(/\s+[–—-]\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function documentFamily(
  module: SpedModule,
  kind: SpedDocumentKind,
  title: string,
  number?: string,
): string {
  const prefix = moduleLabel(module);
  if (kind === 'TECHNICAL_NOTE' && number) return prefix + ' NT ' + number;
  if (kind === 'ORIENTATION_NOTE' && number) return prefix + ' NO ' + number;
  if (kind === 'GUIDE') return prefix + ' Guia Prático';
  const table = kind === 'TABLE' ? tableNumber(title) : undefined;
  if (table) return prefix + ' Tabela ' + table;
  return prefix + ' ' + familyStem(title).slice(0, 180);
}

function relatedTaxes(text: string): string[] {
  const normalized = normalizeCompare(text);
  const checks: Array<[string, RegExp]> = [
    ['ICMS', /\bICMS\b/],
    ['IPI', /\bIPI\b/],
    ['PIS', /\bPIS(?:\/PASEP)?\b/],
    ['COFINS', /\bCOFINS\b/],
    ['IBS', /\bIBS\b/],
    ['CBS', /\bCBS\b/],
    ['IRRF', /\bIRRF\b/],
  ];
  return checks.filter(([, regex]) => regex.test(normalized)).map(([name]) => name);
}

function affectedRecords(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\b(?:[A-Z]-)?[A-Z]\d{3,4}\b/g)) {
    found.add(match[0]!);
    if (found.size >= 50) break;
  }
  return [...found];
}

function fileName(link: SpedParsedLink): string | undefined {
  const text = normalizeSpace(link.text);
  if (text && !/^baixe\s+o\s+arquivo$/i.test(text) && !/^clique\s+aqui$/i.test(text)) return text;
  try {
    const last = new URL(link.url).pathname.split('/').filter(Boolean).at(-1);
    return last ? decodeURIComponent(last) : undefined;
  } catch {
    return undefined;
  }
}

export function descriptorFromPage(
  module: SpedModule,
  page: SpedPage,
): SpedDocumentDescriptor | undefined {
  if (!page.itemId) return undefined;
  const kind = documentKind(page.title, page.text);
  if (!kind) return undefined;
  const revision = revisionKind(page.title);
  const titleVersion = versionFromTitle(page.title, kind);
  // Body version comes only from canonical document text. The full page used to
  // include the serialized Volto state (sibling navigation titles), which made
  // the inferred version depend on unrelated portal items.
  const bodyVersion = versionFromBody(page.documentText, kind);
  const version = titleVersion ?? bodyVersion;
  const numbers = actNumberFor(kind, page.title, version, revision);
  const genericNavigationTitle =
    /^(?:DOWNLOADS?|MANUAIS?(?:\s+E\s+GUIAS?(?:\s+PRÁTICOS?)?)?|GUIAS?(?:\s+PRÁTICOS?)?|NOTAS?\s+(?:TÉCNICAS?|ORIENTATIVAS?)(?:\s+E\s+(?:TÉCNICAS?|ORIENTATIVAS?))?|ESQUEMAS?\s+XSD(?:\s*-\s*VERSÃO\s+MAIS\s+RECENTE)?|LEIAUTES?|TABELAS?)$/i.test(
      normalizeSpace(page.title),
    );
  const strongDocumentEvidence =
    page.fileLinks.length > 0 ||
    page.publishedAt !== undefined ||
    page.createdAt !== undefined ||
    page.updatedAt !== undefined ||
    titleVersion !== undefined ||
    numbers.documentNumber !== undefined;
  if (
    kind !== 'OPERATIONAL_NOTICE' &&
    (!strongDocumentEvidence || (genericNavigationTitle && page.fileLinks.length === 0 && page.publishedAt === undefined && page.updatedAt === undefined))
  ) {
    return undefined;
  }
  const files = page.fileLinks
    .map((link) => ({
      url: link.url,
      externalId: fileIdFromUrl(link.url) ?? link.url,
      ...(fileName(link) ? { name: fileName(link)! } : {}),
    }))
    .filter((file, index, values) => values.findIndex((other) => other.url === file.url) === index);
  const description = normalizeSpace(page.documentText).slice(0, 12_000);
  const parsedUrl = new URL(page.url, SPED_LEGACY_ORIGIN);
  const govbr = parsedUrl.origin.toLowerCase() === SPED_GOVBR_ORIGIN;
  return {
    module,
    kind,
    carrier: govbr && /\/assuntos\/comunicados(?:\/|$)/i.test(parsedUrl.pathname)
      ? 'ANNOUNCEMENT'
      : 'DOCUMENT',
    canonicalPath: govbr
      ? stableGovPath(parsedUrl).toLocaleLowerCase('pt-BR')
      : (/\/arquivo\/show\//i.test(page.url) ? 'arquivo:' : /\/pagina\/show\//i.test(page.url) ? 'pagina:' : 'item:') + page.itemId,
    documentTextSource: page.documentTextSource,
    title: page.title,
    itemId: page.itemId,
    externalId:
      new URL(page.url, SPED_LEGACY_ORIGIN).origin.toLowerCase() === SPED_GOVBR_ORIGIN
        ? 'govbr:' + page.itemId
        : (/\/arquivo\/show\//i.test(page.url)
            ? 'arquivo:'
            : /\/pagina\/show\//i.test(page.url)
              ? 'pagina:'
              : 'item:') + page.itemId,
    officialUrl: page.url,
    ...(page.publishedAt ? { publishedAt: page.publishedAt } : {}),
    ...(page.createdAt ? { createdAt: page.createdAt } : {}),
    ...(page.updatedAt ? { updatedAt: page.updatedAt } : {}),
    ...(version ? { officialVersion: version } : {}),
    ...(numbers.documentNumber ? { documentNumber: numbers.documentNumber } : {}),
    ...(numbers.actNumber ? { actNumber: numbers.actNumber } : {}),
    documentFamily: documentFamily(module, kind, page.title, numbers.documentNumber),
    revisionKind: revision,
    republication: revision === 'REPUBLICATION',
    documentStatus: documentStatus(page.title, page.text),
    ...(description ? { description } : {}),
    relatedTaxes: relatedTaxes(page.title + ' ' + description),
    affectedRecords: affectedRecords(description),
    ...(page.legacyLinks.length
      ? { legacyReferences: page.legacyLinks.map((link) => link.url) }
      : {}),
    files,
  };
}

export function isAllowedGlobalHighlight(module: SpedModule, linkText: string): boolean {
  if (!moduleTextMatches(module, linkText)) return false;
  return isTechnicalNavigationText(linkText) || /INDISPONIBILIDADE|INTERRUPÇÃO|INTERRUPCAO|MANUTENÇÃO|MANUTENCAO/i.test(linkText);
}

export function extractItemId(url: string): string | undefined {
  return itemIdFromUrl(url);
}
