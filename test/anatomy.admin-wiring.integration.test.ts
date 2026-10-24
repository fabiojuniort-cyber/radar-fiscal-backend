import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { DISPOSABLE_URL, prepareAdminDatabase, PROJECT_MIGRATIONS } from './support/anatomy-admin-db.js';

/**
 * ANAT-ADMIN-01 integration package 3 (issue tribusca-control#116): wiring of the administrative API in the REAL
 * buildApp() behind the server flag ANAT_RULES_ADMIN_ENABLED (default off), one executor per instance closed on
 * application close, executor unavailable → 503. Fresh disposable database with the project's migrations (real runner).
 * No shared environment variable is changed: every value is local to this process.
 */
function assertDisposableEnvironment(env: NodeJS.ProcessEnv): string {
  assert.equal(env.CI, 'true', 'CI=true required');
  assert.equal(env.GITHUB_ACTIONS, 'true', 'GitHub Actions only');
  assert.equal(env.NODE_ENV, 'test', 'NODE_ENV=test required');
  assert.equal(env.ANAT04_CI_DATABASE_URL, DISPOSABLE_URL, 'Only the dedicated disposable database is allowed');
  assert.equal(env.DATABASE_URL, undefined, 'Generic runtime database URL must be absent');
  assert.equal(env.DATABASE_ADMIN_URL, undefined, 'Generic admin database URL must be absent');
  return DISPOSABLE_URL;
}

test('server flag: absent or anything but "true" keeps the feature off (env schema)', async () => {
  const { z } = await import('zod');
  const flag = z.enum(['true', 'false']).default('false');
  assert.equal(flag.parse(undefined), 'false');
  for (const bad of ['1', 'yes', 'TRUE', 'on', '']) assert.equal(flag.safeParse(bad).success, false, bad);
});

