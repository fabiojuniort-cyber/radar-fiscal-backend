// RAM-01 / tribusca-control#76. Preparation only; see README gates.
// No application imports, migrations, role changes, arbitrary SQL or secret output.
import { pathToFileURL } from 'node:url';

export const TARGET = Object.freeze({
  project: 'd7291d78-020d-42d5-8cd9-c387a156a580',
  environment: 'c6963775-4b79-4ef7-a82e-0435b8c39102',
  serviceName: 'tmp-ram-01-readonly',
});
const SETTINGS = Object.freeze([
  'shared_buffers', 'shared_memory_size', 'block_size', 'min_dynamic_shared_memory',
  'io_method', 'io_workers', 'io_max_concurrency', 'compute_query_id',
  'work_mem', 'hash_mem_multiplier', 'maintenance_work_mem',
  'autovacuum_work_mem', 'temp_buffers', 'effective_cache_size', 'max_connections',
  'reserved_connections', 'superuser_reserved_connections', 'max_worker_processes',
  'max_parallel_workers', 'max_parallel_workers_per_gather',
  'max_parallel_maintenance_workers', 'autovacuum_max_workers',
  'autovacuum_worker_slots', 'autovacuum_vacuum_cost_limit',
  'autovacuum_vacuum_scale_factor', 'autovacuum_analyze_scale_factor',
  'wal_buffers', 'min_wal_size', 'max_wal_size', 'checkpoint_timeout',
  'checkpoint_completion_target', 'temp_file_limit', 'track_counts',
  'track_io_timing', 'track_wal_io_timing', 'log_min_duration_statement',
  'log_temp_files', 'jit', 'huge_pages', 'shared_memory_type',
]);
const RELATIONS = Object.freeze([
  'publications', 'publication_versions', 'publication_origins',
  'publication_source_feed', 'collection_items', 'collection_runs',
  'collection_attempts', 'collection_run_publications', 'sources',
  'norma_clara_translations',
]);
const quoted = (values) => values.map((v) => `'${v}'`).join(', ');
const relationLabel = `CASE WHEN c.relname IN (${quoted(RELATIONS)}) THEN c.relname ELSE 'other_relation' END`;
const query = (id, sql, fields, maxRows = 1) => Object.freeze({ id, sql, fields, maxRows });
const numericFields = (names) => Object.fromEntries(names.split(' ').map((key) => [key, 'number']));
const enumOf = (...values) => Object.freeze(values);

