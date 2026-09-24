import { createHash } from 'node:crypto';

import { Parser as HtmlParser } from 'htmlparser2';

import { ConnectorError } from './connector.error.js';

/*
 * Parsers for the DOE-SP portal JSON (do-api-web-search / do-api-publication-pdf).
 * Every function validates the shape it relies on and fails with a
 * PROCESSING_ERROR when the source contract changes, instead of silently
 * returning an empty result (an empty day must be distinguishable from a
 * broken payload).
 */

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function invalid(code: string, metadata?: Record<string, unknown>): ConnectorError {
  return new ConnectorError(code, {
    code,
    kind: 'PROCESSING_ERROR',
    retryable: false,
    ...(metadata ? { metadata } : {}),
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed || undefined;
}

export function isDoeSpGuid(value: unknown): value is string {
  return typeof value === 'string' && GUID.test(value);
}

export function asciiUpper(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------- catalogue

export interface DoeSpNamedRef { id: string; name: string }

/** v2/journals and v2/sections: `{ count, items: [{ id, name, ... }] }`. */
export function parseDoeSpNamedItems(body: unknown, code: string): DoeSpNamedRef[] {
  const items = record(body)?.items;
  if (!Array.isArray(items)) throw invalid(code);
  const out: DoeSpNamedRef[] = [];
  for (const item of items) {
    const row = record(item);
    const id = row?.id;
    const name = text(row?.name);
    if (isDoeSpGuid(id) && name) out.push({ id: id.toLowerCase(), name });
  }
  if (!out.length) throw invalid(code);
  return out;
}

export function findDoeSpNamed(items: DoeSpNamedRef[], wanted: string): DoeSpNamedRef | undefined {
  const target = asciiUpper(wanted);
  return items.find((item) => asciiUpper(item.name) === target);
}

// ---------------------------------------------------------------- summary

export interface DoeSpStructuredEntry { id: string; title: string; slug: string; path: string[] }

/**
 * v2/summary/structured: tree `items[] -> children[] -> publications[]`.
 * An empty day is `{ "items": [] }`.
 */
export function parseDoeSpStructured(body: unknown): DoeSpStructuredEntry[] {
  const items = record(body)?.items;
  if (!Array.isArray(items)) throw invalid('DOE_SP_INVALID_STRUCTURED_SUMMARY');
  const out: DoeSpStructuredEntry[] = [];
  const walk = (node: unknown, path: string[], depth: number): void => {
    if (depth > 16) throw invalid('DOE_SP_STRUCTURED_SUMMARY_TOO_DEEP');
    const row = record(node);
    if (!row) return;
    const name = text(row.name) ?? '';
    const here = [...path, name];
    if (Array.isArray(row.publications)) {
      for (const publication of row.publications) {
        const pub = record(publication);
        if (!pub || !isDoeSpGuid(pub.id)) continue;
        out.push({
          id: pub.id.toLowerCase(),
          title: text(pub.title) ?? '',
          slug: text(pub.slug) ?? '',
          path: here,
        });
      }
    }
    if (Array.isArray(row.children)) for (const child of row.children) walk(child, here, depth + 1);
  };
  for (const item of items) walk(item, [], 0);
  return out;
}

/** Order-independent fingerprint of the publication ids of a day. */
export function doeSpIdsHash(ids: Iterable<string>): string {
  const sorted = [...new Set([...ids].map((id) => id.toLowerCase()))].sort();
  return createHash('sha256').update(sorted.join('\n'), 'utf8').digest('hex');
}

export interface DoeSpListItem {
  id: string;
  publicationTypeId?: string;
  /** Raw timestamp from the source (local time, no offset). */
  date: string;
  title: string;
  slug: string;
  excerpt: string;
  hierarchy: string[];
  isLegacy: boolean;
}

export interface DoeSpMalformedItem { index: number; id?: string; reason: string }

/** v2/summary/list: `{ pages, pageSize, publications: [...] }` (whole day). */
export function parseDoeSpList(body: unknown): { items: DoeSpListItem[]; malformed: DoeSpMalformedItem[] } {
  const publications = record(body)?.publications;
  if (!Array.isArray(publications)) throw invalid('DOE_SP_INVALID_SUMMARY_LIST');
  const items: DoeSpListItem[] = [];
  const malformed: DoeSpMalformedItem[] = [];
  publications.forEach((value, index) => {
    const row = record(value);
    const id = row?.id;
    if (!row || !isDoeSpGuid(id)) {
      malformed.push({ index, reason: 'INVALID_ID' });
      return;
    }
    const title = text(row.title);
    const slug = text(row.slug);
    const hierarchy = text(row.hierarchy);
    const date = text(row.date);
    if (!title || !slug || !hierarchy || !date || !/^\d{4}-\d{2}-\d{2}T/.test(date)) {
      malformed.push({ index, id: id.toLowerCase(), reason: 'MISSING_REQUIRED_FIELD' });
      return;
    }
    items.push({
      id: id.toLowerCase(),
      ...(isDoeSpGuid(row.publicationTypeId) ? { publicationTypeId: row.publicationTypeId.toLowerCase() } : {}),
      date,
      title,
      slug,
      excerpt: text(row.excerpt) ?? '',
      hierarchy: hierarchy.split('>').map((part) => part.trim()).filter(Boolean),
      isLegacy: row.isLegacy === true,
    });
  });
  return { items, malformed };
}

/** v2/summary/filters: publication type catalogue of the day. */
export function parseDoeSpTypeCatalogue(body: unknown): Map<string, string> {
  const types = record(body)?.publicationTypes;
  if (!Array.isArray(types)) throw invalid('DOE_SP_INVALID_FILTERS');
  const map = new Map<string, string>();
  for (const value of types) {
    const row = record(value);
    const name = text(row?.name);
    if (isDoeSpGuid(row?.id) && name) map.set((row.id as string).toLowerCase(), name);
  }
  return map;
}

// ---------------------------------------------------------------- detail

export interface DoeSpAttachmentRef { id: string; name: string; position: number }

export interface DoeSpDetail {
  id: string;
  title: string;
  slug: string;
  /** Official DOE date of the edition (YYYY-MM-DD). */
  date: string;
  journal: string;
  firstLevelSectionName?: string;
  secondLevelSectionName?: string;
  section?: string;
  publicationType?: string;
  contentHtml: string;
  attachments: DoeSpAttachmentRef[];
  authCode?: string;
  editionPages: unknown[];
}

export function parseDoeSpDetail(body: unknown, expectedId: string): DoeSpDetail {
  const row = record(body);
  if (!row) throw invalid('DOE_SP_INVALID_PUBLICATION');
  const id = row.id;
  if (!isDoeSpGuid(id) || id.toLowerCase() !== expectedId.toLowerCase()) {
    throw invalid('DOE_SP_PUBLICATION_ID_MISMATCH', { expectedId });
  }
  const title = text(row.title);
  const slug = text(row.slug);
  const date = text(row.date);
  const journal = text(row.journal);
  if (!title || !slug || !date || !ISO_DATE.test(date) || !journal) {
    throw invalid('DOE_SP_PUBLICATION_MISSING_FIELDS', { id });
  }
  if (typeof row.content !== 'string') throw invalid('DOE_SP_PUBLICATION_WITHOUT_CONTENT', { id });

  const attachments: DoeSpAttachmentRef[] = [];
  if (Array.isArray(row.attachments)) {
    for (const value of row.attachments) {
      const item = record(value);
      const attachmentId = item?.id;
      const name = text(item?.name);
      if (!isDoeSpGuid(attachmentId) || !name) throw invalid('DOE_SP_INVALID_ATTACHMENT', { id });
      attachments.push({
        id: attachmentId.toLowerCase(),
        name,
        position: typeof item?.position === 'number' && Number.isSafeInteger(item.position) ? item.position : attachments.length,
      });
    }
  }
  attachments.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));

  const authCode = text(row.authCode);
  return {
    id: id.toLowerCase(),
    title,
    slug,
    date,
    journal,
    ...(text(row.firstLevelSectionName) ? { firstLevelSectionName: text(row.firstLevelSectionName)! } : {}),
    ...(text(row.secondLevelSectionName) ? { secondLevelSectionName: text(row.secondLevelSectionName)! } : {}),
    ...(text(row.section) ? { section: text(row.section)! } : {}),
    ...(text(row.publicationType) ? { publicationType: text(row.publicationType)! } : {}),
    contentHtml: row.content,
    attachments,
    ...(authCode && /^[0-9.]+$/.test(authCode) ? { authCode } : {}),
    editionPages: Array.isArray(row.editionPages) ? row.editionPages : [],
  };
}

/**
 * Plain text of the official HTML. `<head>` (the SEI `<title>`), `<style>`
 * and `<script>` are dropped; block elements become line breaks.
 */
export function doeSpHtmlText(html: string): string {
  let out = '';
  let hidden = 0;
  const hiddenTags = /^(head|title|style|script|noscript)$/;
  const blocks = /^(p|div|br|tr|li|h[1-6]|table|tbody|thead|blockquote|section|article)$/;
  const cells = /^(td|th)$/;
  const parser = new HtmlParser({
    onopentag(name) {
      if (hiddenTags.test(name)) hidden += 1;
      if (hidden) return;
      if (blocks.test(name)) out += '\n';
      else if (cells.test(name)) out += ' ';
    },
    // HTML whitespace semantics: source line breaks are not text breaks.
    ontext(value) { if (!hidden) out += value.replace(/[\s\u00a0]+/g, ' '); },
    onclosetag(name) {
      if (hiddenTags.test(name)) { hidden = Math.max(0, hidden - 1); return; }
      if (hidden) return;
      if (blocks.test(name)) out += '\n';
      else if (cells.test(name)) out += ' ';
    },
  }, { decodeEntities: true, lowerCaseTags: true });
  parser.end(html);
  return out
    .replace(/\r/g, '')
    .replace(/[\t \u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** First non-empty paragraph when it looks like an ementa (summary). */
export function doeSpEmenta(textContent: string): string | undefined {
  const first = textContent.split('\n').map((line) => line.trim()).find(Boolean);
  if (!first || first.length < 20 || first.length > 1_500) return undefined;
  const upper = asciiUpper(first);
  if (/^(O |A |OS |AS )?(GOVERNADOR|SECRETARI|SUBSECRETARI|DIRETOR|PROCURADOR|COORDENADOR|CHEFE|DELEGADO)/.test(upper)) return undefined;
  return /^(DISPOE|ALTERA|INSTITUI|ESTABELECE|DISCIPLINA|REGULAMENTA|DIVULGA|APROVA|INTRODUZ|ACRESCENTA|PRORROGA|REVOGA|DA NOVA|CONCEDE|AUTORIZA|FIXA|DEFINE|CRIA|DECLARA|OFICIALIZA|DESIGNA|RATIFICA|HOMOLOGA|TORNA|DETERMINA|RECONHECE|CONSOLIDA|EXTINGUE|REORGANIZA|ATUALIZA|IMPLEMENTA|PUBLICA|TRANSFERE|SUSPENDE|DISPENSA)/.test(upper)
    ? first
    : undefined;
}

// ---------------------------------------------------------------- editions

export interface DoeSpEditionStatus {
  editionId: string;
  editionName: string;
  publications: number;
  editionAuthCode?: string;
  status?: string;
  volume?: number;
  number?: number;
}

/** v1/editions/status/{date}; `null` body = 404 (no edition that day). */
export function parseDoeSpEditionStatus(body: unknown): DoeSpEditionStatus[] {
  if (body === null) return [];
  const editions = record(body)?.editionsProcessed;
  if (!Array.isArray(editions)) throw invalid('DOE_SP_INVALID_EDITION_STATUS');
  const out: DoeSpEditionStatus[] = [];
  for (const value of editions) {
    const row = record(value);
    const editionName = text(row?.editionName);
    if (!row || !isDoeSpGuid(row.editionId) || !editionName) continue;
    out.push({
      editionId: row.editionId.toLowerCase(),
      editionName,
      publications: typeof row.publications === 'number' ? row.publications : 0,
      ...(text(row.editionAuthCode) ? { editionAuthCode: text(row.editionAuthCode)! } : {}),
      ...(text(row.status) ? { status: text(row.status)! } : {}),
      ...(typeof row.volume === 'number' ? { volume: row.volume } : {}),
      ...(typeof row.number === 'number' ? { number: row.number } : {}),
    });
  }
  return out;
}

export interface DoeSpEditionFileRef { fileName: string; url: string; complementary?: boolean; status?: string }

/** v1/editions/url -> `{ fileName, url }`. */
export function parseDoeSpEditionUrl(body: unknown): DoeSpEditionFileRef | undefined {
  const row = record(body);
  const fileName = text(row?.fileName);
  const url = text(row?.url);
  if (!fileName || !url || !/^https?:\/\//.test(url)) return undefined;
  return { fileName, url };
}

/** v1/supplementary-editions/url -> `{ supplementaryEditionsUrls: [...] }`. */
export function parseDoeSpSupplementaryUrls(body: unknown): DoeSpEditionFileRef[] {
  const items = record(body)?.supplementaryEditionsUrls;
  if (!Array.isArray(items)) return [];
  const out: DoeSpEditionFileRef[] = [];
  for (const value of items) {
    const row = record(value);
    const fileName = text(row?.fileName);
    const url = text(row?.url);
    if (!fileName || !url || !/^https?:\/\//.test(url)) continue;
    const status = text(record(row?.status)?.name);
    out.push({
      fileName,
      url,
      ...(typeof row?.complementary === 'boolean' ? { complementary: row.complementary } : {}),
      ...(status ? { status } : {}),
    });
  }
  return out;
}
