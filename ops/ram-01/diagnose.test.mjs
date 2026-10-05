import test from 'node:test';
import assert from 'node:assert/strict';
import { QUERIES, STATEMENTS, TARGET, configFromEnv, sanitizeRows, safeErrorCode, snapshot, run, main } from './diagnose.mjs';

// Synthetic credentials only. No production URL or network used by these tests.
const fakeEnv = () => ({
  RAM01_EXECUTE: 'READ_ONLY_REVIEWED_76',
  RAILWAY_PROJECT_ID: TARGET.project, RAILWAY_ENVIRONMENT_ID: TARGET.environment,
  RAILWAY_SERVICE_NAME: TARGET.serviceName,
  RAM01_REVIEWED_SHA: 'a'.repeat(40), RAILWAY_GIT_COMMIT_SHA: 'a'.repeat(40),
  RAM01_DATABASE_URL: 'postgresql://synthetic:never-real@fixture.railway.internal:5432/fixture',
  RAM01_EXPECTED_HOST: 'fixture.railway.internal',
});
const server = (overrides = {}) => ({
  version_num: 180000, read_only: true, default_read_only: true,
  in_recovery: false, all_stats_visible: true, statements_installed: false,
  statements_public: false, database_bytes: '123', server_started_epoch: '1234.5', ...overrides,
});
function fakeClient({ failId, serverRow = server(), optionalError = false, connectError = false } = {}) {
  const calls = [];
  return {
    calls,
    async connect() { calls.push('CONNECT'); if (connectError) throw new Error('secret driver message'); },
    async end() { calls.push('END'); },
    async query(sql) {
      calls.push(sql);
      if (sql === QUERIES[0].sql) return { rows: [serverRow] };
      if (sql === QUERIES.find((q) => q.id === failId)?.sql) throw Object.assign(new Error('URL secret'), { code: '57014' });
      if (sql === STATEMENTS.sql && optionalError) throw Object.assign(new Error('URL secret'), { code: '42501' });
      return { rows: [] };
    },
  };
}

