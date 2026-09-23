import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import type { DB } from '../src/infrastructure/database/database.types.js';
import { executeSpedSanitization, planSpedSanitization } from '../src/infrastructure/database/sped-sanitization.js';
import { acquireNextCollectionRun, createCollectionRun } from '../src/modules/collection/collection-run.repository.js';
import { processAcquiredCollectionRun } from '../src/modules/collection/collection.engine.js';
import { ConnectorRegistry } from '../src/modules/collection/connector.registry.js';
import { SpedConnector } from '../src/modules/collection/sped.connector.js';
import { readSpedSourceState } from '../src/modules/collection/sped-source-state.repository.js';
import { fakePortal, productionLikeInventory } from './sped.govbr.fixtures.js';

test('controlled SPED sanitization: dry-run, safety blockers, execution preserving runs/attempts, then clean re-bootstrap', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl);
  const pool = new Pool({ connectionString: adminUrl, max: 3 });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  const sourceId = randomUUID();
  const otherSourceId = randomUUID();
  const code = 'sped-sanitize-' + sourceId.slice(0, 8);
  const portal = fakePortal(productionLikeInventory());
  let sequence = 0;
  let otherPublicationId: string | undefined;

  const registry = new ConnectorRegistry();
  registry.register(new SpedConnector({
    fetch: portal.fetch,
    readState: (source) => readSpedSourceState(db, source),
    now: () => new Date('2026-09-23T03:00:00Z'),
  }));
  const run = async () => {
    await createCollectionRun(db, { sourceId, scheduledFor: new Date(Date.now() - 60_000 + sequence++), triggerType: 'MANUAL' });
    const acquired = await acquireNextCollectionRun(db, 'sanitize-' + sourceId);
    assert.ok(acquired);
    return processAcquiredCollectionRun(db, registry, acquired, { timeoutMs: 20_000, heartbeatIntervalMs: 0 });
  };

  try {
    for (const [id, sourceCode] of [[sourceId, code], [otherSourceId, code + '-other']] as const) {
      await db.insertInto('sources').values({
        id,
        code: sourceCode,
        name: 'sanitization test ' + sourceCode,
        jurisdiction_level: 'FEDERAL',
        base_url: 'https://www.gov.br/sped/pt-br/',
        connector_key: id === sourceId ? 'sped' : 'confaz',
        max_attempts: 1,
      }).execute();
    }

    await run();
    await run();

    const client = await pool.connect();
    try {
      // Dry-run.
      const plan = await planSpedSanitization(client, code);
      assert.deepEqual(plan.blockers, []);
      assert.equal(plan.counts.publications, 13);
      assert.equal(plan.counts.publicationOrigins, 14);
      assert.equal(plan.counts.publicationVersions, 13);
      assert.equal(plan.counts.runsPreserved, 2);
      assert.equal(plan.sharedWithOtherSources.length, 0);

      // Safety: a publication shared with another source blocks the operation.
      const shared = await db.selectFrom('publication_origins').select('publication_id').where('source_id', '=', sourceId).limit(1).executeTakeFirstOrThrow();
      otherPublicationId = shared.publication_id;
      await db.insertInto('publication_origins').values({
        publication_id: shared.publication_id,
        source_id: otherSourceId,
        external_id: 'other:1',
        official_url: 'https://example.gov.br/other/1',
        metadata: JSON.stringify({}),
      } as never).execute();
      const blocked = await planSpedSanitization(client, code);
      assert.ok(blocked.blockers.includes('publications shared with other sources'));
      await assert.rejects(executeSpedSanitization(client, blocked.confirmationToken, code), /blocked/);
      await db.deleteFrom('publication_origins').where('source_id', '=', otherSourceId).execute();
      otherPublicationId = undefined;

      // Stale token (data changed after the dry-run) is rejected.
      await assert.rejects(executeSpedSanitization(client, 'deadbeefdeadbeef', code), /token mismatch/);

      // Execution.
      const fresh = await planSpedSanitization(client, code);
      const result = await executeSpedSanitization(client, fresh.confirmationToken, code);
      assert.equal(result.removed.publications, 13);
      assert.equal(result.removed.origins, 14);
      assert.equal(result.after.publications, 0);
      assert.equal(result.after.runsPreserved, 2);
      assert.equal(result.after.attemptsPreserved, fresh.counts.attemptsPreserved);
      assert.equal(result.after.itemsPreserved, fresh.counts.itemsPreserved);
    } finally {
      client.release();
    }

    // The preserved v2 checkpoint no longer hides documents whose data was removed.
    const state = await readSpedSourceState(db, sourceId);
    assert.equal(Object.values(state.pages).filter((page) => page.kind === 'DOCUMENT').length, 0);
    assert.deepEqual(state.identities, {});

    const rebootstrap = await run();
    assert.equal(rebootstrap.metrics.newPublications, 13);
    assert.equal(rebootstrap.metrics.newVersions, 0);
  } finally {
    const ids = [...new Set((await db.selectFrom('publication_origins').select('publication_id').where('source_id', 'in', [sourceId, otherSourceId]).execute()).map((row) => row.publication_id))];
    if (otherPublicationId) ids.push(otherPublicationId);
    await db.deleteFrom('collection_runs').where('source_id', 'in', [sourceId, otherSourceId]).execute();
    await db.deleteFrom('publication_origins').where('source_id', 'in', [sourceId, otherSourceId]).execute();
    if (ids.length) await db.deleteFrom('publications').where('id', 'in', ids).execute();
    await db.deleteFrom('sources').where('id', 'in', [sourceId, otherSourceId]).execute();
    await db.destroy();
  }
});
