import { sql, type Transaction } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';
import type { NormalizedNewsItem } from './news.normalizer.js';

export type NewsDisposition =
  | 'NEW_NEWS_ITEM'
  | 'EXISTING_NEWS_ITEM'
  | 'NEW_NEWS_VERSION';

export interface PersistNewsItemInput {
  sourceId: string;
  runId: string;
  attemptId: string;
  item: NormalizedNewsItem;
}

export interface PersistNewsItemResult {
  newsItemId: string;
  newsVersionId: string;
  disposition: NewsDisposition;
}

function itemStatus(disposition: NewsDisposition):
  | 'PROCESSED_NEW'
  | 'PROCESSED_EXISTING'
  | 'NEW_VERSION' {
  if (disposition === 'NEW_NEWS_ITEM') return 'PROCESSED_NEW';
  if (disposition === 'NEW_NEWS_VERSION') return 'NEW_VERSION';
  return 'PROCESSED_EXISTING';
}

async function upsertCollectionItem(
  trx: Transaction<DB>,
  input: PersistNewsItemInput,
  newsItemId: string,
  disposition: NewsDisposition,
): Promise<void> {
  const metadata = JSON.stringify(input.item.metadata);
  await sql`
    INSERT INTO collection_items (
      collection_run_id,
      first_attempt_id,
      source_item_key,
      external_id,
      source_url,
      status,
      publication_id,
      raw_metadata,
      content_kind,
      news_item_id
    ) VALUES (
      ${input.runId}::uuid,
      ${input.attemptId}::uuid,
      ${input.item.sourceItemKey},
      ${input.item.externalId ?? null},
      ${input.item.officialUrl},
      ${itemStatus(disposition)},
      NULL,
      ${metadata}::jsonb,
      'NEWS',
      ${newsItemId}::uuid
    )
    ON CONFLICT (collection_run_id, source_item_key)
    DO UPDATE SET
      external_id = EXCLUDED.external_id,
      source_url = EXCLUDED.source_url,
      status = EXCLUDED.status,
      publication_id = NULL,
      raw_metadata = EXCLUDED.raw_metadata,
      content_kind = 'NEWS',
      news_item_id = EXCLUDED.news_item_id,
      error_code = NULL,
      error_message = NULL,
      updated_at = now()
  `.execute(trx);
}

async function getOrCreateNewsItem(
  trx: Transaction<DB>,
  input: PersistNewsItemInput,
): Promise<{ id: string; inserted: boolean }> {
  const inserted = await sql<{ id: string }>`
    INSERT INTO news_items (
      source_id,
      identity_hash,
      external_id,
      agency,
      official_url
    ) VALUES (
      ${input.sourceId}::uuid,
      ${input.item.identityHash},
      ${input.item.externalId ?? null},
      ${input.item.agency ?? null},
      ${input.item.officialUrl}
    )
    ON CONFLICT (source_id, identity_hash) DO NOTHING
    RETURNING id
  `.execute(trx);

  const created = inserted.rows[0];
  if (created) return { id: created.id, inserted: true };

  const existing = await sql<{ id: string }>`
    SELECT id
    FROM news_items
    WHERE source_id = ${input.sourceId}::uuid
      AND identity_hash = ${input.item.identityHash}
    FOR UPDATE
  `.execute(trx);

  const row = existing.rows[0];
  if (!row) {
    throw new Error('News identity could not be resolved after insert conflict.');
  }

  await sql`
    UPDATE news_items
    SET
      external_id = COALESCE(${input.item.externalId ?? null}, external_id),
      agency = COALESCE(${input.item.agency ?? null}, agency),
      official_url = ${input.item.officialUrl},
      last_seen_at = now(),
      updated_at = now()
    WHERE id = ${row.id}::uuid
  `.execute(trx);

  return { id: row.id, inserted: false };
}

