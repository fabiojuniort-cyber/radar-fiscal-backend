import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import {
  Kysely,
  PostgresDialect,
} from 'kysely';
import { Pool } from 'pg';

import { publicRoutes } from '../src/api/routes/public.route.js';
import type { DB } from '../src/infrastructure/database/database.types.js';

const ALLOWED_ORIGIN =
  'https://public-api.test';

test(
  'public API exposes only official/public metadata and handles empty coverage',
  async () => {
    const adminUrl =
      process.env.DATABASE_ADMIN_URL;

    assert.ok(
      adminUrl,
      'DATABASE_ADMIN_URL is required for public API integration tests.',
    );

    const pool = new Pool({
      connectionString: adminUrl,
      max: 2,
    });
    const db = new Kysely<DB>({
      dialect: new PostgresDialect({
        pool,
      }),
    });

    const sourceId = randomUUID();
    const noRunSourceId = randomUUID();
    const runId = randomUUID();
    const attemptId = randomUUID();
    const publicationId = randomUUID();
    const now = new Date();
    const code =
      `public-api-source-${sourceId}`;
    const noRunCode =
      `public-api-no-run-${noRunSourceId}`;

    const app = Fastify();
    app.setValidatorCompiler(
      validatorCompiler,
    );
    app.setSerializerCompiler(
      serializerCompiler,
    );
    app.decorate('db', db);

    try {
      await db
        .insertInto('sources')
        .values([
          {
            id: sourceId,
            code,
            name: 'Public API Source',
            jurisdiction_level: 'STATE',
            uf: 'SP',
            base_url:
              'https://public-api.example.test',
            connector_key:
              `public-api-${sourceId}`,
            is_active: true,
          },
          {
            id: noRunSourceId,
            code: noRunCode,
            name: 'Public API No Run',
            jurisdiction_level: 'FEDERAL',
            uf: null,
            base_url:
              'https://public-api-no-run.example.test',
            connector_key:
              `public-api-no-run-${noRunSourceId}`,
            is_active: true,
          },
        ])
        .execute();

      await db
        .insertInto('publications')
        .values({
          id: publicationId,
          identity_hash:
            'a'.repeat(64),
          identity_strength: 'STRONG',
          identity_basis: {
            test: true,
            source: code,
          },
          jurisdiction_level: 'STATE',
          uf: 'SP',
          agency: 'SEFAZ-SP',
          act_type: 'PORTARIA',
          act_number: '1/2026',
          title:
            'Public API integration publication',
          published_on: now,
          effective_on: now,
          primary_official_url:
            'https://official.example.test/publication/1',
          first_collected_at: now,
          last_seen_at: now,
        })
        .execute();

      await db
        .insertInto('publication_origins')
        .values({
          publication_id: publicationId,
          source_id: sourceId,
          external_id:
            'public-api-external-1',
          official_url:
            'https://official.example.test/publication/1',
        })
        .execute();

      await db
        .insertInto('collection_runs')
        .values({
          id: runId,
          source_id: sourceId,
          scheduled_for: now,
          trigger_type: 'MANUAL',
          status: 'SUCCESS',
          started_at: now,
          finished_at: now,
          source_consulted_at: now,
        })
        .execute();

      await db
        .insertInto('collection_attempts')
        .values({
          id: attemptId,
          collection_run_id: runId,
          attempt_no: 1,
          status: 'SUCCESS',
          started_at: now,
          finished_at: now,
          response_time_ms: 25,
        })
        .execute();

      await db
        .insertInto(
          'collection_run_publications',
        )
        .values({
          collection_run_id: runId,
          publication_id: publicationId,
          publication_version_id: null,
          disposition:
            'NEW_PUBLICATION',
          detected_at: now,
        })
        .execute();

      await app.register(publicRoutes, {
        allowedOrigins: [
          ALLOWED_ORIGIN,
        ],
      });
      await app.ready();

      const sourcesResponse =
        await app.inject({
          method: 'GET',
          url: '/public/v1/sources',
          headers: {
            origin: ALLOWED_ORIGIN,
          },
        });

      assert.equal(
        sourcesResponse.statusCode,
        200,
      );
      assert.equal(
        sourcesResponse.headers[
          'access-control-allow-origin'
        ],
        ALLOWED_ORIGIN,
      );
      assert.equal(
        sourcesResponse.headers[
          'cache-control'
        ],
        'public, max-age=300',
      );

      const sourcesBody =
        sourcesResponse.json<{
          generatedAt: string;
          items: Array<{
            code: string;
            status: string;
            lastRunStatus: string | null;
            importedToday: number;
            totalPublications: number;
          }>;
        }>();

      assert.ok(
        Date.parse(
          sourcesBody.generatedAt,
        ),
      );

      const online =
        sourcesBody.items.find(
          (item) => item.code === code,
        );
      assert.ok(online);
      assert.equal(
        online.status,
        'ONLINE',
      );
      assert.equal(
        online.lastRunStatus,
        'SUCCESS',
      );
      assert.equal(
        online.importedToday,
        1,
      );
      assert.equal(
        online.totalPublications,
        1,
      );

      const noRun =
        sourcesBody.items.find(
          (item) =>
            item.code === noRunCode,
        );
      assert.ok(noRun);
      assert.equal(
        noRun.status,
        'NOT_CONSULTED',
      );
      assert.equal(
        noRun.lastRunStatus,
        null,
      );
      assert.equal(
        noRun.importedToday,
        0,
      );
      assert.equal(
        noRun.totalPublications,
        0,
      );

      const emptyUfResponse =
        await app.inject({
          method: 'GET',
          url:
            '/public/v1/publications?uf=ZZ&limit=3',
        });

      assert.equal(
        emptyUfResponse.statusCode,
        200,
      );
      assert.deepEqual(
        emptyUfResponse.json(),
        { items: [] },
      );

      const publicationsResponse =
        await app.inject({
          method: 'GET',
          url:
            `/public/v1/publications?uf=SP&source=${code}&limit=3`,
        });

      assert.equal(
        publicationsResponse.statusCode,
        200,
      );

      const publicationsBody =
        publicationsResponse.json<{
          items: Array<
            Record<string, unknown>
          >;
        }>();

      assert.equal(
        publicationsBody.items.length,
        1,
      );
      assert.equal(
        publicationsBody.items[0]?.id,
        publicationId,
      );
      assert.equal(
        publicationsBody.items[0]
          ?.officialUrl,
        'https://official.example.test/publication/1',
      );
      assert.equal(
        Object.hasOwn(
          publicationsBody.items[0]!,
          'contentText',
        ),
        false,
      );

      const statsResponse =
        await app.inject({
          method: 'GET',
          url: '/public/v1/stats',
        });

      assert.equal(
        statsResponse.statusCode,
        200,
      );

      const statsBody =
        statsResponse.json<{
          totalPublications: number;
          totalSources: number;
          activeSources: number;
          importedToday: number;
          generatedAt: string;
        }>();

      assert.ok(
        statsBody.totalPublications >=
          1,
      );
      assert.ok(
        statsBody.totalSources >= 2,
      );
      assert.ok(
        statsBody.activeSources >= 2,
      );
      assert.ok(
        statsBody.importedToday >= 1,
      );
      assert.ok(
        Date.parse(statsBody.generatedAt),
      );

      const denied =
        await app.inject({
          method: 'GET',
          url: '/public/v1/stats',
          headers: {
            origin:
              'https://not-allowed.test',
          },
        });

      assert.equal(
        denied.statusCode,
        403,
      );
      assert.equal(
        denied.json().error,
        'origin_not_allowed',
      );

      const preflight =
        await app.inject({
          method: 'OPTIONS',
          url: '/public/v1/stats',
          headers: {
            origin: ALLOWED_ORIGIN,
          },
        });

      assert.equal(
        preflight.statusCode,
        204,
      );
      assert.equal(
        preflight.headers[
          'access-control-allow-origin'
        ],
        ALLOWED_ORIGIN,
      );
    } finally {
      await app.close();

      await db
        .deleteFrom('publications')
        .where('id', '=', publicationId)
        .execute();

      await db
        .deleteFrom('collection_runs')
        .where('id', '=', runId)
        .execute();

      await db
        .deleteFrom('sources')
        .where(
          'id',
          'in',
          [
            sourceId,
            noRunSourceId,
          ],
        )
        .execute();

      await db.destroy();
    }
  },
);
