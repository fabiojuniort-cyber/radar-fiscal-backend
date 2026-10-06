import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';

import { catalogMonitoringRoutes } from '../src/api/routes/catalog-monitoring.route.js';
import { publicRoutes } from '../src/api/routes/public.route.js';
import type { DB } from '../src/infrastructure/database/database.types.js';

test('warm public and archive caches honor SUPPRESS and RESTORE without waiting for TTL', async () => {
  assert.ok(process.env.DATABASE_ADMIN_URL);
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new Pool({
      connectionString: process.env.DATABASE_ADMIN_URL, max: 1,
    }) }),
  });
  try {
    await db.connection().execute(async connection => {
      // A stable snapshot isolates aggregate assertions from parallel fixtures.
      // Every fixture, ledger event and epoch increment is rolled back.
      await sql`BEGIN ISOLATION LEVEL REPEATABLE READ`.execute(connection);
      const app = Fastify();
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);
      app.decorate('db', connection);
      app.decorateRequest('auth', null);
      app.decorate('authenticate', async request => {
        request.auth = { userId: randomUUID(), sessionId: randomUUID() };
      });
      const publicationId = randomUUID();
      const sourceId = randomUUID();
      const runId = randomUUID();
      const sourceCode = `scope-cache-${randomUUID()}`;
      const actType = `ScopeFixture${randomUUID().replaceAll('-', '')}`;
      try {
        await sql`INSERT INTO sources (id,code,name,jurisdiction_level,base_url,connector_key)
          VALUES (${sourceId}::uuid,${sourceCode},${sourceCode},'FEDERAL',
                  'https://example.invalid',${sourceCode})`.execute(connection);
        await sql`INSERT INTO publications (id,identity_hash,identity_strength,identity_basis,
          jurisdiction_level,title,act_type,published_on)
          VALUES (${publicationId}::uuid,${'d'.repeat(64)},'STRONG','{}'::jsonb,
                  'FEDERAL',${actType},${actType},current_date)`.execute(connection);
        await sql`INSERT INTO publication_origins (publication_id,source_id,external_id,official_url)
          VALUES (${publicationId}::uuid,${sourceId}::uuid,${publicationId},
                  'https://example.invalid/scope')`.execute(connection);
        await sql`INSERT INTO collection_runs (id,source_id,scheduled_for,trigger_type,status)
          VALUES (${runId}::uuid,${sourceId}::uuid,now(),'MANUAL','SUCCESS')`.execute(connection);
        await sql`INSERT INTO collection_run_publications (collection_run_id,publication_id,disposition)
          VALUES (${runId}::uuid,${publicationId}::uuid,'NEW_PUBLICATION')`.execute(connection);
        await app.register(publicRoutes);
        await app.register(catalogMonitoringRoutes);
        await app.ready();
        const urls = [
          '/public/v1/sources', '/public/v1/stats',
          '/public/v2/sources', '/public/v2/stats',
          '/api/v2/archive/facets',
          `/api/v2/archive/navigation?groupBy=year&source=${sourceCode}`,
          `/api/v2/archive?source=${sourceCode}&limit=3`,
          `/api/v2/archive?actType=${actType}&limit=3`,
        ];
        async function snapshot() {
          await sql`SET LOCAL ROLE radar_app`.execute(connection);
          const values: unknown[] = [];
          try {
            for (const url of urls) {
              const response = await app.inject({ method: 'GET', url });
              assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
              const body = response.json();
              delete body.generatedAt;
              values.push(body);
            }
          } finally {
            await sql`RESET ROLE`.execute(connection);
          }
          return values;
        }
        const before = await snapshot();
        assert.deepEqual(await snapshot(), before, 'warm cache is reused');
        const suppress = await sql<{ event_id: string }>`
          SELECT event_id FROM public.apply_publication_scope_transition(
            ${publicationId}::uuid,'SUPPRESS',${randomUUID()}::uuid,NULL,
            'TEST_SCOPE_POLICY','TEST_CACHE_SUPPRESS','test-v1',
            ${'b'.repeat(64)},NULL,'INTEGRATION_TEST')`.execute(connection);
        const hidden = await snapshot();
        for (let i = 0; i < urls.length; i++) {
          assert.notDeepEqual(hidden[i], before[i], `${urls[i]} must bypass its warm cache`);
        }
        assert.equal((hidden[6] as { totalItems: number }).totalItems, 0);
        assert.deepEqual((hidden[6] as { items: unknown[] }).items, []);
        await sql`SELECT event_id FROM public.apply_publication_scope_transition(
          ${publicationId}::uuid,'RESTORE',${randomUUID()}::uuid,${suppress.rows[0]!.event_id}::uuid,
          'TEST_SCOPE_POLICY','TEST_CACHE_RESTORE','test-v1',${'b'.repeat(64)},NULL,
          'INTEGRATION_TEST')`.execute(connection);
        assert.deepEqual(await snapshot(), before, 'RESTORE must repopulate every aggregate');
      } finally {
        await app.close();
        await sql`ROLLBACK`.execute(connection);
      }
    });
  } finally {
    await db.destroy();
  }
});
