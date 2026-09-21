import * as nodeHttp from 'node:http';

import type {
  CollectionConnector,
  ConnectorExecutionContext,
  ConnectorFile,
  ConnectorPublication,
  ConnectorResult,
} from './connector.contract.js';
import { ConnectorError } from './connector.error.js';

const CONFAZ_BASE_URL = 'https://www.confaz.fazenda.gov.br';
const CONFAZ_TIMEZONE = 'America/Sao_Paulo';
const DEFAULT_REQUEST_SPACING_MS = 250;
const DEFAULT_REFRESH_KNOWN_PER_FAMILY = 1;
const DEFAULT_BOOTSTRAP_WINDOW_PER_FAMILY = 3;

export const CONFAZ_CONNECTOR_KEY = 'confaz';

export type ConfazFamilyKey =
  | 'convenios'
  | 'ajustes'
  | 'atos'
  | 'protocolos';

interface ConfazFamilyDefinition {
  key: ConfazFamilyKey;
  path: string;
  actType: string;
  labelPattern: RegExp;
}

const FAMILIES: readonly ConfazFamilyDefinition[] = [
  {
    key: 'convenios',
    path: 'convenios',
    actType: 'CONVÊNIO ICMS',
    labelPattern: /CONV[ÊE]NIO\s+ICMS/i,
  },
  {
    key: 'ajustes',
    path: 'ajustes',
    actType: 'AJUSTE SINIEF',
    labelPattern: /AJUSTE\s+SINIEF/i,
  },
  {
    key: 'atos',
    path: 'atos',
    actType: 'ATO COTEPE/ICMS',
    labelPattern: /ATO\s+COTEPE(?:\s*\/\s*ICMS|\s+ICMS)?/i,
  },
  {
    key: 'protocolos',
    path: 'protocolos',
    actType: 'PROTOCOLO ICMS',
    labelPattern: /PROTOCOLO\s+ICMS/i,
  },
] as const;

const MONTHS: Readonly<Record<string, number>> = {
  janeiro: 0,
  fevereiro: 1,
  março: 2,
  marco: 2,
  abril: 3,
  maio: 4,
  junho: 5,
  julho: 6,
  agosto: 7,
  setembro: 8,
  outubro: 9,
  novembro: 10,
  dezembro: 11,
};

const STATE_NAMES: ReadonlyArray<readonly [string, string]> = [
  ['Acre', 'AC'],
  ['Alagoas', 'AL'],
  ['Amapá', 'AP'],
  ['Amazonas', 'AM'],
  ['Bahia', 'BA'],
  ['Ceará', 'CE'],
  ['Distrito Federal', 'DF'],
  ['Espírito Santo', 'ES'],
  ['Goiás', 'GO'],
  ['Maranhão', 'MA'],
  ['Mato Grosso do Sul', 'MS'],
  ['Mato Grosso', 'MT'],
  ['Minas Gerais', 'MG'],
  ['Pará', 'PA'],
  ['Paraíba', 'PB'],
  ['Paraná', 'PR'],
  ['Pernambuco', 'PE'],
  ['Piauí', 'PI'],
  ['Rio de Janeiro', 'RJ'],
  ['Rio Grande do Norte', 'RN'],
  ['Rio Grande do Sul', 'RS'],
  ['Rondônia', 'RO'],
  ['Roraima', 'RR'],
  ['Santa Catarina', 'SC'],
  ['São Paulo', 'SP'],
  ['Sergipe', 'SE'],
  ['Tocantins', 'TO'],
];

export interface ConfazKnownOrigin {
  officialUrl: string;
  lastSeenAt: Date;
}

export interface ConfazSourceState {
  connectorConfig: Record<string, unknown>;
  knownOrigins: ConfazKnownOrigin[];
}

export type ConfazSourceStateReader = (
  sourceId: string,
) => Promise<ConfazSourceState>;

export interface ConfazConnectorOptions {
  fetchImpl?: typeof fetch;
  proxyUrl?: string;
  readSourceState?: ConfazSourceStateReader;
  now?: () => Date;
  requestSpacingMs?: number;
  refreshKnownPerFamily?: number;
  bootstrapWindowPerFamily?: number;
}

type SetGlobalProxyFromEnv = (
  proxyEnv?: {
    HTTP_PROXY?: string;
    HTTPS_PROXY?: string;
    NO_PROXY?: string;
  },
) => () => void;

function createConfazProxyFetch(proxyUrl: string): typeof fetch {
  const parsed = new URL(proxyUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('CONFAZ proxy URL must use http:// or https://');
  }

  const setGlobalProxyFromEnv = (
    nodeHttp as typeof nodeHttp & {
      setGlobalProxyFromEnv?: SetGlobalProxyFromEnv;
    }
  ).setGlobalProxyFromEnv;

  if (!setGlobalProxyFromEnv) {
    throw new Error(
      'Current Node.js runtime does not support built-in proxy configuration',
    );
  }

  // POC constraint: the collection worker processes one run at a time.
  // Scope the global proxy switch to the lifetime of this single fetch call
  // and restore it immediately afterwards.
  return (async (input, init) => {
    const restore = setGlobalProxyFromEnv({
      HTTPS_PROXY: proxyUrl,
      NO_PROXY: '',
    });

    try {
      return await fetch(input, init);
    } finally {
      restore();
    }
  }) as typeof fetch;
}

