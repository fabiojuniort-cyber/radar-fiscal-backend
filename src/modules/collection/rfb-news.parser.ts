import { Parser } from 'htmlparser2';

const RFB_ORIGIN = 'https://www.gov.br';
const RFB_NEWS_PREFIX = '/receitafederal/pt-br/assuntos/noticias/';
const NON_VISIBLE_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg']);

export interface RfbNewsListingItem {
  title: string;
  url: string;
}

export interface RfbNewsArticle {
  title: string;
  summary?: string;
  content?: string;
  category?: string;
  publishedAt?: Date;
  updatedAt?: Date;
  imageUrl?: string;
  tags: string[];
  url: string;
}

function normalizeSpace(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function absoluteUrl(value: string, baseUrl: string): string | undefined {
  try {
    const url = new URL(value, baseUrl);
    if (url.origin !== RFB_ORIGIN) return undefined;
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function imageUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, baseUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function imageSourceFromAttributes(attributes: Record<string, string>): string | undefined {
  const direct =
    attributes.src ??
    attributes['data-src'] ??
    attributes['data-lazy-src'] ??
    attributes['data-original'];
  if (direct) return direct;

  const srcset = attributes.srcset ?? attributes['data-srcset'];
  if (!srcset) return undefined;
  const first = srcset.split(',')[0]?.trim().split(/\s+/)[0];
  return first || undefined;
}

function isArticleUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.origin !== RFB_ORIGIN) return false;
    if (!url.pathname.startsWith(RFB_NEWS_PREFIX)) return false;

    const rest = url.pathname.slice(RFB_NEWS_PREFIX.length);
    const parts = rest.split('/').filter(Boolean);
    return parts.length >= 3 && /^20\d{2}$/.test(parts[0] ?? '');
  } catch {
    return false;
  }
}

export function parseRfbNewsListing(
  html: string,
  pageUrl = `${RFB_ORIGIN}${RFB_NEWS_PREFIX}ultimas-noticias`,
): RfbNewsListingItem[] {
  const items = new Map<string, RfbNewsListingItem>();
  let anchorHref: string | undefined;
  let anchorText = '';
  let hiddenDepth = 0;

  const parser = new Parser({
    onopentag(name, attributes) {
      const tag = name.toLowerCase();
      if (NON_VISIBLE_TAGS.has(tag)) hiddenDepth += 1;

      if (tag === 'a' && hiddenDepth === 0) {
        anchorHref = attributes.href;
        anchorText = '';
      }
    },
    ontext(text) {
      if (hiddenDepth === 0 && anchorHref !== undefined) {
        anchorText += ` ${text}`;
      }
    },
    onclosetag(name) {
      const tag = name.toLowerCase();

      if (tag === 'a' && anchorHref !== undefined) {
        const url = absoluteUrl(anchorHref, pageUrl);
        const title = normalizeSpace(anchorText);
        if (url && title && isArticleUrl(url) && !items.has(url)) {
          items.set(url, { title, url });
        }
        anchorHref = undefined;
        anchorText = '';
      }

      if (NON_VISIBLE_TAGS.has(tag) && hiddenDepth > 0) hiddenDepth -= 1;
    },
  }, { decodeEntities: true });

  parser.write(html);
  parser.end();

  return [...items.values()];
}

function parseBrazilDateTime(value: string): Date | undefined {
  const match = /(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2})h(\d{2}))?/.exec(value);
  if (!match) return undefined;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const hour = Number(match[4] ?? '00');
  const minute = Number(match[5] ?? '00');
  if (
    month < 1 || month > 12 ||
    day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    hour < 0 || hour > 23 || minute < 0 || minute > 59
  ) return undefined;

  const date = new Date(
    `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00-03:00`,
  );
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function parseSourceDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const brazil = parseBrazilDateTime(value);
  if (brazil) return brazil;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function metaValue(
  meta: Map<string, string>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = meta.get(key.toLowerCase());
    if (value) return value;
  }
  return undefined;
}

function visibleTimestamp(text: string, label: 'Publicado' | 'Atualizado'): Date | undefined {
  const expression = new RegExp(
    `${label} em\\s+(\\d{2}\\/\\d{2}\\/\\d{4}(?:\\s+\\d{2}h\\d{2})?)`,
    'i',
  );
  return parseBrazilDateTime(expression.exec(text)?.[1] ?? '');
}

