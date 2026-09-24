import { createHash } from 'node:crypto';

import { Parser as HtmlParser } from 'htmlparser2';

import {
  canonicalizeRfbActType,
  canonicalizeRfbAgency,
  isCentralRfbAgency,
  normalizeRfbActNumber,
  parseCanonicalRfbFormalAct,
  type CanonicalRfbActType,
} from './rfb-normas.identity.js';

export const RFB_NORMAS_ORIGIN = 'https://normas.receita.fazenda.gov.br';
export const RFB_NORMAS_SEARCH_URL = RFB_NORMAS_ORIGIN + '/sijut2consulta/consulta.action';

export type RfbCaptureCategory =
  | 'NORMATIVE'
  | 'INTERPRETATIVE'
  | 'OPERATIONAL'
  | 'PORTARIA';

export interface RfbNormasListingItem {
  idAto: string;
  type: string;
  number: string;
  agency: string;
  publishedAt: Date;
  abstract: string;
  detailUrl: string;
}

export interface RfbSearchPage {
  items: RfbNormasListingItem[];
  totalCount: number;
  totalPages: number;
  page: number;
}

export interface RfbFilterDecision {
  included: boolean;
  category?: RfbCaptureCategory;
  reason: string;
}

export interface RfbAttachment {
  url: string;
  externalId: string;
  name?: string;
}

export interface RfbRepresentation {
  normalizedText: string;
  normalizedHash: string;
  title?: string;
  attachments: RfbAttachment[];
  status?: string;
}

interface Cell {
  text: string;
  hrefs: string[];
}

interface Row {
  cells: Cell[];
}

function normalizeInline(value: string): string {
  return value.replace(/[\t\r\n \u00a0]+/g, ' ').trim();
}

function asciiUpper(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
}

function parseBrazilDate(value: string): Date | undefined {
  const match = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  const iso = `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso
    ? parsed
    : undefined;
}

export function extractRfbIdAto(href: string): string | undefined {
  try {
    const parsed = new URL(href, RFB_NORMAS_SEARCH_URL);
    const query = parsed.searchParams.get('idAto');
    if (query && /^\d+$/.test(query)) return query;

    const hash = parsed.hash;
    const match =
      /\/consulta\/externa\/(\d+)(?:\/|$)/i.exec(hash)?.[1] ??
      /\/consulta\/externa\/(\d+)(?:\/|$)/i.exec(parsed.pathname)?.[1];
    return match && /^\d+$/.test(match) ? match : undefined;
  } catch {
    return undefined;
  }
}

function detailUrl(idAto: string): string {
  return `${RFB_NORMAS_ORIGIN}/sijut2consulta/link.action?idAto=${encodeURIComponent(idAto)}`;
}

export function buildRfbSearchUrl(input: {
  start: Date;
  end: Date;
  page: number;
}): string {
  const format = (date: Date): string => {
    const day = String(date.getUTCDate()).padStart(2, '0');
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    return `${day}/${month}/${date.getUTCFullYear()}`;
  };
  const params = new URLSearchParams({
    facetsExistentes: '',
    orgaosSelecionados: '',
    tiposAtosSelecionados: '',
    lblTiposAtosSelecionados: '',
    ordemColuna: '',
    ordemDirecao: '',
    tipoConsulta: 'formulario',
    tipoAtoFacet: '',
    siglaOrgaoFacet: '',
    anoAtoFacet: '',
    termoBusca: '',
    numero_ato: '',
    tipoData: '2',
    dt_inicio: format(input.start),
    dt_fim: format(input.end),
    ano_ato: '',
    optOrdem: 'Publicacao_DESC',
    p: String(input.page),
    x: '0',
    y: '0',
  });
  return `${RFB_NORMAS_SEARCH_URL}?${params.toString()}`;
}

export function buildRfbRepresentationUrl(
  idAto: string,
  kind: 'original' | 'vigente' | 'multivigente' | 'relacional',
): string {
  const legacyView = kind === 'multivigente' ? 'anotado' : kind;
  return `${RFB_NORMAS_ORIGIN}/sijut2consulta/imprimir.action?visao=${legacyView}&idAto=${encodeURIComponent(idAto)}`;
}

export function buildRfbModernRepresentationUrl(
  idAto: string,
  kind: 'original' | 'vigente' | 'multivigente' | 'relacional',
): string {
  return `https://normasinternet2.receita.fazenda.gov.br/#/consulta/externa/${encodeURIComponent(idAto)}/visao/${kind}`;
}

