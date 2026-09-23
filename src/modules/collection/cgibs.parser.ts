import { Parser as HtmlParser } from 'htmlparser2';

import { CGIBS_BASE_URL } from './cgibs.client.js';

export type CgibsFamily =
  | 'RESOLUTIONS'
  | 'REGULATIONS'
  | 'PORTARIAS'
  | 'JOINT_ACTS'
  | 'JOINT_TECHNICAL_ACTS'
  | 'OFFICIAL_COMMUNIQUES'
  | 'TECHNICAL_DOCUMENTS'
  | 'GUIDES'
  | 'BOOKLETS'
  | 'NEWS';

export type CgibsDocumentStatus =
  | 'CURRENT'
  | 'PREVIOUS'
  | 'REVOKED'
  | 'DRAFT'
  | 'PUBLISHED';

export type CgibsSourceRole = 'PRIMARY' | 'ENRICHMENT' | 'VALIDATION';

export interface CgibsDocumentDescriptor {
  family: CgibsFamily;
  title: string;
  section?: string;
  actType?: string;
  actNumber?: string;
  publishedAt?: Date;
  effectiveAt?: Date;
  officialVersion?: string;
  documentFamily: string;
  documentStatus: CgibsDocumentStatus;
  revisionKind: string;
  sourceRole: CgibsSourceRole;
  officialUrl: string;
  externalId?: string;
  identityKey: string;
  content?: string;
  fileUrl?: string;
  fileName?: string;
  pageUrl?: string;
  metadata: Record<string, unknown>;
}

export interface CgibsPageCandidate {
  family: CgibsFamily;
  url: string;
  title: string;
  sourceRole: CgibsSourceRole;
}

export interface CgibsParsedContainer {
  documents: CgibsDocumentDescriptor[];
  pageLinks: CgibsPageCandidate[];
}

interface AnchorRecord {
  href: string;
  text: string;
  heading?: string;
  context: string;
}

function normalizeInline(value: string): string {
  return value.replace(/[\t\n\r \u00a0]+/g, ' ').trim();
}

function asciiUpper(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
}

function validDate(day: string, month: string, year: string): Date | undefined {
  const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso ? date : undefined;
}

const MONTHS: Record<string, string> = {
  JANEIRO: '01',
  FEVEREIRO: '02',
  MARCO: '03',
  ABRIL: '04',
  MAIO: '05',
  JUNHO: '06',
  JULHO: '07',
  AGOSTO: '08',
  SETEMBRO: '09',
  OUTUBRO: '10',
  NOVEMBRO: '11',
  DEZEMBRO: '12',
};

export function parseCgibsDate(value: string): Date | undefined {
  const slash = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(value);
  if (slash?.[1] && slash[2] && slash[3]) return validDate(slash[1], slash[2], slash[3]);

  const textual = /\b(\d{1,2})\s+DE\s+([A-ZÇÃÕÉÊÍÓÔÚ]+)\s+DE\s+(\d{4})\b/.exec(asciiUpper(value));
  if (textual?.[1] && textual[2] && textual[3]) {
    const month = MONTHS[textual[2]];
    if (month) return validDate(textual[1], month, textual[3]);
  }
  return undefined;
}

function publicationDate(value: string): Date | undefined {
  const patterns = [
    /Publicad[oa]\s+e\s+disponibilizad[oa]\s+no\s+site\s+do\s+CGIBS\s+em\s+([^\n.;]+)/i,
    /Publicad[oa]\s+no\s+site\s+do\s+CGIBS\s+em\s+([^\n.;]+)/i,
    /Publica[cç][aã]o\s*:\s*([^\n.;]+)/i,
    /Publicado\s+em\s*:\s*([^\n.;]+)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(value)?.[1];
    const parsed = match ? parseCgibsDate(match) : undefined;
    if (parsed) return parsed;
  }
  return undefined;
}

function effectiveDate(value: string): Date | undefined {
  const patterns = [
    /(?:in[ií]cio\s+da\s+vig[eê]ncia|vig[eê]ncia|produz(?:indo)?\s+efeitos?)\s*(?:em|a\s+partir\s+de|:)\s*([^\n.;]+)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(value)?.[1];
    const parsed = match ? parseCgibsDate(match) : undefined;
    if (parsed) return parsed;
  }
  return undefined;
}

