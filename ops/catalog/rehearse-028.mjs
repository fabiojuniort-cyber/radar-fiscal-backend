// PERF-02 / migration 028 — R3 rehearsal runner (Issue tribusca-control#55).
//
// Runs inside Railway only. It prints counts, sizes, timings and object names;
// never row contents or connection strings.
//
// MODE=preflight  read-only checks against production (PROD_DATABASE_ADMIN_URL),
//                 every statement inside a READ ONLY transaction.
// MODE=rehearse   on the PITR restore: migration 028 timed with disk sampling,
//                 then `npm run db:prepare` and ops/catalog/028-validate.sql.
// MODE=dumpcheck  compares the migrated restore with its pg_dump/pg_restore copy
//                 (database perf028_dumpcheck on the same restore server).
//
// The restore target is derived from the production URLs by replacing host
// and port with RESTORE_HOST, which must be a tmp-perf-028-* private domain.
// Child processes never receive the production URLs.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import pg from 'pg';

const RESTORE_HOST_PREFIX = 'tmp-perf-028-restore.';
const DUMPCHECK_DATABASE = 'perf028_dumpcheck';
const EXPECTED_MIGRATION_SHA256 = process.env.EXPECTED_MIGRATION_SHA256;

function log(label, value) {
  console.log(
    `[rehearse-028] ${label}${value === undefined ? '' : ` ${JSON.stringify(value)}`}`,
  );
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function retarget(url, host, database) {
  const parsed = new URL(url);
  parsed.hostname = host;
  parsed.port = '5432';
  if (database) {
    parsed.pathname = `/${database}`;
  }
  return parsed.toString();
}

function restoreTargets() {
  const restoreHost = requireEnv('RESTORE_HOST');
  const prodAdmin = new URL(requireEnv('PROD_DATABASE_ADMIN_URL'));
  const prodApp = new URL(requireEnv('PROD_DATABASE_URL'));

  if (!restoreHost.startsWith(RESTORE_HOST_PREFIX)) {
    throw new Error('RESTORE_HOST is not a tmp-perf-028-restore domain');
  }
  if (
    restoreHost === prodAdmin.hostname
    || restoreHost === prodApp.hostname
  ) {
    throw new Error('RESTORE_HOST equals the production host');
  }

  return {
    admin: retarget(prodAdmin.toString(), restoreHost),
    app: retarget(prodApp.toString(), restoreHost),
    host: restoreHost,
  };
}

async function withClient(connectionString, fn) {
  const client = new pg.Client({
    connectionString,
    statement_timeout: 0,
    application_name: 'perf-028-rehearsal',
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function readOnly(connectionString, fn) {
  const client = new pg.Client({
    connectionString,
    application_name: 'perf-028-preflight',
    options: '-c default_transaction_read_only=on -c statement_timeout=60000 -c lock_timeout=2000',
  });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const result = await fn(client);
    await client.query('ROLLBACK');
    return result;
  } finally {
    await client.end();
  }
}

const SIZE_SQL = `
  SELECT c.relname AS relation,
         c.reltuples::bigint AS estimated_rows,
         pg_relation_size(c.oid) AS heap_bytes,
         pg_indexes_size(c.oid) AS index_bytes,
         pg_total_relation_size(c.oid) AS total_bytes
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('publications', 'publication_versions',
                      'publication_origins', 'publication_source_feed', 'sources')
  ORDER BY c.relname`;

async function describeServer(client) {
  const server = await client.query(`
    SELECT current_setting('server_version') AS server_version,
           current_user,
           r.rolsuper AS is_superuser,
           has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_in_database,
           pg_is_in_recovery() AS in_recovery,
           pg_database_size(current_database()) AS database_bytes
    FROM pg_roles r WHERE r.rolname = current_user`);
  log('server', server.rows[0]);

  const settings = await client.query(`
    SELECT name, setting, unit FROM pg_settings
    WHERE name IN ('statement_timeout', 'lock_timeout',
                   'idle_in_transaction_session_timeout', 'max_wal_size',
                   'maintenance_work_mem', 'work_mem', 'shared_buffers',
                   'max_parallel_maintenance_workers', 'default_text_search_config')
    ORDER BY name`);
  log('settings', settings.rows);

  const roleSettings = await client.query(`
    SELECT s.setrole <> 0 AS for_role, s.setdatabase <> 0 AS for_database, s.setconfig
    FROM pg_db_role_setting s
    WHERE s.setrole IN (0, (SELECT oid FROM pg_roles WHERE rolname = current_user))
      AND s.setdatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))`);
  log('role_database_settings', roleSettings.rows);

  const extensions = await client.query(`
    SELECT a.name, a.default_version, a.installed_version,
           coalesce(e.extversion IS NOT NULL, false) AS installed
    FROM pg_available_extensions a
    LEFT JOIN pg_extension e ON e.extname = a.name
    WHERE a.name = 'unaccent'`);
  log('unaccent', extensions.rows);

  const trusted = await client.query(`
    SELECT name, trusted FROM pg_available_extension_versions
    WHERE name = 'unaccent' ORDER BY version DESC LIMIT 1`);
  log('unaccent_trusted', trusted.rows);

  const sizes = await client.query(SIZE_SQL);
  log('relations', sizes.rows);

  const migrations = await client.query(`
    SELECT count(*)::int AS applied,
           max(filename) AS latest,
           count(*) FILTER (WHERE filename = '028_catalog_scale.sql')::int AS has_028
    FROM schema_migrations`);
  log('schema_migrations', migrations.rows[0]);
}

async function preflight() {
  const prod = requireEnv('PROD_DATABASE_ADMIN_URL');

  await readOnly(prod, async (client) => {
    await describeServer(client);

    const activity = await client.query(`
      SELECT coalesce(application_name, '') AS application_name,
             state,
             count(*)::int AS sessions,
             max(extract(epoch FROM now() - xact_start))::int AS oldest_xact_seconds
      FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
      GROUP BY 1, 2 ORDER BY 1, 2`);
    log('activity', activity.rows);

    const locks = await client.query(`
      SELECT c.relname AS relation, l.mode, l.granted, count(*)::int AS locks
      FROM pg_locks l
      JOIN pg_class c ON c.oid = l.relation
      WHERE c.relname IN ('publications', 'publication_versions',
                          'publication_origins', 'sources')
        AND l.pid <> pg_backend_pid()
      GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`);
    log('locks', locks.rows);

    const prepared = await client.query(
      'SELECT count(*)::int AS prepared_xacts FROM pg_prepared_xacts',
    );
    log('prepared_xacts', prepared.rows[0]);
  });

  log('preflight done');
}

function runNpm(script, env) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn('npm', ['run', script], {
      env,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      const seconds = (Date.now() - started) / 1000;
      if (code === 0) {
        resolve(seconds);
      } else {
        reject(new Error(`npm run ${script} exited with ${code} after ${seconds}s`));
      }
    });
  });
}