export function parseRfbSearchPage(html: string, requestedPage = 1): RfbSearchPage {
  const rows: Row[] = [];
  let currentRow: Row | undefined;
  let currentCell: Cell | undefined;
  let ignored = 0;
  let pageText = '';

  const parser = new HtmlParser({
    onopentag(name, attrs) {
      const tag = name.toLowerCase();
      if (tag === 'script' || tag === 'style') {
        ignored += 1;
        return;
      }
      if (ignored) return;
      if (tag === 'tr') currentRow = { cells: [] };
      if (tag === 'td' && currentRow) {
        currentCell = { text: '', hrefs: [] };
        currentRow.cells.push(currentCell);
      }
      if (tag === 'a' && currentCell && attrs.href) currentCell.hrefs.push(attrs.href);
      if (tag === 'br' || tag === 'p' || tag === 'div') {
        if (currentCell) currentCell.text += '\n';
        pageText += '\n';
      }
    },
    ontext(value) {
      if (ignored) return;
      pageText += value + ' ';
      if (currentCell) currentCell.text += value;
    },
    onclosetag(name) {
      const tag = name.toLowerCase();
      if (tag === 'script' || tag === 'style') {
        if (ignored) ignored -= 1;
        return;
      }
      if (ignored) return;
      if (tag === 'td') currentCell = undefined;
      if (tag === 'tr' && currentRow) {
        if (currentRow.cells.length) rows.push(currentRow);
        currentRow = undefined;
        currentCell = undefined;
      }
    },
  }, { decodeEntities: true });
  parser.end(html);

  const items: RfbNormasListingItem[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (row.cells.length < 5) continue;
    const type = normalizeInline(row.cells[0]?.text ?? '');
    const number = normalizeInline(row.cells[1]?.text ?? '');
    const agency = normalizeInline(row.cells[2]?.text ?? '');
    const publishedAt = parseBrazilDate(row.cells[3]?.text ?? '');
    const abstract = normalizeInline(row.cells.slice(4).map((cell) => cell.text).join(' '));
    if (!type || !number || !agency || !publishedAt) continue;

    const hrefs = row.cells.flatMap((cell) => cell.hrefs);
    const idAto = hrefs.map(extractRfbIdAto).find((value): value is string => value !== undefined);
    if (!idAto || seen.has(idAto)) continue;
    seen.add(idAto);

    items.push({
      idAto,
      type,
      number,
      agency,
      publishedAt,
      abstract,
      detailUrl: detailUrl(idAto),
    });
  }

  const normalizedText = normalizeInline(pageText);
  const totalMatch = /Total\s+de\s+atos\s+localizados\s*:\s*([\d.]+)/i.exec(normalizedText);
  const pageMatch = /P[aá]gina\s+\d+\s+de\s+(\d+)/i.exec(normalizedText);
  const totalCount = totalMatch?.[1] ? Number(totalMatch[1].replaceAll('.', '')) : items.length;
  const totalPages = pageMatch?.[1]
    ? Number(pageMatch[1])
    : Math.max(1, Math.ceil(totalCount / 100));

  return {
    items,
    totalCount: Number.isSafeInteger(totalCount) ? totalCount : items.length,
    totalPages: Number.isSafeInteger(totalPages) && totalPages > 0 ? totalPages : 1,
    page: requestedPage,
  };
}

