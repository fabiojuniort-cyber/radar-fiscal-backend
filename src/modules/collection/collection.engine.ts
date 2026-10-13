import { createHash } from 'node:crypto';

import { sql, type Kysely } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';
import {
  finishCollectionAttempt,
  finishCollectionRun,
  heartbeatCollectionRun,
  scheduleCollectionRetry,
  startCollectionAttempt,
  type AcquiredCollectionRun,
} from './collection-run.repository.js';
import type {
  ConnectorNewsItem,
  ConnectorPublication,
  ConnectorResult,
} from './connector.contract.js';
import { connectorPublicationCount } from './connector.contract.js';
import { ConnectorError } from './connector.error.js';
import { createCollectionMemoryProbe } from './collection.memory.js';
import {
  evaluateRuntimeCollectionFilter,
  loadApprovedCollectionFilterRuntime,
  recordRuntimeCollectionDiscard,
  recordRuntimeDiscardRate,
  recordRuntimeUnknownType,
} from './collection-filter.runtime.js';
import { disposePublicationSpool } from './publication-spool.js';
import {
  executeConnector,
  type ConnectorExecutionFailure,
  type ConnectorExecutionOutcome,
} from './connector.executor.js';
import { ConnectorRegistry } from './connector.registry.js';
import { normalizeNewsItem } from './news.normalizer.js';
import {
  persistNewsItem,
  recordNewsCollectionItemFailure,
} from './news.persistence.js';
import {
  normalizePublication,
} from './publication.normalizer.js';
import {
  persistPublication,
  recordCollectionItemFailure,
  type PublicationDisposition,
} from './publication.persistence.js';
import {
  decideRetry,
  type RetryPolicyOptions,
} from './retry.policy.js';
import {
  resolveCollectionRunStatus,
  type CollectionRunTerminalStatus,
} from './run-status.js';

export interface CollectionEngineLogger {
  info(
    data: Record<string, unknown>,
    message: string,
  ): void;
  warn(
    data: Record<string, unknown>,
    message: string,
  ): void;
  error(
    data: Record<string, unknown>,
    message: string,
  ): void;
}

export interface CollectionEngineOptions {
  timeoutMs?: number;
  /**
   * Time reserved at the end of the attempt for a graceful yield (the soft
   * deadline is timeoutMs - budgetGraceMs). Defaults to defaultBudgetGraceMs.
   */
  budgetGraceMs?: number;
  heartbeatIntervalMs?: number;
  retryPolicy?: RetryPolicyOptions;
  logger?: CollectionEngineLogger;
}

export interface CollectionEngineMetrics {
  /** Publications + news items returned by the connector. */
  found: number;
  /** Publications + news items persisted or recognized as existing. */
  processed: number;
  newPublications: number;
  existingPublications: number;
  newVersions: number;
  itemErrors: number;
  connectorPartialFailures: number;
}

