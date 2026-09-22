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
  text: string;
  headings: string[];
  title: string;
  publishedAt?: Date;
  updatedAt?: Date;
  itemId?: string;
  links: SpedParsedLink[];
  fileLinks: SpedParsedLink[];
}

export interface SpedDocumentDescriptor {
  module: SpedModule;
  kind: SpedDocumentKind;
  title: string;
  itemId: string;
  externalId: string;
  officialUrl: string;
  publishedAt?: Date;
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
  files: Array<{
    url: string;
    externalId: string;
    name?: string;
  }>;
}

const SPED_ORIGIN = 'https://sped.rfb.gov.br';
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
    const parsed = new URL(url, SPED_ORIGIN);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}

function documentPageIdFromUrl(url: string): { id: string; type: 'item' | 'arquivo' | 'pagina' } | undefined {
  const path = linkPath(url);
  const item = /\/item\/show\/(\d+)/i.exec(path)?.[1];
  if (item) return { id: item, type: 'item' };
  const archive = /\/arquivo\/show\/(\d+)/i.exec(path)?.[1];
  if (archive) return { id: archive, type: 'arquivo' };
  const page = /\/pagina\/show\/(\d+)/i.exec(path)?.[1];
  if (page) return { id: page, type: 'pagina' };
  return undefined;
}

function itemIdFromUrl(url: string): string | undefined {
  return documentPageIdFromUrl(url)?.id;
}

function fileIdFromUrl(url: string): string | undefined {
  const path = linkPath(url);
  return /\/arquivo\/(?:download|show)\/(\d+)/i.exec(path)?.[1]
    ?? /\/estatico\/([^/]+)\/([^/?#]+)/i.exec(path)?.slice(1).join(':');
}

function headingTitle(headings: string[], fallbackText: string): string {
  const candidates = headings
    .map(normalizeSpace)
    .filter(Boolean)
    .filter((heading) => !MODULE_TITLES.has(normalizeCompare(heading)));
  const last = candidates.at(-1);
  if (last) return last;
  const firstLine = normalizeSpace(fallbackText).slice(0, 240);
  return firstLine || 'Portal SPED';
}

export function parseSpedPage(html: string, url: string): SpedPage {
  const links: SpedParsedLink[] = [];
  const headings: string[] = [];
  const allText: string[] = [];
  let currentLink: { href: string; text: string } | undefined;
  let currentHeading: { tag: string; text: string } | undefined;

  const parser = new Parser({
    onopentag(name, attrs) {
      const tag = name.toLowerCase();
      if (tag === 'a' && attrs.href) currentLink = { href: attrs.href, text: '' };
      if (/^h[1-4]$/.test(tag)) currentHeading = { tag, text: '' };
    },
    ontext(text) {
      allText.push(text);
      if (currentLink) currentLink.text += text;
      if (currentHeading) currentHeading.text += text;
    },
    onclosetag(name) {
      const tag = name.toLowerCase();
      if (tag === 'a' && currentLink) {
        try {
          const absolute = new URL(currentLink.href, url);
          if (absolute.origin.toLowerCase() === SPED_ORIGIN.toLowerCase()) {
            links.push({
              url: absolute.toString(),
              path: absolute.pathname + absolute.search,
              text: normalizeSpace(currentLink.text),
            });
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

  const text = normalizeSpace(allText.join(' '));
  const publishedMatch = /Publicado\s+em\s+(\d{2}\/\d{2}\/\d{4})/i.exec(text);
  const dataMatch = /\bData\s+(\d{2}\/\d{2}\/\d{4})(?:\s+\d{2}:\d{2}:\d{2})?/i.exec(text);
  const updateMatch = /(?:Atualiza(?:ção|cao)|Atualizado\s+em|Atualizada\s+em)\s*[:\-]?\s*(\d{2}\/\d{2}\/\d{4})/i.exec(text);
  const publishedAt = parseBrDate(publishedMatch?.[1] ?? dataMatch?.[1] ?? '');
  const updatedAt = parseBrDate(updateMatch?.[1] ?? '');
  const title = headingTitle(headings, text);
  const fileLinks = links.filter((link) =>
    /\/arquivo\/download\/\d+/i.test(link.path) ||
    /\/estatico\//i.test(link.path),
  );

  const documentPage = documentPageIdFromUrl(url);
  return {
    url,
    text,
    headings,
    title,
    ...(publishedAt ? { publishedAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(documentPage ? { itemId: documentPage.id } : {}),
    links,
    fileLinks,
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
  const bodyVersion = versionFromBody(page.text, kind);
  const version = titleVersion ?? bodyVersion;
  const numbers = actNumberFor(kind, page.title, version, revision);
  const genericNavigationTitle =
    /^(?:DOWNLOADS?|MANUAIS?(?:\s+E\s+GUIAS?(?:\s+PRÁTICOS?)?)?|GUIAS?(?:\s+PRÁTICOS?)?|NOTAS?\s+(?:TÉCNICAS?|ORIENTATIVAS?)(?:\s+E\s+(?:TÉCNICAS?|ORIENTATIVAS?))?|ESQUEMAS?\s+XSD(?:\s*-\s*VERSÃO\s+MAIS\s+RECENTE)?|LEIAUTES?|TABELAS?)$/i.test(
      normalizeSpace(page.title),
    );
  const strongDocumentEvidence =
    page.fileLinks.length > 0 ||
    page.publishedAt !== undefined ||
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
  const description = normalizeSpace(page.text).slice(0, 12_000);
  return {
    module,
    kind,
    title: page.title,
    itemId: page.itemId,
    externalId:
      (/\/arquivo\/show\//i.test(page.url)
        ? 'arquivo:'
        : /\/pagina\/show\//i.test(page.url)
          ? 'pagina:'
          : 'item:') + page.itemId,
    officialUrl: page.url,
    ...(page.publishedAt ? { publishedAt: page.publishedAt } : {}),
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