export interface ConfazIndexLink {
  family: ConfazFamilyKey;
  year: number;
  actNumber: number;
  label: string;
  url: string;
  variant: 'NORMAL' | 'RETIFICACAO' | 'REPUBLICACAO' | 'ORIGINAL';
}

interface Anchor {
  text: string;
  url: string;
}

interface FetchHtmlResult {
  html: string;
  finalUrl: string;
  contentType?: string;
  etag?: string;
  lastModified?: string;
}

interface ParsedSourceConfig {
  baselines: Partial<Record<ConfazFamilyKey, Partial<Record<string, number>>>>;
  incrementalYears?: number[];
}

function normalizeSpaces(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function stripDiacritics(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
    ordm: 'º',
    ordf: 'ª',
    deg: '°',
    aacute: 'á',
    Aacute: 'Á',
    atilde: 'ã',
    Atilde: 'Ã',
    acirc: 'â',
    Acirc: 'Â',
    ccedil: 'ç',
    Ccedil: 'Ç',
    eacute: 'é',
    Eacute: 'É',
    ecirc: 'ê',
    Ecirc: 'Ê',
    iacute: 'í',
    Iacute: 'Í',
    oacute: 'ó',
    Oacute: 'Ó',
    ocirc: 'ô',
    Ocirc: 'Ô',
    otilde: 'õ',
    Otilde: 'Õ',
    uacute: 'ú',
    Uacute: 'Ú',
  };

  return value.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi,
    (entity, token: string) => {
      if (token.startsWith('#x') || token.startsWith('#X')) {
        const codePoint = Number.parseInt(token.slice(2), 16);
        return Number.isFinite(codePoint)
          ? String.fromCodePoint(codePoint)
          : entity;
      }

      if (token.startsWith('#')) {
        const codePoint = Number.parseInt(token.slice(1), 10);
        return Number.isFinite(codePoint)
          ? String.fromCodePoint(codePoint)
          : entity;
      }

      return named[token] ?? named[token.toLowerCase()] ?? entity;
    },
  );
}

function textFromHtml(value: string): string {
  return normalizeSpaces(
    decodeHtmlEntities(
      value
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' '),
    ),
  );
}

function blockTextFromHtml(value: string): string {
  const cleaned = value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  return decodeHtmlEntities(cleaned)
    .split(/\r?\n/)
    .map((line) => normalizeSpaces(line))
    .filter(Boolean)
    .join('\n');
}

function extractMainHtml(html: string): string {
  const startPatterns = [
    /<div\b[^>]*\bid=["']content-core["'][^>]*>/i,
    /<main\b[^>]*>/i,
  ];

  for (const pattern of startPatterns) {
    const match = pattern.exec(html);
    if (!match || match.index === undefined) {
      continue;
    }

    const start = match.index + match[0].length;
    const footerIndex = html.search(/<footer\b/i);
    const end = footerIndex > start ? footerIndex : html.length;
    return html.slice(start, end);
  }

  const h1 = /<h1\b[^>]*>/i.exec(html);
  if (h1?.index !== undefined) {
    const footerIndex = html.search(/<footer\b/i);
    const end = footerIndex > h1.index ? footerIndex : html.length;
    return html.slice(h1.index, end);
  }

  return html;
}

function extractH1(html: string): string | undefined {
  const match = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  return match?.[1] ? textFromHtml(match[1]) : undefined;
}

function extractAnchors(html: string, baseUrl: string): Anchor[] {
  const anchors: Anchor[] = [];
  const pattern = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(pattern)) {
    const href = decodeHtmlEntities(match[2] ?? '').trim();
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) {
      continue;
    }

    let url: string;
    try {
      url = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }

    const text = textFromHtml(match[3] ?? '');
    if (!text) {
      continue;
    }

    anchors.push({ text, url });
  }

  return anchors;
}

function parseActReference(
  value: string,
): { number: number; year: number } | undefined {
  const match = /(?:N[º°.]?\s*)?(\d{1,3})\s*\/\s*(\d{2,4})/i.exec(value);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }

  const number = Number.parseInt(match[1], 10);
  const rawYear = Number.parseInt(match[2], 10);
  const year = rawYear < 100 ? 2000 + rawYear : rawYear;

  if (!Number.isSafeInteger(number) || number < 1 || year < 1900 || year > 2200) {
    return undefined;
  }

  return { number, year };
}

function variantFromLabel(label: string): ConfazIndexLink['variant'] {
  const normalized = stripDiacritics(label).toUpperCase();
  if (normalized.includes('RETIFICACAO')) {
    return 'RETIFICACAO';
  }
  if (normalized.includes('REPUBLICACAO')) {
    return 'REPUBLICACAO';
  }
  if (normalized.includes('ORIGINAL')) {
    return 'ORIGINAL';
  }
  return 'NORMAL';
}

function familyForKey(key: ConfazFamilyKey): ConfazFamilyDefinition {
  const family = FAMILIES.find((candidate) => candidate.key === key);
  if (!family) {
    throw new Error(`Unsupported CONFAZ family: ${key}`);
  }
  return family;
}