export interface CollectionEngineResult {
  runId: string;
  attemptNo: number;
  state: 'TERMINAL' | 'RETRY_SCHEDULED';
  status?: CollectionRunTerminalStatus;
  nextAttemptAt?: Date;
  metrics: CollectionEngineMetrics;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

function noopLogger(): CollectionEngineLogger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function emptyMetrics(): CollectionEngineMetrics {
  return {
    found: 0,
    processed: 0,
    newPublications: 0,
    existingPublications: 0,
    newVersions: 0,
    itemErrors: 0,
    connectorPartialFailures: 0,
  };
}

function dispositionMetric(
  metrics: CollectionEngineMetrics,
  disposition: PublicationDisposition,
): void {
  switch (disposition) {
    case 'NEW_PUBLICATION':
      metrics.newPublications += 1;
      break;
    case 'EXISTING_PUBLICATION':
      metrics.existingPublications += 1;
      break;
    case 'NEW_VERSION':
      metrics.newVersions += 1;
      break;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Unknown collection item processing error';
}

function sourceItemKey(
  publication: ConnectorPublication,
  index: number,
): string {
  const externalId = publication.externalId?.trim();

  if (externalId) {
    return externalId;
  }

  const officialUrl = publication.officialUrl?.trim();

  if (officialUrl) {
    return officialUrl;
  }

  return `invalid:${index}:${createHash('sha256')
    .update(
      JSON.stringify({
        title: publication.title,
        sphere: publication.sphere,
        agency: publication.agency ?? null,
        actType: publication.actType ?? null,
        actNumber: publication.actNumber ?? null,
      }),
      'utf8',
    )
    .digest('hex')}`;
}

function newsSourceItemKey(
  item: ConnectorNewsItem,
  index: number,
): string {
  const externalId = item.externalId?.trim();
  if (externalId) return externalId;

  const officialUrl = item.officialUrl?.trim();
  if (officialUrl) return officialUrl;

  return `invalid-news:${index}:${createHash('sha256')
    .update(
      JSON.stringify({
        title: item.title,
        agency: item.agency ?? null,
        category: item.category ?? null,
      }),
      'utf8',
    )
    .digest('hex')}`;
}

function resultItemCount(
  outcome: Extract<ConnectorExecutionOutcome, { ok: true }>,
): number {
  return connectorPublicationCount(outcome.result) +
    (outcome.result.newsItems?.length ?? 0);
}

function missingConnectorOutcome(
  connectorKey: string,
): ConnectorExecutionFailure {
  return {
    ok: false,
    status: 'PROCESSING_ERROR',
    durationMs: 0,
    code: 'CONNECTOR_NOT_REGISTERED',
    message: `Connector not registered: ${connectorKey}`,
    retryable: false,
  };
}

function terminalStatusAfterProcessing(
  outcome: Extract<
    ConnectorExecutionOutcome,
    { ok: true }
  >,
  metrics: CollectionEngineMetrics,
): CollectionRunTerminalStatus {
  const itemCount = resultItemCount(outcome);

  if (
    metrics.itemErrors > 0 &&
    metrics.processed === 0 &&
    itemCount > 0 &&
    metrics.connectorPartialFailures === 0
  ) {
    return 'PROCESSING_FAILED';
  }

  if (
    metrics.itemErrors > 0 ||
    metrics.connectorPartialFailures > 0 ||
    outcome.result.completion?.complete === false
  ) {
    return 'PARTIAL_SUCCESS';
  }

  return itemCount > 0
    ? 'SUCCESS'
    : 'SUCCESS_NO_RESULTS';
}

/**
 * Structured summary for PARTIAL_SUCCESS runs. A voluntary early stop is
 * reported with its reason first (e.g. TIME_BUDGET_REACHED) so it is never
 * confused with a timeout or a failure.
 */
function partialSummary(
  outcome: Extract<ConnectorExecutionOutcome, { ok: true }>,
  metrics: CollectionEngineMetrics,
): string | undefined {
  const parts: string[] = [];
  const completion = outcome.result.completion;
  if (completion?.complete === false) {
    const pending = Object.entries(completion.pending ?? {})
      .map(([key, value]) => key + '=' + value)
      .join(', ');
    parts.push((completion.reason ?? 'INCOMPLETE') + (pending ? ' (' + pending + ')' : ''));
  }
  if (metrics.itemErrors > 0 || metrics.connectorPartialFailures > 0) {
    parts.push(`Partial processing: ${metrics.itemErrors} item errors, ${metrics.connectorPartialFailures} connector partial failures`);
  }
  return parts.length ? parts.join('; ') : undefined;
}

export async function processAcquiredCollectionRun(
  db: Kysely<DB>,
  registry: ConnectorRegistry,
  run: AcquiredCollectionRun,
  options: CollectionEngineOptions = {},
): Promise<CollectionEngineResult> {
  const logger = options.logger ?? noopLogger();
  const timeoutMs =
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ??
    DEFAULT_HEARTBEAT_INTERVAL_MS;

  const connector = registry.has(run.connectorKey)
    ? registry.get(run.connectorKey)
    : undefined;

  const attempt = await startCollectionAttempt(
    db,
    run.id,
    run.workerId,
    connector?.version,
  );

  const metrics = emptyMetrics();

  logger.info(
    {
      sourceId: run.sourceId,
      runId: run.id,
      attemptId: attempt.id,
      attemptNo: attempt.attemptNo,
      connectorKey: run.connectorKey,
      correlationId: run.correlationId,
      workerId: run.workerId,
    },
    'Collection attempt started',
  );

  let heartbeatTimer: NodeJS.Timeout | undefined;
  let collectedResult: ConnectorResult | undefined;
  const memory = run.connectorKey === 'dou'
    ? createCollectionMemoryProbe(sample => logger.info({
        sourceId: run.sourceId, runId: run.id, attemptId: attempt.id, ...sample,
      }, 'Collection memory sample'))
    : undefined;

  if (heartbeatIntervalMs > 0) {
    heartbeatTimer = setInterval(() => {
      void heartbeatCollectionRun(
        db,
        run.id,
        run.workerId,
      )
        .then((owned) => {
          if (!owned) {
            logger.warn(
              {
                runId: run.id,
                workerId: run.workerId,
              },
              'Collection heartbeat lost run ownership',
            );
          }
        })
        .catch((error: unknown) => {
          logger.error(
            {
              runId: run.id,
              workerId: run.workerId,
              error: errorMessage(error),
            },
            'Collection heartbeat failed',
          );
        });
    }, heartbeatIntervalMs);

    heartbeatTimer.unref();
  }

  try {
    const outcome: ConnectorExecutionOutcome = connector
        ? await executeConnector({
            connector,
            sourceId: run.sourceId,
            runId: run.id,
            attemptId: attempt.id,
            timeoutMs,
            ...(memory ? { memory } : {}),
            ...(options.budgetGraceMs !== undefined ? { budgetGraceMs: options.budgetGraceMs } : {}),
          })
        : missingConnectorOutcome(run.connectorKey);

    if (outcome.ok) collectedResult = outcome.result;

    const finishedAttempt = await finishCollectionAttempt(db, {
      attemptId: attempt.id,
      outcome,
      runId: run.id,
      workerId: run.workerId,
      sourceId: run.sourceId,
      connectorKey: run.connectorKey,
    });
    if (!finishedAttempt) {
      // The recovering owner decides this run's status. Do not replay a
      // stale spool/array, publish checkpoints, schedule retries or finish it.
      throw new ConnectorError('Collection run ownership was lost before persistence.', {
        code: 'COLLECTION_RUN_OWNERSHIP_LOST', kind: 'CANCELLED', retryable: false,
      });
    }

    if (!outcome.ok) {
      const persistentDouRetry =
        run.connectorKey === 'dou' &&
        outcome.retryable;

      const retry = decideRetry(
        {
          attemptNo: attempt.attemptNo,
          // DOU/INLABS is operationally intermittent. Retryable transport/source
          // failures keep the same run alive until a successful consultation.
          // Non-retryable failures still terminate immediately.
          maxAttempts:
            persistentDouRetry
              ? Number.MAX_SAFE_INTEGER
              : run.maxAttempts,
          retryable: outcome.retryable,
          ...(persistentDouRetry
            ? { retryAfterSeconds: 20 }
            : outcome.retryAfterSeconds !== undefined
              ? {
                  retryAfterSeconds:
                    outcome.retryAfterSeconds,
                }
              : {}),
        },
        persistentDouRetry
          ? {
              baseDelayMs: 20_000,
              maxBackoffMs: 20_000,
            }
          : options.retryPolicy,
      );

      if (retry.shouldRetry && retry.delayMs !== null) {
        const nextAttemptAt = new Date(
          Date.now() + retry.delayMs,
        );

        await scheduleCollectionRetry(db, {
          runId: run.id,
          workerId: run.workerId,
          nextAttemptAt,
          errorSummary:
            `${outcome.code}: ${outcome.message}`,
        });

        logger.warn(
          {
            sourceId: run.sourceId,
            runId: run.id,
            attemptId: attempt.id,
            attemptNo: attempt.attemptNo,
            status: outcome.status,
            errorCode: outcome.code,
            errorMessage: outcome.message,
            errorMetadata: outcome.metadata ?? null,
            durationMs: outcome.durationMs,
            nextAttemptAt:
              nextAttemptAt.toISOString(),
          },
          'Collection retry scheduled',
        );

        return {
          runId: run.id,
          attemptNo: attempt.attemptNo,
          state: 'RETRY_SCHEDULED',
          nextAttemptAt,
          metrics,
        };
      }

      const status = resolveCollectionRunStatus(outcome);

      await finishCollectionRun(db, {
        runId: run.id,
        workerId: run.workerId,
        status,
        errorSummary:
          `${outcome.code}: ${outcome.message}`,
      });

      logger.error(
        {
          sourceId: run.sourceId,
          runId: run.id,
          attemptId: attempt.id,
          attemptNo: attempt.attemptNo,
          status,
          attemptStatus: outcome.status,
          errorCode: outcome.code,
          errorMessage: outcome.message,
          errorMetadata: outcome.metadata ?? null,
          durationMs: outcome.durationMs,
        },
        'Collection run failed',
      );

      return {
        runId: run.id,
        attemptNo: attempt.attemptNo,
        state: 'TERMINAL',
        status,
        metrics,
      };
    }

    const newsItems = outcome.result.newsItems ?? [];
    metrics.found = connectorPublicationCount(outcome.result) + newsItems.length;

    let filterRuntime: Awaited<
      ReturnType<typeof loadApprovedCollectionFilterRuntime>
    > | undefined;

    let filterEvaluated = 0;
    let filteredPublications = 0;
    metrics.connectorPartialFailures =
      outcome.result.partialFailures?.length ?? 0;

    memory?.('persist_start', { publications: metrics.found, spoolBytes: outcome.result.publicationStream?.bytes ?? 0 });
    // The executor only returns a sealed spool after collect succeeds. Replay
    // is sequential and awaited, retaining one complete publication at a time.
    const publicationInput = outcome.result.publicationStream ?? outcome.result.publications;
    let index = -1;
    for await (const publication of publicationInput) {
      index += 1;

      try {
        const normalized = normalizePublication({
          sourceId: run.sourceId,
          publication,
        });

        if (filterRuntime === undefined) {
          try {
            filterRuntime = await loadApprovedCollectionFilterRuntime(
              db,
              run.sourceId,
            );
          } catch (error) {
            throw Object.assign(
              new Error('COLLECTION_FILTER_RUNTIME_UNAVAILABLE'),
              { cause: error },
            );
          }
        }

        let runtimeDecision = filterRuntime
          ? evaluateRuntimeCollectionFilter(
              filterRuntime,
              normalized,
            )
          : null;

        if (runtimeDecision?.decision.decision === 'DISCARD') {
          const protection = await sql<{protected:boolean}>`SELECT public.collection_filter_capture_protected(
            ${normalized.identityHash},${run.sourceId}::uuid,${normalized.officialUrl}) AS protected`.execute(db);
          if (protection.rows[0]?.protected) {
            runtimeDecision = {...runtimeDecision,decision:{...runtimeDecision.decision,
              decision:'KEEP',reasonCode:'PROTECTED_PUBLICATION'}};
            logger.info({sourceId:run.sourceId,runId:run.id},'F3 publication retained for company/origin review');
          }
        }

        if (runtimeDecision) {
          filterEvaluated += 1;
        }

        if (
          filterRuntime &&
          runtimeDecision?.decision.decision === 'DISCARD'
        ) {
          await recordRuntimeCollectionDiscard(db, {
            runtime: filterRuntime,
            runId: run.id,
            attemptId: attempt.id,
            publication: normalized,
            decision: runtimeDecision,
          });
          filteredPublications += 1;
          metrics.processed += 1;
          continue;
        }

        const persisted = await db
          .transaction()
          .execute(async (trx) => {
            const result = await persistPublication(trx, {
              sourceId: run.sourceId,
              runId: run.id,
              attemptId: attempt.id,
              publication: normalized,
            });
            if (
              filterRuntime &&
              runtimeDecision?.decision.requiresNewTypeReview
            ) {
              await recordRuntimeUnknownType(trx, {
                runtime: filterRuntime,
                publicationId: result.publicationId,
                decision: runtimeDecision,
              });
            }
            return result;
          });

        metrics.processed += 1;
        dispositionMetric(
          metrics,
          persisted.disposition,
        );
      } catch (error) {
        metrics.itemErrors += 1;

        await db.transaction().execute((trx) =>
          recordCollectionItemFailure(trx, {
            runId: run.id,
            attemptId: attempt.id,
            sourceItemKey: sourceItemKey(
              publication,
              index,
            ),
            ...(publication.externalId
              ? {
                  externalId:
                    publication.externalId,
                }
              : {}),
            ...(publication.officialUrl
              ? {
                  sourceUrl:
                    publication.officialUrl,
                }
              : {}),
            metadata: publication.metadata ?? {},
            errorCode: 'PUBLICATION_PROCESSING_ERROR',
            errorMessage: errorMessage(error),
          }),
        );

        logger.warn(
          {
            sourceId: run.sourceId,
            runId: run.id,
            attemptId: attempt.id,
            itemReference: sourceItemKey(
              publication,
              index,
            ),
            error: errorMessage(error),
          },
          'Publication processing failed',
        );
      }
      if ((index + 1) % 100 === 0) memory?.('persist_progress', { publications: index + 1 });
    }

    for (let index = 0; index < newsItems.length; index += 1) {
      const item = newsItems[index]!;

      try {
        const normalized = normalizeNewsItem({
          sourceId: run.sourceId,
          item,
        });

        await db.transaction().execute((trx) =>
          persistNewsItem(trx, {
            sourceId: run.sourceId,
            runId: run.id,
            attemptId: attempt.id,
            item: normalized,
          }),
        );

        metrics.processed += 1;
      } catch (error) {
        metrics.itemErrors += 1;

        await db.transaction().execute((trx) =>
          recordNewsCollectionItemFailure(trx, {
            runId: run.id,
            attemptId: attempt.id,
            sourceItemKey: newsSourceItemKey(item, index),
            ...(item.externalId
              ? { externalId: item.externalId }
              : {}),
            ...(item.officialUrl
              ? { sourceUrl: item.officialUrl }
              : {}),
            metadata: item.metadata ?? {},
            errorCode: 'NEWS_PROCESSING_ERROR',
            errorMessage: errorMessage(error),
          }),
        );

        logger.warn(
          {
            sourceId: run.sourceId,
            runId: run.id,
            attemptId: attempt.id,
            itemReference: newsSourceItemKey(item, index),
            error: errorMessage(error),
          },
          'News processing failed',
        );
      }
    }

    if (filterRuntime && filterEvaluated > 0) {
      try {
        const alerted = await recordRuntimeDiscardRate(db, {
          runtime: filterRuntime,
          runId: run.id,
          foundCount: filterEvaluated,
          discardCount: filteredPublications,
        });
        if (alerted) {
          logger.warn(
            {
              sourceId: run.sourceId,
              runId: run.id,
              filterEvaluated,
              filteredPublications,
              policyVersion: filterRuntime.policyVersion,
              policyRevision: filterRuntime.policyRevision,
            },
            'Abnormal collection filter discard rate detected',
          );
        }
      } catch (error) {
        logger.error(
          {
            sourceId: run.sourceId,
            runId: run.id,
            error: errorMessage(error),
          },
          'Collection filter discard-rate telemetry failed',
        );
      }
    }

    const status = terminalStatusAfterProcessing(
      outcome,
      metrics,
    );
    memory?.('persist_complete', { publications: metrics.processed });
    // Cleanup is part of successful replay, before terminal status can make
    // receipts eligible. The finally path still handles every earlier exit.
    await disposePublicationSpool(outcome.result.publicationStream);

    await finishCollectionRun(db, {
      runId: run.id,
      workerId: run.workerId,
      status,
      ...(partialSummary(outcome, metrics)
        ? { errorSummary: partialSummary(outcome, metrics)! }
        : {}),
    });

    logger.info(
      {
        sourceId: run.sourceId,
        runId: run.id,
        attemptId: attempt.id,
        attemptNo: attempt.attemptNo,
        status,
        durationMs: outcome.durationMs,
        ...metrics,
        filterEvaluated,
        filteredPublications,
        filterPolicyVersion: filterRuntime?.policyVersion ?? null,
        filterPolicyRevision: filterRuntime?.policyRevision ?? null,
        newsFound: newsItems.length,
        ...(outcome.result.completion?.complete === false
          ? {
              incompleteReason: outcome.result.completion.reason ?? 'UNSPECIFIED',
              pending: outcome.result.completion.pending ?? {},
            }
          : {}),
      },
      'Collection run completed',
    );

    return {
      runId: run.id,
      attemptNo: attempt.attemptNo,
      state: 'TERMINAL',
      status,
      metrics,
    };
  } catch (error) {
    if (!(error instanceof ConnectorError) || !error.code.startsWith('PUBLICATION_SPOOL_')) throw error;
    // A corrupt/unreadable spool must never promote the attempt's receipts.
    await finishCollectionRun(db, {
      runId: run.id, workerId: run.workerId, status: 'PROCESSING_FAILED',
      errorSummary: error.code,
    });
    logger.error({ runId: run.id, attemptId: attempt.id, errorCode: error.code }, 'Collection spool replay failed');
    return { runId: run.id, attemptNo: attempt.attemptNo, state: 'TERMINAL', status: 'PROCESSING_FAILED', metrics };
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    try { await disposePublicationSpool(collectedResult?.publicationStream); }
    catch {
      logger.error({ runId: run.id, attemptId: attempt.id, errorCode: 'PUBLICATION_SPOOL_CLEANUP_FAILED' }, 'Collection spool cleanup failed');
    }
    memory?.('cleanup');
  }
}
