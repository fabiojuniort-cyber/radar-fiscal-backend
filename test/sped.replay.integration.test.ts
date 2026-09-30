import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import type { DB } from '../src/infrastructure/database/database.types.js';
import { acquireNextCollectionRun, createCollectionRun } from '../src/modules/collection/collection-run.repository.js';
import { processAcquiredCollectionRun } from '../src/modules/collection/collection.engine.js';
import { ConnectorRegistry } from '../src/modules/collection/connector.registry.js';
import { SPED_STATE_VERSION, SpedConnector } from '../src/modules/collection/sped.connector.js';
import { readSpedSourceState } from '../src/modules/collection/sped-source-state.repository.js';
import { fakePortal, productionLikeInventory } from './sped.govbr.fixtures.js';

interface Harness {
  db: Kysely<DB>;
  sourceId: string;
  run(): ReturnType<typeof processAcquiredCollectionRun>;
  counts(): Promise<{ publications: number; versions: number; origins: number }>;
  attemptMetadata(runId: string): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

async function harness(fetchImpl: typeof fetch, now: () => Date): Promise<Harness> {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required for SPED integration tests.');
  const pool = new Pool({ connectionString: adminUrl, max: 3 });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  const sourceId = randomUUID();
  let sequence = 0;

  await db.insertInto('sources').values({
    id: sourceId,
    code: 'sped-' + sourceId,
    name: 'Portal SPED gov.br replay integration',
    jurisdiction_level: 'FEDERAL',
    base_url: 'https://www.gov.br/sped/pt-br/',
    connector_key: 'sped',
    max_attempts: 1,
  }).execute();

  const registry = new ConnectorRegistry();
  registry.register(new SpedConnector({
    fetch: fetchImpl,
    readState: (source) => readSpedSourceState(db, source),
    now,
  }));

  const publicationIds = async () => [...new Set(
    (await db.selectFrom('publication_origins').select('publication_id').where('source_id', '=', sourceId).execute())
      .map((row) => row.publication_id),
  )];

  return {
    db,
    sourceId,
    async run() {
      const runId = await createCollectionRun(db, {
        sourceId,
        scheduledFor: new Date(Date.now() - 60_000 + sequence++),
        triggerType: 'MANUAL',
      });
      const acquired = await acquireNextCollectionRun(db, 'sped-replay-' + sourceId);
      assert.ok(acquired);
      assert.equal(acquired.id, runId);
      return processAcquiredCollectionRun(db, registry, acquired, { timeoutMs: 20_000, heartbeatIntervalMs: 0 });
    },
    async counts() {
      const ids = await publicationIds();
      const versions = ids.length
        ? await db.selectFrom('publication_versions').select('id').where('publication_id', 'in', ids).execute()
        : [];
      const origins = await db.selectFrom('publication_origins').select('id').where('source_id', '=', sourceId).execute();
      return { publications: ids.length, versions: versions.length, origins: origins.length };
    },
    async attemptMetadata(runId: string) {
      const row = await db.selectFrom('collection_attempts')
        .select('metadata')
        .where('collection_run_id', '=', runId)
        .orderBy('attempt_no', 'desc')
        .executeTakeFirstOrThrow();
      return row.metadata as Record<string, unknown>;
    },
    async close() {
      const ids = await publicationIds();
      await db.deleteFrom('collection_runs').where('source_id', '=', sourceId).execute();
      await db.deleteFrom('publication_origins').where('source_id', '=', sourceId).execute();
      if (ids.length) await db.deleteFrom('publications').where('id', 'in', ids).execute();
      await db.deleteFrom('sources').where('id', '=', sourceId).execute();
      await db.destroy();
    },
  };
}

function sped(metadata: Record<string, unknown>): Record<string, number> & { identityAudit: { unresolvedCollisions: number } } {
  return metadata.sped as never;
}

// ---------------------------------------------------------------------------
// Teste A — replay through Motor + PostgreSQL
// ---------------------------------------------------------------------------

test('A: bootstrap then replay through the collection engine is incremental and creates no artificial versions', async () => {
  const inventory = productionLikeInventory();
  const portal = fakePortal(inventory);
  const h = await harness(portal.fetch, () => new Date('2026-09-23T03:00:00Z'));
  try {
    const bootstrap = await h.run();
    assert.equal(bootstrap.status, 'SUCCESS');
    const afterBootstrap = await h.counts();
    // 14 documents; the DeRE mirror is one publication with two origins.
    assert.equal(bootstrap.metrics.found, 14);
    assert.equal(afterBootstrap.publications, 13);
    assert.equal(afterBootstrap.origins, 14);
    assert.equal(afterBootstrap.versions, 13, 'bootstrap must not create versions (no collisions, no alternating mirrors)');
    assert.equal(bootstrap.metrics.newVersions, 0);
    const bootstrapFetches = { ...portal.stats };

    const state = await readSpedSourceState(h.db, h.sourceId);
    assert.equal(state.version, SPED_STATE_VERSION);
    // 13 document pages + 1 gov.br folder, which stays a CONTAINER.
    assert.equal(Object.values(state.pages).filter((page) => page.kind === 'DOCUMENT').length, 13);
    assert.equal(Object.values(state.pages).filter((page) => page.kind === 'CONTAINER' && page.canonicalUrl.endsWith('/versao-atual/esquemas-xsd')).length > 0, true);
    // Every persisted origin exposes the identity it is linked to, matching
    // the checkpoint identity (the reference if the checkpoint drops it).
    const persistedKeys = state.persistedIdentityKeys ?? {};
    assert.equal(Object.keys(persistedKeys).length, 14);
    for (const [externalId, identity] of Object.entries(state.identities ?? {})) {
      assert.equal(persistedKeys[externalId], identity.key);
    }

    portal.reset();
    const replay = await h.run();
    const afterReplay = await h.counts();
    assert.equal(replay.metrics.newPublications, 0);
    assert.equal(replay.metrics.newVersions, 0);
    assert.deepEqual(afterReplay, afterBootstrap, 'same publications, versions and origins');

    const replayMeta = sped(await h.attemptMetadata(replay.runId));
    assert.ok(replayMeta.skippedKnownDocumentCount >= 13, 'checkpoint must be loaded and reused');
    assert.equal(portal.stats.documentPageFetches, 1, 'only the folder container is re-fetched; known documents are not');
    assert.equal(replay.metrics.existingPublications, 1, 'the folder page is re-emitted unchanged (no version)');
    assert.equal(portal.stats.fileDownloads, 0, 'no file is downloaded again');
    assert.ok(bootstrapFetches.documentPageFetches >= 14);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Teste B — partial bootstrap
// ---------------------------------------------------------------------------

test('B: after a PARTIAL_SUCCESS bootstrap, completed items are reused and failed ones retried', async () => {
  const inventory = productionLikeInventory();
  const failingFiles = new Set(['guia-324', 'guia-323']);
  const portal = fakePortal({ ...inventory, failingFiles });
  const h = await harness(portal.fetch, () => new Date('2026-09-23T03:00:00Z'));
  try {
    const bootstrap = await h.run();
    assert.equal(bootstrap.status, 'PARTIAL_SUCCESS');
    const bootMeta = sped(await h.attemptMetadata(bootstrap.runId));
    assert.equal(bootMeta.deferredDocumentCount, 2);
    const afterBootstrap = await h.counts();
    assert.equal(afterBootstrap.publications, 11);
    assert.equal(afterBootstrap.versions, 11);

    // The deferred documents must not be hidden behind the checkpoint.
    const state = await readSpedSourceState(h.db, h.sourceId);
    const guidePages = Object.values(state.pages).filter((page) => /guia-pratico-efd-versao-3-2-[34]/.test(page.canonicalUrl));
    assert.ok(guidePages.length >= 2);
    assert.ok(guidePages.every((page) => page.kind !== 'DOCUMENT'));

    failingFiles.clear();
    portal.reset();
    const next = await h.run();
    assert.equal(next.status, 'SUCCESS');
    assert.equal(next.metrics.newPublications, 2, 'the two failed guides are retried and captured');
    assert.equal(next.metrics.newVersions, 0);
    assert.equal(portal.stats.documentPageFetches, 3, 'only the failed documents (plus the folder container) are fetched again');
    assert.equal(portal.stats.fileDownloads, 2);
    const nextMeta = sped(await h.attemptMetadata(next.runId));
    assert.ok(nextMeta.skippedKnownDocumentCount >= 11, 'completed items reused from the PARTIAL_SUCCESS checkpoint');

    const afterNext = await h.counts();
    assert.equal(afterNext.publications, 13);
    assert.equal(afterNext.versions, 13);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Teste E — real change: same document, new bytes
// ---------------------------------------------------------------------------

test('E: same official document with a different file SHA-256 becomes a new publication_version', async () => {
  const inventory = productionLikeInventory();
  const fileGeneration = new Map<string, number>();
  const portal = fakePortal({ ...inventory, fileGeneration });
  let now = new Date('2026-09-23T03:00:00Z');
  const h = await harness(portal.fetch, () => now);
  try {
    await h.run();
    const before = await h.counts();

    // The guide bytes change; after the revisit window the document is rechecked.
    fileGeneration.set('guia-324', 2);
    now = new Date('2026-09-24T04:00:00Z');
    const changed = await h.run();
    assert.equal(changed.metrics.newPublications, 0);
    assert.equal(changed.metrics.newVersions, 1);
    const after = await h.counts();
    assert.equal(after.publications, before.publications, 'same publication');
    assert.equal(after.versions, before.versions + 1, 'exactly one new version');

    const guide = await h.db.selectFrom('publication_origins as po')
      .innerJoin('publication_versions as pv', 'pv.publication_id', 'po.publication_id')
      .select(['pv.version_no', 'pv.is_current'])
      .where('po.source_id', '=', h.sourceId)
      .where('po.external_id', 'like', '%guia-pratico-efd-versao-3-2-4.pdf')
      .orderBy('pv.version_no')
      .execute();
    assert.deepEqual(guide.map((row) => [row.version_no, row.is_current]), [[1, false], [2, true]]);

    // Rechecking unchanged documents later still creates nothing.
    now = new Date('2026-09-26T05:00:00Z');
    const quiet = await h.run();
    assert.equal(quiet.metrics.newVersions, 0);
    assert.equal(quiet.metrics.newPublications, 0);
  } finally {
    await h.close();
  }
});

test('legacy checkpoints (pre state v2) are ignored instead of hiding documents', async () => {
  const portal = fakePortal(productionLikeInventory());
  const h = await harness(portal.fetch, () => new Date('2026-09-23T03:00:00Z'));
  try {
    // Simulate the production incident: a SUCCESS run whose v1 checkpoint marks
    // every page as a known DOCUMENT while the domain data was later cleaned.
    const runId = await createCollectionRun(h.db, { sourceId: h.sourceId, scheduledFor: new Date(Date.now() - 120_000), triggerType: 'MANUAL' });
    const acquired = await acquireNextCollectionRun(h.db, 'legacy-' + h.sourceId);
    assert.ok(acquired);
    await h.db.updateTable('collection_runs').set({ status: 'SUCCESS', finished_at: new Date() }).where('id', '=', runId).execute();
    await h.db.insertInto('collection_attempts').values({
      collection_run_id: runId,
      attempt_no: 1,
      status: 'SUCCESS',
      started_at: new Date(),
      finished_at: new Date(),
      metadata: JSON.stringify({ spedState: { items: {}, pages: { 'https://www.gov.br/sped/pt-br/x': { canonicalUrl: 'https://www.gov.br/sped/pt-br/x', kind: 'DOCUMENT', module: 'DERE', checkedAt: new Date().toISOString() } } } }),
    } as never).execute();

    const state = await readSpedSourceState(h.db, h.sourceId);
    assert.deepEqual(state.pages, {});
  } finally {
    await h.close();
  }
});
