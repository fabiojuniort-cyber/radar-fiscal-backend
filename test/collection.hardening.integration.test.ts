import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';

import type { DB } from '../src/infrastructure/database/database.types.js';
import {
  CHECKPOINT_GENERATIONS_KEPT,
  readCurrentCheckpoint,
  writeCheckpoint,
} from '../src/modules/collection/checkpoint.repository.js';
import { acquireNextCollectionRun, createCollectionRun } from '../src/modules/collection/collection-run.repository.js';
import { processAcquiredCollectionRun } from '../src/modules/collection/collection.engine.js';
import type {
  CollectionConnector,
  ConnectorExecutionContext,
  ConnectorTimeBudget,
} from '../src/modules/collection/connector.contract.js';
import { ConnectorRegistry } from '../src/modules/collection/connector.registry.js';
import { readNfeEncatSourceState } from '../src/modules/collection/nfe-encat-source-state.repository.js';
import { NFE_ENCAT_STATE_VERSION } from '../src/modules/collection/nfe-encat.connector.js';
import { readSpedSourceState } from '../src/modules/collection/sped-source-state.repository.js';
import { SPED_STATE_VERSION, SpedConnector } from '../src/modules/collection/sped.connector.js';
import { measureCapacity, runCapacitySnapshotIfDue } from '../src/modules/operations/db-capacity.js';
import { pruneCollectionMetadata } from '../src/modules/operations/metadata-retention.js';
import { fakePortal, productionLikeInventory } from './sped.govbr.fixtures.js';

const adminUrl = process.env.DATABASE_ADMIN_URL;

function adminDb(max = 4): Kysely<DB> {
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required for hardening integration tests.');
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: adminUrl, max }) }) });
}

/** Connections that run as radar_worker_runtime (least privilege of the worker/scheduler). */
function workerDb(max = 4): Kysely<DB> {
  assert.ok(adminUrl);
  const pool = new Pool({ connectionString: adminUrl, max });
  pool.on('connect', (client) => {
    void client.query('SET ROLE radar_worker_runtime');
  });
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

async function createSource(db: Kysely<DB>, connectorKey: string): Promise<string> {
  const id = randomUUID();
  await db.insertInto('sources').values({
    id,
    code: 'hardening-' + id,
    name: 'Hardening integration ' + connectorKey,
    jurisdiction_level: 'FEDERAL',
    base_url: 'https://example.invalid/',
    connector_key: connectorKey,
    max_attempts: 1,
  }).execute();
  return id;
}

let runSequence = 0;

async function createFinishedRun(
  db: Kysely<DB>,
  sourceId: string,
  status: string,
  metadata: Record<string, unknown> = {},
  finishedAt = new Date(),
): Promise<{ runId: string; attemptId: string }> {
  const runId = randomUUID();
  await db.insertInto('collection_runs').values({
    id: runId,
    source_id: sourceId,
    scheduled_for: new Date(finishedAt.getTime() - 60_000 - runSequence++),
    trigger_type: 'MANUAL',
    status,
    started_at: new Date(finishedAt.getTime() - 30_000),
    finished_at: finishedAt,
  }).execute();
  const attempt = await db.insertInto('collection_attempts').values({
    collection_run_id: runId,
    attempt_no: 1,
    status: 'SUCCESS',
    started_at: new Date(finishedAt.getTime() - 30_000),
    finished_at: finishedAt,
    metadata: JSON.stringify(metadata),
  }).returning('id').executeTakeFirstOrThrow();
  return { runId, attemptId: attempt.id };
}

async function cleanupSource(db: Kysely<DB>, sourceId: string): Promise<void> {
  const ids = [...new Set(
    (await db.selectFrom('publication_origins').select('publication_id').where('source_id', '=', sourceId).execute())
      .map((row) => row.publication_id),
  )];
  await db.deleteFrom('collection_runs').where('source_id', '=', sourceId).execute();
  await db.deleteFrom('publication_origins').where('source_id', '=', sourceId).execute();
  if (ids.length) await db.deleteFrom('publications').where('id', 'in', ids).execute();
  await db.deleteFrom('sources').where('id', '=', sourceId).execute();
}

// ---------------------------------------------------------------------------
// Checkpoint store
// ---------------------------------------------------------------------------

test('checkpoint generations are concurrency-safe and only current + 2 previous are kept (worker role)', async () => {
  const admin = adminDb();
  const worker = workerDb(8);
  const sourceId = await createSource(admin, 'sped');
  try {
    const { runId, attemptId } = await createFinishedRun(admin, sourceId, 'SUCCESS');
    const refs = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      worker.transaction().execute((trx) => writeCheckpoint(trx, {
        sourceId,
        connectorKey: 'sped',
        runId,
        attemptId,
        checkpoint: { version: SPED_STATE_VERSION, state: { index, items: {}, pages: {} } },
      })),
    ));

    assert.deepEqual(refs.map((ref) => ref.generation).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
    const rows = await admin.selectFrom('collection_checkpoints')
      .select(['generation'])
      .where('source_id', '=', sourceId)
      .orderBy('generation')
      .execute();
    assert.deepEqual(rows.map((row) => Number(row.generation)), [6, 7, 8]);
    assert.equal(rows.length, CHECKPOINT_GENERATIONS_KEPT);

    // The UNIQUE constraint is the backstop for any allocation bug.
    await assert.rejects(
      admin.insertInto('collection_checkpoints').values({
        source_id: sourceId,
        connector_key: 'sped',
        state_version: SPED_STATE_VERSION,
        generation: 8,
        payload: '{}',
        payload_sha256: 'a'.repeat(64),
        payload_bytes: 2,
      }).execute(),
      /uq_collection_checkpoint_generation/,
    );

    // Worker cannot rewrite a generation in place.
    await assert.rejects(
      worker.updateTable('collection_checkpoints').set({ payload: '{}' }).where('source_id', '=', sourceId).execute(),
      /permission denied/,
    );
  } finally {
    await cleanupSource(admin, sourceId);
    await worker.destroy();
    await admin.destroy();
  }
});