const NORMATIVE_TYPES = new Set<CanonicalRfbActType>([
  'INSTRUÇÃO NORMATIVA',
  'INSTRUÇÃO NORMATIVA CONJUNTA',
  'ATO DECLARATÓRIO INTERPRETATIVO',
  'ATO DECLARATÓRIO NORMATIVO',
  'PARECER NORMATIVO',
]);

const OPERATIONAL_TYPES = new Set<CanonicalRfbActType>([
  'NOTA TÉCNICA',
  'NOTA TÉCNICA CONJUNTA',
  'ATO TÉCNICO CONJUNTO',
  'NORMA DE EXECUÇÃO',
  'NORMA DE EXECUÇÃO CONJUNTA',
]);

const PORTARIA_TYPES = new Set<CanonicalRfbActType>([
  'PORTARIA',
  'PORTARIA CONJUNTA',
  'PORTARIA NORMATIVA',
  'PORTARIA INTERMINISTERIAL',
]);

const POSITIVE_OPERATIONAL =
  /\b(?:IBS|CBS|PIS|COFINS|IPI|IRPJ|CSLL|DCTF|DIRF|PER\/DCOMP|PERDCOMP|SPED|EFD|ESOCIAL|E-SOCIAL|REINF|NF-E|NFS-E|CT-E|MDF-E|OBRIGACAO ACESSORIA|TRIBUT|DECLARACAO|ARRECADACAO|CNPJ|CADASTRO FISCAL|REGIME TRIBUT|BENEFICIO FISCAL|CREDITO TRIBUT|RETENCAO|IMPORTACAO|EXPORTACAO|ADUANEIR|SIMPLES NACIONAL|IMPOSTO|CONTRIBUICAO|PARCELAMENTO|COMPENSACAO|RESTITUICAO)\b/;

const ADMINISTRATIVE_NEGATIVE =
  /\b(?:PORTARIA DE PESSOAL|DESIGNA|NOMEIA|EXONERA|SUBSTITUIR SERVIDOR|COMISSAO DE ETICA|HORARIO DE ATENDIMENTO|SUSPENDE TEMPORARIAMENTE AS ATIVIDADES DA AGENCIA|FUNCIONAMENTO DA AGENCIA|FUNCIONAMENTO DE UNIDADE|FERIADO|PONTO FACULTATIVO|TELETRABALHO|GESTAO DE PESSOAS)\b/;

const ADE_LOW_VALUE =
  /\b(?:CERTIFICA .*OPERADOR ECONOMICO AUTORIZADO|PROGRAMA REMESSA CONFORME|CERTIFICA A EMPRESA|CERTIFICA COMO OEA)\b/;

const PURE_NCM_CLASSIFICATION =
  /\b(?:ASSUNTO\s*:\s*CLASSIFICACAO DE MERCADORIAS|CLASSIFICACAO FISCAL DE MERCADORIAS|NOMENCLATURA COMUM DO MERCOSUL\s*-?\s*NCM)\b/;

