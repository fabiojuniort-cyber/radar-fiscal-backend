import 'dotenv/config';

import { Pool } from 'pg';

import { RfbNormasClient } from '../modules/collection/rfb-normas.client.js';
import {
  buildRfbSearchUrl,
  decideRfbCapture,
  parseRfbSearchPage,
  type RfbNormasListingItem,
} from '../modules/collection/rfb-normas.parser.js';

const databaseUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_ADMIN_URL or DATABASE_URL is required.');

const sourceId = '4e9a40f1-9a12-4786-a816-5104cb252e3f';
const signal = new AbortController().signal;
const client = new RfbNormasClient();

function endOfMonth(year: number, monthIndex: number): Date {
  return new Date(Date.UTC(year, monthIndex + 1, 0));
}

const included = new Map<string, RfbNormasListingItem & { reason: string; category?: string }>();
let discovered = 0;
let pages = 0;

for (let monthIndex = 0; monthIndex < 8; monthIndex += 1) {
  const start = new Date(Date.UTC(2025, monthIndex, 1));
  const end = endOfMonth(2025, monthIndex);
  let page = 1;
  while (true) {
    const response = await client.getHtml(buildRfbSearchUrl({ start, end, page }), signal);
    const parsed = parseRfbSearchPage(response.html, page);
    pages += 1;
    discovered += parsed.items.length;
    for (const item of parsed.items) {
      const decision = decideRfbCapture(item);
      if (decision.included) {
        included.set(item.idAto, {
          ...item,
          reason: decision.reason,
          ...(decision.category ? { category: decision.category } : {}),
        });
      }
    }
    if (page >= parsed.totalPages) break;
    page += 1;
  }
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  const persisted = await pool.query(
    `SELECT external_id FROM publication_origins WHERE source_id = $1 AND external_id IS NOT NULL`,
    [sourceId],
  );
  const persistedIds = new Set(persisted.rows.map((row) => String(row.external_id)));
  const missing = [...included.values()]
    .filter((item) => !persistedIds.has(item.idAto))
    .map((item) => ({
      idAto: item.idAto,
      type: item.type,
      number: item.number,
      agency: item.agency,
      publishedOn: item.publishedAt.toISOString().slice(0, 10),
      abstract: item.abstract,
      category: item.category ?? null,
      reason: item.reason,
      detailUrl: item.detailUrl,
    }));
  console.log('RFB_NORMAS_BOOTSTRAP_AUDIT=' + JSON.stringify({
    period: '2025-01-01..2025-08-31',
    pages,
    discovered,
    included: included.size,
    persistedOriginsTotal: persistedIds.size,
    missingCount: missing.length,
    missing,
  }));
} finally {
  await pool.end();
}
