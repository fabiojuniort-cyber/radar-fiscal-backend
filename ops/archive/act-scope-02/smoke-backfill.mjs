import { randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { isCronDue } from '../../dist/modules/collection/cron.js';
import { assertDouBackfillAvailable, planDouBackfillDates, readDouBackfillCoverage, runDouBackfillBatch, saoPauloDate } from '../../dist/modules/collection/dou-backfill.js';

// Single official day, one attempt, existing central collection engine.
// No alternate filter, fixture, checkpoint reset or publication deletion.
const DAY = '2026-07-15';
const POLICY = 'cada0d81-95bd-4d18-bd03-66067cc9893c';
const apply = process.argv.includes('--apply');
const db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({
  connectionString: process.env.DATABASE_URL, max: 3,
  connectionTimeoutMillis: 15_000,
}) }) });
try {
  if (!process.env.RAILWAY_PROJECT_ID || !process.env.DATABASE_URL) throw Error('RAILWAY_RUNTIME_REQUIRED');
  const source = await db.selectFrom('sources').select(['id', 'is_active', 'connector_key', 'schedule_cron', 'schedule_timezone']).where('code', '=', 'dou').executeTakeFirst();
  if (!source || !source.is_active || source.connector_key !== 'dou') throw Error('DOU_SOURCE_DRIFT');
  const policy = await sql`SELECT id,version,revision FROM collection_filter_policies WHERE status='APPROVED' ORDER BY version DESC LIMIT 1`.execute(db);
  if (policy.rows[0]?.id !== POLICY || policy.rows[0]?.version !== 1 || policy.rows[0]?.revision !== 5) throw Error('EFFECTIVE_POLICY_DRIFT');
  const coverage = await readDouBackfillCoverage(db, source.id);
  const dates = planDouBackfillDates({ from: DAY, to: DAY, today: saoPauloDate(new Date()), covered: coverage.covered });
  console.log('ACT_SCOPE_02_BACKFILL_PLAN=' + JSON.stringify({ mode: apply ? 'APPLY' : 'DRY_RUN', day: DAY, dates, attemptsMaximum: 1, acquisitionTimeoutMs: 900_000, note: 'timeout is not a wall-clock cap for persistence' }));
  if (apply) {
    if (dates.length !== 1 || dates[0] !== DAY) throw Error('DAY_ALREADY_COVERED_OR_INELIGIBLE');
    if (!process.env.INLABS_EMAIL || !process.env.INLABS_PASSWORD) throw Error('INLABS_CREDENTIALS_REQUIRED');
    await assertDouBackfillAvailable(db, source.id);
    if (source.schedule_cron !== '0 6,10,14,18 * * *' || source.schedule_timezone !== 'America/Sao_Paulo') throw Error('SCHEDULE_DRIFT');
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    // Start only with >90 minutes until the next normal DOU cycle.
    for (let n = 0; n <= 90; n++) {
      if (isCronDue(source.schedule_cron, new Date(minute + n * 60_000), source.schedule_timezone)) throw Error('SCHEDULED_CYCLE_TOO_CLOSE');
    }
    const result = await runDouBackfillBatch(db, {
      sourceId: source.id, dates, workerId: 'ACT_SCOPE_02_SMOKE_' + randomUUID(),
      credentials: () => ({ email: process.env.INLABS_EMAIL, password: process.env.INLABS_PASSWORD }),
      receipts: coverage.receipts, maxAttempts: 1, timeoutMs: 900_000,
    });
    console.log('ACT_SCOPE_02_BACKFILL_RESULT=' + JSON.stringify({ runId: result.runId, dates: result.dates, attempts: result.attempts, retryLimitReached: result.retryLimitReached ?? false, status: result.result.status, metrics: result.result.metrics }));
    if (result.retryLimitReached || !['SUCCESS', 'PARTIAL_SUCCESS'].includes(result.result.status)) process.exitCode = 2;
  }
} catch (error) {
  // Operational errors carry no connection strings/credential values.
  console.error('ACT_SCOPE_02_BACKFILL_REFUSED=' + (error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'OPERATION_FAILED'));
  process.exitCode = 1;
} finally { await db.destroy(); }