export function extractConfazIndexLinks(
  html: string,
  indexUrl: string,
  familyKey: ConfazFamilyKey,
  expectedYear: number,
): ConfazIndexLink[] {
  const family = familyForKey(familyKey);
  const prefix = `/legislacao/${family.path}/${expectedYear}/`;
  const byUrl = new Map<string, ConfazIndexLink>();

  for (const anchor of extractAnchors(html, indexUrl)) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(anchor.url);
    } catch {
      continue;
    }

    if (
      parsedUrl.hostname !== 'www.confaz.fazenda.gov.br' ||
      !parsedUrl.pathname.startsWith(prefix) ||
      parsedUrl.pathname === `${prefix}${expectedYear}` ||
      !family.labelPattern.test(anchor.text)
    ) {
      continue;
    }

    const reference = parseActReference(anchor.text);
    if (!reference || reference.year !== expectedYear) {
      continue;
    }

    const cleanUrl = `${parsedUrl.origin}${parsedUrl.pathname}`;
    const candidate: ConfazIndexLink = {
      family: family.key,
      year: expectedYear,
      actNumber: reference.number,
      label: normalizeSpaces(anchor.text),
      url: cleanUrl,
      variant: variantFromLabel(anchor.text),
    };

    const existing = byUrl.get(cleanUrl);
    if (!existing || existing.label.length < candidate.label.length) {
      byUrl.set(cleanUrl, candidate);
    }
  }

  return [...byUrl.values()].sort((a, b) => {
    if (a.actNumber !== b.actNumber) {
      return b.actNumber - a.actNumber;
    }
    return a.url.localeCompare(b.url);
  });
}

function parseDotDate(value: string): Date | undefined {
  const match = /(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) {
    return undefined;
  }

  const day = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10) - 1;
  const rawYear = Number.parseInt(match[3], 10);
  const year = rawYear < 100 ? 2000 + rawYear : rawYear;
  const date = new Date(Date.UTC(year, month, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }

  return date;
}

function parseLongDate(value: string): Date | undefined {
  const normalized = stripDiacritics(value).toLowerCase();
  const match = /(\d{1,2})(?:º|°)?\s+de\s+([a-z]+)\s+de\s+(\d{4})/.exec(normalized);
  if (!match?.[1] || !match[2] || !match[3]) {
    return undefined;
  }

  const day = Number.parseInt(match[1], 10);
  const month = MONTHS[match[2]];
  const year = Number.parseInt(match[3], 10);
  if (month === undefined) {
    return undefined;
  }

  const date = new Date(Date.UTC(year, month, day));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function isoDate(date: Date | undefined): string | undefined {
  return date?.toISOString().slice(0, 10);
}

function extractPublishedAt(text: string): Date | undefined {
  const match = /Publica(?:do|ç(?:ã|a)o)\s+no\s+DOU\s+de\s+((?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4})|(?:\d{1,2}(?:º|°)?\s+de\s+[A-ZÁÀÂÃÉÊÍÓÔÕÚÇ]+\s+de\s+\d{4}))/i.exec(text);
  if (!match?.[1]) {
    return undefined;
  }
  return parseDotDate(match[1]) ?? parseLongDate(match[1]);
}

function extractActDate(
  text: string,
  reference: { number: number; year: number },
): Date | undefined {
  const lines = text.split('\n').slice(0, 25);

  for (const line of lines) {
    const match =
      /(?:N[º°.]?\s*)?(\d{1,3})\s*,\s*DE\s+(\d{1,2}(?:º|°)?\s+DE\s+[A-ZÁÀÂÃÉÊÍÓÔÕÚÇ]+\s+DE\s+\d{4})/i.exec(
        line,
      );

    if (!match?.[1] || !match[2]) {
      continue;
    }

    const number = Number.parseInt(match[1], 10);
    const parsed = parseLongDate(match[2]);

    if (
      number === reference.number &&
      parsed?.getUTCFullYear() === reference.year
    ) {
      return parsed;
    }
  }

  return undefined;
}

function extractRatification(text: string): {
  date?: Date;
  reference?: string;
} | undefined {
  const match = /Ratifica(?:ç|c)[aã]o\s+Nacional\s+no\s+DOU\s+de\s+((?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4})|(?:\d{1,2}(?:º|°)?\s+de\s+[A-ZÁÀÂÃÉÊÍÓÔÕÚÇ]+\s+de\s+\d{4}))(?:,\s*pelo\s+Ato\s+Declarat[oó]rio\s+([^\n.]+))?/i.exec(text);
  if (!match) {
    return undefined;
  }

  const date = match[1]
    ? parseDotDate(match[1]) ?? parseLongDate(match[1])
    : undefined;
  const reference = match[2] ? normalizeSpaces(match[2]) : undefined;

  return {
    ...(date ? { date } : {}),
    ...(reference ? { reference } : {}),
  };
}

function extractDouReference(text: string): string | undefined {
  const match = /Publicado\s+no\s+DOU[^\n]*?pelo\s+([^\n.]+)/i.exec(text);
  return match?.[1] ? normalizeSpaces(match[1]) : undefined;
}

