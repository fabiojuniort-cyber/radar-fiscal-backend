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

  if (type === 'EDITAL DE TRANSAÇÃO') {
    if (agency !== 'RFB_PGFN') {
      return { included: false, reason: 'TRANSACTION_NOTICE_NON_JOINT' };
    }
    return {
      included: true,
      category: 'OPERATIONAL',
      reason: 'CENTRAL_TAX_TRANSACTION_NOTICE',
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

function htmlFragmentText(value: string): string {
  let out = '';
  const parser = new HtmlParser({
    onopentag(name) {
      if (/^(?:br|p|div|li|tr|td|th|h[1-6])$/.test(name.toLowerCase())) out += '\n';
    },
    ontext(text) {
      out += text;
    },
    onclosetag(name) {
      if (/^(?:p|div|li|tr|td|th|h[1-6])$/.test(name.toLowerCase())) out += '\n';
    },
  }, { decodeEntities: true });
  parser.end(value);
  return out
    .replace(/[\t \u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n+/g, '\n')
    .trim();
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function validIsoDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
    ? value
    : undefined;
}

interface ApiSegment {
  order: number;
  text: string;
  attachment?: RfbAttachment;
}

function apiSegments(payload: Record<string, unknown>): ApiSegment[] {
  const segments: ApiSegment[] = [];
  const visit = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const raw of value) {
      const item = record(raw);
      if (!item) continue;
      const order = typeof item.ordemSegmentoAto === 'number' && Number.isFinite(item.ordemSegmentoAto)
        ? item.ordemSegmentoAto
        : Number.MAX_SAFE_INTEGER;
      const omit = item.omitir === true;
      const text = !omit && typeof item.textoIntegra === 'string'
        ? htmlFragmentText(item.textoIntegra)
        : '';
      const file = record(item.arquivoBinario);
      const id = file && typeof file.idArquivoBinario === 'number' && Number.isSafeInteger(file.idArquivoBinario)
        ? String(file.idArquivoBinario)
        : undefined;
      const name = file && typeof file.nomeArquivoBinario === 'string'
        ? normalizeInline(file.nomeArquivoBinario)
        : undefined;
      if (text || id) {
        segments.push({
          order,
          text,
          ...(id
            ? {
                attachment: {
                  url: `${RFB_NORMAS_ORIGIN}/sijut2consulta/anexoOutros.action?idArquivoBinario=${encodeURIComponent(id)}`,
                  externalId: id,
                  ...(name ? { name } : {}),
                },
              }
            : {}),
        });
      }
    }
  };
  visit(payload.ementas);
  visit(payload.outrosSegmentos);
  return segments.sort((a, b) => a.order - b.order);
}

export interface RfbApiRepresentation extends RfbRepresentation {
  publishedAt?: Date;
  effectiveAt?: Date;
  actDate?: Date;
  agency?: string;
  type?: string;
  number?: string;
  published: boolean;
  current: boolean;
  republication: boolean;
  publicationReference?: string;
}

export function buildRfbApiRepresentationUrl(
  idAto: string,
  kind: 'original' | 'vigente' | 'multivigente' | 'relacional',
): string {
  return `https://normasinternet2.receita.fazenda.gov.br/api/consulta-externa/ato/${encodeURIComponent(idAto)}/visao/${kind}`;
}

export function parseRfbApiRepresentation(payload: unknown): RfbApiRepresentation {
  const root = record(payload);
  if (!root) throw new TypeError('RFB Normas API payload must be an object.');
  const idAto = root.idAto;
  if (typeof idAto !== 'number' || !Number.isSafeInteger(idAto) || idAto < 1) {
    throw new TypeError('RFB Normas API payload is missing a valid idAto.');
  }

  const epigrafe = record(root.epigrafe);
  const tipoAto = record(epigrafe?.tipoAto);
  const orgaos = Array.isArray(epigrafe?.orgaos) ? epigrafe!.orgaos : [];
  const firstAgency = record(orgaos[0]);
  const title = typeof root.epigrafeCompleta === 'string'
    ? normalizeInline(root.epigrafeCompleta)
    : undefined;
  const segments = apiSegments(root);
  const normalizedText = segments
    .map((segment) => segment.text)
    .filter(Boolean)
    .join('\n')
    .trim();

  const attachments: RfbAttachment[] = [];
  const seen = new Set<string>();
  for (const segment of segments) {
    if (!segment.attachment || seen.has(segment.attachment.externalId)) continue;
    seen.add(segment.attachment.externalId);
    attachments.push(segment.attachment);
  }

  const history = Array.isArray(root.historico)
    ? root.historico
        .map((item) => record(item))
        .filter((item): item is Record<string, unknown> => item !== undefined)
        .map((item) => JSON.stringify(item, Object.keys(item).sort()))
        .sort()
    : [];
  const relationshipDigest = createHash('sha256')
    .update(JSON.stringify({
      text: normalizedText,
      history,
      anchors: Array.isArray(root.ancorasNoAto) ? root.ancorasNoAto : [],
      retificationAnchors: Array.isArray(root.ancorasRetificacaoEpigrafe) ? root.ancorasRetificacaoEpigrafe : [],
    }))
    .digest('hex');

  const publishedOn = validIsoDate(root.dataPublicacao);
  const effectiveOn = validIsoDate(root.dataVigenciaInicio);
  const actOn = validIsoDate(epigrafe?.dataAto);

  return {
    normalizedText,
    normalizedHash: relationshipDigest,
    ...(title ? { title } : {}),
    attachments,
    ...(root.vigente === false ? { status: 'REVOKED' } : root.vigente === true ? { status: 'VIGENTE' } : {}),
    ...(publishedOn ? { publishedAt: new Date(`${publishedOn}T00:00:00Z`) } : {}),
    ...(effectiveOn ? { effectiveAt: new Date(`${effectiveOn}T00:00:00Z`) } : {}),
    ...(actOn ? { actDate: new Date(`${actOn}T00:00:00Z`) } : {}),
    ...(typeof firstAgency?.siglaOrgao === 'string' ? { agency: firstAgency.siglaOrgao } : {}),
    ...(typeof tipoAto?.nomeTipoAto === 'string' ? { type: tipoAto.nomeTipoAto } : {}),
    ...(typeof epigrafe?.numeroAto === 'string' ? { number: epigrafe.numeroAto } : {}),
    published: root.publicado === true,
    current: root.vigente === true,
    republication: root.ehRepublicado === true,
    ...(typeof root.dadosPublicacao === 'string' ? { publicationReference: normalizeInline(root.dadosPublicacao) } : {}),
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
