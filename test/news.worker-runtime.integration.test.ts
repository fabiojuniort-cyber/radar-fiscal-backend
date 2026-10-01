import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';

import type { DB } from '../src/infrastructure/database/database.types.js';
import { normalizeNewsItem } from '../src/modules/collection/news.normalizer.js';
import { persistNewsItem } from '../src/modules/collection/news.persistence.js';

function runtimeUrl(adminUrl: string, password: string): string {
  const url = new URL(adminUrl);
  url.username = 'radar_worker_runtime';
  url.password = password;
  return url.toString();
}

test('radar_worker_runtime persists NEWS while versions remain immutable', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  const workerPassword = process.env.DB_WORKER_RUNTIME_PASSWORD ?? process.env.DB_RUNTIME_PASSWORD;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required.');
  assert.ok(workerPassword, 'DB worker runtime password is required.');

  const adminDb = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: adminUrl, max: 1 }) }),
  });
  const workerDb = new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: runtimeUrl(adminUrl, workerPassword), max: 1 }),
    }),
  });

  const sourceId = randomUUID();
  const runId = randomUUID();
  const attemptId = randomUUID();
  const suffix = sourceId.slice(0, 8);

  try {
    await sql`
      INSERT INTO sources (
        id, code, name, jurisdiction_level, agency, base_url,
        connector_key, content_kind, schedule_timezone, max_attempts, is_active
      ) VALUES (
        ${sourceId}::uuid,
        ${`news-worker-${suffix}`},
        'NEWS worker runtime integration',
        'FEDERAL',
        'RFB',
        'https://www.gov.br/receitafederal/pt-br/assuntos/noticias',
        ${`news-worker-${suffix}`},
        'NEWS',
        'America/Sao_Paulo',
        1,
        TRUE
      )
    `.execute(adminDb);

    await sql`
      INSERT INTO collection_runs (
        id, source_id, scheduled_for, trigger_type, status,
        started_at, worker_id, locked_at, heartbeat_at
      ) VALUES (
        ${runId}::uuid,
        ${sourceId}::uuid,
        now() - interval '1 minute',
        'MANUAL',
        'RUNNING',
        now(),
        'news-worker-runtime-test',
        now(),
        now()
      )
    `.execute(adminDb);

    await sql`
      INSERT INTO collection_attempts (
        id, collection_run_id, attempt_no, status, connector_version
      ) VALUES (
        ${attemptId}::uuid,
        ${runId}::uuid,
        1,
        'RUNNING',
        'test'
      )
    `.execute(adminDb);

    const item = normalizeNewsItem({
      sourceId,
      item: {
        externalId: 'worker-runtime-news-1',
        title: 'Receita Federal publica orientação sobre CBS',
        summary: 'Teste de persistência pelo papel real do Worker.',
        content: 'Conteúdo tributário oficial para o teste de integração.',
        category: 'Tributação',
        publishedAt: new Date('2026-10-01T12:00:00Z'),
        officialUrl: 'https://www.gov.br/receitafederal/pt-br/assuntos/noticias/2026/outubro/worker-runtime-news-1',
        agency: 'Receita Federal',
        tags: ['CBS'],
      },
    });

    const first = await workerDb.transaction().execute((trx) =>
      persistNewsItem(trx, { sourceId, runId, attemptId, item }),
    );
    assert.equal(first.disposition, 'NEW_NEWS_ITEM');

    const replay = await workerDb.transaction().execute((trx) =>
      persistNewsItem(trx, { sourceId, runId, attemptId, item }),
    );
    assert.equal(replay.disposition, 'EXISTING_NEWS_ITEM');
    assert.equal(replay.newsVersionId, first.newsVersionId);

    const versions = await sql<{ count: number }>`
      SELECT count(*)::int AS count
      FROM news_item_versions
      WHERE news_item_id = ${first.newsItemId}::uuid
    `.execute(adminDb);
    assert.equal(versions.rows[0]?.count, 1);

    await assert.rejects(
      () => sql`
        UPDATE news_item_versions
        SET title = title
        WHERE id = ${first.newsVersionId}::uuid
      `.execute(workerDb),
      (error: unknown) =>
        Boolean(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          (error as { code?: string }).code === '42501',
        ),
    );
  } finally {
    await sql`DELETE FROM collection_runs WHERE source_id = ${sourceId}::uuid`.execute(adminDb);
    await sql`
      DELETE FROM news_item_versions
      WHERE news_item_id IN (
        SELECT id FROM news_items WHERE source_id = ${sourceId}::uuid
      )
    `.execute(adminDb);
    await sql`DELETE FROM news_items WHERE source_id = ${sourceId}::uuid`.execute(adminDb);
    await sql`DELETE FROM sources WHERE id = ${sourceId}::uuid`.execute(adminDb);
    await workerDb.destroy();
    await adminDb.destroy();
  }
});
