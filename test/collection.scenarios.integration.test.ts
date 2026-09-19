import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  Kysely,
  PostgresDialect,
} from 'kysely';
import { Pool } from 'pg';

import type { DB } from '../src/infrastructure/database/database.types.js';
import {
  acquireNextCollectionRun,
  createCollectionRun,
} from '../src/modules/collection/collection-run.repository.js';
import {
  processAcquiredCollectionRun,
  type CollectionEngineResult,
} from '../src/modules/collection/collection.engine.js';
import { ConnectorRegistry } from '../src/modules/collection/connector.registry.js';
import {
  createMandatorySimulatedConnectors,
  type ScriptedSimulatedConnector,
} from '../src/modules/collection/simulated.connectors.js';

interface ScenarioContext {
  sourceId: string;
  runIds: string[];
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) =>
    setTimeout(resolve, ms),
  );
}

async function createScenarioSource(
  db: Kysely<DB>,
  connector: ScriptedSimulatedConnector,
  maxAttempts: number,
): Promise<string> {
  const sourceId = randomUUID();

  await db
    .insertInto('sources')
    .values({
      id: sourceId,
      code: `scenario-${sourceId}`,
      name: `Scenario ${connector.key}`,
      jurisdiction_level: 'FEDERAL',
      base_url: 'https://simulated.example.test',
      connector_key:
        `${connector.key}-${sourceId}`,
      max_attempts: maxAttempts,
    })
    .execute();

  return sourceId;
}

async function createScenarioRun(
  db: Kysely<DB>,
  sourceId: string,
  offsetMs = 0,
): Promise<string> {
  return createCollectionRun(db, {
    sourceId,
    scheduledFor: new Date(
      Date.now() - 60_000 + offsetMs,
    ),
    triggerType: 'MANUAL',
  });
}

async function runUntilTerminal(
  db: Kysely<DB>,
  registry: ConnectorRegistry,
  connectorKey: string,
  sourceId: string,
): Promise<CollectionEngineResult> {
  for (let iteration = 0; iteration < 10; iteration += 1) {
    const run =
      await acquireNextCollectionRun(
        db,
        `worker-${connectorKey}`,
      );

    if (!run) {
      await sleep(5);
      continue;
    }

    assert.equal(run.sourceId, sourceId);

    const result =
      await processAcquiredCollectionRun(
        db,
        registry,
        run,
        {
          timeoutMs: 15,
          heartbeatIntervalMs: 0,
          retryPolicy: {
            baseDelayMs: 0,
            maxBackoffMs: 0,
          },
        },
      );

    if (result.state === 'TERMINAL') {
      return result;
    }
  }

  assert.fail(
    `Scenario ${connectorKey} did not reach a terminal state`,
  );
}

async function cleanupScenario(
  db: Kysely<DB>,
  context: ScenarioContext,
): Promise<void> {
  const publicationIds = await db
    .selectFrom('publication_origins')
    .select('publication_id')
    .where('source_id', '=', context.sourceId)
    .execute()
    .then((rows) => [
      ...new Set(
        rows.map((row) => row.publication_id),
      ),
    ]);

  if (context.runIds.length > 0) {
    await db
      .deleteFrom('collection_runs')
      .where('id', 'in', context.runIds)
      .execute();
  }

  await db
    .deleteFrom('publication_origins')
    .where('source_id', '=', context.sourceId)
    .execute();

  if (publicationIds.length > 0) {
    const stillReferenced = await db
      .selectFrom('publication_origins')
      .select('publication_id')
      .where('publication_id', 'in', publicationIds)
      .execute()
      .then(
        (rows) =>
          new Set(
            rows.map((row) => row.publication_id),
          ),
      );

    const deletable = publicationIds.filter(
      (id) => !stillReferenced.has(id),
    );

    if (deletable.length > 0) {
      await db
        .deleteFrom('publications')
        .where('id', 'in', deletable)
        .execute();
    }
  }

  await db
    .deleteFrom('sources')
    .where('id', '=', context.sourceId)
    .execute();
}