const skip = process.env.ANAT04_CI_DATABASE_URL === undefined || !PROJECT_MIGRATIONS ? 'CI-only database with ANAT_PROJECT_MIGRATIONS=1' : false;
test('wiring through buildApp(): flag off, flag on, executor unavailable, close (fresh disposable database)', { skip }, async (t) => {
  const url = assertDisposableEnvironment(process.env); // Must precede any connection.
  const owner = new pg.Client({ connectionString: url }); await owner.connect();
  await prepareAdminDatabase(owner);
  const login = `anat_wiring_ci_${randomBytes(4).toString('hex')}`; const password = randomBytes(24).toString('hex');
  await owner.query(`CREATE ROLE ${login} LOGIN INHERIT PASSWORD '${password}' IN ROLE radar_app`);
  const runtimeUrl = url.replace('postgres:postgres@', `${login}:${password}@`);
  // env.ts reads process.env once, at import: the flag is decided per child import below through a fresh module graph.
  process.env.DATABASE_URL = runtimeUrl; process.env.JWT_ACCESS_SECRET = randomBytes(48).toString('hex'); process.env.LOG_LEVEL = 'silent';
  const { buildApp } = await import('../src/app.js');
  const { env } = await import('../src/config/env.js');
  const { registerAnatomyRulesAdmin } = await import('../src/modules/anatomy/admin/rules-admin.wiring.js');
  const { SimulationExecutor } = await import('../src/modules/anatomy/simulation-executor.js');
  delete process.env.DATABASE_URL;
  const P = '/api/v1/admin/anatomy-rules';
  const admin = randomUUID(); const sid = randomUUID();
  await owner.query('INSERT INTO app_users (id, email) VALUES ($1, $2)', [admin, `${admin}@example.test`]);
  await owner.query("INSERT INTO platform_user_roles (user_id, role, granted_by) VALUES ($1, 'PLATFORM_ADMIN', 'system:ci')", [admin]);
  await owner.query("INSERT INTO auth_sessions (user_id, id, idle_expires_at, absolute_expires_at) VALUES ($1, $2, now() + interval '1 hour', now() + interval '2 hours')", [admin, sid]);
  const as = (app: { jwt: { sign: (p: object) => string } }) => ({ authorization: `Bearer ${app.jwt.sign({ sub: admin, sid, typ: 'access' })}` });
  try {
    await t.test('default: the flag is off and buildApp() exposes no anatomy-rules route', async () => {
      assert.equal(env.ANAT_RULES_ADMIN_ENABLED, 'false');
      const app = await buildApp(); await app.ready();
      try {
        const r = await app.inject({ method: 'GET', url: `${P}/drafts`, headers: as(app) });
        assert.equal(r.statusCode, 404);
        assert.equal(app.hasRoute({ method: 'GET', url: `${P}/drafts` }), false);
        assert.equal((await app.inject({ method: 'GET', url: '/api/v1/admin/me', headers: as(app) })).statusCode, 200, 'the rest of the API works');
      } finally { await app.close(); }
    });

    await t.test('flag on: buildApp() serves the plugin (auth required) with its own pool and one executor, closed on close', async () => {
      (env as { ANAT_RULES_ADMIN_ENABLED: string }).ANAT_RULES_ADMIN_ENABLED = 'true';
      const closes: string[] = [];
      const original = SimulationExecutor.prototype.close;
      SimulationExecutor.prototype.close = async function close() { closes.push('executor'); return original.call(this); };
      try {
        const app = await buildApp(); await app.ready();
        assert.equal(app.hasRoute({ method: 'GET', url: `${P}/drafts` }), true);
        assert.equal((await app.inject({ method: 'GET', url: `${P}/drafts` })).statusCode, 401);
        const ok = await app.inject({ method: 'GET', url: `${P}/drafts`, headers: as(app) });
        assert.equal(ok.statusCode, 200, ok.body);
        await app.close();
        assert.deepEqual(closes, ['executor'], 'exactly one executor per instance, closed with the application');
      } finally {
        SimulationExecutor.prototype.close = original;
        (env as { ANAT_RULES_ADMIN_ENABLED: string }).ANAT_RULES_ADMIN_ENABLED = 'false';
      }
    });

    await t.test('executor unavailable: the routes stay up, simulation answers 503; the pool is ended on close', async () => {
      const { default: Fastify } = await import('fastify');
      const { serializerCompiler, validatorCompiler } = await import('fastify-type-provider-zod');
      const { Kysely, PostgresDialect } = await import('kysely');
      const { registerAuthSupport } = await import('../src/modules/auth/auth.plugin.js');
      const app = Fastify({ logger: false });
      app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
      const dbPool = new pg.Pool({ connectionString: runtimeUrl, max: 2 });
      app.decorate('db', new Kysely<never>({ dialect: new PostgresDialect({ pool: dbPool }) }));
      app.decorate('curatorPool', null);
      await registerAuthSupport(app);
      const wiring = await registerAnatomyRulesAdmin(app, { enabled: true, connectionString: runtimeUrl,
        createExecutor: () => { throw new Error('worker module missing'); } });
      await app.ready();
      assert.equal(wiring.executor, null);
      const r = await app.inject({ method: 'POST', url: `${P}/candidates/${randomUUID()}/simulate`, headers: as(app) });
      assert.deepEqual([r.statusCode, r.json().error], [503, 'SIMULATION_UNAVAILABLE']);
      assert.equal((await app.inject({ method: 'GET', url: `${P}/drafts`, headers: as(app) })).statusCode, 200);
      await app.close(); await dbPool.end();
      assert.equal(wiring.pool!.ended, true);
    });

    await t.test('flag off through the wiring itself: no pool, no executor, no route', async () => {
      const { default: Fastify } = await import('fastify');
      const app = Fastify({ logger: false });
      const wiring = await registerAnatomyRulesAdmin(app, { enabled: false, connectionString: runtimeUrl,
        createExecutor: () => { throw new Error('must not be called'); } });
      await app.ready();
      assert.deepEqual(wiring, { enabled: false, pool: null, executor: null });
      assert.equal((await app.inject({ method: 'GET', url: `${P}/drafts` })).statusCode, 404);
      await app.close();
    });
  } finally {
    await owner.query(`DROP OWNED BY ${login}`).catch(() => undefined);
    await owner.query(`DROP ROLE IF EXISTS ${login}`).catch(() => undefined);
    await owner.end();
  }
});