async function latestVersion(
  trx: Transaction<DB>,
  newsItemId: string,
): Promise<{ id: string; versionNo: number; contentHash: string } | undefined> {
  const result = await sql<{
    id: string;
    version_no: number;
    content_hash: string;
  }>`
    SELECT id, version_no, content_hash
    FROM news_item_versions
    WHERE news_item_id = ${newsItemId}::uuid
    ORDER BY version_no DESC
    LIMIT 1
    FOR UPDATE
  `.execute(trx);

  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        versionNo: row.version_no,
        contentHash: row.content_hash,
      }
    : undefined;
}

async function insertVersion(
  trx: Transaction<DB>,
  input: PersistNewsItemInput,
  newsItemId: string,
  versionNo: number,
): Promise<string> {
  const metadata = JSON.stringify(input.item.metadata);
  const result = await sql<{ id: string }>`
    INSERT INTO news_item_versions (
      news_item_id,
      version_no,
      content_hash,
      title,
      summary,
      content,
      category,
      published_at,
      updated_at_source,
      official_url,
      tags,
      source_metadata
    ) VALUES (
      ${newsItemId}::uuid,
      ${versionNo},
      ${input.item.contentHash},
      ${input.item.title},
      ${input.item.summary ?? null},
      ${input.item.content ?? null},
      ${input.item.category ?? null},
      ${input.item.publishedAt ?? null},
      ${input.item.updatedAtSource ?? null},
      ${input.item.officialUrl},
      ${input.item.tags}::text[],
      ${metadata}::jsonb
    )
    RETURNING id
  `.execute(trx);

  const row = result.rows[0];
  if (!row) throw new Error('News version insert returned no id.');
  return row.id;
}

export async function persistNewsItem(
  trx: Transaction<DB>,
  input: PersistNewsItemInput,
): Promise<PersistNewsItemResult> {
  const item = await getOrCreateNewsItem(trx, input);
  const current = await latestVersion(trx, item.id);

  if (current?.contentHash === input.item.contentHash) {
    await upsertCollectionItem(
      trx,
      input,
      item.id,
      'EXISTING_NEWS_ITEM',
    );

    return {
      newsItemId: item.id,
      newsVersionId: current.id,
      disposition: 'EXISTING_NEWS_ITEM',
    };
  }

  const versionNo = (current?.versionNo ?? 0) + 1;
  const newsVersionId = await insertVersion(
    trx,
    input,
    item.id,
    versionNo,
  );
  const disposition: NewsDisposition = item.inserted
    ? 'NEW_NEWS_ITEM'
    : 'NEW_NEWS_VERSION';

  await upsertCollectionItem(
    trx,
    input,
    item.id,
    disposition,
  );

  return {
    newsItemId: item.id,
    newsVersionId,
    disposition,
  };
}

export async function recordNewsCollectionItemFailure(
  trx: Transaction<DB>,
  input: {
    runId: string;
    attemptId: string;
    sourceItemKey: string;
    externalId?: string;
    sourceUrl?: string;
    metadata?: Record<string, unknown>;
    errorCode: string;
    errorMessage: string;
  },
): Promise<void> {
  const metadata = JSON.stringify(input.metadata ?? {});
  await sql`
    INSERT INTO collection_items (
      collection_run_id,
      first_attempt_id,
      source_item_key,
      external_id,
      source_url,
      status,
      publication_id,
      raw_metadata,
      content_kind,
      news_item_id,
      error_code,
      error_message
    ) VALUES (
      ${input.runId}::uuid,
      ${input.attemptId}::uuid,
      ${input.sourceItemKey},
      ${input.externalId ?? null},
      ${input.sourceUrl ?? null},
      'FAILED',
      NULL,
      ${metadata}::jsonb,
      'NEWS',
      NULL,
      ${input.errorCode},
      ${input.errorMessage}
    )
    ON CONFLICT (collection_run_id, source_item_key)
    DO UPDATE SET
      external_id = EXCLUDED.external_id,
      source_url = EXCLUDED.source_url,
      status = 'FAILED',
      publication_id = NULL,
      news_item_id = NULL,
      raw_metadata = EXCLUDED.raw_metadata,
      content_kind = 'NEWS',
      error_code = EXCLUDED.error_code,
      error_message = EXCLUDED.error_message,
      updated_at = now()
  `.execute(trx);
}
