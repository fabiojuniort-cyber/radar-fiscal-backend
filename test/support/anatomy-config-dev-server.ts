import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { DISPOSABLE_URL, prepareAdminDatabase, PROJECT_MIGRATIONS } from './anatomy-admin-db.js';

/**
 * TEST/DEV HARNESS ONLY (ANAT-CONFIG-01, issue #116): serves the REAL accessible-configuration API (routes, SQL entry
 * points of 081, isolated executor, JWT + session check) over a FRESH disposable database with the project's
 * migrations, so the web screen can be exercised end to end in a browser. The only non-production pieces are the
 * harness endpoints under /auth/__dev-* (switch between synthetic users: two platform admins and one non-admin).
 * It refuses to start outside the disposable environment.
 * Usage: CI=true GITHUB_ACTIONS=true NODE_ENV=test ANAT_PROJECT_MIGRATIONS=1 ANAT04_CI_DATABASE_URL=<disposable> node --import tsx this-file [port]
 */
const env = process.env;
if (env.CI !== 'true' || env.GITHUB_ACTIONS !== 'true' || env.NODE_ENV !== 'test' || env.ANAT04_CI_DATABASE_URL !== DISPOSABLE_URL || !PROJECT_MIGRATIONS
  || env.DATABASE_URL !== undefined || env.DATABASE_ADMIN_URL !== undefined) {
  throw new Error('ANAT04_DISPOSABLE_CI_ONLY: refusing to start the anatomy config dev harness');
}
process.env.DATABASE_URL = DISPOSABLE_URL; process.env.JWT_ACCESS_SECRET = randomBytes(48).toString('hex');
const [{ default: Fastify }, { serializerCompiler, validatorCompiler }, { Kysely, PostgresDialect }, { registerAuthSupport }, { anatomyConfigRoutes },
  { SimulationExecutor }, { isPlatformAdmin }] = await Promise.all([
  import('fastify'), import('fastify-type-provider-zod'), import('kysely'), import('../../src/modules/auth/auth.plugin.js'),
  import('../../src/api/routes/anatomy-config.route.js'), import('../../src/modules/anatomy/simulation-executor.js'), import('../../src/modules/auth/platform-role.js')]);
delete process.env.DATABASE_URL;

const owner = new pg.Client({ connectionString: DISPOSABLE_URL }); await owner.connect();
await prepareAdminDatabase(owner);
const login = `anat_cfg_dev_${randomBytes(4).toString('hex')}`; const password = randomBytes(24).toString('hex');
await owner.query(`CREATE ROLE ${login} LOGIN INHERIT PASSWORD '${password}' IN ROLE radar_app`);
const pool = new pg.Pool({ connectionString: DISPOSABLE_URL.replace('postgres:postgres@', `${login}:${password}@`), max: 4 });
const executor = new SimulationExecutor();
const app = Fastify({ logger: false });
app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
app.decorate('db', new Kysely<any>({ dialect: new PostgresDialect({ pool }) })); app.decorate('curatorPool', null);
await registerAuthSupport(app);
await app.register(anatomyConfigRoutes, { pool, executor });

const users: Record<string, { id: string; sid: string; email: string; name: string }> = {};
for (const [name, admin] of [['ana', true], ['bruno', true], ['visitante', false]] as const) {
  const id = randomUUID(); const sid = randomUUID(); const email = `${name}@example.test`;
  await owner.query('INSERT INTO app_users (id, email) VALUES ($1, $2)', [id, email]);
  if (admin) await owner.query("INSERT INTO platform_user_roles (user_id, role, granted_by) VALUES ($1, 'PLATFORM_ADMIN', 'system:ci')", [id]);
  await owner.query("INSERT INTO auth_sessions (id, user_id, idle_expires_at, absolute_expires_at) VALUES ($1, $2, now() + interval '8 hours', now() + interval '8 hours')", [sid, id]);
  users[name] = { id, sid, email, name: `${name} (sintético)` };
}
const who = (cookie: string | undefined) => users[/anat_cfg_user=(ana|bruno|visitante)/u.exec(cookie ?? '')?.[1] ?? ''] ?? null;
app.get('/auth/__dev-login', async (request, reply) => {
  const as = (request.query as { as?: string }).as; const name = as === 'bruno' || as === 'visitante' ? as : 'ana';
  return reply.header('set-cookie', `anat_cfg_user=${name}; Path=/; HttpOnly; SameSite=Lax`).redirect('/admin/anatomia');
});
app.post('/auth/refresh', async (request, reply) => {
  const u = who(request.headers.cookie); if (!u) return reply.status(401).send({ error: 'unauthorized' });
  return { accessToken: app.jwt.sign({ sub: u.id, sid: u.sid, typ: 'access' }), tokenType: 'Bearer', expiresIn: 900 };
});
app.get('/auth/me', { preHandler: app.authenticate }, async (request) => {
  const u = Object.values(users).find((x) => x.id === request.auth!.userId)!;
  return { user: { id: u.id, email: u.email, name: u.name }, memberships: [] };
});
app.post('/auth/logout', async (_r, reply) => reply.header('set-cookie', 'anat_cfg_user=; Path=/; Max-Age=0').send({ ok: true }));
app.get('/api/v1/admin/me', { preHandler: app.authenticate }, async (request) => {
  const admin = await isPlatformAdmin(app.db, request.auth!.userId);
  return { platformAdmin: admin, taxonomyCurator: false, licenseBypass: admin, curatorDatabase: false };
});
// Read-only evidence for the browser test: version pointer and the audit rows of this flow (no secrets).
app.get('/auth/__dev-state', async () => ({
  current: (await owner.query('SELECT version FROM anatomy_config_current')).rows[0] ?? null,
  versions: (await owner.query('SELECT version, kind FROM anatomy_config_versions ORDER BY version')).rows,
  audit: (await owner.query("SELECT action, after_data AS data FROM audit_log WHERE action LIKE 'ANAT_RULES_CONFIG_%' ORDER BY occurred_at, id")).rows,
}));
const port = Number(process.argv[2] ?? 3998);
await app.listen({ host: '127.0.0.1', port });
console.log(`anatomy config dev harness on http://127.0.0.1:${port} (disposable database; synthetic users: ana, bruno, visitante)`);
const stop = async () => { await app.close(); await executor.close(); await pool.end(); await owner.end(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