function extractEffectiveDate(
  text: string,
  publishedAt: Date | undefined,
  ratification: ReturnType<typeof extractRatification>,
): { date?: Date; basis?: string; text?: string } {
  const effectMatch = /(?:produz(?:indo)?\s+efeitos?|efeitos?)\s+(?:a\s+partir\s+de|em)\s+([^\n.;]+)/i.exec(text);
  if (effectMatch?.[1]) {
    const date = parseDotDate(effectMatch[1]) ?? parseLongDate(effectMatch[1]);
    if (date) {
      return {
        date,
        basis: 'EXPLICIT_EFFECTS_DATE',
        text: normalizeSpaces(effectMatch[0]),
      };
    }
  }

  const ratificationPhrase = /entra\s+em\s+vigor\s+na\s+data\s+da\s+publica(?:ç|c)[aã]o\s+no\s+Di[aá]rio\s+Oficial\s+da\s+Uni[aã]o\s+de\s+sua\s+ratifica(?:ç|c)[aã]o\s+nacional/i.exec(text);
  if (ratificationPhrase && ratification?.date) {
    return {
      date: ratification.date,
      basis: 'RATIFICATION_DOU_PUBLICATION',
      text: normalizeSpaces(ratificationPhrase[0]),
    };
  }

  const publicationPhrase = /entra\s+em\s+vigor\s+na\s+data\s+(?:da(?:\s+sua)?|de\s+sua)\s+publica(?:ç|c)[aã]o\s+(?:no\s+Di[aá]rio\s+Oficial\s+da\s+Uni[aã]o|no\s+DOU)?/i.exec(text);
  if (publicationPhrase && publishedAt) {
    return {
      date: publishedAt,
      basis: 'DOU_PUBLICATION',
      text: normalizeSpaces(publicationPhrase[0]),
    };
  }

  return {};
}

function extractEmenta(mainHtml: string, text: string, heading: string): string {
  const paragraphs = [...mainHtml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => textFromHtml(match[1] ?? ''))
    .filter(Boolean);

  for (const paragraph of paragraphs) {
    if (
      paragraph.length >= 20 &&
      !/^Publicado\s+no\s+DOU/i.test(paragraph) &&
      !/^Ratifica/i.test(paragraph) &&
      !/^Imprimir$/i.test(paragraph) &&
      !paragraph.toUpperCase().startsWith(heading.toUpperCase())
    ) {
      return paragraph;
    }
  }

  const lines = text.split('\n');
  const headingIndex = lines.findIndex((line) => normalizeSpaces(line) === normalizeSpaces(heading));
  const candidates = headingIndex >= 0 ? lines.slice(headingIndex + 1) : lines;
  for (const line of candidates) {
    const normalized = normalizeSpaces(line);
    if (
      normalized.length >= 20 &&
      !/^Publicado\s+no\s+DOU/i.test(normalized) &&
      !/^Ratifica/i.test(normalized) &&
      !/^Imprimir$/i.test(normalized) &&
      !/^(CONV[ÊE]NIO|AJUSTE|ATO|PROTOCOLO)\b/i.test(normalized)
    ) {
      return normalized;
    }
  }

  return heading;
}

function inferVariantFromPage(heading: string, indexVariant?: ConfazIndexLink['variant']): ConfazIndexLink['variant'] {
  const headingVariant = variantFromLabel(heading);
  return headingVariant !== 'NORMAL' ? headingVariant : (indexVariant ?? 'NORMAL');
}

function canonicalActType(baseActType: string, variant: ConfazIndexLink['variant']): string {
  switch (variant) {
    case 'RETIFICACAO':
      return `RETIFICAÇÃO DE ${baseActType}`;
    case 'REPUBLICACAO':
      return `REPUBLICAÇÃO DE ${baseActType}`;
    case 'ORIGINAL':
      return `ORIGINAL DE ${baseActType}`;
    case 'NORMAL':
      return baseActType;
  }
}

