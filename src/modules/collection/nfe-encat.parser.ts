import { Parser as HtmlParser } from 'htmlparser2';

export type NfeEncatPortalFamily = 'TECHNICAL_NOTES' | 'TECHNICAL_REPORTS' | 'SCHEMAS' | 'MANUALS';
export type NfeEncatDocumentStatus = 'CURRENT' | 'TESTING' | 'RETIRED' | 'PUBLISHED';
export type NfeEncatEnvironment = 'PRODUCTION' | 'HOMOLOGATION';
export type NfeEncatFileType = 'PDF' | 'ZIP' | 'XML' | 'UNKNOWN';

export interface NfeEncatListingItem {
  portalFamily: NfeEncatPortalFamily;
  portalSection: string;
  title: string;
  description?: string;
  documentNumber?: string;
  documentFamily: string;
  officialVersion?: string;
  publishedAt?: Date;
  documentStatus: NfeEncatDocumentStatus;
  environment?: NfeEncatEnvironment;
  contentToken: string;
  externalId: string;
  officialUrl: string;
  listingUrl: string;
  fileType: NfeEncatFileType;
}

interface ParagraphCapture {
  className: string;
  text: string;
  titleText: string;
  links: string[];
  titleSpanDepth: number;
}

function normalizeText(value: string): string {
  return value.replace(/[\t \u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
}

function normalizeInline(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function asciiUpper(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
}

function validDate(day: string, month: string, year: string): Date | undefined {
  const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso ? date : undefined;
}

function publicationDate(value: string): Date | undefined {
  const match = /\bPublicad[oa]\s+em\s+(\d{1,2})\/(\d{1,2})\/(\d{4})\b/i.exec(value)
    ?? /\bPublicad[oa]\s+em\s+(\d{1,2})[-.](\d{1,2})[-.](\d{4})\b/i.exec(value);
  return match?.[1] && match[2] && match[3] ? validDate(match[1], match[2], match[3]) : undefined;
}

function officialVersion(title: string): string | undefined {
  const match = /\b(?:v(?:ers(?:a|ã)o)?\.?\s*)(\d+(?:\.\d+)+(?:[a-z])?)\b/i.exec(title)
    ?? /\bvers(?:a|ã)o\s+(\d+(?:\.\d+)+(?:[a-z])?)\b/i.exec(title);
  return match?.[1];
}

function technicalNumber(title: string, family: NfeEncatPortalFamily): string | undefined {
  const pattern = family === 'TECHNICAL_NOTES'
    ? /\b(?:Nota\s+T[eé]cnica(?:\s+Conjunta)?|NT)\s*[.:-]?\s*(\d{4}\.\d{3})\b/i
    : family === 'TECHNICAL_REPORTS'
      ? /\b(?:Informe\s+T[eé]cnico|IT)\s*[.:-]?\s*(\d{4}\.\d{3})\b/i
      : undefined;
  return pattern?.exec(title)?.[1];
}

function statusForSection(section: string): NfeEncatDocumentStatus {
  const upper = asciiUpper(section);
  if (/TESTE|HOMOLOGA/.test(upper)) return 'TESTING';
  if (/ANTERIOR|DESUSO|NAO VIGENTE|NAO-VIGENTE/.test(upper)) return 'RETIRED';
  if (/VIGENTE|OFICIAL|EM USO/.test(upper)) return 'CURRENT';
  return 'PUBLISHED';
}

function environmentForSection(section: string): NfeEncatEnvironment | undefined {
  const upper = asciiUpper(section);
  if (/TESTE|HOMOLOGA/.test(upper)) return 'HOMOLOGATION';
  if (/OFICIAL|PRODUCAO|EM USO/.test(upper)) return 'PRODUCTION';
  return undefined;
}

function fileType(title: string): NfeEncatFileType {
  if (/\bZIP\b/i.test(title)) return 'ZIP';
  if (/\bPDF\b/i.test(title)) return 'PDF';
  if (/\bXML\b/i.test(title) && !/Esquemas?\s+XML/i.test(title)) return 'XML';
  if (/Nota\s+T[eé]cnica|Informe\s+T[eé]cnico|Manual|MOC|Anexo/i.test(title)) return 'PDF';
  return 'UNKNOWN';
}

function isOtherDfe(title: string): boolean {
  const upper = asciiUpper(title).replace(/[\s_-]+/g, '');
  return /NFGAS|NFAG|NFCOM|NF3E|NFEABI/.test(upper);
}

function belongsToRequestedScope(title: string, family: NfeEncatPortalFamily): boolean {
  if (isOtherDfe(title)) return false;
  if (family === 'SCHEMAS') return /NF\s*-?\s*E|NFC\s*-?\s*E/i.test(title);
  return true;
}

function contentTokenFromHref(href: string): string | undefined {
  const raw = /(?:[?&])conteudo=([^&#]+)/i.exec(href)?.[1];
  if (!raw) return undefined;
  try {
    const decoded = decodeURIComponent(raw.replace(/\+/g, '%2B')).trim();
    return decoded || undefined;
  } catch {
    return undefined;
  }
}

function documentFamilyFor(title: string, family: NfeEncatPortalFamily, number?: string): string {
  if (family === 'TECHNICAL_NOTES') return number ? `NT ${number}` : 'NOTAS TÉCNICAS NF-E/NFC-E';
  if (family === 'TECHNICAL_REPORTS') return number ? `IT ${number}` : 'INFORMES TÉCNICOS NF-E/NFC-E';
  if (family === 'SCHEMAS') {
    const nt = /\bNT\s*(\d{4}\.\d{3})\b/i.exec(title)?.[1];
    return nt ? `SCHEMAS NF-E/NFC-E — NT ${nt}` : 'SCHEMAS XML NF-E/NFC-E';
  }
  const anexo = /\bAnexo\s+([IVX]+)\b/i.exec(title)?.[1];
  if (/\bMOC\b|Manual\s+de\s+Orienta[cç][aã]o\s+ao\s+Contribuinte/i.test(title)) return anexo ? `MOC — ANEXO ${anexo.toUpperCase()}` : 'MOC NF-E/NFC-E';
  return 'MANUAIS NF-E/NFC-E';
}

function paragraphDescription(text: string, title: string): string | undefined {
  const lines = normalizeText(text).split('\n').map(normalizeInline).filter(Boolean);
  if (!lines.length) return undefined;
  const normalizedTitle = normalizeInline(title);
  const index = lines.findIndex(line => line === normalizedTitle || line.includes(normalizedTitle));
  const after = index >= 0 ? lines.slice(index + 1) : lines.slice(1);
  const description = after.join('\n').trim();
  return description || undefined;
}

export function parseNfeEncatListing(
  html: string,
  portalFamily: NfeEncatPortalFamily,
  listingUrl: string,
): NfeEncatListingItem[] {
  let section = '';
  let paragraph: ParagraphCapture | undefined;
  const items: NfeEncatListingItem[] = [];

  const finalizeParagraph = (): void => {
    if (!paragraph) return;
    const current = paragraph;
    paragraph = undefined;
    const text = normalizeText(current.text);
    if (/\btituloSessao\b/i.test(current.className)) {
      section = normalizeInline(text);
      return;
    }
    const href = current.links.find(link => /exibirArquivo\.aspx\?[^#]*\bconteudo=/i.test(link));
    if (!href) return;
    const token = contentTokenFromHref(href);
    if (!token) return;
    const title = normalizeInline(current.titleText || text.split('\n')[0] || '');
    if (!title || !belongsToRequestedScope(title, portalFamily)) return;
    const number = technicalNumber(title, portalFamily);
    const version = officialVersion(title);
    const officialUrl = new URL(href, listingUrl).toString();
    const description = paragraphDescription(current.text, title);
    const combined = `${title}\n${description ?? ''}`;
    const status = statusForSection(section);
    const environment = environmentForSection(section);
    items.push({
      portalFamily,
      portalSection: section || 'UNSECTIONED',
      title,
      ...(description ? { description } : {}),
      ...(number ? { documentNumber: number } : {}),
      documentFamily: documentFamilyFor(title, portalFamily, number),
      ...(version ? { officialVersion: version } : {}),
      ...(publicationDate(combined) ? { publishedAt: publicationDate(combined)! } : {}),
      documentStatus: status,
      ...(environment ? { environment } : {}),
      contentToken: token,
      externalId: token,
      officialUrl,
      listingUrl,
      fileType: fileType(title),
    });
  };

  const parser = new HtmlParser({
    onopentag(name, attributes) {
      const tag = name.toLowerCase();
      if (tag === 'p') {
        if (paragraph) finalizeParagraph();
        paragraph = {
          className: attributes.class ?? '',
          text: '',
          titleText: '',
          links: [],
          titleSpanDepth: 0,
        };
        return;
      }
      if (!paragraph) return;
      if (tag === 'br') paragraph.text += '\n';
      if (tag === 'a' && attributes.href) paragraph.links.push(attributes.href);
      if (tag === 'span' && /\btituloConteudo\b/i.test(attributes.class ?? '')) paragraph.titleSpanDepth += 1;
    },
    ontext(value) {
      if (!paragraph) return;
      paragraph.text += value;
      if (paragraph.titleSpanDepth > 0) paragraph.titleText += value;
    },
    onclosetag(name) {
      const tag = name.toLowerCase();
      if (!paragraph) return;
      if (tag === 'span' && paragraph.titleSpanDepth > 0) paragraph.titleSpanDepth -= 1;
      if (tag === 'p') finalizeParagraph();
    },
  }, { decodeEntities: true });

  parser.end(html);
  if (paragraph) finalizeParagraph();

  const unique = new Map<string, NfeEncatListingItem>();
  for (const item of items) {
    const key = `${item.portalFamily}:${item.contentToken}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()];
}