export const QUERIES = Object.freeze([
  query('server', `SELECT current_setting('server_version_num')::int AS version_num,
    current_setting('transaction_read_only') = 'on' AS read_only,
    current_setting('default_transaction_read_only') = 'on' AS default_read_only,
    pg_catalog.pg_is_in_recovery() AS in_recovery,
    pg_catalog.pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') AS all_stats_visible,
    pg_catalog.pg_database_size(current_database()) AS database_bytes,
    extract(epoch FROM pg_catalog.pg_postmaster_start_time()) AS server_started_epoch,
    EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_stat_statements') AS statements_installed,
    EXISTS (SELECT 1 FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname = 'pg_stat_statements' AND n.nspname = 'public') AS statements_public`, {
    ...numericFields('version_num database_bytes server_started_epoch'),
    read_only: 'boolean', default_read_only: 'boolean', in_recovery: 'boolean',
    all_stats_visible: 'boolean', statements_installed: 'boolean', statements_public: 'boolean',
  }),
  query('settings', `SELECT name, setting, unit, source, pending_restart
    FROM pg_catalog.pg_settings WHERE name IN (${quoted(SETTINGS)}) ORDER BY name`, {
    name: enumOf(...SETTINGS), setting: 'setting',
    unit: enumOf('B', 'kB', 'MB', 'GB', '8kB', '16MB', 'ms', 's', 'min', 'h', 'd', 'us'),
    source: enumOf('default', 'dynamic default', 'environment variable', 'configuration file',
      'command line', 'global', 'database', 'user', 'database user', 'client', 'override', 'interactive', 'test', 'session'),
    pending_restart: 'boolean',
  }, SETTINGS.length),
  query('activity', `SELECT
    CASE WHEN coalesce(application_name, '') = '' THEN 'unset'
      WHEN application_name IN ('radar-fiscal-backend', 'radar-fiscal-worker', 'radar-fiscal-scheduler')
      THEN application_name ELSE 'other_named' END AS app_bucket,
    state, backend_type, wait_event_type, count(*) AS connections,
    max(extract(epoch FROM clock_timestamp() - xact_start)) AS oldest_xact_seconds,
    max(extract(epoch FROM clock_timestamp() - backend_start)) AS oldest_connection_seconds,
    max(extract(epoch FROM clock_timestamp() - query_start)) FILTER (WHERE state = 'active') AS oldest_active_seconds
    FROM pg_catalog.pg_stat_activity
    WHERE pid <> pg_catalog.pg_backend_pid() AND (datname = current_database() OR datid IS NULL)
    GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4 LIMIT 256`, {
    app_bucket: enumOf('unset', 'radar-fiscal-backend', 'radar-fiscal-worker', 'radar-fiscal-scheduler', 'other_named'),
    state: enumOf('starting', 'active', 'idle', 'idle in transaction', 'idle in transaction (aborted)', 'fastpath function call', 'disabled'),
    backend_type: enumOf('autovacuum launcher', 'autovacuum worker', 'logical replication launcher',
      'logical replication worker', 'parallel worker', 'background writer', 'client backend',
      'checkpointer', 'archiver', 'standalone backend', 'startup', 'walreceiver', 'walsender', 'walwriter', 'walsummarizer', 'io worker'),
    wait_event_type: enumOf('Activity', 'BufferPin', 'Client', 'Extension', 'InjectionPoint', 'IO', 'IPC', 'Lock', 'LWLock', 'Timeout'),
    ...numericFields('connections oldest_xact_seconds oldest_connection_seconds oldest_active_seconds'),
  }, 256),
  query('database', `SELECT numbackends, xact_commit, xact_rollback, blks_read, blks_hit,
    tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted,
    conflicts, temp_files, temp_bytes, deadlocks, blk_read_time, blk_write_time,
    sessions, sessions_abandoned, sessions_fatal, sessions_killed,
    session_time, active_time, idle_in_transaction_time,
    extract(epoch FROM stats_reset) AS stats_reset_epoch
    FROM pg_catalog.pg_stat_database WHERE datname = current_database()`, numericFields(
    'numbackends xact_commit xact_rollback blks_read blks_hit tup_returned tup_fetched tup_inserted tup_updated tup_deleted conflicts temp_files temp_bytes deadlocks blk_read_time blk_write_time sessions sessions_abandoned sessions_fatal sessions_killed session_time active_time idle_in_transaction_time stats_reset_epoch')),
  query('relations', `SELECT ${relationLabel} AS relation,
    c.reltuples AS estimated_rows, pg_catalog.pg_table_size(c.oid) AS table_bytes,
    pg_catalog.pg_indexes_size(c.oid) AS index_bytes,
    pg_catalog.pg_total_relation_size(c.oid) AS total_bytes,
    s.n_live_tup, s.n_dead_tup, s.n_mod_since_analyze,
    s.seq_scan, s.idx_scan, s.autovacuum_count, s.autoanalyze_count,
    extract(epoch FROM s.last_autovacuum) AS last_autovacuum_epoch,
    extract(epoch FROM s.last_autoanalyze) AS last_autoanalyze_epoch
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_stat_user_tables s ON s.relid = c.oid
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'm')
    ORDER BY total_bytes DESC, c.oid LIMIT 20`, {
    relation: enumOf(...RELATIONS, 'other_relation'),
    ...numericFields('estimated_rows table_bytes index_bytes total_bytes n_live_tup n_dead_tup n_mod_since_analyze seq_scan idx_scan autovacuum_count autoanalyze_count last_autovacuum_epoch last_autoanalyze_epoch'),
  }, 20),
  query('indexes', `SELECT ${relationLabel} AS relation,
    pg_catalog.pg_relation_size(i.indexrelid) AS index_bytes,
    i.indisvalid AS valid, i.indisready AS ready, s.idx_scan, s.idx_tup_read, s.idx_tup_fetch
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_stat_user_indexes s ON s.indexrelid = i.indexrelid
    WHERE n.nspname = 'public' ORDER BY index_bytes DESC, i.indexrelid LIMIT 20`, {
    relation: enumOf(...RELATIONS, 'other_relation'), valid: 'boolean', ready: 'boolean',
    ...numericFields('index_bytes idx_scan idx_tup_read idx_tup_fetch'),
  }, 20),
  query('locks', `SELECT locktype, mode, granted, count(*) AS locks
    FROM pg_catalog.pg_locks
    WHERE pid IS DISTINCT FROM pg_catalog.pg_backend_pid()
      AND (database IS NULL OR database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database()))
    GROUP BY 1, 2, 3 ORDER BY 1, 2, 3 LIMIT 64`, {
    locktype: enumOf('relation', 'extend', 'frozenid', 'page', 'tuple', 'transactionid', 'virtualxid', 'spectoken', 'object', 'userlock', 'advisory', 'applytransaction'),
    mode: enumOf('AccessShareLock', 'RowShareLock', 'RowExclusiveLock', 'ShareUpdateExclusiveLock', 'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock', 'SIReadLock'),
    granted: 'boolean', locks: 'number',
  }, 64),
  query('checkpointer', `SELECT num_timed, num_requested, num_done, write_time,
    sync_time, buffers_written, extract(epoch FROM stats_reset) AS stats_reset_epoch
    FROM pg_catalog.pg_stat_checkpointer`, numericFields('num_timed num_requested num_done write_time sync_time buffers_written stats_reset_epoch')),
  query('bgwriter', `SELECT buffers_clean, maxwritten_clean, buffers_alloc,
    extract(epoch FROM stats_reset) AS stats_reset_epoch FROM pg_catalog.pg_stat_bgwriter`,
  numericFields('buffers_clean maxwritten_clean buffers_alloc stats_reset_epoch')),
  query('wal', `SELECT wal_records, wal_fpi, wal_bytes, wal_buffers_full,
    extract(epoch FROM stats_reset) AS stats_reset_epoch FROM pg_catalog.pg_stat_wal`,
  numericFields('wal_records wal_fpi wal_bytes wal_buffers_full stats_reset_epoch')),
  query('archiver', `SELECT archived_count, failed_count,
    extract(epoch FROM last_archived_time) AS last_archived_epoch,
    extract(epoch FROM last_failed_time) AS last_failed_epoch,
    extract(epoch FROM stats_reset) AS stats_reset_epoch FROM pg_catalog.pg_stat_archiver`,
  numericFields('archived_count failed_count last_archived_epoch last_failed_epoch stats_reset_epoch')),
  query('replication_retention', `SELECT count(*) AS slots,
    count(*) FILTER (WHERE active) AS active_slots,
    max(pg_catalog.pg_wal_lsn_diff(pg_catalog.pg_current_wal_lsn(), restart_lsn)) AS max_retained_wal_bytes
    FROM pg_catalog.pg_replication_slots`, numericFields('slots active_slots max_retained_wal_bytes')),
]);

