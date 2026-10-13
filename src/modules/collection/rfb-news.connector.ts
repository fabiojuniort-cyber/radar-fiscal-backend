import type {
  CollectionConnector,
  ConnectorNewsItem,
  ConnectorPartialFailure,
  ConnectorResult,
} from './connector.contract.js';
import { ConnectorError } from './connector.error.js';
import {
  RfbNewsClient,
  type RfbNewsClientOptions,
} from './rfb-news.client.js';
import {
  classifyRfbNewsRelevance,
} from './rfb-news.filter.js';
import {
  parseRfbNewsArticle,
  parseRfbNewsListing,
} from './rfb-news.parser.js';

export const RFB_NEWS_CONNECTOR_KEY = 'rfb-news';
const DEFAULT_MAX_ARTICLES_PER_RUN = 30;

export interface RfbNewsConnectorOptions {
  fetch?: typeof fetch;
  maxArticlesPerRun?: number;
  client?: Omit<RfbNewsClientOptions, 'fetch'>;
}

function resolveMaxArticles(value?: number): number {
  const raw = value ?? Number(
    process.env.RFB_NEWS_MAX_ARTICLES_PER_RUN ?? DEFAULT_MAX_ARTICLES_PER_RUN,
  );
  if (!Number.isSafeInteger(raw) || raw < 1 || raw > 100) {
    throw new RangeError('RFB_NEWS_MAX_ARTICLES_PER_RUN must be an integer between 1 and 100');
  }
  return raw;
}

function failureInfo(error: unknown): { code: string; message: string } {
  if (error instanceof ConnectorError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: 'RFB_NEWS_ARTICLE_PROCESSING_ERROR',
    message: error instanceof Error ? error.message : 'Unknown Receita Federal news error',
  };
}

export class RfbNewsConnector implements CollectionConnector {
  readonly key = RFB_NEWS_CONNECTOR_KEY;
  readonly version = '0.2.0';
  readonly #client: RfbNewsClient;
  readonly #maxArticlesPerRun: number;

  constructor(options: RfbNewsConnectorOptions = {}) {
    this.#client = new RfbNewsClient({
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.client ?? {}),
    });
    this.#maxArticlesPerRun = resolveMaxArticles(options.maxArticlesPerRun);
  }

  async collect(context: Parameters<CollectionConnector['collect']>[0]): Promise<ConnectorResult> {
    const listing = await this.#client.getListing(context.signal);
    const discovered = parseRfbNewsListing(listing.html, listing.url);
    const candidates = discovered.slice(0, this.#maxArticlesPerRun);
    const newsItems: ConnectorNewsItem[] = [];
    const partialFailures: ConnectorPartialFailure[] = [];

    let fetched = 0;
    let excluded = 0;
    let yielded = false;

    for (let index = 0; index < candidates.length; index += 1) {
      if (context.budget?.shouldYield()) {
        yielded = true;
        break;
      }

      const candidate = candidates[index]!;
      try {
        const detail = await this.#client.getHtml(candidate.url, context.signal);
        fetched += 1;
        const article = parseRfbNewsArticle(detail.html, detail.url);
        const relevance = classifyRfbNewsRelevance(article);

        if (!relevance.relevant) {
          excluded += 1;
          continue;
        }

        newsItems.push({
          title: article.title,
          ...(article.summary ? { summary: article.summary } : {}),
          ...(article.content ? { content: article.content } : {}),
          ...(article.category ? { category: article.category } : {}),
          ...(article.publishedAt ? { publishedAt: article.publishedAt } : {}),
          ...(article.updatedAt ? { updatedAtSource: article.updatedAt } : {}),
          officialUrl: article.url,
          agency: 'Receita Federal',
          tags: article.tags,
          metadata: {
            source: 'RFB_NEWS',
            ...(article.imageUrl ? { imageUrl: article.imageUrl } : {}),
            relevance: {
              reason: relevance.reason,
              matchedTerms: relevance.matchedTerms,
            },
            listingTitle: candidate.title,
            ...(detail.sourceEtag ? { sourceEtag: detail.sourceEtag } : {}),
            ...(detail.sourceLastModified
              ? { sourceLastModified: detail.sourceLastModified }
              : {}),
          },
        });
      } catch (error) {
        if (context.signal.aborted) throw error;
        const failure = failureInfo(error);
        partialFailures.push({
          code: failure.code,
          message: failure.message,
          itemReference: candidate.url,
        });
      }
    }

    const cappedPending = Math.max(0, discovered.length - candidates.length);
    const processedCandidates = fetched + partialFailures.length;
    const yieldedPending = yielded
      ? Math.max(0, candidates.length - processedCandidates)
      : 0;
    const pending = cappedPending + yieldedPending;

    return {
      publications: [],
      newsItems,
      ...(partialFailures.length ? { partialFailures } : {}),
      metadata: {
        source: 'RFB_NEWS',
        listingUrl: listing.url,
        discoveredCount: discovered.length,
        fetchedCount: fetched,
        includedCount: newsItems.length,
        excludedCount: excluded,
        failedCount: partialFailures.length,
        maxArticlesPerRun: this.#maxArticlesPerRun,
      },
      ...(pending > 0
        ? {
            completion: {
              complete: false,
              reason: yielded ? 'TIME_BUDGET_REACHED' : 'SOURCE_BUDGET_REACHED',
              pending: { articles: pending },
            },
          }
        : {}),
    };
  }
}
