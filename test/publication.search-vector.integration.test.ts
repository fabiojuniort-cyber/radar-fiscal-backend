import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';

import type { DB } from '../src/infrastructure/database/database.types.js';
import { normalizePublication } from '../src/modules/collection/publication.normalizer.js';
import { persistPublication } from '../src/modules/collection/publication.persistence.js';

test('publication persistence keeps content above 1 MiB while search_vector remains searchable', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required for collection integration tests.');

  const pool = new Pool({ connectionString: adminUrl, max: 2 });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

  const sourceId = randomUUID();
  const runId = randomUUID();
  const attemptId = randomUUID();
  const middle = 'conteudo-intermediario '.repeat(60_000);
  const content = 'CABECALHO TRIBUTARIO IBS CBS. ' + middle + ' RODAPE ICMS ISSQN.';
  let publicationId: string | undefined;

  assert.ok(Buffer.byteLength(content, 'utf8') > 1_048_575);

  try {
    await db.insertInto('sources').values({
      id: sourceId,
      code: `search-vector-large-${sourceId}`,
      name: 'Oversized search-vector integration source',
      jurisdiction_level: 'STATE',
      uf: 'SP',
      base_url: 'https://example.test',
      connector_key: `search-vector-large-${sourceId}`,
    }).execute();

    await db.insertInto('collection_runs').values({
      id: runId,
      source_id: sourceId,
      scheduled_for: new Date('2026-09-25T00:00:00Z'),
      trigger_type: 'MANUAL',
    }).execute();

    await db.insertInto('collection_attempts').values({
      id: attemptId,
      collection_run_id: runId,
      attempt_no: 1,
      status: 'RUNNING',
    }).execute();

    const normalized = normalizePublication({
      sourceId,
      publication: {
        title: 'Comunicado com conteúdo integral extenso',
        agency: 'SEFAZ/SP',
        sphere: 'STATE',
        stateCode: 'SP',
        actType: 'COMUNICADO',
        publishedAt: new Date('2025-02-05T00:00:00Z'),
        content,
        officialUrl: 'https://example.test/large-act',
        externalId: 'large-act',
        metadata: { sourceRole: 'PRIMARY' },
      },
    });

    const persisted = await db.transaction().execute((trx) =>
      persistPublication(trx, {
        sourceId,
        runId,
        attemptId,
        publication: normalized,
      }),
    );
    publicationId = persisted.publicationId;

    const row = await db
      .selectFrom('publication_versions')
      .select([
        'content_text',
        sql<number>`octet_length(content_text)`.as('content_bytes'),
        sql<boolean>`search_vector @@ plainto_tsquery('portuguese'::regconfig, 'tributario')`.as('head_match'),
        sql<boolean>`search_vector @@ plainto_tsquery('portuguese'::regconfig, 'icms')`.as('tail_match'),
      ])
      .where('id', '=', persisted.publicationVersionId)
      .executeTakeFirstOrThrow();

    assert.equal(row.content_text, content);
    assert.ok(Number(row.content_bytes) > 1_048_575);
    assert.equal(row.head_match, true);
    assert.equal(row.tail_match, true);
  } finally {
    await db.deleteFrom('collection_runs').where('id', '=', runId).execute();
    await db.deleteFrom('publication_origins').where('source_id', '=', sourceId).execute();
    if (publicationId) {
      await db.deleteFrom('publications').where('id', '=', publicationId).execute();
    }
    await db.deleteFrom('sources').where('id', '=', sourceId).execute();
    await db.destroy();
  }
});