test(
  'mandatory simulated collection scenarios',
  async (t) => {
    const adminUrl = process.env.DATABASE_ADMIN_URL;

    assert.ok(
      adminUrl,
      'DATABASE_ADMIN_URL is required for simulated collection integration tests.',
    );

    const pool = new Pool({
      connectionString: adminUrl,
      max: 4,
    });

    const db = new Kysely<DB>({
      dialect: new PostgresDialect({ pool }),
    });

    const scenarios =
      createMandatorySimulatedConnectors();

    async function executeScenario(
      connector: ScriptedSimulatedConnector,
      maxAttempts = 1,
    ): Promise<{
      context: ScenarioContext;
      registry: ConnectorRegistry;
      result: CollectionEngineResult;
    }> {
      const registry = new ConnectorRegistry();
      const sourceId = await createScenarioSource(
        db,
        connector,
        maxAttempts,
      );

      const source = await db
        .selectFrom('sources')
        .select('connector_key')
        .where('id', '=', sourceId)
        .executeTakeFirstOrThrow();

      registry.register({
        key: source.connector_key,
        version: connector.version,
        collect: (context) =>
          connector.collect(context),
      });

      const runId = await createScenarioRun(
        db,
        sourceId,
      );

      const result = await runUntilTerminal(
        db,
        registry,
        source.connector_key,
        sourceId,
      );

      return {
        context: {
          sourceId,
          runIds: [runId],
        },
        registry,
        result,
      };
    }

    await t.test(
      '1. success with new publication',
      async () => {
        const scenario = await executeScenario(
          scenarios.successWithNew,
        );

        try {
          assert.equal(
            scenario.result.status,
            'SUCCESS',
          );
          assert.equal(
            scenario.result.metrics.newPublications,
            1,
          );

          const count = await db
            .selectFrom('publication_origins')
            .select(({ fn }) =>
              fn.countAll<number>().as('count'),
            )
            .where(
              'source_id',
              '=',
              scenario.context.sourceId,
            )
            .executeTakeFirstOrThrow();

          assert.equal(Number(count.count), 1);
        } finally {
          await cleanupScenario(
            db,
            scenario.context,
          );
        }
      },
    );

    await t.test(
      '2. success with no publications',
      async () => {
        const scenario = await executeScenario(
          scenarios.noResults,
        );

        try {
          assert.equal(
            scenario.result.status,
            'SUCCESS_NO_RESULTS',
          );
          assert.equal(
            scenario.result.metrics.found,
            0,
          );
        } finally {
          await cleanupScenario(
            db,
            scenario.context,
          );
        }
      },
    );

    await t.test(
      '3. duplicate publication does not duplicate persistence',
      async () => {
        const scenario = await executeScenario(
          scenarios.duplicatePublication,
        );

        try {
          assert.equal(
            scenario.result.status,
            'SUCCESS',
          );
          assert.equal(
            scenario.result.metrics.found,
            2,
          );
          assert.equal(
            scenario.result.metrics.newPublications,
            1,
          );
          assert.equal(
            scenario.result.metrics.existingPublications,
            1,
          );

          const items = await db
            .selectFrom('collection_items')
            .select('id')
            .where(
              'collection_run_id',
              '=',
              scenario.context.runIds[0]!,
            )
            .execute();

          const links = await db
            .selectFrom(
              'collection_run_publications',
            )
            .select('publication_id')
            .where(
              'collection_run_id',
              '=',
              scenario.context.runIds[0]!,
            )
            .execute();

          assert.equal(items.length, 1);
          assert.equal(links.length, 1);
        } finally {
          await cleanupScenario(
            db,
            scenario.context,
          );
        }
      },
    );

    await t.test(
      '4. same identity with updated content creates a new version',
      async () => {
        const connector =
          scenarios.updatedContent;
        const registry = new ConnectorRegistry();
        const sourceId =
          await createScenarioSource(
            db,
            connector,
            1,
          );

        const source = await db
          .selectFrom('sources')
          .select('connector_key')
          .where('id', '=', sourceId)
          .executeTakeFirstOrThrow();

        registry.register({
          key: source.connector_key,
          version: connector.version,
          collect: (context) =>
            connector.collect(context),
        });

        const firstRun =
          await createScenarioRun(
            db,
            sourceId,
            0,
          );

        const first = await runUntilTerminal(
          db,
          registry,
          source.connector_key,
          sourceId,
        );

        const secondRun =
          await createScenarioRun(
            db,
            sourceId,
            1_000,
          );

        const second = await runUntilTerminal(
          db,
          registry,
          source.connector_key,
          sourceId,
        );

        const context = {
          sourceId,
          runIds: [firstRun, secondRun],
        };

        try {
          assert.equal(first.status, 'SUCCESS');
          assert.equal(
            first.metrics.newPublications,
            1,
          );
          assert.equal(second.status, 'SUCCESS');
          assert.equal(
            second.metrics.newVersions,
            1,
          );

          const publication = await db
            .selectFrom('publication_origins')
            .select('publication_id')
            .where('source_id', '=', sourceId)
            .executeTakeFirstOrThrow();

          const versions = await db
            .selectFrom('publication_versions')
            .select([
              'version_no',
              'is_current',
            ])
            .where(
              'publication_id',
              '=',
              publication.publication_id,
            )
            .orderBy('version_no')
            .execute();

          assert.deepEqual(versions, [
            {
              version_no: 1,
              is_current: false,
            },
            {
              version_no: 2,
              is_current: true,
            },
          ]);
        } finally {
          await cleanupScenario(db, context);
        }
      },
    );

    await t.test(
      '5. timeout is traceable and closes as FETCH_FAILED when attempts are exhausted',
      async () => {
        const scenario = await executeScenario(
          scenarios.timeout,
          1,
        );

        try {
          assert.equal(
            scenario.result.status,
            'FETCH_FAILED',
          );

          const attempts = await db
            .selectFrom('collection_attempts')
            .select([
              'status',
              'error_code',
            ])
            .where(
              'collection_run_id',
              '=',
              scenario.context.runIds[0]!,
            )
            .execute();

          assert.deepEqual(attempts, [
            {
              status: 'TIMEOUT',
              error_code: 'CONNECTOR_TIMEOUT',
            },
          ]);
        } finally {
          await cleanupScenario(
            db,
            scenario.context,
          );
        }
      },
    );

    await t.test(
      '6. fetch error closes as FETCH_FAILED',
      async () => {
        const scenario = await executeScenario(
          scenarios.fetchError,
        );

        try {
          assert.equal(
            scenario.result.status,
            'FETCH_FAILED',
          );
        } finally {
          await cleanupScenario(
            db,
            scenario.context,
          );
        }
      },
    );

    await t.test(
      '7. parser or processing error closes as PROCESSING_FAILED',
      async () => {
        const scenario = await executeScenario(
          scenarios.processingError,
        );

        try {
          assert.equal(
            scenario.result.status,
            'PROCESSING_FAILED',
          );
        } finally {
          await cleanupScenario(
            db,
            scenario.context,
          );
        }
      },
    );

    await t.test(
      '8. partial result closes as PARTIAL_SUCCESS',
      async () => {
        const scenario = await executeScenario(
          scenarios.partialResult,
        );

        try {
          assert.equal(
            scenario.result.status,
            'PARTIAL_SUCCESS',
          );
          assert.equal(
            scenario.result.metrics
              .connectorPartialFailures,
            1,
          );
          assert.equal(
            scenario.result.metrics.processed,
            1,
          );
        } finally {
          await cleanupScenario(
            db,
            scenario.context,
          );
        }
      },
    );

    await t.test(
      '9. initial failure retries and then succeeds',
      async () => {
        const scenario = await executeScenario(
          scenarios.retrySuccess,
          3,
        );

        try {
          assert.equal(
            scenario.result.status,
            'SUCCESS',
          );
          assert.equal(
            scenarios.retrySuccess.calls,
            2,
          );

          const attempts = await db
            .selectFrom('collection_attempts')
            .select([
              'attempt_no',
              'status',
            ])
            .where(
              'collection_run_id',
              '=',
              scenario.context.runIds[0]!,
            )
            .orderBy('attempt_no')
            .execute();

          assert.deepEqual(attempts, [
            {
              attempt_no: 1,
              status: 'FETCH_ERROR',
            },
            {
              attempt_no: 2,
              status: 'SUCCESS',
            },
          ]);
        } finally {
          await cleanupScenario(
            db,
            scenario.context,
          );
        }
      },
    );

    await t.test(
      '10. retries exhausted preserves every failed attempt',
      async () => {
        const scenario = await executeScenario(
          scenarios.retriesExhausted,
          2,
        );

        try {
          assert.equal(
            scenario.result.status,
            'FETCH_FAILED',
          );
          assert.equal(
            scenarios.retriesExhausted.calls,
            2,
          );

          const attempts = await db
            .selectFrom('collection_attempts')
            .select([
              'attempt_no',
              'status',
              'retryable',
            ])
            .where(
              'collection_run_id',
              '=',
              scenario.context.runIds[0]!,
            )
            .orderBy('attempt_no')
            .execute();

          assert.deepEqual(attempts, [
            {
              attempt_no: 1,
              status: 'FETCH_ERROR',
              retryable: true,
            },
            {
              attempt_no: 2,
              status: 'FETCH_ERROR',
              retryable: true,
            },
          ]);
        } finally {
          await cleanupScenario(
            db,
            scenario.context,
          );
        }
      },
    );

    await db.destroy();
  },
);
