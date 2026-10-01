import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  Kysely,
  PostgresDialect,
  sql,
} from 'kysely';
import { Pool } from 'pg';

import type { DB } from '../src/infrastructure/database/database.types.js';
import {
  acquireNextCollectionRun,
  createCollectionRun,
} from '../src/modules/collection/collection-run.repository.js';
import { processAcquiredCollectionRun } from '../src/modules/collection/collection.engine.js';
import { ConnectorRegistry } from '../src/modules/collection/connector.registry.js';

async function runNewsCollection(
  db: Kysely<DB>,
  registry: ConnectorRegistry,
  sourceId: string,
  scheduledFor: Date,
) {
  const runId = await createCollectionRun(db, {
    sourceId,
    scheduledFor,
    triggerType: 'MANUAL',
  });

  const acquired = await acquireNextCollectionRun(
    db,
    `news-test-worker-${runId}`,
  );
  assert.ok(acquired, 'news run must be acquirable');
  assert.equal(acquired.id, runId);

  const result = await processAcquiredCollectionRun(
    db,
    registry,
    acquired,
    {
      timeoutMs: 5_000,
      heartbeatIntervalMs: 0,
    },
  );

  return { runId, result };
}

test('news collection is isolated from publications, idempotent on replay and versions real changes', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required for news integration tests.');

  const pool = new Pool({ connectionString: adminUrl, max: 2 });
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
  });

  const sourceId = randomUUID();
  const connectorKey = `news-integration-${sourceId}`;
  const sourceCode = `news-integration-${sourceId}`;
  const registry = new ConnectorRegistry();
  let revision = 1;
  const runIds: string[] = [];

  registry.register({
    key: connectorKey,
    version: '1',
    async collect() {
      return {
        publications: [],
        newsItems: [
          {
            externalId: 'rfb-news-1',
            title: 'Receita Federal publica orientação sobre CBS',
            summary: revision === 1
              ? 'Resumo original sobre a CBS.'
              : 'Resumo atualizado sobre a CBS.',
            content: revision === 1
              ? 'Conteúdo oficial original.'
              : 'Conteúdo oficial atualizado.',
            category: 'Tributação',
            publishedAt: new Date('2026-10-01T12:00:00Z'),
            officialUrl: 'https://www.gov.br/receitafederal/pt-br/assuntos/noticias/2026/outubro/noticia-cbs',
            agency: 'Receita Federal',
            tags: ['CBS', 'RTC'],
            metadata: { relevance: 'TAX' },
          },
        ],
      };
    },
  });

  try {
    await sql`
      INSERT INTO sources (
        id, code, name, jurisdiction_level, agency, base_url,
        connector_key, content_kind, schedule_timezone, max_attempts, is_active
      ) VALUES (
        ${sourceId}::uuid,
        ${sourceCode},
        'News integration test',
        'FEDERAL',
        'RFB',
        'https://www.gov.br/receitafederal/pt-br/assuntos/noticias',
        ${connectorKey},
        'NEWS',
        'America/Sao_Paulo',
        1,
        TRUE
      )
    `.execute(db);

    const first = await runNewsCollection(
      db,
      registry,
      sourceId,
      new Date('2026-10-01T13:00:00Z'),
    );
    runIds.push(first.runId);

    assert.equal(first.result.status, 'SUCCESS');
    assert.equal(first.result.metrics.found, 1);
    assert.equal(first.result.metrics.processed, 1);
    assert.equal(first.result.metrics.newPublications, 0);
    assert.equal(first.result.metrics.newVersions, 0);

    const firstState = await sql<{
      news_items: number;
      news_versions: number;
      publications: number;
      item_kind: string;
      item_status: string;
    }>`
      SELECT
        (SELECT count(*)::int FROM news_items WHERE source_id = ${sourceId}::uuid) AS news_items,
        (SELECT count(*)::int FROM news_item_versions niv JOIN news_items ni ON ni.id = niv.news_item_id WHERE ni.source_id = ${sourceId}::uuid) AS news_versions,
        (SELECT count(*)::int FROM publication_origins WHERE source_id = ${sourceId}::uuid) AS publications,
        ci.content_kind AS item_kind,
        ci.status AS item_status
      FROM collection_items ci
      WHERE ci.collection_run_id = ${first.runId}::uuid
    `.execute(db);

    assert.deepEqual(firstState.rows[0], {
      news_items: 1,
      news_versions: 1,
      publications: 0,
      item_kind: 'NEWS',
      item_status: 'PROCESSED_NEW',
    });

    const replay = await runNewsCollection(
      db,
      registry,
      sourceId,
      new Date('2026-10-01T14:00:00Z'),
    );
    runIds.push(replay.runId);

    assert.equal(replay.result.status, 'SUCCESS');
    const replayVersions = await sql<{ count: number }>`
      SELECT count(*)::int AS count
      FROM news_item_versions niv
      JOIN news_items ni ON ni.id = niv.news_item_id
      WHERE ni.source_id = ${sourceId}::uuid
    `.execute(db);
    assert.equal(replayVersions.rows[0]?.count, 1);

    revision = 2;
    const changed = await runNewsCollection(
      db,
      registry,
      sourceId,
      new Date('2026-10-01T15:00:00Z'),
    );
    runIds.push(changed.runId);

    assert.equal(changed.result.status, 'SUCCESS');
    const changedState = await sql<{
      count: number;
      status: string;
    }>`
      SELECT
        (SELECT count(*)::int
         FROM news_item_versions niv
         JOIN news_items ni ON ni.id = niv.news_item_id
         WHERE ni.source_id = ${sourceId}::uuid) AS count,
        ci.status
      FROM collection_items ci
      WHERE ci.collection_run_id = ${changed.runId}::uuid
    `.execute(db);

    assert.deepEqual(changedState.rows[0], {
      count: 2,
      status: 'NEW_VERSION',
    });
  } finally {
    if (runIds.length > 0) {
      await db
        .deleteFrom('collection_runs')
        .where('id', 'in', runIds)
        .execute();
    }

    await sql`
      DELETE FROM news_item_versions
      WHERE news_item_id IN (
        SELECT id FROM news_items WHERE source_id = ${sourceId}::uuid
      )
    `.execute(db);
    await sql`DELETE FROM news_items WHERE source_id = ${sourceId}::uuid`.execute(db);
    await db.deleteFrom('sources').where('id', '=', sourceId).execute();
    await db.destroy();
  }
});
