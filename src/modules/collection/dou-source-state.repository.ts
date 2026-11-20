import type { Kysely } from 'kysely';
import type { DB } from '../../infrastructure/database/database.types.js';
import type { DouState } from './dou.connector.js';
import type { DouReserveReceipts } from './dou-reserve.js';
import { ConnectorError } from './connector.error.js';

export async function readDouSourceState(db: Kysely<DB>, sourceId: string, runId: string): Promise<DouState> {
  const run = await db.selectFrom('collection_runs').select('trigger_type').where('id', '=', runId).where('source_id', '=', sourceId).executeTakeFirstOrThrow();
  if (run.trigger_type === 'BACKFILL') throw new ConnectorError('DOU backfill requires an explicit bounded date batch', { code: 'DOU_BACKFILL_DATE_BATCH_REQUIRED', kind: 'PROCESSING_ERROR', retryable: false });
  const last = await db.selectFrom('collection_attempts as ca')
    .innerJoin('collection_runs as cr', 'cr.id', 'ca.collection_run_id')
    .select(['ca.metadata', 'cr.finished_at']).where('cr.source_id', '=', sourceId)
    .where('cr.status', 'in', ['SUCCESS', 'SUCCESS_NO_RESULTS']).where('ca.status', '=', 'SUCCESS')
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
      const { rawSha256, observedSections } = value as Record<string, unknown>;
      if (typeof rawSha256 === 'string' && /^[a-f0-9]{64}$/.test(rawSha256) &&
          Array.isArray(observedSections) && observedSections.length > 0 && observedSections.length <= 2 &&
          observedSections.every(item => item === section || item === `${section}E`)) {
        reserveArchives[key] = { rawSha256, observedSections };
      }
    }
  }
  return { archives, ...(Object.keys(reserveArchives).length ? { reserveArchives } : {}), ...(last?.finished_at ? { lastSuccessAt: last.finished_at } : {}) };
}