// showtext=false prevents the extension from returning query text at all.
export const STATEMENTS = query('statements_aggregate', `SELECT count(*) AS entries,
  coalesce(sum(calls), 0) AS calls, coalesce(sum(total_exec_time), 0) AS total_exec_ms,
  max(max_exec_time) AS max_exec_ms, coalesce(sum(shared_blks_hit), 0) AS shared_blks_hit,
  coalesce(sum(shared_blks_read), 0) AS shared_blks_read,
  coalesce(sum(temp_blks_read), 0) AS temp_blks_read,
  coalesce(sum(temp_blks_written), 0) AS temp_blks_written
  FROM public.pg_stat_statements(false)
  WHERE dbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())`,
numericFields('entries calls total_exec_ms max_exec_ms shared_blks_hit shared_blks_read temp_blks_read temp_blks_written'));

export function sanitizeRows(spec, rows) {
  if (!Array.isArray(rows) || rows.length > spec.maxRows) throw new Error('ROW_LIMIT');
  return rows.map((row) => Object.fromEntries(Object.entries(spec.fields).map(([key, type]) => {
    const value = row[key];
    if (value === null || value === undefined) return [key, null];
    if (type === 'boolean' && typeof value === 'boolean') return [key, value];
    if (type === 'number') {
      if ((typeof value === 'number' && Number.isFinite(value)) ||
          (typeof value === 'string' && value.length <= 64 && /^-?\d+(\.\d+)?$/.test(value))) return [key, value];
      throw new Error('OUTPUT_TYPE');
    }
    if (type === 'setting' && typeof value === 'string' && value.length <= 64 &&
        (/^-?\d+(\.\d+)?$/.test(value) || ['on', 'off', 'auto', 'try', 'mmap', 'sysv', 'windows', 'sync', 'worker', 'io_uring'].includes(value))) return [key, value];
    if (Array.isArray(type)) return [key, type.includes(value) ? value : 'other'];
    throw new Error('OUTPUT_TYPE');
  })));
}

