import 'dotenv/config';

import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';

import {
  importNcmCatalog,
} from '../../modules/taxonomy/ncm/ncm-catalog.importer.js';
import {
  NCM_SOURCE_URL,
  parseNcmCatalogPayload,
} from '../../modules/taxonomy/ncm/ncm-catalog.source.js';

const envSchema = z.object({
  DATABASE_ADMIN_URL: z.string().min(1).optional(),
});

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function downloadSource(): Promise<{
  raw: string;
  parsed: ReturnType<typeof parseNcmCatalogPayload>;
  sourceSha256: string;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(NCM_SOURCE_URL, {
      headers: {
        accept: 'application/json',
        'user-agent': 'TriBusca-Radar-Fiscal/1.0',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`NCM_SOURCE_HTTP_${response.status}`);
    }

    const contentLength = Number(response.headers.get('content-length') ?? '0');
    if (contentLength > MAX_SOURCE_BYTES) {
      throw new Error(`NCM_SOURCE_TOO_LARGE:${contentLength}`);
    }

    const raw = await response.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_SOURCE_BYTES) {
      throw new Error(`NCM_SOURCE_TOO_LARGE:${Buffer.byteLength(raw, 'utf8')}`);
    }

    let json: unknown;
    try {
      json = JSON.parse(raw) as unknown;
    } catch {
      throw new Error('NCM_SOURCE_INVALID_JSON');
    }

    return {
      raw,
      parsed: parseNcmCatalogPayload(json),
      sourceSha256: sha256(raw),
    };
  } finally {
    clearTimeout(timeout);
  }
}

const isDryRun = process.argv.includes('--dry-run');
const downloaded = await downloadSource();

if (isDryRun) {
  console.log('NCM_CATALOG_DRY_RUN=' + JSON.stringify({
    ok: true,
    sourceUrl: NCM_SOURCE_URL,
    sourceSha256: downloaded.sourceSha256,
    sourceUpdatedOn: downloaded.parsed.sourceUpdatedOn,
    sourceUpdatedOnIso: downloaded.parsed.sourceUpdatedOnIso,
    totalEntries: downloaded.parsed.entries.length,
    assignableEntries: downloaded.parsed.assignableCount,
  }));
  process.exit(0);
}

const env = envSchema.parse(process.env);
if (!env.DATABASE_ADMIN_URL) {
  throw new Error('DATABASE_ADMIN_URL is required unless --dry-run is used.');
}

const pool = new Pool({
  connectionString: env.DATABASE_ADMIN_URL,
  max: 1,
});

try {
  const client = await pool.connect();
  try {
    const result = await importNcmCatalog(client, {
      sourceUrl: NCM_SOURCE_URL,
      sourceSha256: downloaded.sourceSha256,
      parsed: downloaded.parsed,
    });

    console.log('NCM_CATALOG_IMPORT=' + JSON.stringify({
      ok: true,
      ...result,
      sourceUpdatedOn: downloaded.parsed.sourceUpdatedOnIso,
      totalEntries: downloaded.parsed.entries.length,
    }));
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