function extractFileLinks(mainHtml: string, officialUrl: string): ConnectorFile[] {
  const fileExtensions = /\.(pdf|zip|xlsx?|csv|xml|docx?|ods|odt)(?:$|[?#])/i;
  const seen = new Set<string>();
  const files: ConnectorFile[] = [];

  for (const anchor of extractAnchors(mainHtml, officialUrl)) {
    let url: URL;
    try {
      url = new URL(anchor.url);
    } catch {
      continue;
    }

    if (
      url.hostname !== 'www.confaz.fazenda.gov.br' ||
      (!fileExtensions.test(url.pathname) && !url.pathname.includes('@@download/file'))
    ) {
      continue;
    }

    const cleanUrl = url.toString();
    if (seen.has(cleanUrl)) {
      continue;
    }
    seen.add(cleanUrl);

    const extensionMatch = /\.([a-z0-9]+)(?:$|[?#])/i.exec(url.pathname);
    const extension = extensionMatch?.[1]?.toLowerCase();
    const mimeType = extension === 'pdf'
      ? 'application/pdf'
      : extension === 'zip'
        ? 'application/zip'
        : undefined;

    files.push({
      url: cleanUrl,
      ...(anchor.text ? { name: anchor.text } : {}),
      ...(mimeType ? { mimeType } : {}),
      metadata: {
        discoveredOnOfficialPage: officialUrl,
      },
    });
  }

  return files;
}

function extractRelatedLinks(mainHtml: string, officialUrl: string): Array<{ label: string; url: string }> {
  const seen = new Set<string>();
  const related: Array<{ label: string; url: string }> = [];
  const fileExtensions = /\.(pdf|zip|xlsx?|csv|xml|docx?|ods|odt)(?:$|[?#])/i;

  for (const anchor of extractAnchors(mainHtml, officialUrl)) {
    let url: URL;
    try {
      url = new URL(anchor.url);
    } catch {
      continue;
    }

    if (
      url.hostname !== 'www.confaz.fazenda.gov.br' ||
      url.toString() === officialUrl ||
      fileExtensions.test(url.pathname) ||
      url.pathname.includes('@@download/file') ||
      /Voltar para o topo|Tweet|Imprimir/i.test(anchor.text)
    ) {
      continue;
    }

    const cleanUrl = `${url.origin}${url.pathname}${url.search}`;
    const key = `${anchor.text}\u0000${cleanUrl}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    related.push({ label: anchor.text, url: cleanUrl });
  }

  return related.slice(0, 50);
}

function explicitUfMentions(ementa: string): string[] {
  let remaining = stripDiacritics(ementa).toLowerCase();
  const ufs: string[] = [];
  const states = [...STATE_NAMES].sort((a, b) => b[0].length - a[0].length);

  for (const [name, uf] of states) {
    const token = stripDiacritics(name).toLowerCase();
    const pattern = new RegExp(`\\b${token.replace(/\s+/g, '\\s+')}\\b`, 'gi');
    if (pattern.test(remaining)) {
      ufs.push(uf);
      remaining = remaining.replace(pattern, ' '.repeat(token.length));
    }
  }

  return [...new Set(ufs)].sort();
}

function extractContentText(mainHtml: string, heading: string): string {
  const text = blockTextFromHtml(mainHtml);
  const lines = text.split('\n');
  const startIndex = lines.findIndex((line) => normalizeSpaces(line) === normalizeSpaces(heading));
  const useful = startIndex >= 0 ? lines.slice(startIndex) : lines;
  const endIndex = useful.findIndex((line) => /^(Voltar para o topo|Desenvolvido com o CMS)/i.test(line));
  const sliced = endIndex >= 0 ? useful.slice(0, endIndex) : useful;
  const body = sliced
    .filter((line) => !/^Tweet$/i.test(line) && !/^Imprimir$/i.test(line))
    .join('\n')
    .trim();

  return normalizeSpaces(body.split('\n')[0] ?? '') === normalizeSpaces(heading)
    ? body
    : `${heading}\n${body}`.trim();
}

function metadataDate(date: Date | undefined): string | undefined {
  return date ? isoDate(date) : undefined;
}

export function parseConfazPublicationHtml(
  html: string,
  officialUrl: string,
  familyKey: ConfazFamilyKey,
  indexVariant?: ConfazIndexLink['variant'],
): ConnectorPublication {
  const family = familyForKey(familyKey);
  const mainHtml = extractMainHtml(html);
  const heading = extractH1(html) ?? extractH1(mainHtml);

  if (!heading || !family.labelPattern.test(heading)) {
    throw new ConnectorError(
      `CONFAZ page does not contain the expected ${family.actType} heading`,
      {
        kind: 'PROCESSING_ERROR',
        code: 'CONFAZ_ACT_HEADING_NOT_FOUND',
        retryable: false,
        metadata: { officialUrl, family: familyKey },
      },
    );
  }

  const reference = parseActReference(heading);
  if (!reference) {
    throw new ConnectorError(
      'CONFAZ act number/year could not be parsed from the official heading',
      {
        kind: 'PROCESSING_ERROR',
        code: 'CONFAZ_ACT_REFERENCE_NOT_FOUND',
        retryable: false,
        metadata: { officialUrl, heading },
      },
    );
  }

  const content = extractContentText(mainHtml, heading);
  const ementa = extractEmenta(mainHtml, content, heading);
  const publishedAt = extractPublishedAt(content);
  const actDate = extractActDate(content, reference);
  const ratification = extractRatification(content);
  const effective = extractEffectiveDate(content, publishedAt, ratification);
  const variant = inferVariantFromPage(heading, indexVariant);
  const files = extractFileLinks(mainHtml, officialUrl);
  const relatedLinks = extractRelatedLinks(mainHtml, officialUrl);
  // Signatory blocks list nearly every state and must not be interpreted
  // as normative applicability/mention. Only inspect the normative body.
  const normativeContent = content.split(
    /\nPresidente\s+do\s+CONFAZ\b/i,
  )[0] ?? content;
  const ufMentions = explicitUfMentions(normativeContent);
  const parsedUrl = new URL(officialUrl);
  const sourcePath = parsedUrl.pathname;

  const douReference = extractDouReference(content);

  const metadata: Record<string, unknown> = {
    source: 'CONFAZ',
    sourcePath,
    family: familyKey,
    year: reference.year,
    actNumberNumeric: reference.number,
    officialHeading: heading,
    officialActNumber: `${reference.number}/${String(reference.year).slice(-2)}`,
    variant,
    ...(actDate ? { actDate: metadataDate(actDate) } : {}),
    ...(publishedAt
      ? {
          dou: {
            publicationDate: metadataDate(publishedAt),
            ...(douReference ? { reference: douReference } : {}),
          },
        }
      : {}),
    ...(ratification
      ? {
          ratification: {
            ...(ratification.date ? { publicationDate: metadataDate(ratification.date) } : {}),
            ...(ratification.reference ? { reference: ratification.reference } : {}),
          },
        }
      : {}),
    ...(effective.basis || effective.text
      ? {
          effectiveDateBasis: effective.basis,
          effectiveText: effective.text,
        }
      : {}),
    ...(ufMentions.length > 0
      ? { explicitUfMentions: ufMentions, explicitUfMentionsSource: 'NORMATIVE_TEXT_MENTIONS' }
      : {}),
    ...(relatedLinks.length > 0 ? { relatedLinks } : {}),
  };

  return {
    title: ementa,
    agency: 'CONFAZ',
    sphere: 'FEDERAL',
    actType: canonicalActType(family.actType, variant),
    actNumber: `${reference.number}/${reference.year}`,
    ...(publishedAt ? { publishedAt } : {}),
    ...(effective.date ? { effectiveAt: effective.date } : {}),
    content,
    officialUrl,
    externalId: sourcePath,
    ...(files.length > 0 ? { files } : {}),
    metadata,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseSourceConfig(config: Record<string, unknown>): ParsedSourceConfig {
  const confaz = asRecord(config.confaz) ?? config;
  const baselinesRaw = asRecord(confaz.incrementalBaselines);
  const baselines: ParsedSourceConfig['baselines'] = {};

  if (baselinesRaw) {
    for (const family of FAMILIES) {
      const familyRaw = asRecord(baselinesRaw[family.key]);
      if (!familyRaw) {
        continue;
      }
      const parsed: Record<string, number> = {};
      for (const [year, value] of Object.entries(familyRaw)) {
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
          parsed[year] = value;
        }
      }
      baselines[family.key] = parsed;
    }
  }

  const incrementalYears = Array.isArray(confaz.incrementalYears)
    ? confaz.incrementalYears.filter(
        (value): value is number =>
          typeof value === 'number' &&
          Number.isSafeInteger(value) &&
          value >= 1900 &&
          value <= 2200,
      )
    : undefined;

  return {
    baselines,
    ...(incrementalYears && incrementalYears.length > 0
      ? { incrementalYears: [...new Set(incrementalYears)] }
      : {}),
  };
}

function currentYearAndMonth(now: Date): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CONFAZ_TIMEZONE,
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(now);

  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);

  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(month)) {
    throw new Error('Could not resolve current date for CONFAZ collection');
  }

  return { year, month };
}

function yearsForIncrementalCollection(now: Date, config: ParsedSourceConfig): number[] {
  if (config.incrementalYears) {
    return [...config.incrementalYears].sort((a, b) => b - a);
  }

  const current = currentYearAndMonth(now);
  return current.month <= 2
    ? [current.year, current.year - 1]
    : [current.year];
}

function baselineFor(
  config: ParsedSourceConfig,
  family: ConfazFamilyKey,
  year: number,
): number | undefined {
  return config.baselines[family]?.[String(year)];
}

function officialPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function originMatchesFamilyYear(
  origin: ConfazKnownOrigin,
  family: ConfazFamilyDefinition,
  year: number,
): boolean {
  try {
    const parsed = new URL(origin.officialUrl);
    return parsed.pathname.startsWith(`/legislacao/${family.path}/${year}/`);
  } catch {
    return false;
  }
}

function chooseLinksToFetch(
  links: ConfazIndexLink[],
  family: ConfazFamilyDefinition,
  year: number,
  config: ParsedSourceConfig,
  knownOrigins: ConfazKnownOrigin[],
  refreshKnownPerFamily: number,
  bootstrapWindowPerFamily: number,
): {
  links: ConfazIndexLink[];
  skippedPreBaseline: number;
  bootstrapLimited: boolean;
} {
  const knownByUrl = new Map(
    knownOrigins.map((origin) => [officialPath(origin.officialUrl), origin]),
  );
  const familyKnown = knownOrigins
    .filter((origin) => originMatchesFamilyYear(origin, family, year))
    .sort((a, b) => a.lastSeenAt.getTime() - b.lastSeenAt.getTime());
  const baseline = baselineFor(config, family.key, year);

  const selected = new Map<string, ConfazIndexLink>();
  let skippedPreBaseline = 0;
  let bootstrapLimited = false;

  const knownIndexedActs = links.filter((link) =>
    knownByUrl.has(officialPath(link.url)),
  );
  const highestKnownActNumber = knownIndexedActs.reduce<number | undefined>(
    (highest, link) =>
      highest === undefined || link.actNumber > highest
        ? link.actNumber
        : highest,
    undefined,
  );
  const recentDiscoveryUrls = new Set(
    links
      .slice(0, bootstrapWindowPerFamily)
      .map((link) => officialPath(link.url)),
  );

  for (const link of links) {
    const key = officialPath(link.url);
    const known = knownByUrl.has(key);
    const special = link.variant !== 'NORMAL';

    if (known) {
      continue;
    }

    const aboveConfiguredBaseline =
      baseline !== undefined && link.actNumber > baseline;
    const aboveObservedHighWater =
      baseline === undefined &&
      highestKnownActNumber !== undefined &&
      link.actNumber > highestKnownActNumber;
    const inRecentDiscoveryWindow =
      baseline === undefined &&
      familyKnown.length > 0 &&
      recentDiscoveryUrls.has(key);

    if (
      special ||
      aboveConfiguredBaseline ||
      aboveObservedHighWater ||
      inRecentDiscoveryWindow
    ) {
      selected.set(key, link);
      continue;
    }

    if (baseline !== undefined && link.actNumber <= baseline) {
      skippedPreBaseline += 1;
    }
  }

  if (baseline === undefined && familyKnown.length === 0) {
    bootstrapLimited = true;
    for (const link of links.slice(0, bootstrapWindowPerFamily)) {
      selected.set(officialPath(link.url), link);
    }
    for (const link of links.filter((candidate) => candidate.variant !== 'NORMAL')) {
      selected.set(officialPath(link.url), link);
    }
  }

  if (refreshKnownPerFamily > 0 && familyKnown.length > 0) {
    const oldest = familyKnown.slice(0, refreshKnownPerFamily);
    const byUrl = new Map(links.map((link) => [officialPath(link.url), link]));
    for (const origin of oldest) {
      const link = byUrl.get(officialPath(origin.officialUrl));
      if (link) {
        selected.set(officialPath(link.url), link);
      }
    }

    const latestKnown = links.find((link) => knownByUrl.has(officialPath(link.url)));
    if (latestKnown) {
      selected.set(officialPath(latestKnown.url), latestKnown);
    }
  }

  return {
    links: [...selected.values()].sort((a, b) => b.actNumber - a.actNumber),
    skippedPreBaseline,
    bootstrapLimited,
  };
}

function retryAfterSeconds(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) {
    return undefined;
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return Math.ceil(numeric);
  }

  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1000));
  }

  return undefined;
}

function decodeResponseBody(buffer: ArrayBuffer, contentType: string | null): string {
  const charset = /charset\s*=\s*([^;\s]+)/i.exec(contentType ?? '')?.[1]
    ?.replace(/["']/g, '')
    .toLowerCase();

  const label = charset === 'iso-8859-1' || charset === 'latin1'
    ? 'windows-1252'
    : charset === 'windows-1252'
      ? 'windows-1252'
      : 'utf-8';

  try {
    return new TextDecoder(label).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

function networkFailureDetail(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return typeof error === 'string' ? error : undefined;
  }

  const details: string[] = [`${error.name}: ${error.message}`];
  const cause = (error as Error & { cause?: unknown }).cause;

  if (cause instanceof Error) {
    const code = (cause as Error & { code?: unknown }).code;
    details.push(
      `${cause.name}: ${cause.message}${typeof code === 'string' ? ` [${code}]` : ''}`,
    );
  } else if (cause !== undefined) {
    details.push(String(cause));
  }

  return details.filter(Boolean).join(' <- ');
}

function networkConnectorError(error: unknown, url: string): ConnectorError {
  if (error instanceof ConnectorError) {
    return error;
  }

  const detail = networkFailureDetail(error);

  return new ConnectorError(
    `CONFAZ network request failed for ${url}${detail ? `: ${detail}` : ''}`,
    {
      kind: 'NETWORK_ERROR',
      code: 'CONFAZ_NETWORK_ERROR',
      retryable: true,
      metadata: {
        url,
        ...(detail ? { networkFailureDetail: detail } : {}),
      },
      cause: error,
    },
  );
}

class RequestGate {
  private lastStartedAt = 0;

  constructor(
    private readonly spacingMs: number,
  ) {}

  async wait(signal: AbortSignal): Promise<void> {
    const remaining = this.spacingMs - (Date.now() - this.lastStartedAt);
    if (remaining > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, remaining);
        const abort = () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        };
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener('abort', abort, { once: true });
      });
    }
    this.lastStartedAt = Date.now();
  }
}

export class ConfazConnector implements CollectionConnector {
  readonly key = CONFAZ_CONNECTOR_KEY;
  readonly version = 'confaz-1.0.0';

  private readonly fetchImpl: typeof fetch;
  private readonly proxyEnabled: boolean;
  private readonly readSourceState: ConfazSourceStateReader | undefined;
  private readonly now: () => Date;
  private readonly refreshKnownPerFamily: number;
  private readonly bootstrapWindowPerFamily: number;
  private readonly requestGate: RequestGate;

  constructor(options: ConfazConnectorOptions = {}) {
    this.proxyEnabled = Boolean(options.proxyUrl);
    this.fetchImpl =
      options.fetchImpl ??
      (options.proxyUrl
        ? createConfazProxyFetch(options.proxyUrl)
        : fetch);
    this.readSourceState = options.readSourceState;
    this.now = options.now ?? (() => new Date());
    this.refreshKnownPerFamily =
      options.refreshKnownPerFamily ?? DEFAULT_REFRESH_KNOWN_PER_FAMILY;
    this.bootstrapWindowPerFamily =
      options.bootstrapWindowPerFamily ?? DEFAULT_BOOTSTRAP_WINDOW_PER_FAMILY;
    this.requestGate = new RequestGate(
      options.requestSpacingMs ?? DEFAULT_REQUEST_SPACING_MS,
    );
  }

  private async fetchHtml(url: string, signal: AbortSignal): Promise<FetchHtmlResult> {
    await this.requestGate.wait(signal);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'follow',
        signal,
        headers: {
          'User-Agent': 'RadarFiscal/0.1 (+https://github.com/fabiojuniort-cyber/radar-fiscal-backend; CONFAZ connector)',
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
          'Accept-Language': 'pt-BR,pt;q=0.9',
        },
      });
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      throw networkConnectorError(error, url);
    }

    if (!response.ok) {
      const retryAfter = retryAfterSeconds(response);
      const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
      const kind = response.status === 429
        ? 'RATE_LIMITED' as const
        : response.status >= 500
          ? 'SOURCE_UNAVAILABLE' as const
          : 'HTTP_ERROR' as const;

      throw new ConnectorError(
        `CONFAZ returned HTTP ${response.status} for ${url}`,
        {
          kind,
          code: response.status === 429 ? 'CONFAZ_RATE_LIMITED' : 'CONFAZ_HTTP_ERROR',
          retryable,
          httpStatus: response.status,
          ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
          metadata: { url, statusText: response.statusText },
        },
      );
    }

    const contentType = response.headers.get('content-type');
    if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      throw new ConnectorError(
        `CONFAZ returned unexpected content type ${contentType}`,
        {
          kind: 'PROCESSING_ERROR',
          code: 'CONFAZ_UNEXPECTED_CONTENT_TYPE',
          retryable: false,
          metadata: { url, contentType },
        },
      );
    }

    const buffer = await response.arrayBuffer();
    return {
      html: decodeResponseBody(buffer, contentType),
      finalUrl: response.url || url,
      ...(contentType ? { contentType } : {}),
      ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}),
      ...(response.headers.get('last-modified')
        ? { lastModified: response.headers.get('last-modified')! }
        : {}),
    };
  }

  async collect(context: ConnectorExecutionContext): Promise<ConnectorResult> {
    const state = this.readSourceState
      ? await this.readSourceState(context.sourceId)
      : { connectorConfig: {}, knownOrigins: [] };
    const config = parseSourceConfig(state.connectorConfig);
    const years = yearsForIncrementalCollection(this.now(), config);
    const publications: ConnectorPublication[] = [];
    const partialFailures: NonNullable<ConnectorResult['partialFailures']> = [];

    let indexesAttempted = 0;
    let indexesSucceeded = 0;
    let detailPagesAttempted = 0;
    let skippedPreBaseline = 0;
    let bootstrapLimited = false;

    for (const year of years) {
      for (const family of FAMILIES) {
        const indexUrl = `${CONFAZ_BASE_URL}/legislacao/${family.path}/${year}/${year}`;
        indexesAttempted += 1;

        let index: FetchHtmlResult;
        try {
          index = await this.fetchHtml(indexUrl, context.signal);
          indexesSucceeded += 1;
        } catch (error) {
          if (context.signal.aborted) {
            throw error;
          }
          const connectorError = networkConnectorError(error, indexUrl);
          partialFailures.push({
            code: connectorError.code,
            message: connectorError.message,
            itemReference: indexUrl,
          });
          continue;
        }

        const links = extractConfazIndexLinks(index.html, index.finalUrl, family.key, year);
        const selected = chooseLinksToFetch(
          links,
          family,
          year,
          config,
          state.knownOrigins,
          this.refreshKnownPerFamily,
          this.bootstrapWindowPerFamily,
        );
        skippedPreBaseline += selected.skippedPreBaseline;
        bootstrapLimited ||= selected.bootstrapLimited;

        for (const link of selected.links) {
          detailPagesAttempted += 1;
          try {
            const detail = await this.fetchHtml(link.url, context.signal);
            const publication = parseConfazPublicationHtml(
              detail.html,
              detail.finalUrl,
              family.key,
              link.variant,
            );
            publication.metadata = {
              ...(publication.metadata ?? {}),
              indexUrl,
              indexLabel: link.label,
              sourceEtag: detail.etag,
              sourceLastModified: detail.lastModified,
            };
            publications.push(publication);
          } catch (error) {
            if (context.signal.aborted) {
              throw error;
            }
            const connectorError = networkConnectorError(error, link.url);
            partialFailures.push({
              code: connectorError.code,
              message: connectorError.message,
              itemReference: link.url,
            });
          }
        }
      }
    }

    if (indexesAttempted > 0 && indexesSucceeded === 0) {
      const failureSamples = partialFailures.slice(0, 4);
      const firstFailure = failureSamples[0];
      throw new ConnectorError(
        firstFailure
          ? `All CONFAZ annual indexes failed in this attempt. First failure: ${firstFailure.message}`
          : 'All CONFAZ annual indexes failed in this attempt',
        {
          kind: 'SOURCE_UNAVAILABLE',
          code: 'CONFAZ_ALL_INDEXES_FAILED',
          retryable: true,
          metadata: {
            years,
            indexFailureCount: partialFailures.length,
            failureSamples,
          },
        },
      );
    }

    return {
      publications,
      ...(partialFailures.length > 0 ? { partialFailures } : {}),
      metadata: {
        source: 'CONFAZ',
        connectorVersion: this.version,
        years,
        indexesAttempted,
        indexesSucceeded,
        detailPagesAttempted,
        publicationCount: publications.length,
        skippedPreBaseline,
        knownOriginCount: state.knownOrigins.length,
        bootstrapLimited,
        requestSpacingMs: DEFAULT_REQUEST_SPACING_MS,
        egressProxyEnabled: this.proxyEnabled,
      },
    };
  }
}
