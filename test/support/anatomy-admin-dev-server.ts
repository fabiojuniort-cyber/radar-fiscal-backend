import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { DISPOSABLE_URL, prepareAdminDatabase } from './anatomy-admin-db.js';

/**
 * TEST/DEV HARNESS ONLY (ANAT-ADMIN-01 P4, issue #116): serves the real P3-D plugin, the real P3-C executor and the real
 * JWT + session check over a FRESH disposable database, so the web screens can be exercised end to end locally.
 * The only non-production pieces are the harness endpoints under /auth/__dev-* (switch between two synthetic platform
 * admins, "author" and "reviewer"; synthetic fixtures). It refuses to start outside the disposable environment.
 * Usage: CI=true GITHUB_ACTIONS=true NODE_ENV=test ANAT04_CI_DATABASE_URL=<disposable> node --import tsx this-file [port]
 */
const env = process.env;
if (env.CI !== 'true' || env.GITHUB_ACTIONS !== 'true' || env.NODE_ENV !== 'test' || env.ANAT04_CI_DATABASE_URL !== DISPOSABLE_URL
  || env.DATABASE_URL !== undefined || env.DATABASE_ADMIN_URL !== undefined) {
  throw new Error('ANAT04_DISPOSABLE_CI_ONLY: refusing to start the anatomy admin dev harness');
}
process.env.DATABASE_URL = DISPOSABLE_URL; process.env.JWT_ACCESS_SECRET = randomBytes(48).toString('hex');
const [{ default: Fastify }, { serializerCompiler, validatorCompiler }, { Kysely, PostgresDialect }, { registerAuthSupport }, { anatomyRulesAdminRoutes },
  { SimulationExecutor }, { DEFAULT_PROFILES, PROFILE_FORMAT_VERSION }, { isPlatformAdmin }] = await Promise.all([
  import('fastify'), import('fastify-type-provider-zod'), import('kysely'), import('../../src/modules/auth/auth.plugin.js'),
  import('../../src/api/routes/anatomy-rules-admin.route.js'), import('../../src/modules/anatomy/simulation-executor.js'),
  import('../../src/modules/anatomy/profile.js'), import('../../src/modules/auth/platform-role.js')]);
delete process.env.DATABASE_URL;

const owner = new pg.Client({ connectionString: DISPOSABLE_URL }); await owner.connect();
await prepareAdminDatabase(owner, ['anatomy-api-ci-bootstrap.sql']);
const login = `anat_dev_${randomBytes(4).toString('hex')}`; const password = randomBytes(24).toString('hex');
await owner.query(`CREATE ROLE ${login} LOGIN INHERIT PASSWORD '${password}' IN ROLE radar_app`);
const pool = new pg.Pool({ connectionString: DISPOSABLE_URL.replace('postgres:postgres@', `${login}:${password}@`), max: 4 });
const executor = new SimulationExecutor();
const app = Fastify({ logger: false });
app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
app.decorate('db', new Kysely<any>({ dialect: new PostgresDialect({ pool }) })); app.decorate('curatorPool', null);
await registerAuthSupport(app);
await app.register(anatomyRulesAdminRoutes, { pool, executor });

const users: Record<string, { id: string; sid: string; email: string; name: string }> = {};
for (const name of ['author', 'reviewer']) {
  const id = randomUUID(); const sid = randomUUID(); const email = `${name}@example.test`;
  await owner.query('INSERT INTO app_users (id, email) VALUES ($1, $2)', [id, email]);
  await owner.query("INSERT INTO platform_user_roles (user_id, role, granted_by) VALUES ($1, 'PLATFORM_ADMIN', 'system:ci')", [id]);
  await owner.query("INSERT INTO auth_sessions (id, user_id, idle_expires_at, absolute_expires_at) VALUES ($1, $2, now() + interval '8 hours', now() + interval '8 hours')", [sid, id]);
  users[name] = { id, sid, email, name: name === 'author' ? 'Autora sintética' : 'Revisor sintético' };
}
const who = (cookie: string | undefined) => users[/anat_dev_user=(author|reviewer)/u.exec(cookie ?? '')?.[1] ?? ''] ?? null;
app.get('/auth/__dev-login', async (request, reply) => {
  const as = (request.query as { as?: string }).as === 'reviewer' ? 'reviewer' : 'author';
  return reply.header('set-cookie', `anat_dev_user=${as}; Path=/; HttpOnly; SameSite=Lax`).redirect('/admin/anatomia-regras');
});
app.post('/auth/refresh', async (request, reply) => {
  const u = who(request.headers.cookie); if (!u) return reply.status(401).send({ error: 'unauthorized' });
  return { accessToken: app.jwt.sign({ sub: u.id, sid: u.sid, typ: 'access' }), tokenType: 'Bearer', expiresIn: 900 };
});
app.get('/auth/me', { preHandler: app.authenticate }, async (request) => {
  const u = Object.values(users).find((x) => x.id === request.auth!.userId)!;
  return { user: { id: u.id, email: u.email, name: u.name }, memberships: [] };
});
app.post('/auth/logout', async (_r, reply) => reply.header('set-cookie', 'anat_dev_user=; Path=/; Max-Age=0').send({ ok: true }));
app.get('/api/v1/admin/me', { preHandler: app.authenticate }, async (request) => {
  const admin = await isPlatformAdmin(app.db, request.auth!.userId);
  return { platformAdmin: admin, taxonomyCurator: false, licenseBypass: admin, curatorDatabase: false };
});
const rfbHeaders = (DEFAULT_PROFILES.find((p) => p.scope.level === 'default')!.fields as { ncm: { columnHeaders: string[] } }).ncm.columnHeaders;
app.get('/auth/__dev-fixtures', async () => ({
  defaults: DEFAULT_PROFILES,
  candidate: [...DEFAULT_PROFILES.filter((p) => !(p.scope.level === 'source' && p.scope.source === 'RFB')),
    { profileVersion: PROFILE_FORMAT_VERSION, scope: { level: 'source', source: 'RFB' }, fields: { ncm: { columnHeaders: [...rfbHeaders, 'Classificacao'] } } }],
  examples: [{ id: 'col-classificacao', purpose: 'coluna NCM chamada Classificacao (sintético)', polarity: 'positive', source: 'RFB',
    input: { html: '<table><tr><td>Classificacao</td></tr><tr><td>8471.30.12</td></tr></table>' },
    expect: [{ kind: 'entity', domain: 'NCM', literal: '8471.30.12' }], catalog: { edition: 'syn', codes: ['84713012'] } }],
}));
const port = Number(process.argv[2] ?? 3999);
await app.listen({ host: '127.0.0.1', port });
console.log(`anatomy admin dev harness on http://127.0.0.1:${port} (disposable database; synthetic admins: author, reviewer)`);
const stop = async () => { await app.close(); await executor.close(); await pool.end(); await owner.end(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