function officialVersion(value: string): string | undefined {
  const normalized = normalizeInline(value);
  const standard =
    /\b(?:VERS(?:A|Ã)O|VERSAO|V)\.?\s*(\d+(?:[._ ]\d+){1,3}[A-Z]?)\b/i.exec(normalized)?.[1] ??
    /\bEDI[CÇ][AÃ]O\s+(\d+(?:\.\d+)+)\b/i.exec(normalized)?.[1] ??
    /\bOPENAPI\s+V(\d+(?:[._ ]\d+)+)\b/i.exec(normalized)?.[1];
  return standard?.replace(/[ _]+/g, '.').replace(/\.{2,}/g, '.');
}

function formalAct(value: string): { actType?: string; actNumber?: string } {
  const text = normalizeInline(value);
  const upper = asciiUpper(text);

  const typePatterns: Array<[RegExp, string]> = [
    [/ATO TECNICO CONJUNTO[^N]*N[ºO°.]?\s*/i, 'ATO TÉCNICO CONJUNTO'],
    [/ATO CONJUNTO[^N]*N[ºO°.]?\s*/i, 'ATO CONJUNTO'],
    [/PORTARIA CONJUNTA[^N]*N[ºO°.]?\s*/i, 'PORTARIA CONJUNTA'],
    [/RESOLUCAO CGIBS\s+N[ºO°.]?\s*/i, 'RESOLUÇÃO CGIBS'],
    [/PORTARIA(?:\s+CGIBS)?\s+N[ºO°.]?\s*/i, 'PORTARIA CGIBS'],
    [/COMUNICADO(?:\s+CONJUNTO)?(?:\s+CGIBS(?:\s+E\s+RFB)?)?\s+N[ºO°.]?\s*/i, 'COMUNICADO OFICIAL'],
    [/NOTA ORIENTATIVA(?:\s+DERE)?\s+N?[ºO°.]?\s*/i, 'NOTA ORIENTATIVA'],
  ];

  let actType: string | undefined;
  for (const [pattern, label] of typePatterns) {
    if (pattern.test(upper)) {
      actType = label;
      break;
    }
  }

  if (!actType) return {};

  const explicit = /\bN[ºO°.]?\s*(\d{1,4})\s*[\/.]\s*(\d{4})\b/i.exec(upper);
  if (explicit?.[1] && explicit[2]) return { actType, actNumber: `${explicit[1]}/${explicit[2]}` };

  const number = /\bN[ºO°.]?\s*(\d{1,4})\b/i.exec(upper)?.[1];
  const year = parseCgibsDate(text)?.getUTCFullYear().toString() ?? /\b(20\d{2})\b/.exec(upper)?.[1];
  return { actType, ...(number && year ? { actNumber: `${number}/${year}` } : {}) };
}

function statusFor(value: string): CgibsDocumentStatus {
  const upper = asciiUpper(value);
  if (/REVOGAD/.test(upper)) return 'REVOKED';
  if (/MINUTA|RASCUNHO/.test(upper)) return 'DRAFT';
  if (/VERSOES? ANTERIORES|VERSAO ANTERIOR|HISTORICO/.test(upper)) return 'PREVIOUS';
  if (/VERSAO ATUAL|VIGENTE|ATUAL/.test(upper)) return 'CURRENT';
  return 'PUBLISHED';
}

function revisionKind(value: string): string {
  const upper = asciiUpper(value);
  if (/RETIFIC/.test(upper)) return 'RETIFICATION';
  if (/REPUBLIC/.test(upper)) return 'REPUBLICATION';
  if (/REVOGAD/.test(upper)) return 'REVOKED';
  if (/MINUTA|RASCUNHO/.test(upper)) return 'DRAFT';
  if (/VERSOES? ANTERIORES|VERSAO ANTERIOR/.test(upper)) return 'PREVIOUS';
  return 'ORIGINAL';
}

function familyRole(family: CgibsFamily): CgibsSourceRole {
  if (family === 'REGULATIONS' || family === 'GUIDES' || family === 'BOOKLETS' || family === 'NEWS') return 'ENRICHMENT';
  return 'PRIMARY';
}