test('readCurrentCheckpoint skips failed runs, other state versions and corrupted payloads', async () => {
  const admin = adminDb();
  const sourceId = await createSource(admin, 'sped');
  try {
    const good = await createFinishedRun(admin, sourceId, 'SUCCESS');
    const failed = await createFinishedRun(admin, sourceId, 'PROCESSING_FAILED');
    const write = (run: { runId: string; attemptId: string }, version: number, marker: string) =>
      admin.transaction().execute((trx) => writeCheckpoint(trx, {
        sourceId,
        connectorKey: 'sped',
        runId: run.runId,
        attemptId: run.attemptId,
        checkpoint: { version, state: { marker, nested: { b: 1, a: [2, 1] } } },
      }));

    const first = await write(good, SPED_STATE_VERSION, 'good');
    await write(failed, SPED_STATE_VERSION, 'failed');
    await write(good, SPED_STATE_VERSION + 1, 'future');

    const accepted = ['SUCCESS', 'SUCCESS_NO_RESULTS', 'PARTIAL_SUCCESS'];
    const read = await readCurrentCheckpoint(admin, sourceId, 'sped', {
      stateVersion: SPED_STATE_VERSION,
      acceptedRunStatuses: accepted,
    });
    assert.equal(read?.generation, first.generation);
    assert.equal(read?.state.marker, 'good');

    // Integrity: a payload that no longer matches its SHA-256 is never used.
    await admin.updateTable('collection_checkpoints')
      .set({ payload: JSON.stringify({ marker: 'tampered' }) })
      .where('id', '=', first.id)
      .execute();
    assert.equal(await readCurrentCheckpoint(admin, sourceId, 'sped', {
      stateVersion: SPED_STATE_VERSION,
      acceptedRunStatuses: accepted,
    }), undefined);
  } finally {
    await cleanupSource(admin, sourceId);
    await admin.destroy();
  }
});