export function decideRfbCapture(item: RfbNormasListingItem): RfbFilterDecision {
  const type = canonicalizeRfbActType(item.type);
  const agency = canonicalizeRfbAgency(item.agency);
  const text = asciiUpper(`${item.type} ${item.agency} ${item.abstract}`);

  if (!type) return { included: false, reason: 'TYPE_UNRECOGNIZED' };

  if (NORMATIVE_TYPES.has(type)) {
    return { included: true, category: 'NORMATIVE', reason: 'NORMATIVE_TYPE' };
  }

  if (type === 'SOLUÇÃO DE CONSULTA' || type === 'SOLUÇÃO DE DIVERGÊNCIA') {
    if (agency !== 'COSIT') {
      return { included: false, reason: 'INTERPRETATIVE_NON_COSIT' };
    }
    if (PURE_NCM_CLASSIFICATION.test(text)) {
      return { included: false, reason: 'INTERPRETATIVE_NCM_CLASSIFICATION' };
    }
    return { included: true, category: 'INTERPRETATIVE', reason: 'COSIT_INTERPRETATIVE' };
  }

  if (OPERATIONAL_TYPES.has(type)) {
    if (!isCentralRfbAgency(item.agency)) {
      return { included: false, reason: 'OPERATIONAL_NONCENTRAL' };
    }
    return {
      included: true,
      category: 'OPERATIONAL',
      reason: POSITIVE_OPERATIONAL.test(text) ? 'OPERATIONAL_KEYWORD' : 'OPERATIONAL_CENTRAL_DEFAULT_INCLUDE',
    };
  }

  if (type === 'ATO DECLARATÓRIO EXECUTIVO' || type === 'ATO DECLARATÓRIO EXECUTIVO CONJUNTO') {
    if (!isCentralRfbAgency(item.agency)) {
      return { included: false, reason: 'ADE_NONCENTRAL' };
    }
    if (ADE_LOW_VALUE.test(text) && !POSITIVE_OPERATIONAL.test(text)) {
      return { included: false, reason: 'ADE_LOW_VALUE_CERTIFICATION' };
    }
    if (ADMINISTRATIVE_NEGATIVE.test(text) && !POSITIVE_OPERATIONAL.test(text)) {
      return { included: false, reason: 'ADE_ADMINISTRATIVE' };
    }
    return {
      included: true,
      category: 'OPERATIONAL',
      reason: POSITIVE_OPERATIONAL.test(text) ? 'ADE_OPERATIONAL_KEYWORD' : 'ADE_CENTRAL_DEFAULT_INCLUDE',
    };
  }

  if (PORTARIA_TYPES.has(type)) {
    if (asciiUpper(item.type).includes('PORTARIA DE PESSOAL')) {
      return { included: false, reason: 'PORTARIA_PESSOAL' };
    }
    if (!isCentralRfbAgency(item.agency)) {
      return { included: false, reason: 'PORTARIA_NONCENTRAL' };
    }
    if (ADMINISTRATIVE_NEGATIVE.test(text) && !POSITIVE_OPERATIONAL.test(text)) {
      return { included: false, reason: 'PORTARIA_ADMINISTRATIVE' };
    }
    return {
      included: true,
      category: 'PORTARIA',
      reason: POSITIVE_OPERATIONAL.test(text) ? 'PORTARIA_TAX_OPERATIONAL_KEYWORD' : 'PORTARIA_CENTRAL_DEFAULT_INCLUDE',
    };
  }

  if (type === 'ORIENTAÇÃO NORMATIVA' || type === 'ATO CONJUNTO') {
    if (!isCentralRfbAgency(item.agency)) {
      return { included: false, reason: 'EQUIVALENT_NONCENTRAL' };
    }
    return {
      included: true,
      category: POSITIVE_OPERATIONAL.test(text) ? 'OPERATIONAL' : 'NORMATIVE',
      reason: POSITIVE_OPERATIONAL.test(text) ? 'EQUIVALENT_OPERATIONAL_KEYWORD' : 'EQUIVALENT_CENTRAL_DEFAULT_INCLUDE',
    };
  }

  return { included: false, reason: 'TYPE_OUT_OF_SCOPE' };
}