function childEnv(targets) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('PROD_')) {
      delete env[key];
    }
  }
  env.DATABASE_ADMIN_URL = targets.admin;
  env.DATABASE_URL = targets.app;
  return env;
}

async function assertRestoreTarget(targets) {
  const prodAddr = await readOnly(
    requireEnv('PROD_DATABASE_ADMIN_URL'),
    async (client) => (await client.query(
      'SELECT host(inet_server_addr()) AS addr',
    )).rows[0].addr,
  );

  await withClient(targets.admin, async (client) => {
    const { rows } = await client.query(`
      SELECT host(inet_server_addr()) AS addr, pg_is_in_recovery() AS in_recovery`);
    if (!rows[0].addr || rows[0].addr === prodAddr) {
      throw new Error('restore target resolves to the production server');
    }
    if (rows[0].in_recovery) {
      throw new Error('restore target is still in recovery');
    }
  });
  log('target', { host: targets.host, distinct_from_production: true });
}

async function sampleDisk(connectionString, stopSignal) {
  const samples = [];
  const client = new pg.Client({
    connectionString,
    application_name: 'perf-028-disk-sampler',
  });
  await client.connect();
  try {
    while (!stopSignal.stopped) {
      try {
        const { rows } = await client.query(`
          SELECT pg_database_size(current_database())::bigint AS database_bytes,
                 (SELECT coalesce(sum(size), 0) FROM pg_ls_waldir())::bigint AS wal_bytes,
                 (SELECT coalesce(sum(temp_bytes), 0) FROM pg_stat_database)::bigint AS temp_bytes_total`);
        samples.push({ at: Date.now(), ...rows[0] });
      } catch (error) {
        samples.push({ at: Date.now(), error: error.message });
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  } finally {
    await client.end().catch(() => {});
  }
  return samples;
}

function summarizeSamples(samples) {
  const valid = samples.filter((sample) => !sample.error);
  const max = (key) => valid.reduce(
    (best, sample) => Math.max(best, Number(sample[key])),
    0,
  );
  const sumMax = valid.reduce(
    (best, sample) => Math.max(
      best,
      Number(sample.database_bytes) + Number(sample.wal_bytes),
    ),
    0,
  );
  return {
    samples: samples.length,
    errors: samples.length - valid.length,
    max_database_bytes: max('database_bytes'),
    max_wal_bytes: max('wal_bytes'),
    max_database_plus_wal_bytes: sumMax,
  };
}

function splitValidationSql(text) {
  const steps = [];
  let buffer = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('\\echo ')) {
      steps.push({ echo: line.slice(6).trim() });
      continue;
    }
    if (line.startsWith('--') && buffer.length === 0) {
      continue;
    }
    buffer.push(line);
    if (/;\s*$/.test(line)) {
      steps.push({ sql: buffer.join('\n') });
      buffer = [];
    }
  }
  return steps;
}

