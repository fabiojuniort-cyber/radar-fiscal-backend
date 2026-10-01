import { createHash } from 'node:crypto';

import type { ConnectorNewsItem } from './connector.contract.js';

export interface NormalizedNewsItem {
  title: string;
  summary?: string;
  content?: string;
  category?: string;
  publishedAt?: Date;
  updatedAtSource?: Date;
  officialUrl: string;
  externalId?: string;
  agency?: string;
  tags: string[];
  metadata: Record<string, unknown>;
  sourceItemKey: string;
  identityHash: string;
  contentHash: string;
}

function normalizeSpace(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function optionalText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizeSpace(value);
  return normalized || undefined;
}

function canonicalOfficialUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('News official URL must use HTTP or HTTPS.');
  }

  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (
      key.toLowerCase().startsWith('utm_') ||
      ['fbclid', 'gclid', 'trk'].includes(key.toLowerCase())
    ) {
      url.searchParams.delete(key);
    }
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString();
}

function canonicalImageUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function stableTags(tags: string[] | undefined): string[] {
  const values = (tags ?? [])
    .map(normalizeSpace)
    .filter(Boolean);

  return [...new Set(values)].sort((a, b) =>
    a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }),
  );
}

function validDate(value: Date | undefined, field: string): Date | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value.getTime())) {
    throw new Error(`Invalid news ${field}.`);
  }
  return value;
}

export function normalizeNewsItem(input: {
  sourceId: string;
  item: ConnectorNewsItem;
}): NormalizedNewsItem {
  const title = normalizeSpace(input.item.title);
  if (!title) throw new Error('News title is required.');

  const officialUrl = canonicalOfficialUrl(input.item.officialUrl);
  const externalId = optionalText(input.item.externalId);
  const summary = optionalText(input.item.summary);
  const content = optionalText(input.item.content);
  const category = optionalText(input.item.category);
  const agency = optionalText(input.item.agency);
  const publishedAt = validDate(input.item.publishedAt, 'publishedAt');
  const updatedAtSource = validDate(input.item.updatedAtSource, 'updatedAtSource');
  const tags = stableTags(input.item.tags);
  const metadata: Record<string, unknown> = { ...(input.item.metadata ?? {}) };
  const imageUrl = canonicalImageUrl(metadata.imageUrl);
  if (imageUrl) metadata.imageUrl = imageUrl;
  else delete metadata.imageUrl;

  const sourceIdentity = externalId
    ? `external:${externalId}`
    : `url:${officialUrl}`;
  const identityHash = createHash('sha256')
    .update(`${input.sourceId}\n${sourceIdentity}`, 'utf8')
    .digest('hex');

  const semanticContent: Record<string, unknown> = {
    version: 1,
    title,
    summary: summary ?? null,
    content: content ?? null,
    category: category ?? null,
    publishedAt: publishedAt?.toISOString() ?? null,
    updatedAtSource: updatedAtSource?.toISOString() ?? null,
    tags,
  };
  if (imageUrl) semanticContent.imageUrl = imageUrl;

  const contentHash = createHash('sha256')
    .update(JSON.stringify(semanticContent), 'utf8')
    .digest('hex');

  return {
    title,
    ...(summary ? { summary } : {}),
    ...(content ? { content } : {}),
    ...(category ? { category } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(updatedAtSource ? { updatedAtSource } : {}),
    officialUrl,
    ...(externalId ? { externalId } : {}),
    ...(agency ? { agency } : {}),
    tags,
    metadata,
    sourceItemKey: externalId ?? officialUrl,
    identityHash,
    contentHash,
  };
}
