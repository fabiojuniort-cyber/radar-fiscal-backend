import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import type { DB } from '../src/infrastructure/database/database.types.js';
import { readCollectionDiagnostics } from '../src/modules/operations/collection-diagnostics.js';

test('collection diagnostics groups item failures and resolves the linked identity of an origin conflict', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required for collection diagnostics integration tests.');

  const pool = new Pool({ connectionString: adminUrl, max: 2 });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  const suffix = randomUUID().slice(0, 8);
  let sourceId: string | undefined;
  let publicationId: string | undefined;

  try {
    sourceId = (await db.insertInto('sources').values({
      code: `diag-${suffix}`,
      name: 'diag',
      jurisdiction_level: 'FEDERAL',
      base_url: 'https://diag.example.test',
      connector_key: `diag-${suffix}`,
    }).returning('id').executeTakeFirstOrThrow()).id;

    publicationId = (await db.insertInto('publications').values({
      title: 'Arquivos XSD versão 1.2.0',
      jurisdiction_level: 'FEDERAL',
      act_type: 'PACOTE TÉCNICO',
      identity_strength: 'SOURCE_SCOPED',
      identity_basis: { version: 1, scope: 'FEDERAL', sourceKeyType: 'CANONICAL_KEY', sourceKey: 'old-key' },
      identity_hash: `diag-${suffix}`.padEnd(64, '0'),
    }).returning('id').executeTakeFirstOrThrow()).id;

    await db.insertInto('publication_origins').values({
      publication_id: publicationId,
      source_id: sourceId,
      external_id: `govbr:/xsd-${suffix}.zip`,
      official_url: `https://diag.example.test/xsd-${suffix}.zip`,
    }).execute();

    const runs: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const run = await db.insertInto('collection_runs').values({
        source_id: sourceId,
        scheduled_for: new Date(Date.now() - (i + 1) * 3_600_000),
        status: 'PARTIAL_SUCCESS',
        finished_at: new Date(Date.now() - i * 3_600_000),
      }).returning('id').executeTakeFirstOrThrow();
      runs.push(run.id);
      await db.insertInto('collection_items').values({
        collection_run_id: run.id,
        source_item_key: `govbr:/xsd-${suffix}.zip`,
        external_id: `govbr:/xsd-${suffix}.zip`,
        status: 'FAILED',
        error_code: 'PublicationOriginConflictError',
        error_message: 'Publication origin is already linked to another publication identity.',
        raw_metadata: { module: 'DERE', documentKind: 'SCHEMA', identityVersion: 3, body: 'must not leak' },
      }).execute();
    }

    const diagnostics = await readCollectionDiagnostics(db, 48);

    const group = diagnostics.itemFailures.find((item) => item.sourceCode === `diag-${suffix}`);
    assert.ok(group);
    assert.equal(group.failures, 3);
    assert.equal(group.distinctItems, 1);

    const conflict = diagnostics.originConflicts.find((item) => item.sourceCode === `diag-${suffix}`);
    assert.ok(conflict);
    assert.equal(conflict.linkedPublication?.id, publicationId);
    assert.deepEqual(conflict.linkedPublication?.identityBasis, {
      version: 1, scope: 'FEDERAL', sourceKeyType: 'CANONICAL_KEY', sourceKey: 'old-key',
    });
    assert.deepEqual(conflict.failedItemMetadata, { module: 'DERE', documentKind: 'SCHEMA', identityVersion: 3 });
  } finally {
    if (sourceId) {
      await db.deleteFrom('collection_runs').where('source_id', '=', sourceId).execute();
      await db.deleteFrom('publication_origins').where('source_id', '=', sourceId).execute();
    }
    if (publicationId) await db.deleteFrom('publications').where('id', '=', publicationId).execute();
    if (sourceId) await db.deleteFrom('sources').where('id', '=', sourceId).execute();
    await db.destroy();
  }
});