async function runValidation(connectionString, label) {
  const text = await readFile(new URL('./028-validate.sql', import.meta.url), 'utf8');
  const started = Date.now();
  await withClient(connectionString, async (client) => {
    for (const step of splitValidationSql(text)) {
      if (step.echo) {
        log(`${label} ${step.echo}`);
        continue;
      }
      const result = await client.query(step.sql);
      if (result.rows?.length) {
        const rows = result.fields?.[0]?.name === 'QUERY PLAN'
          ? result.rows.map((row) => row['QUERY PLAN'])
          : result.rows;
        log(`${label} rows`, rows);
      }
    }
  });
  log(`${label} seconds`, (Date.now() - started) / 1000);
}

async function rehearse() {
  const migration = await readFile(
    new URL('../../migrations/028_catalog_scale.sql', import.meta.url),
  );
  const sha256 = createHash('sha256').update(migration).digest('hex');
  log('migration_028_sha256', sha256);
  if (EXPECTED_MIGRATION_SHA256 && EXPECTED_MIGRATION_SHA256 !== sha256) {
    throw new Error('migration 028 checksum differs from the frozen artifact');
  }

  const targets = restoreTargets();
  await assertRestoreTarget(targets);

  await withClient(targets.admin, async (client) => {
    log('before');
    await describeServer(client);
  });

  const stopSignal = { stopped: false };
  const sampler = sampleDisk(targets.admin, stopSignal);
  const env = childEnv(targets);
  let migrateSeconds;
  try {
    migrateSeconds = await runNpm('db:migrate', env);
  } finally {
    stopSignal.stopped = true;
  }
  log('migrate_seconds', migrateSeconds);
  log('disk_during_migration', summarizeSamples(await sampler));

  await withClient(targets.admin, async (client) => {
    log('after');
    await describeServer(client);
  });

  log('db_prepare_seconds', await runNpm('db:prepare', env));

  await withClient(targets.admin, async (client) => {
    const started = Date.now();
    await client.query('ANALYZE publications, publication_versions, publication_source_feed');
    log('analyze_seconds', (Date.now() - started) / 1000);
  });

  await runValidation(targets.admin, 'validate');
  log('rehearse done');
}