function representationText(html: string): { text: string; headings: string[]; anchors: Array<{ href: string; text: string }> } {
  let ignored = 0;
  let text = '';
  let heading = '';
  let headingTag: string | undefined;
  const headings: string[] = [];
  let anchor: { href: string; text: string } | undefined;
  const anchors: Array<{ href: string; text: string }> = [];

  const parser = new HtmlParser({
    onopentag(name, attrs) {
      const tag = name.toLowerCase();
      if (['script', 'style', 'nav', 'footer', 'header'].includes(tag)) {
        ignored += 1;
        return;
      }
      if (ignored) return;
      if (/^h[1-6]$/.test(tag)) {
        headingTag = tag;
        heading = '';
      }
      if (tag === 'a' && attrs.href) anchor = { href: attrs.href, text: '' };
      if (['br', 'p', 'div', 'li', 'tr'].includes(tag)) text += '\n';
    },
    ontext(value) {
      if (ignored) return;
      text += value;
      if (headingTag) heading += value;
      if (anchor) anchor.text += value;
    },
    onclosetag(name) {
      const tag = name.toLowerCase();
      if (['script', 'style', 'nav', 'footer', 'header'].includes(tag)) {
        if (ignored) ignored -= 1;
        return;
      }
      if (ignored) return;
      if (tag === headingTag) {
        const value = normalizeInline(heading);
        if (value) headings.push(value);
        headingTag = undefined;
      }
      if (tag === 'a' && anchor) {
        anchors.push({ href: anchor.href, text: normalizeInline(anchor.text) });
        anchor = undefined;
      }
    },
  }, { decodeEntities: true });
  parser.end(html);

  const normalizedText = text
    .split(/\n+/)
    .map(normalizeInline)
    .filter(Boolean)
    .filter((line) => !/^(?:Voltar|Imprimir|Fechar|Topo)$/i.test(line))
    .join('\n')
    .trim();

  return { text: normalizedText, headings, anchors };
}

export function parseRfbRepresentationHtml(html: string, baseUrl: string): RfbRepresentation {
  const parsed = representationText(html);
  const title = parsed.headings.find((value) => {
    const type = canonicalizeRfbActType(value);
    return type !== undefined && /N[ºO°.]?\s*[\d.]+/i.test(value);
  }) ?? parsed.text.split('\n').find((value) => {
    const type = canonicalizeRfbActType(value);
    return type !== undefined && /N[ºO°.]?\s*[\d.]+/i.test(value);
  });

  const attachments: RfbAttachment[] = [];
  const seen = new Set<string>();
  for (const link of parsed.anchors) {
    let absolute: URL;
    try {
      absolute = new URL(link.href, baseUrl);
    } catch {
      continue;
    }
    if (absolute.hostname !== 'normas.receita.fazenda.gov.br') continue;
    const externalId = absolute.searchParams.get('idArquivoBinario');
    if (absolute.pathname !== '/sijut2consulta/anexoOutros.action' || !externalId || !/^\d+$/.test(externalId)) continue;
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    attachments.push({
      url: absolute.toString(),
      externalId,
      ...(link.text ? { name: link.text } : {}),
    });
  }

  const status = /\bREVOGAD[AO]\b/i.test(parsed.text)
    ? 'REVOKED'
    : /\bVIGENTE\b/i.test(parsed.text)
      ? 'VIGENTE'
      : undefined;

  return {
    normalizedText: parsed.text,
    normalizedHash: createHash('sha256').update(parsed.text, 'utf8').digest('hex'),
    ...(title ? { title } : {}),
    attachments,
    ...(status ? { status } : {}),
  };
}

export function canonicalizeRfbListingNumber(
  item: RfbNormasListingItem,
  title?: string,
): { agency?: string; actType?: string; actNumber?: string; actDate?: Date } {
  const fromTitle = title
    ? parseCanonicalRfbFormalAct(title, item.agency, item.type, item.publishedAt.getUTCFullYear())
    : undefined;
  if (fromTitle) return fromTitle;

  const agency = canonicalizeRfbAgency(item.agency);
  const actType = canonicalizeRfbActType(item.type);
  const actNumber = normalizeRfbActNumber(item.number, item.publishedAt.getUTCFullYear());
  return {
    ...(agency ? { agency } : {}),
    ...(actType ? { actType } : {}),
    ...(actNumber ? { actNumber } : {}),
  };
}
