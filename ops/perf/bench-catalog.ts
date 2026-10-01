// Times the catalog endpoints through the real Fastify app against a
// performance database seeded with ops/perf/seed-catalog-scale.sql.
//
//   AGGREGATE_CACHE_TTL_MS=0 DATABASE_URL=... DATABASE_ADMIN_URL=... \
//   JWT_ACCESS_SECRET=... npx tsx ops/perf/bench-catalog.ts
//
// AGGREGATE_CACHE_TTL_MS=0 measures cold queries (what the cache hides).
import { sql } from 'kysely';

import { buildApp } from '../../src/app.js';

const PASSWORD = 'Perf-Bench-2026!Safe';
const EMAIL = 'perf-bench@example.test';

const app = await buildApp();
await app.ready();

const dbName = await sql<{ name: string }>`select current_database() as name`.execute(app.db);
if (!dbName.rows[0]?.name.includes('perf')) {
  throw new Error('bench-catalog only runs against a database whose name contains "perf"');
}

let login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: EMAIL, password: PASSWORD } });
if (login.statusCode !== 200) {
  await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { name: 'Perf Bench', email: EMAIL, company: 'Perf Bench Company', password: PASSWORD, confirmPassword: PASSWORD, acceptedTerms: true },
  });
  login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: EMAIL, password: PASSWORD } });
}

const tenant = await sql<{ tenant_id: string }>`
  select tm.tenant_id
  from tenant_memberships tm
  join app_users u on u.id = tm.user_id
  where lower(u.email) = ${EMAIL}
`.execute(app.db);

const headers = {
  authorization: `Bearer ${login.json<{ accessToken: string }>().accessToken}`,
  'x-tenant-id': tenant.rows[0]!.tenant_id,
};

const urls = (process.argv[2]?.split(',') ?? [
  '/api/v1/account',
  '/public/v2/stats',
  '/public/v2/sources',
  '/api/v2/archive/facets',
  '/api/v2/archive?page=1&limit=25',
  '/api/v2/archive?page=40&limit=25',
  '/api/v2/archive?page=4000&limit=25',
  '/api/v2/archive?page=1&limit=25&source=dou',
  '/api/v2/archive?page=1&limit=25&source=sped',
  '/api/v2/archive?page=1&limit=25&uf=SP',
  '/api/v2/archive?page=1&limit=25&q=99999',
  '/api/v1/monitoring/runs',
]);

for (const url of urls) {
  const started = performance.now();
  const response = await app.inject({ method: 'GET', url, headers });
  const ms = Math.round(performance.now() - started);
  console.log(`${String(ms).padStart(8)} ms  ${response.statusCode}  ${url}`);
}

await app.close();