const FINGERPRINT_SQL = `
  SELECT
    (SELECT count(*) FROM pg_extension WHERE extname = 'unaccent')::int AS unaccent_extension,
    (SELECT count(*) FROM pg_ts_config WHERE cfgname = 'pt_unaccent')::int AS pt_unaccent_config,
    (SELECT string_agg(attrelid::regclass || '.' || attname, ',' ORDER BY attrelid::regclass::text, attname)
       FROM pg_attribute
       WHERE attgenerated = 's' AND NOT attisdropped
         AND attrelid IN ('public.publications'::regclass,
                          'public.publication_versions'::regclass)) AS generated_columns,
    (SELECT string_agg(indexname, ',' ORDER BY indexname) FROM pg_indexes
       WHERE schemaname = 'public'
         AND (indexname IN ('ix_publications_visible_order', 'ix_publications_title_vector',
                            'ix_publication_source_feed_order')
              OR indexname LIKE '%search_vector%')) AS indexes,
    (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname IN ('ix_publications_visible_order', 'ix_publications_title_vector',
                           'ix_publication_source_feed_order')
         AND i.indisvalid)::int AS valid_new_indexes,
    (SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger
       WHERE NOT tgisinternal AND tgname LIKE '%source_feed%') AS feed_triggers,
    (SELECT count(*) FROM public.publication_source_feed)::bigint AS feed_rows,
    (SELECT md5(string_agg(md5(source_code || ':' || publication_id || ':' || is_hidden),
                           ',' ORDER BY source_code, publication_id))
       FROM public.publication_source_feed) AS feed_md5,
    (SELECT count(*) FROM public.publications)::bigint AS publications,
    (SELECT count(*) FROM public.publications WHERE is_hidden)::bigint AS hidden,
    (SELECT count(*) FROM public.publications WHERE is_confaz)::bigint AS confaz,
    (SELECT md5(string_agg(md5(id || ':' || title_vector::text), ',' ORDER BY id))
       FROM public.publications) AS title_vector_md5,
    (SELECT md5(string_agg(md5(id || ':' || coalesce(search_vector::text, '')), ',' ORDER BY id))
       FROM public.publication_versions) AS search_vector_md5,
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname LIKE '%source_feed%' AND p.prosecdef)::int
       AS secdef_functions`;

async function dumpcheck() {
  const targets = restoreTargets();
  await assertRestoreTarget(targets);
  const copy = retarget(targets.admin, targets.host, DUMPCHECK_DATABASE);

  const fingerprints = {};
  for (const [label, url] of [['migrated', targets.admin], ['dump_restored', copy]]) {
    fingerprints[label] = await withClient(
      url,
      async (client) => (await client.query(FINGERPRINT_SQL)).rows[0],
    );
    log(`fingerprint ${label}`, fingerprints[label]);
  }

  const differences = Object.keys(fingerprints.migrated).filter(
    (key) => String(fingerprints.migrated[key]) !== String(fingerprints.dump_restored[key]),
  );
  log('fingerprint_differences', differences);

  await runValidation(copy, 'validate_dump_restored');
  log('dumpcheck done');
}

const modes = { preflight, rehearse, dumpcheck };
const mode = process.env.MODE;

if (!modes[mode]) {
  console.error(`[rehearse-028] unknown MODE ${mode}`);
  process.exit(2);
}

modes[mode]()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`[rehearse-028] failed: ${error.message}`);
    process.exit(1);
  });
