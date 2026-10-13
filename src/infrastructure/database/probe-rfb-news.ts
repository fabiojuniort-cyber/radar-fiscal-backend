import { RfbNewsClient } from '../../modules/collection/rfb-news.client.js';
import { classifyRfbNewsRelevance } from '../../modules/collection/rfb-news.filter.js';
import {
  parseRfbNewsArticle,
  parseRfbNewsListing,
} from '../../modules/collection/rfb-news.parser.js';

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 45_000);
timeout.unref();

try {
  const client = new RfbNewsClient({ timeoutMs: 20_000 });
  const listing = await client.getListing(controller.signal);
  const items = parseRfbNewsListing(listing.html, listing.url);

  if (items.length === 0) {
    throw new Error('RFB_NEWS_PROBE_NO_ARTICLES_DISCOVERED');
  }

  let parsed = 0;
  let relevant = 0;
  const samples: Array<{
    title: string;
    url: string;
    relevant: boolean;
    reason: string;
  }> = [];
  const failures: Array<{ url: string; error: string }> = [];

  for (const item of items.slice(0, 5)) {
    try {
      const detail = await client.getHtml(item.url, controller.signal);
      const article = parseRfbNewsArticle(detail.html, detail.url);
      const decision = classifyRfbNewsRelevance(article);
      parsed += 1;
      if (decision.relevant) relevant += 1;
      samples.push({
        title: article.title,
        url: article.url,
        relevant: decision.relevant,
        reason: decision.reason,
      });
    } catch (error) {
      failures.push({
        url: item.url,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  if (parsed === 0) {
    throw new Error('RFB_NEWS_PROBE_NO_ARTICLE_PARSED');
  }

  console.log('RFB_NEWS_PROBE=' + JSON.stringify({
    ok: true,
    listingUrl: listing.url,
    discovered: items.length,
    attempted: Math.min(items.length, 5),
    parsed,
    relevant,
    failures,
    samples,
  }));
} finally {
  clearTimeout(timeout);
}