function familyActType(family: CgibsFamily, title: string): string {
  const formal = formalAct(title).actType;
  if (formal) return formal;
  const upper = asciiUpper(title);
  if (/NOTA ORIENTATIVA/.test(upper)) return 'NOTA ORIENTATIVA';
  if (/MANUAL/.test(upper)) return 'MANUAL';
  if (/LEIAUTE|LAYOUT/.test(upper)) return 'LEIAUTE';
  if (/XSD|ESQUEMA/.test(upper)) return 'ESQUEMA XSD';
  if (/OPENAPI/.test(upper)) return 'ESPECIFICAÇÃO OPENAPI';
  if (/CARTILHA/.test(upper)) return 'CARTILHA';
  if (/GUIA/.test(upper)) return 'GUIA';
  switch (family) {
    case 'RESOLUTIONS': return 'RESOLUÇÃO CGIBS';
    case 'PORTARIAS': return 'PORTARIA CGIBS';
    case 'JOINT_ACTS': return 'ATO CONJUNTO';
    case 'JOINT_TECHNICAL_ACTS': return 'ATO TÉCNICO CONJUNTO';
    case 'OFFICIAL_COMMUNIQUES': return 'COMUNICADO OFICIAL';
    case 'REGULATIONS': return 'REGULAMENTO';
    case 'TECHNICAL_DOCUMENTS': return 'DOCUMENTO TÉCNICO';
    case 'GUIDES': return 'GUIA';
    case 'BOOKLETS': return 'CARTILHA';
    case 'NEWS': return 'COMUNICADO OPERACIONAL';
  }
}

function documentFamily(title: string, family: CgibsFamily, section?: string): string {
  const formal = formalAct(title);
  if (formal.actType && formal.actNumber) return `${formal.actType} ${formal.actNumber}`;

  const cleaned = normalizeInline(title)
    .replace(/\([^)]*\.(?:pdf|zip|docx|xlsx|xml)[^)]*\)$/i, '')
    .replace(/\.(?:pdf|zip|docx|xlsx|xml)$/i, '')
    .replace(/\b(?:VERS(?:A|Ã)O|VERSAO|V)\.?\s*\d+(?:[._ ]\d+){1,3}[A-Z]?\b/ig, '')
    .replace(/\bEDI[CÇ][AÃ]O\s+\d+(?:\.\d+)+\b/ig, '')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned || family;
}

function stablePath(url: string): string {
  const parsed = new URL(url, CGIBS_BASE_URL);
  return parsed.pathname.replace(/\/{2,}/g, '/');
}