test('SPED and NF-e: legacy metadata state is read until the first checkpoint row exists, then the table wins', async () => {
  const admin = adminDb();
  const spedSource = await createSource(admin, 'sped');
  const nfeSource = await createSource(admin, 'nfe-encat');
  try {
    const checkedAt = new Date().toISOString();
    const legacyPage = 'https://www.gov.br/sped/pt-br/legacy-missing';
    const tablePage = 'https://www.gov.br/sped/pt-br/table-missing';
    const legacySped = await createFinishedRun(admin, spedSource, 'SUCCESS', {
      spedState: {
        version: SPED_STATE_VERSION,
        items: {},
        pages: { [legacyPage]: { canonicalUrl: legacyPage, kind: 'MISSING', module: 'DERE', checkedAt } },
        identities: {},
      },
    });
    const file = (sha: string) => ({ rawSha256: sha.repeat(64), sizeBytes: 1, mimeType: 'application/pdf', checkedAt });
    const legacyNfe = await createFinishedRun(admin, nfeSource, 'SUCCESS', {
      nfeEncatState: { items: { 'TECHNICAL_NOTES:legacy': file('a') } },
    });

    assert.deepEqual(Object.keys((await readSpedSourceState(admin, spedSource)).pages), [legacyPage]);
    assert.deepEqual(Object.keys((await readNfeEncatSourceState(admin, nfeSource)).items), ['TECHNICAL_NOTES:legacy']);

    await admin.transaction().execute(async (trx) => {
      await writeCheckpoint(trx, {
        sourceId: spedSource,
        connectorKey: 'sped',
        runId: legacySped.runId,
        attemptId: legacySped.attemptId,
        checkpoint: {
          version: SPED_STATE_VERSION,
          state: {
            version: SPED_STATE_VERSION,
            items: {},
            pages: { [tablePage]: { canonicalUrl: tablePage, kind: 'MISSING', module: 'DERE', checkedAt } },
            identities: {},
          },
        },
      });
      await writeCheckpoint(trx, {
        sourceId: nfeSource,
        connectorKey: 'nfe-encat',
        runId: legacyNfe.runId,
        attemptId: legacyNfe.attemptId,
        checkpoint: { version: NFE_ENCAT_STATE_VERSION, state: { items: { 'TECHNICAL_NOTES:table': file('b') } } },
      });
    });

    assert.deepEqual(Object.keys((await readSpedSourceState(admin, spedSource)).pages), [tablePage]);
    assert.deepEqual(Object.keys((await readNfeEncatSourceState(admin, nfeSource)).items), ['TECHNICAL_NOTES:table']);
  } finally {
    await cleanupSource(admin, spedSource);
    await cleanupSource(admin, nfeSource);
    await admin.destroy();
  }
});

// ---------------------------------------------------------------------------
// SPED through the Motor: transition, time budget, hard timeout
// ---------------------------------------------------------------------------

/** Budget that asks to yield after `allowed` shouldYield() calls. */
function scriptedBudget(allowed: number): ConnectorTimeBudget {
  let calls = 0;
  const far = new Date(Date.now() + 3_600_000);
  return {
    deadlineAt: far,
    softDeadlineAt: far,
    remainingMs: () => 3_600_000,
    shouldYield: () => ++calls > allowed,
  };
}

class ScriptedBudgetConnector implements CollectionConnector {
  readonly key = 'sped';
  allowed = Number.POSITIVE_INFINITY;
  constructor(private readonly inner: SpedConnector) {}
  collect(context: ConnectorExecutionContext) {
    // Infinite = keep the real budget created by the executor.
    if (!Number.isFinite(this.allowed)) return this.inner.collect(context);
    return this.inner.collect({ ...context, budget: scriptedBudget(this.allowed) });
  }
}

