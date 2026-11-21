import { sql, type Kysely } from 'kysely';
import type { DB } from '../../infrastructure/database/database.types.js';
import type { DouState } from './dou.connector.js';
import type { DouReserveReceipts } from './dou-reserve.js';
import { ConnectorError } from './connector.error.js';
import { isDouEdition, readDouCoverage, type DouEditionInventory } from './dou-coverage.js';

export async function readDouSourceState(db: Kysely<DB>, sourceId: string, runId: string, trackCoverage = false): Promise<DouState> {
  const run = await db.selectFrom('collection_runs').select('trigger_type').where('id', '=', runId).where('source_id', '=', sourceId).executeTakeFirstOrThrow();
  if (run.trigger_type === 'BACKFILL') throw new ConnectorError('DOU backfill requires an explicit bounded date batch', { code: 'DOU_BACKFILL_DATE_BATCH_REQUIRED', kind: 'PROCESSING_ERROR', retryable: false });
  const last = await db.selectFrom('collection_attempts as ca')
    .innerJoin('collection_runs as cr', 'cr.id', 'ca.collection_run_id')
    .select(['ca.metadata', 'cr.finished_at', 'cr.status']).where('cr.source_id', '=', sourceId)
    .where(eb => eb.or([
      eb('cr.status', 'in', ['SUCCESS', 'SUCCESS_NO_RESULTS']),
      ...(trackCoverage ? [eb.and([
        eb('cr.status', '=', 'PARTIAL_SUCCESS'),
        // This exact engine summary is only emitted for coverage deferral with
        // zero item errors and zero connector partial failures. Other partial
        // runs cannot promote a receipt or suppress a later replay.
        sql<boolean>`cr.error_summary ~ '^MATERIAL_CONTENT_DEFERRED \\(douCoverageRows=[0-9]+\\)$'`,
        sql<boolean>`ca.metadata ? 'douCoverage'`,
      ])] : []),
    ])).where('ca.status', '=', 'SUCCESS')
    .where('cr.trigger_type', '!=', 'BACKFILL')
    .orderBy('cr.finished_at', 'desc').orderBy('ca.attempt_no', 'desc').executeTakeFirst();
  const metadata = last?.metadata as Record<string, unknown> | undefined;
  const raw = metadata?.douArchives;
  const archives: Record<string, string> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [name, value] of Object.entries(raw)) {
      if (/^\d{4}-\d{2}-\d{2}-DO[123]E?\.zip$/.test(name) && typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) archives[name] = value;
    }
  }
  const reserveArchives: DouReserveReceipts = {};
  const reserve = metadata?.douReserveArchives;
  if (reserve && typeof reserve === 'object' && !Array.isArray(reserve)) {
    for (const [key, value] of Object.entries(reserve)) {
      const section = /^\d{4}-\d{2}-\d{2}-(DO[13])$/.exec(key)?.[1];
      if (!section || !value || typeof value !== 'object' || Array.isArray(value)) continue;
      const { rawSha256, observedSections, editions } = value as Record<string, unknown>;
      if (typeof rawSha256 === 'string' && /^[a-f0-9]{64}$/.test(rawSha256) &&
          Array.isArray(observedSections) && observedSections.length <= 2 &&
          observedSections.every(item => item === section || item === `${section}E`)) {
        const verifiedEditions = readReceiptEditions(editions, section);
        reserveArchives[key] = { rawSha256, observedSections, ...(verifiedEditions ? { editions: verifiedEditions } : {}) };
      }
    }
  }
  const recentObservations = trackCoverage
    ? await db.selectFrom('collection_attempts as ca')
      .innerJoin('collection_runs as cr', 'cr.id', 'ca.collection_run_id')
      .select(sql<unknown>`ca.metadata -> 'douCoverage'`.as('coverage')).where('cr.source_id', '=', sourceId)
      .where('cr.trigger_type', '!=', 'BACKFILL').where('cr.finished_at', 'is not', null)
      .where('cr.status', '!=', 'CANCELLED')
      .where(sql<boolean>`ca.metadata ? 'douCoverage'`)
      .orderBy('cr.finished_at', 'desc').orderBy('ca.attempt_no', 'desc').limit(16).execute()
    : [];
  const [latest, ...earlier] = recentObservations.map(observation => {
    const snapshot = readDouCoverage(observation.coverage);
    if (!snapshot) throw new ConnectorError('DOU_COVERAGE_STATE_INVALID', {
      code: 'DOU_COVERAGE_STATE_INVALID', kind: 'PROCESSING_ERROR', retryable: false,
    });
    return snapshot;
  });
  // Concurrent runs can finish out of observation order. Recover recently
  // observed dates which the latest run did not see when it acquired state.
  const oldest = latest && Object.keys(latest.rows).sort()[0]?.slice(0, 10);
  for (const snapshot of earlier) {
    for (const [key, row] of Object.entries(snapshot.rows)) {
      if (row.status === 'CONFIRMED_BY_COUNT' && oldest && row.date < oldest) continue;
      const current = latest!.rows[key];
      if (!current || row.lastAttemptAt > current.lastAttemptAt) latest!.rows[key] = row;
    }
  }
  return {
    archives,
    ...(Object.keys(reserveArchives).length ? { reserveArchives } : {}),
    ...(latest ? { reserveCoverage: latest } : {}),
    ...(last?.finished_at && last.status !== 'PARTIAL_SUCCESS' ? { lastSuccessAt: last.finished_at } : {}),
  };
}

function readReceiptEditions(value: unknown, section: string): DouEditionInventory | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  for (const [key, counts] of entries) {
    if ((key !== section && key !== `${section}E`) || !counts || typeof counts !== 'object' || Array.isArray(counts)) return undefined;
    const items = Object.entries(counts);
    if (items.length > 32 || items.some(([edition, count]) => !isDouEdition(edition) || typeof count !== 'number' ||
        !Number.isSafeInteger(count) || count < 0 || count > 5000)) return undefined;
  }
  return Object.fromEntries(entries) as DouEditionInventory;
}