function canonicalToken(value: string): string {
  return asciiUpper(value)
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function identityFor(
  family: CgibsFamily,
  title: string,
  actType: string,
  actNumber: string | undefined,
  docFamily: string,
  version: string | undefined,
  section: string | undefined,
): string {
  if (actNumber && /RESOLU|PORTARIA|ATO |COMUNICADO|NOTA ORIENTATIVA/.test(asciiUpper(actType))) {
    return `CGIBS|ACT|${canonicalToken(actType)}|${canonicalToken(actNumber)}`;
  }

  const statusScope = /PRODU[CÇ][AÃ]O RESTRITA|PILOTO/i.test(`${section ?? ''} ${title}`)
    ? 'PRODUCAO_RESTRITA'
    : 'GERAL';
  return `CGIBS|DOC|${canonicalToken(family)}|${canonicalToken(docFamily)}|${canonicalToken(version ?? 'SEM_VERSAO')}|${statusScope}`;
}

function fileLike(url: string): boolean {
  const parsed = new URL(url, CGIBS_BASE_URL);
  return /\/upload\/arquivos\//i.test(parsed.pathname) ||
    /\.(?:pdf|zip|docx|xlsx|xml|json)(?:$|[?#])/i.test(parsed.toString());
}

const EXCLUDED_PAGE_PATHS = new Set([
  '/', '/inicial', '/quem-somos', '/noticias', '/central-de-conteudo', '/legislacoes',
  '/resolucoes', '/regulamentos', '/portarias', '/atos-conjuntos', '/atos-tecnicos-conjuntos',
  '/relatorios', '/transparencia', '/portal-de-servicos', '/mapa-do-site', '/guias',
  '/cartilhas', '/comunicados-oficiais', '/documentos-tecnicos', '/videos',
]);

function eligiblePageLink(url: string, listingUrl: string): boolean {
  const parsed = new URL(url, listingUrl);
  if (!['https://www.cgibs.gov.br', 'https://cgibs.gov.br'].includes(parsed.origin.toLowerCase())) return false;
  const path = parsed.pathname.replace(/\/$/, '') || '/';
  if (EXCLUDED_PAGE_PATHS.has(path)) return false;
  if (fileLike(parsed.toString())) return false;
  if (/^\/(?:midia|ouvidoria|busca|termos-de-uso)(?:\/|$)/i.test(path)) return false;
  return true;
}

function operationalNews(title: string): boolean {
  const upper = asciiUpper(title);
  const tax = /IBS|CBS|REFORMA TRIBUTARIA|DERE|SPLIT PAYMENT|DOCUMENTO FISCAL/.test(upper);
  const action = /NOTA ORIENTATIVA|ORIENTACAO|MANUAL|LEIAUTE|XSD|ESQUEMA|VALIDACAO|PRAZO|OBRIGACAO|APURACAO|REGULAMENT|ATO TECNICO|CONFORMIDADE|PRODUCAO RESTRITA|ATUALIZ/.test(upper);
  return tax && action;
}

function collectAnchors(html: string): { headings: string[]; anchors: AnchorRecord[]; pageText: string; h1?: string } {
  const headings: string[] = [];
  const anchors: AnchorRecord[] = [];
  let currentHeading = '';
  let headingTag: string | undefined;
  let headingText = '';
  let anchor: { href: string; text: string } | undefined;
  let context = '';
  let pageText = '';
  let h1: string | undefined;
  let ignoredDepth = 0;

  const parser = new HtmlParser({
    onopentag(name, attrs) {
      const tag = name.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'nav' || tag === 'footer') {
        ignoredDepth += 1;
        return;
      }
      if (ignoredDepth > 0) return;
      if (/^h[1-6]$/.test(tag)) {
        headingTag = tag;
        headingText = '';
      }
      if (tag === 'a' && attrs.href) anchor = { href: attrs.href, text: '' };
      if (tag === 'br' || tag === 'p' || tag === 'li' || tag === 'div') context += '\n';
    },
    ontext(value) {
      if (ignoredDepth > 0) return;
      pageText += value + ' ';
      context += value;
      if (headingTag) headingText += value;
      if (anchor) anchor.text += value;
    },
    onclosetag(name) {
      const tag = name.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'nav' || tag === 'footer') {
        if (ignoredDepth > 0) ignoredDepth -= 1;
        return;
      }
      if (ignoredDepth > 0) return;
      if (tag === headingTag) {
        const heading = normalizeInline(headingText);
        if (heading) {
          currentHeading = heading;
          headings.push(heading);
          if (tag === 'h1' && !h1) h1 = heading;
        }
        headingTag = undefined;
        headingText = '';
      }
      if (tag === 'a' && anchor) {
        anchors.push({
          href: anchor.href,
          text: normalizeInline(anchor.text),
          ...(currentHeading ? { heading: currentHeading } : {}),
          context: normalizeInline(context.slice(-1200)),
        });
        anchor = undefined;
      }
    },
  }, { decodeEntities: true });

  parser.end(html);
  return { headings, anchors, pageText: normalizeInline(pageText), ...(h1 ? { h1 } : {}) };
}

function descriptorFromArtifact(
  family: CgibsFamily,
  listingUrl: string,
  anchor: AnchorRecord,
): CgibsDocumentDescriptor | undefined {
  const absolute = new URL(anchor.href, listingUrl).toString();
  if (!fileLike(absolute)) return undefined;

  const title = normalizeInline(anchor.heading && !/VERS(?:A|Ã)O ATUAL|VERSOES? ANTERIORES|MANUAL DE|NOTAS ORIENTATIVAS?/i.test(anchor.heading)
    ? anchor.heading
    : anchor.text || anchor.heading || stablePath(absolute).split('/').pop() || 'Documento CGIBS');
  if (!title) return undefined;

  const section = anchor.heading && anchor.heading !== title ? anchor.heading : undefined;
  const combined = normalizeInline(`${anchor.heading ?? ''} ${anchor.text} ${anchor.context}`);
  const formal = formalAct(`${title} ${combined}`);
  const actType = formal.actType ?? familyActType(family, title);
  const actNumber = formal.actNumber;
  const version = officialVersion(`${title} ${section ?? ''}`);
  const docFamily = documentFamily(title, family, section);
  const externalId = stablePath(absolute);
  const publishedAt = publicationDate(combined);
  const effectiveAt = effectiveDate(combined);

  return {
    family,
    title,
    ...(section ? { section } : {}),
    actType,
    ...(actNumber ? { actNumber } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(effectiveAt ? { effectiveAt } : {}),
    ...(version ? { officialVersion: version } : {}),
    documentFamily: docFamily,
    documentStatus: statusFor(combined),
    revisionKind: revisionKind(combined),
    sourceRole: familyRole(family),
    officialUrl: absolute,
    externalId,
    identityKey: identityFor(family, title, actType, actNumber, docFamily, version, section),
    content: normalizeInline(anchor.context) || undefined,
    fileUrl: absolute,
    fileName: anchor.text || stablePath(absolute).split('/').pop(),
    pageUrl: listingUrl,
    metadata: {
      listingUrl,
      family,
      ...(section ? { section } : {}),
      sourceRole: familyRole(family),
    },
  };
}

export function parseCgibsContainer(
  html: string,
  family: CgibsFamily,
  listingUrl: string,
): CgibsParsedContainer {
  const parsed = collectAnchors(html);
  const documents = parsed.anchors
    .map((anchor) => descriptorFromArtifact(family, listingUrl, anchor))
    .filter((item): item is CgibsDocumentDescriptor => item !== undefined);

  const pageLinks: CgibsPageCandidate[] = [];
  const seenPages = new Set<string>();
  for (const anchor of parsed.anchors) {
    if (!anchor.href || !eligiblePageLink(anchor.href, listingUrl)) continue;
    const absolute = new URL(anchor.href, listingUrl).toString();
    const title = normalizeInline(anchor.text || anchor.heading || '');
    if (!title) continue;
    if (family === 'NEWS' && !operationalNews(title)) continue;
    if (!['OFFICIAL_COMMUNIQUES', 'TECHNICAL_DOCUMENTS', 'GUIDES', 'BOOKLETS', 'NEWS'].includes(family)) continue;
    const canonical = new URL(absolute);
    canonical.hash = '';
    const url = canonical.toString();
    if (seenPages.has(url)) continue;
    seenPages.add(url);
    pageLinks.push({ family, url, title, sourceRole: familyRole(family) });
  }

  const uniqueDocuments = new Map<string, CgibsDocumentDescriptor>();
  for (const document of documents) {
    const key = document.externalId ?? document.officialUrl;
    const previous = uniqueDocuments.get(key);
    if (!previous || (previous.sourceRole !== 'PRIMARY' && document.sourceRole === 'PRIMARY')) {
      uniqueDocuments.set(key, document);
    }
  }

  return { documents: [...uniqueDocuments.values()], pageLinks };
}

export function parseCgibsDetailPage(
  html: string,
  family: CgibsFamily,
  pageUrl: string,
): CgibsParsedContainer {
  const parsed = collectAnchors(html);
  const attachments = parsed.anchors
    .map((anchor) => descriptorFromArtifact(family, pageUrl, anchor))
    .filter((item): item is CgibsDocumentDescriptor => item !== undefined);

  if (attachments.length) return { documents: attachments, pageLinks: [] };

  const title = normalizeInline(parsed.h1 ?? '');
  if (!title) return { documents: [], pageLinks: [] };
  if (family === 'NEWS' && !operationalNews(title)) return { documents: [], pageLinks: [] };

  const publishedAt = publicationDate(parsed.pageText);
  const effectiveAt = effectiveDate(parsed.pageText);
  const formal = formalAct(title);
  const actType = formal.actType ?? familyActType(family, title);
  const version = officialVersion(title);
  const docFamily = documentFamily(title, family);
  const canonical = new URL(pageUrl);
  canonical.hash = '';
  const officialUrl = canonical.toString();

  return {
    documents: [{
      family,
      title,
      actType,
      ...(formal.actNumber ? { actNumber: formal.actNumber } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      ...(effectiveAt ? { effectiveAt } : {}),
      ...(version ? { officialVersion: version } : {}),
      documentFamily: docFamily,
      documentStatus: statusFor(parsed.pageText),
      revisionKind: revisionKind(parsed.pageText),
      sourceRole: familyRole(family),
      officialUrl,
      externalId: stablePath(officialUrl),
      identityKey: identityFor(family, title, actType, formal.actNumber, docFamily, version, undefined),
      content: parsed.pageText,
      pageUrl: officialUrl,
      metadata: {
        family,
        sourceRole: familyRole(family),
        officialUrlGranularity: 'PAGE',
      },
    }],
    pageLinks: [],
  };
}