async function spedHarness(fetchImpl: typeof fetch) {
  const db = adminDb();
  const sourceId = await createSource(db, 'sped');
  const connector = new ScriptedBudgetConnector(new SpedConnector({
    fetch: fetchImpl,
    readState: (source) => readSpedSourceState(db, source),
    now: () => new Date('2026-09-23T03:00:00Z'),
  }));
  const registry = new ConnectorRegistry();
  registry.register(connector);
  let sequence = 0;

  const run = async (options: { timeoutMs?: number; budgetGraceMs?: number } = {}) => {
    const runId = await createCollectionRun(db, {
      sourceId,
      scheduledFor: new Date(Date.now() - 60_000 + sequence++),
      triggerType: 'MANUAL',
    });
    const acquired = await acquireNextCollectionRun(db, 'hardening-' + sourceId);
    assert.ok(acquired);
    assert.equal(acquired.id, runId);
    return processAcquiredCollectionRun(db, registry, acquired, {
      timeoutMs: options.timeoutMs ?? 20_000,
      heartbeatIntervalMs: 0,
      ...(options.budgetGraceMs !== undefined ? { budgetGraceMs: options.budgetGraceMs } : {}),
    });
  };

  const counts = async () => {
    const ids = [...new Set(
      (await db.selectFrom('publication_origins').select('publication_id').where('source_id', '=', sourceId).execute())
        .map((row) => row.publication_id),
    )];
    const versions = ids.length
      ? await db.selectFrom('publication_versions').select('id').where('publication_id', 'in', ids).execute()
      : [];
    const origins = await db.selectFrom('publication_origins').select('id').where('source_id', '=', sourceId).execute();
    return { publications: ids.length, versions: versions.length, origins: origins.length };
  };

  const runInfo = async (runId: string) => {
    const runRow = await db.selectFrom('collection_runs')
      .select(['status', 'error_summary', 'next_attempt_at'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    const attempts = await db.selectFrom('collection_attempts')
      .select(['status', 'metadata'])
      .where('collection_run_id', '=', runId)
      .execute();
    return { run: runRow, attempts };
  };

  return {
    db,
    sourceId,
    connector,
    run,
    counts,
    runInfo,
    async close() {
      await cleanupSource(db, sourceId);
      await db.destroy();
    },
  };
}

test('SPED legacy checkpoint moves to collection_checkpoints without recrawl, then is read from the table', async () => {
  const portal = fakePortal(productionLikeInventory());
  const h = await spedHarness(portal.fetch);
  try {
    const bootstrap = await h.run();
    assert.equal(bootstrap.status, 'SUCCESS');
    const afterBootstrap = await h.counts();

    // Rebuild the pre-deploy situation: state only in attempt metadata.
    const stored = await readCurrentCheckpoint(h.db, h.sourceId, 'sped');
    assert.ok(stored);
    await h.db.updateTable('collection_attempts')
      .set({ metadata: sql`metadata || jsonb_build_object('spedState', ${JSON.stringify(stored.state)}::jsonb)` })
      .where('collection_run_id', '=', bootstrap.runId)
      .execute();
    await h.db.deleteFrom('collection_checkpoints').where('source_id', '=', h.sourceId).execute();

    portal.reset();
    const transition = await h.run();
    assert.equal(transition.status, 'SUCCESS');
    assert.equal(portal.stats.fileDownloads, 0, 'legacy checkpoint reused: no file downloaded again');
    assert.equal(portal.stats.documentPageFetches, 1, 'only the folder container is fetched');
    const afterTransition = await readCurrentCheckpoint(h.db, h.sourceId, 'sped');
    assert.equal(afterTransition?.producedByRunId, transition.runId, 'new checkpoint row written');

    const info = await h.runInfo(transition.runId);
    const metadata = info.attempts[0]!.metadata as Record<string, unknown>;
    assert.equal(metadata.spedState, undefined, 'heavy state is no longer written to attempt metadata');
    assert.equal((metadata.checkpointRef as { generation: number }).generation, 1);

    // Remove the legacy copy entirely: the next run must work from the table.
    await h.db.updateTable('collection_attempts')
      .set({ metadata: sql`metadata - 'spedState'` })
      .where('collection_run_id', '=', bootstrap.runId)
      .execute();
    portal.reset();
    const fromTable = await h.run();
    assert.equal(fromTable.status, 'SUCCESS');
    assert.equal(portal.stats.fileDownloads, 0);
    assert.equal(portal.stats.documentPageFetches, 1);
    assert.equal(fromTable.metrics.newVersions, 0);
    assert.deepEqual(await h.counts(), afterBootstrap, 'no artificial publications or versions');
  } finally {
    await h.close();
  }
});

test('SPED time budget: yielded runs end PARTIAL_SUCCESS/TIME_BUDGET_REACHED and later runs converge without artificial versions', async () => {
  // Reference: one full bootstrap without any budget pressure.
  const referencePortal = fakePortal(productionLikeInventory());
  const reference = await spedHarness(referencePortal.fetch);
  let expected: { publications: number; versions: number; origins: number };
  try {
    await reference.run();
    expected = await reference.counts();
  } finally {
    await reference.close();
  }

  // Real executor budget with a slow portal (every request takes 25 ms):
  // soft window 400 ms, of which 60% for discovery and the rest for downloads.
  const portal = fakePortal(productionLikeInventory());
  const slowFetch: typeof fetch = async (input, init) => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return portal.fetch(input, init);
  };
  const h = await spedHarness(slowFetch);
  try {
    let yieldedRuns = 0;
    let finalStatus = '';
    for (let index = 0; index < 60; index += 1) {
      const result = await h.run({ timeoutMs: 1_500, budgetGraceMs: 1_100 });
      const info = await h.runInfo(result.runId);
      assert.equal(info.attempts.length, 1, 'a yield is not retried immediately');
      assert.equal(info.attempts[0]!.status, 'SUCCESS', 'a yield is not a failed attempt');
      const metadata = info.attempts[0]!.metadata as Record<string, unknown>;
      assert.ok(metadata.checkpointRef, 'checkpoint saved on yield');
      const completion = metadata.completion as { complete: boolean; reason?: string } | undefined;
      if (completion?.complete === false) {
        yieldedRuns += 1;
        assert.equal(result.status, 'PARTIAL_SUCCESS');
        assert.equal(info.run.status, 'PARTIAL_SUCCESS');
        assert.match(info.run.error_summary ?? '', /^TIME_BUDGET_REACHED/);
        assert.equal(info.run.next_attempt_at, null);
        assert.equal(completion.reason, 'TIME_BUDGET_REACHED');
        continue;
      }
      finalStatus = result.status;
      break;
    }
    assert.ok(yieldedRuns >= 2, 'the scripted budget must force several yields (got ' + yieldedRuns + ')');
    assert.equal(finalStatus, 'SUCCESS');

    const converged = await h.counts();
    assert.deepEqual(converged, expected, 'same publications/origins/versions as an uninterrupted bootstrap');
    assert.equal(converged.versions, converged.publications, '0 artificial versions');

    const checkpoints = await h.db.selectFrom('collection_checkpoints')
      .select('generation')
      .where('source_id', '=', h.sourceId)
      .execute();
    assert.equal(checkpoints.length, CHECKPOINT_GENERATIONS_KEPT);

    portal.reset();
    const replay = await h.run();
    assert.equal(replay.status, 'SUCCESS');
    assert.equal(replay.metrics.newVersions, 0);
    assert.equal(portal.stats.fileDownloads, 0);
    assert.deepEqual(await h.counts(), expected);
  } finally {
    await h.close();
  }
});

test('SPED real time budget through the executor: soft deadline reached yields gracefully, no TIMEOUT', async () => {
  const portal = fakePortal(productionLikeInventory());
  const h = await spedHarness(portal.fetch);
  try {
    // Soft deadline = timeout - grace = 1 ms after start: yield at the first safe point.
    const result = await h.run({ timeoutMs: 20_000, budgetGraceMs: 19_999 });
    assert.equal(result.status, 'PARTIAL_SUCCESS');
    const info = await h.runInfo(result.runId);
    assert.equal(info.attempts.length, 1);
    assert.equal(info.attempts[0]!.status, 'SUCCESS');
    assert.match(info.run.error_summary ?? '', /^TIME_BUDGET_REACHED/);
    assert.equal((await h.counts()).versions, (await h.counts()).publications);

    const next = await h.run();
    assert.equal(next.status, 'SUCCESS', 'the following run continues normally');
  } finally {
    await h.close();
  }
});

test('hard timeout still applies to a hung connector and never writes a checkpoint', async () => {
  const db = adminDb();
  const key = 'hardening-hang-' + randomUUID();
  const sourceId = await createSource(db, key);
  const registry = new ConnectorRegistry();
  registry.register({
    key,
    async collect(context: ConnectorExecutionContext) {
      await new Promise((_, reject) => context.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      return { publications: [], checkpoint: { version: 1, state: { never: true } } };
    },
  });
  const keepAlive = setInterval(() => undefined, 1_000);
  try {
    await createCollectionRun(db, { sourceId, scheduledFor: new Date(Date.now() - 60_000), triggerType: 'MANUAL' });
    const acquired = await acquireNextCollectionRun(db, 'hardening-hang');
    assert.ok(acquired);
    await processAcquiredCollectionRun(db, registry, acquired, { timeoutMs: 300, heartbeatIntervalMs: 0 });
    const attempt = await db.selectFrom('collection_attempts')
      .select(['status', 'error_code'])
      .where('collection_run_id', '=', acquired.id)
      .executeTakeFirstOrThrow();
    assert.equal(attempt.status, 'TIMEOUT');
    const checkpoints = await db.selectFrom('collection_checkpoints').select('id').where('source_id', '=', sourceId).execute();
    assert.equal(checkpoints.length, 0);
  } finally {
    clearInterval(keepAlive);
    await cleanupSource(db, sourceId);
    await db.destroy();
  }
});

// ---------------------------------------------------------------------------
// Operations: metadata retention and capacity telemetry (worker role)
// ---------------------------------------------------------------------------

test('metadata prune: dry-run changes nothing; apply removes only known heavy keys in batches and never deletes attempts', async () => {
  const admin = adminDb();
  const worker = workerDb(2);
  const spedSource = await createSource(admin, 'sped');
  const nfeSource = await createSource(admin, 'nfe-encat');
  const now = new Date('2030-01-01T00:00:00Z');
  const old = new Date('2029-11-01T00:00:00Z');
  const recent = new Date('2029-12-25T00:00:00Z');
  try {
    const heavySped = {
      publicationCount: 3,
      partialFailureCount: 0,
      sped: {
        processedDocumentCount: 3,
        deferredDocumentCount: 1,
        deferredDocuments: [{ externalId: 'x' }],
        identityAudit: { identityVersion: 'v2', emittedPublicationCount: 3, distinctIdentityKeyCount: 3, mirrorGroups: [{}], collisionsResolved: [{}, {}], unresolvedCollisions: 0 },
        moduleResults: [{ module: 'DERE' }],
      },
      spedState: { version: SPED_STATE_VERSION, items: {}, pages: {}, identities: {} },
    };
    const oldSped = await Promise.all([1, 2, 3].map(() => createFinishedRun(admin, spedSource, 'SUCCESS', heavySped, old)));
    const recentSped = await createFinishedRun(admin, spedSource, 'SUCCESS', heavySped, recent);
    await admin.transaction().execute((trx) => writeCheckpoint(trx, {
      sourceId: spedSource,
      connectorKey: 'sped',
      runId: recentSped.runId,
      attemptId: recentSped.attemptId,
      checkpoint: { version: SPED_STATE_VERSION, state: { version: SPED_STATE_VERSION, items: {}, pages: {}, identities: {} } },
    }));
    // NF-e source WITHOUT checkpoint row: its legacy state must be kept.
    const oldNfe = await createFinishedRun(admin, nfeSource, 'SUCCESS', { nfeEncatState: { items: {} }, publicationCount: 1 }, old);

    const snapshot = async () => (await admin.selectFrom('collection_attempts')
      .select(['id', 'metadata'])
      .where('collection_run_id', 'in', [...oldSped.map((r) => r.runId), recentSped.runId, oldNfe.runId])
      .orderBy('id')
      .execute()).map((row) => JSON.stringify(row.metadata));
    const before = await snapshot();

    const dry = await pruneCollectionMetadata(worker, { apply: false, now, batchSize: 2 });
    assert.equal(dry.mode, 'DRY_RUN');
    assert.deepEqual(await snapshot(), before, 'dry-run writes nothing');
    const ours = dry.sample.filter((item) => oldSped.some((run) => run.attemptId === item.attemptId));
    assert.equal(ours.length, 3);
    for (const item of ours) assert.deepEqual([...item.removed].sort(), ['sped.deferredDocuments', 'sped.identityAudit', 'spedState']);
    assert.ok(dry.legacyStateKeptWithoutCheckpoint >= 1);

    const applied = await pruneCollectionMetadata(worker, { apply: true, now, batchSize: 2 });
    assert.ok(applied.updatedAttempts >= 3);
    assert.ok(applied.batches >= 2, 'processed in batches');

    const rows = await admin.selectFrom('collection_attempts')
      .select(['id', 'metadata', 'status', 'finished_at'])
      .where('collection_run_id', 'in', [...oldSped.map((r) => r.runId), recentSped.runId, oldNfe.runId])
      .execute();
    assert.equal(rows.length, 5, 'no attempt deleted');
    for (const run of oldSped) {
      const metadata = rows.find((row) => row.id === run.attemptId)!.metadata as Record<string, any>;
      assert.equal(metadata.spedState, undefined);
      assert.equal(metadata.sped.identityAudit, undefined);
      assert.equal(metadata.sped.deferredDocuments, undefined);
      assert.equal(metadata.sped.deferredDocumentCount, 1, 'counts preserved');
      assert.equal(metadata.sped.processedDocumentCount, 3);
      assert.deepEqual(metadata.sped.moduleResults, [{ module: 'DERE' }]);
      assert.equal(metadata.sped.identityAuditCounts.collisionsResolved, 2);
      assert.equal(metadata.publicationCount, 3);
      assert.ok(metadata.metadataPruned.at);
    }
    const recentMeta = rows.find((row) => row.id === recentSped.attemptId)!.metadata as Record<string, any>;
    assert.ok(recentMeta.spedState, 'attempts newer than the retention window are untouched');
    const nfeMeta = rows.find((row) => row.id === oldNfe.attemptId)!.metadata as Record<string, any>;
    assert.ok(nfeMeta.nfeEncatState, 'legacy state kept while the source has no checkpoint row');

    const again = await pruneCollectionMetadata(worker, { apply: true, now });
    assert.equal(again.sample.filter((item) => oldSped.some((run) => run.attemptId === item.attemptId)).length, 0, 'idempotent');
  } finally {
    await cleanupSource(admin, spedSource);
    await cleanupSource(admin, nfeSource);
    await worker.destroy();
    await admin.destroy();
  }
});

test('capacity snapshot is created by the worker role without pg_monitor (WAL NULL, max_wal_size basis) and respects the interval', async () => {
  const admin = adminDb();
  const worker = workerDb(2);
  const logs: Array<{ level: string; bindings: Record<string, unknown> }> = [];
  const logger = {
    info: (bindings: Record<string, unknown>) => logs.push({ level: 'info', bindings }),
    warn: (bindings: Record<string, unknown>) => logs.push({ level: 'warn', bindings }),
    error: (bindings: Record<string, unknown>) => logs.push({ level: 'error', bindings }),
  };
  const now = new Date('2031-01-01T00:00:00Z');
  try {
    const measurement = await measureCapacity(worker, { capacityBytes: 1_000_000_000_000 });
    assert.equal(measurement.walBytes, null, 'runtime role cannot list pg_wal');
    assert.equal(measurement.walEstimateBasis, 'MAX_WAL_SIZE');
    assert.equal(measurement.estimatedPgBytes, measurement.dbBytes + measurement.maxWalSizeBytes);
    assert.ok(measurement.topTables.length > 0);

    const first = await runCapacitySnapshotIfDue(worker, { now, intervalMs: 3_600_000, capacityBytes: 1_000_000, logger });
    assert.equal(first.taken, true);
    assert.equal(first.alertLevel, 'CRITICAL', 'tiny capacity forces the CRITICAL path');
    assert.equal(logs.at(-1)?.level, 'error');
    assert.equal(logs.at(-1)?.bindings.event, 'db_capacity_snapshot');
    assert.equal(logs.at(-1)?.bindings.alertCode, 'DB_CAPACITY_CRITICAL');

    const second = await runCapacitySnapshotIfDue(worker, { now: new Date(now.getTime() + 60_000), intervalMs: 3_600_000, logger });
    assert.equal(second.taken, false, 'not due yet');

    const row = await admin.selectFrom('db_capacity_snapshots')
      .selectAll()
      .where('id', '=', first.snapshotId!)
      .executeTakeFirstOrThrow();
    assert.equal(row.wal_bytes, null);
    assert.equal(row.wal_estimate_basis, 'MAX_WAL_SIZE');
    assert.equal(row.alert_level, 'CRITICAL');
    assert.ok(Array.isArray(row.top_tables));

    // Monitoring connection (here: admin) measures WAL when available.
    const monitor = new Pool({ connectionString: adminUrl, max: 1 });
    try {
      const measured = await measureCapacity(worker, { monitor });
      assert.equal(measured.walEstimateBasis, 'MEASURED');
      assert.ok((measured.walBytes ?? -1) >= 0);
    } finally {
      await monitor.end();
    }
  } finally {
    await admin.deleteFrom('db_capacity_snapshots').where('taken_at', '>=', now).execute();
    await worker.destroy();
    await admin.destroy();
  }
});
