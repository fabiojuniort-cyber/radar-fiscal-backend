import type { Pool } from 'pg';

export type AuditEventPlan = {
  action: string;
  entityType: string;
  count: number;
  pending: number;
  ruleExists: boolean;
};
export type AuditBackfillPlan = {
  pending: number;
  unregistered: number;
  events: AuditEventPlan[];
};
export type BackfillSummary = {
  processed: number; remaining: number; batches: number; elapsedMs: number; completed: boolean;
};
export class AuditBackfillUnknownEventsError extends Error {
  constructor(readonly events: AuditEventPlan[]) {
    super('audit_backfill_unknown_events');
    this.name = 'AuditBackfillUnknownEventsError';
  }
}

// SELECT only: include every stored action/entity pair, even already processed rows.
// Group first so policy lookup is evaluated once per event type, not per audit.
export async function planAuditBackfill(pool: Pool): Promise<AuditBackfillPlan> {
  const result = await pool.query<{
    action: string; entity_type: string; count: string; pending: string; rule_exists: boolean;
  }>(`
    WITH event_types AS MATERIALIZED (
      SELECT action, entity_type, count(*)::text AS count,
        count(*) FILTER (WHERE public.audit_backfill_pending(audit_policy_version,actor_id))::text AS pending
      FROM public.audit_log GROUP BY action, entity_type
    )
    SELECT *, public.audit_event_policy(action,entity_type) IS NOT NULL AS rule_exists
    FROM event_types ORDER BY action COLLATE "C", entity_type COLLATE "C"
  `);
  const events = result.rows.map(row => ({
    action: row.action, entityType: row.entity_type,
    count: Number(row.count), pending: Number(row.pending), ruleExists: row.rule_exists,
  }));
  return {
    pending: events.reduce((sum, event) => sum + event.pending, 0),
    unregistered: events.filter(event => !event.ruleExists).reduce((sum, event) => sum + event.count, 0),
    events,
  };
}

export async function applyAuditBackfill(
  pool: Pool, options: { batchSize?: number; maxBatches?: number } = {},
): Promise<BackfillSummary> {
  const size = options.batchSize ?? 5000, max = options.maxBatches ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isInteger(size) || size < 1 || size > 10000 || !Number.isInteger(max) || max < 1) {
    throw Error('invalid_backfill_options');
  }
  const start = performance.now();
  const plan = await planAuditBackfill(pool);
  if (plan.unregistered > 0) {
    throw new AuditBackfillUnknownEventsError(plan.events.filter(event => !event.ruleExists));
  }
  let processed = 0, batches = 0, remaining = plan.pending;
  while (remaining > 0 && batches < max) {
    // One call = one committed batch. SQL independently checks all types before
    // any data/checkpoint write, under a per-batch lock, including direct callers.
    let result;
    try {
      result = await pool.query<{ processed: number; remaining: string }>(
        'SELECT * FROM public.audit_backfill_batch($1)', [size],
      );
    } catch (error) {
      const failure = error as { code?: string; message?: string };
      if (failure.code === '55000' && failure.message === 'audit_backfill_unknown_events') {
        const current = await planAuditBackfill(pool);
        throw new AuditBackfillUnknownEventsError(current.events.filter(event => !event.ruleExists));
      }
      throw error;
    }
    processed += result.rows[0]!.processed;
    remaining = Number(result.rows[0]!.remaining);
    batches++;
    if (result.rows[0]!.processed === 0 && remaining > 0) throw Error('audit_backfill_no_progress');
  }
  return { processed, remaining, batches, elapsedMs: performance.now() - start, completed: remaining === 0 };
}