test('execution requires all exact deployment gates', () => {
  for (const key of ['RAM01_EXECUTE', 'RAILWAY_PROJECT_ID', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_SERVICE_NAME', 'RAM01_REVIEWED_SHA', 'RAILWAY_GIT_COMMIT_SHA']) {
    assert.throws(() => configFromEnv({ ...fakeEnv(), [key]: 'wrong' }), /EXECUTION_GATE/);
  }
  assert.throws(() => configFromEnv({}), /EXECUTION_GATE/);
});
test('URL validation rejects host drift, public endpoint and connection-option injection', () => {
  for (const url of ['not-a-url', 'https://synthetic:fake@fixture.railway.internal/db',
    'postgresql://synthetic:fake@public.example/db', 'postgresql://synthetic:fake@other.railway.internal/db',
    'postgresql://synthetic:fake@fixture.railway.internal:1234/db',
    'postgresql://synthetic:fake@fixture.railway.internal/db?options=-c%20default_transaction_read_only=off',
    'postgresql://synthetic:fake@fixture.railway.internal/db#fragment',
    'postgresql://fixture.railway.internal/db', 'postgresql://synthetic:fake@fixture.railway.internal/']) {
    assert.throws(() => configFromEnv({ ...fakeEnv(), RAM01_DATABASE_URL: url }), /TARGET_GATE/);
  }
});
test('read-only/startup options and one-client timeouts are fixed', () => {
  const cfg = configFromEnv(fakeEnv());
  assert.match(cfg.options, /default_transaction_read_only=on/);
  assert.match(cfg.options, /statement_timeout=3000/);
  assert.match(cfg.options, /lock_timeout=500/);
  assert.match(cfg.options, /idle_in_transaction_session_timeout=5000/);
  assert.match(cfg.options, /search_path=pg_catalog/);
  assert.equal(cfg.connectionTimeoutMillis, 5000);
  assert.equal(cfg.query_timeout, 5000);
  assert.equal(cfg.application_name, 'ram-01-readonly');
});
test('SQL is fixed SELECT-only, catalog-only; no client query text or app-table scan', () => {
  for (const q of [...QUERIES, STATEMENTS]) {
    assert.match(q.sql.trim(), /^SELECT\b/i);
    assert.doesNotMatch(q.sql, /;|\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|VACUUM|ANALYZE|COPY|RESET|GRANT|REVOKE|CALL|DO|EXPLAIN)\b/i);
    assert.doesNotMatch(q.sql, /\b(?:client_addr|client_hostname|usename|setconfig|sourcefile|pg_read_file|pg_log_backend_memory_contexts|pg_stat_reset|pg_terminate_backend|pg_cancel_backend)\b/i);
    assert.doesNotMatch(q.sql, /SELECT\s+\*/i);
    assert.ok(q.maxRows <= 256);
  }
  assert.match(STATEMENTS.sql, /public\.pg_stat_statements\(false\)/);
  assert.doesNotMatch(STATEMENTS.sql, /\bquery\b|\bqueryid\b|\buserid\b/);
});
test('sanitizer drops extra fields and does not expose arbitrary text or arbitrary app/object names', () => {
  const spec = QUERIES.find((q) => q.id === 'activity');
  const out = sanitizeRows(spec, [{ app_bucket: 'PASSWORD', state: 'idle', backend_type: 'secret',
    wait_event_type: 'Client', connections: '3', query: 'SECRET', client_addr: 'SECRET', oldest_xact_seconds: null }]);
  assert.equal(out[0].app_bucket, 'other');
  assert.equal(out[0].backend_type, 'other');
  assert.equal(out[0].connections, '3');
  assert.equal(out[0].oldest_xact_seconds, null);
  assert.doesNotMatch(JSON.stringify(out), /SECRET|PASSWORD|query|client_addr/);
  assert.throws(() => sanitizeRows(spec, [{ connections: 'secret' }]), /OUTPUT_TYPE/);
  assert.throws(() => sanitizeRows(spec, new Array(257).fill({})), /ROW_LIMIT/);
});
test('settings allow only safe enumerations/numbers with original unit', () => {
  const spec = QUERIES.find((q) => q.id === 'settings');
  assert.equal(sanitizeRows(spec, [{ name: 'shared_buffers', setting: '16384', unit: '8kB', source: 'configuration file', pending_restart: false }])[0].unit, '8kB');
  assert.throws(() => sanitizeRows(spec, [{ name: 'work_mem', setting: 'postgres://secret' }]), /OUTPUT_TYPE/);
  assert.throws(() => sanitizeRows(spec, [{ name: 'work_mem', setting: 4096 }]), /OUTPUT_TYPE/);
});
test('snapshot wraps every query in READ ONLY and ROLLBACK', async () => {
  const c = fakeClient(); const records = [];
  await snapshot(c, (r) => records.push(r), 1);
  assert.equal(c.calls[0], 'BEGIN READ ONLY');
  assert.equal(c.calls.at(-1), 'ROLLBACK');
  assert.equal(records.find((r) => r.section === 'statements_aggregate').status, 'NOT_PROVEN');
});
test('server gate fails closed on wrong major, writable session, recovery or empty row', async () => {
  for (const overrides of [{ version_num: 170001 }, { version_num: 190000 }, { read_only: false }, { default_read_only: false }, { in_recovery: true }]) {
    const c = fakeClient({ serverRow: server(overrides) });
    await assert.rejects(snapshot(c, () => {}, 1), /SERVER_GATE/);
    assert.equal(c.calls.at(-1), 'ROLLBACK');
    assert.equal(c.calls.length, 3);
  }
});
test('failure rolls back and closes client without raw error output', async () => {
  const c = fakeClient({ failId: 'database' }); const records = [];
  await assert.rejects(run(c, (r) => records.push(r)), /URL secret/);
  assert.equal(c.calls.at(-2), 'ROLLBACK'); assert.equal(c.calls.at(-1), 'END');
  assert.doesNotMatch(JSON.stringify(records), /secret/);
});
test('optional extension privilege failure remains NOT_PROVEN with SQLSTATE only', async () => {
  const c = fakeClient({ serverRow: server({ statements_installed: true, statements_public: true }), optionalError: true });
  const records = []; await snapshot(c, (r) => records.push(r), 1);
  assert.deepEqual(records.at(-1), { sample: 1, section: 'statements_aggregate', status: 'NOT_PROVEN', code: '42501' });
  assert.equal(c.calls.at(-1), 'ROLLBACK');
});
test('two fresh snapshots use one connection and wait only after ROLLBACK', async () => {
  const c = fakeClient(); let pauses = 0;
  await run(c, () => {}, async (ms) => { pauses++; assert.equal(ms, 15000); assert.equal(c.calls.at(-1), 'ROLLBACK'); });
  assert.equal(pauses, 1); assert.equal(c.calls.filter((v) => v === 'CONNECT').length, 1);
  assert.equal(c.calls.filter((v) => v === 'BEGIN READ ONLY').length, 2);
  assert.equal(c.calls.filter((v) => v === 'ROLLBACK').length, 2);
  assert.equal(c.calls.at(-1), 'END');
});
test('connect failure still closes the client', async () => {
  const c = fakeClient({ connectError: true });
  await assert.rejects(run(c, () => {})); assert.deepEqual(c.calls, ['CONNECT', 'END']);
});
test('safeErrorCode excludes message, stack, detail, URL and arbitrary codes', () => {
  assert.equal(safeErrorCode({ message: 'postgres://SECRET', stack: 'SECRET', code: 'TOKEN_SECRET' }), 'DIAGNOSTIC_FAILED');
  assert.equal(safeErrorCode({ message: 'SECRET', code: '57014' }), '57014');
  assert.equal(safeErrorCode(new Error('TARGET_GATE')), 'TARGET_GATE');
});
test('main dry-run requires no pg installation or credentials and exposes no environment', async () => {
  let output = '';
  await main(['--dry-run'], { RAM01_DATABASE_URL: 'NEVER_PRINT_THIS_SECRET' }, (line) => { output += line; });
  const out = JSON.parse(output); assert.equal(out.connection, false);
  assert.equal(out.queries.length, QUERIES.length + 1);
  assert.doesNotMatch(output, /NEVER_PRINT_THIS_SECRET/);
});
test('main defaults to refusal; invalid execution cannot import/connect pg', async () => {
  for (const args of [[], ['--execute'], ['--execute', '--dry-run'], ['--arbitrary-sql=DELETE']]) {
    let output = '';
    await assert.rejects(main(args, {}, (line) => { output += line; }), /EXECUTION_GATE/);
    assert.equal(output, '');
  }
});