export function configFromEnv(env) {
  if (env.RAM01_EXECUTE !== 'READ_ONLY_REVIEWED_76' ||
      env.RAILWAY_PROJECT_ID !== TARGET.project || env.RAILWAY_ENVIRONMENT_ID !== TARGET.environment ||
      env.RAILWAY_SERVICE_NAME !== TARGET.serviceName ||
      !/^[a-f0-9]{40}$/.test(env.RAM01_REVIEWED_SHA ?? '') ||
      env.RAILWAY_GIT_COMMIT_SHA !== env.RAM01_REVIEWED_SHA) throw new Error('EXECUTION_GATE');
  let parsed;
  try { parsed = new URL(env.RAM01_DATABASE_URL); } catch { throw new Error('TARGET_GATE'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.username || !parsed.password ||
      !parsed.pathname || parsed.pathname === '/' || parsed.search || parsed.hash ||
      !env.RAM01_EXPECTED_HOST || parsed.hostname !== env.RAM01_EXPECTED_HOST ||
      !parsed.hostname.endsWith('.railway.internal') || (parsed.port && parsed.port !== '5432')) throw new Error('TARGET_GATE');
  return {
    connectionString: env.RAM01_DATABASE_URL,
    application_name: 'ram-01-readonly',
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
    options: '-c default_transaction_read_only=on -c statement_timeout=3000 -c lock_timeout=500 -c idle_in_transaction_session_timeout=5000 -c search_path=pg_catalog',
  };
}

export function safeErrorCode(error) {
  const codes = ['EXECUTION_GATE', 'TARGET_GATE', 'SERVER_GATE', 'ROW_LIMIT', 'OUTPUT_TYPE', 'OUTPUT_LIMIT'];
  if (codes.includes(error?.message)) return error.message;
  // Never emit the driver message/detail/hint/stack or arbitrary error.code.
  return /^[0-9A-Z]{5}$/.test(error?.code ?? '') ? error.code : 'DIAGNOSTIC_FAILED';
}

export async function snapshot(client, emit, sample) {
  await client.query('BEGIN READ ONLY');
  try {
    let server;
    for (const spec of QUERIES) {
      const { rows } = await client.query(spec.sql);
      const safe = sanitizeRows(spec, rows);
      if (spec.id === 'server') {
        server = safe[0];
        if (!server || Number(server.version_num) < 180000 || Number(server.version_num) >= 190000 ||
            server.read_only !== true || server.default_read_only !== true || server.in_recovery !== false) throw new Error('SERVER_GATE');
      }
      emit({ sample, section: spec.id, rows: safe });
    }
    if (server.statements_public) {
      let result;
      try {
        result = await client.query(STATEMENTS.sql);
      } catch (error) {
        // Only expected PostgreSQL availability/privilege failures are optional.
        // Sanitization/output failures and transport/timeouts must fail closed.
        if (!['42501', '42883', '42P01', '42703', '55000'].includes(error?.code)) throw error;
        emit({ sample, section: STATEMENTS.id, status: 'NOT_PROVEN', code: safeErrorCode(error) });
      }
      if (result) emit({ sample, section: STATEMENTS.id, rows: sanitizeRows(STATEMENTS, result.rows) });
    } else {
      emit({ sample, section: STATEMENTS.id, status: 'NOT_PROVEN', reason: 'NOT_INSTALLED_IN_PUBLIC' });
    }
  } finally {
    await client.query('ROLLBACK');
  }
}

export async function run(client, emit, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  try {
    await client.connect();
    for (let sample = 1; sample <= 2; sample++) {
      emit({ sample, section: 'sample_start', at: new Date().toISOString() });
      await snapshot(client, emit, sample);
      if (sample === 1) await pause(15000); // Outside the transaction; fresh statistics next time.
    }
  } finally {
    await client.end();
  }
  emit({ section: 'complete', status: 'READ_ONLY_COMPLETED', samples: 2 });
}

export async function main(argv = process.argv.slice(2), env = process.env, write = (line) => process.stdout.write(line)) {
  let bytes = 0;
  const emit = (record) => {
    const line = JSON.stringify({ scope: 'ram-01', ...record });
    bytes += Buffer.byteLength(line) + 1;
    if (bytes > 192 * 1024) throw new Error('OUTPUT_LIMIT');
    write(line + '\n');
  };
  if (argv.length === 1 && argv[0] === '--dry-run') {
    emit({ section: 'dry_run', connection: false, queries: [...QUERIES, STATEMENTS].map(({ id, sql, maxRows }) => ({ id, sql, maxRows })) });
    return;
  }
  if (argv.length !== 1 || argv[0] !== '--execute') throw new Error('EXECUTION_GATE');
  const config = configFromEnv(env);
  const { default: pg } = await import('pg');
  const client = new pg.Client(config); // Exactly one connection. No pool.
  client.on('error', () => {}); // Suppress raw asynchronous driver errors; requests/watchdog fail closed.
  const watchdog = setTimeout(() => {
    emit({ section: 'failure', code: 'DEADLINE_EXCEEDED' });
    process.exit(1); // Socket closes; open read-only transaction is rolled back server-side.
  }, 120000);
  try { await run(client, emit); } finally { clearTimeout(watchdog); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(JSON.stringify({ scope: 'ram-01', section: 'failure', code: safeErrorCode(error) }) + '\n');
    process.exitCode = 1;
  });
}