export function parseRfbNewsArticle(
  html: string,
  url: string,
): RfbNewsArticle {
  const meta = new Map<string, string>();
  const tags = new Set<string>();
  const pageText: string[] = [];
  const mainText: string[] = [];
  const h1Text: string[] = [];
  let hiddenDepth = 0;
  let mainDepth = 0;
  let h1Depth = 0;
  let tagAnchor = false;
  let tagAnchorText = '';
  let mainImageUrl: string | undefined;

  const parser = new Parser({
    onopentag(name, attributes) {
      const tag = name.toLowerCase();
      if (NON_VISIBLE_TAGS.has(tag)) hiddenDepth += 1;

      if (tag === 'main') mainDepth += 1;
      if (tag === 'h1' && mainDepth > 0) h1Depth += 1;

      if (tag === 'img' && mainDepth > 0 && !mainImageUrl) {
        mainImageUrl = imageUrl(imageSourceFromAttributes(attributes), url);
      }

      if (tag === 'meta') {
        const key = (
          attributes.property ??
          attributes.name ??
          attributes.itemprop ??
          ''
        ).trim().toLowerCase();
        const content = normalizeSpace(attributes.content ?? '');
        if (key && content && !meta.has(key)) meta.set(key, content);
      }

      if (tag === 'a') {
        const href = attributes.href ?? '';
        tagAnchor = /subject%3alist|subject:list|@@search\?subject/i.test(href);
        if (tagAnchor) tagAnchorText = '';
      }
    },
    ontext(text) {
      if (hiddenDepth > 0) return;
      pageText.push(text);
      if (mainDepth > 0) mainText.push(text);
      if (h1Depth > 0) h1Text.push(text);
      if (tagAnchor) tagAnchorText += ` ${text}`;
    },
    onclosetag(name) {
      const tag = name.toLowerCase();

      if (tag === 'a' && tagAnchor) {
        const value = normalizeSpace(tagAnchorText);
        if (value) tags.add(value);
        tagAnchor = false;
        tagAnchorText = '';
      }

      if (tag === 'h1' && h1Depth > 0) h1Depth -= 1;
      if (tag === 'main' && mainDepth > 0) mainDepth -= 1;
      if (NON_VISIBLE_TAGS.has(tag) && hiddenDepth > 0) hiddenDepth -= 1;
    },
  }, { decodeEntities: true });

  parser.write(html);
  parser.end();

  const visible = normalizeSpace(mainText.join(' '));
  const pageVisible = normalizeSpace(pageText.join(' '));
  const title = normalizeSpace(
    metaValue(meta, 'og:title', 'twitter:title', 'dc.title') ?? h1Text.join(' '),
  );
  if (!title) throw new Error('Receita Federal news article has no title.');

  const summary = normalizeSpace(
    metaValue(meta, 'og:description', 'twitter:description', 'description', 'dc.description') ?? '',
  ) || undefined;

  const publishedAt =
    parseSourceDate(metaValue(
      meta,
      'article:published_time',
      'dc.date',
      'dc.date.created',
      'dc.date.issued',
      'dcterms.created',
      'dcterms.issued',
      'datepublished',
    )) ??
    visibleTimestamp(pageVisible, 'Publicado');

  const updatedAt =
    parseSourceDate(metaValue(
      meta,
      'article:modified_time',
      'dcterms.modified',
      'dc.date.modified',
      'datemodified',
      'modified',
    )) ??
    visibleTimestamp(pageVisible, 'Atualizado');

  const keywordMeta = metaValue(meta, 'keywords', 'news_keywords');
  if (keywordMeta) {
    for (const tag of keywordMeta.split(/[,;|]/)) {
      const normalized = normalizeSpace(tag);
      if (normalized) tags.add(normalized);
    }
  }

  const category = normalizeSpace(
    metaValue(meta, 'article:section', 'section', 'dc.type') ?? '',
  ) || undefined;
  const articleImageUrl =
    imageUrl(metaValue(meta, 'og:image', 'twitter:image', 'twitter:image:src'), url) ??
    mainImageUrl;

  const content = visible || undefined;

  return {
    title,
    ...(summary ? { summary } : {}),
    ...(content ? { content } : {}),
    ...(category ? { category } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(articleImageUrl ? { imageUrl: articleImageUrl } : {}),
    tags: [...tags],
    url,
  };
}
