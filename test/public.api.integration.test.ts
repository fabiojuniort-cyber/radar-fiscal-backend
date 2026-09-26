import assert from 'node:assert/strict';
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

function hash64(value: string): string {
  return createHash('sha256')
    .update(value)
    .digest('hex');
}

test(
  'public API exposes only global official metadata with restricted CORS',
  async (t) => {
    const adminUrl =
      process.env.DATABASE_ADMIN_URL;

    assert.ok(
      adminUrl,
      'DATABASE_ADMIN_URL is required for public API integration tests.',
    );

    process.env.PUBLIC_API_ALLOWED_ORIGINS =
      'https://public.example';

    const { buildApp } =
      await import('../src/app.js');

    const admin = new Pool({
      connectionString: adminUrl,
      max: 1,
    });

    const sourceSpId = randomUUID();
    const sourceFederalId = randomUUID();
    const runId = randomUUID();
    const attemptId = randomUUID();
    const publicationSpId = randomUUID();
    const publicationFederalId = randomUUID();
    const suffix = randomUUID().slice(0, 8);
    const sourceSpCode =
      `api-sp-${suffix}`;
    const sourceFederalCode =
      `api-fed-${suffix}`;

    const app = await buildApp();

    try {
      await admin.query(
        `
          INSERT INTO sources (
            id,
            code,
            name,
            jurisdiction_level,
            uf,
            base_url,
            connector_key,
            is_active
          )
          VALUES
            (
              $1,
              $2,
              'API SP Test',
              'STATE',
              'SP',
              'https://example.test/sp',
              $3,
              true
            ),
            (
              $4,
              $5,
              'API Federal Test',
              'FEDERAL',
              NULL,
              'https://example.test/federal',
              $6,
              true
            )
        `,
        [
          sourceSpId,
          sourceSpCode,
          `connector-${sourceSpCode}`,
          sourceFederalId,
          sourceFederalCode,
          `connector-${sourceFederalCode}`,
        ],
      );

      await admin.query(
        `
          INSERT INTO collection_runs (
            id,
            source_id,
            scheduled_for,
            trigger_type,
            status,
            started_at,
            finished_at,
            source_consulted_at
          )
          VALUES (
            $1,
            $2,
            now(),
            'SCHEDULED',
            'SUCCESS',
            now() - interval '2 seconds',
            now(),
            now()
          )
        `,
        [runId, sourceSpId],
      );

      await admin.query(
        `
          INSERT INTO collection_attempts (
            id,
            collection_run_id,
            attempt_no,
            status,
            started_at,
            finished_at,
            response_time_ms
          )
          VALUES (
            $1,
            $2,
            1,
            'SUCCESS',
            now() - interval '2 seconds',
            now(),
            120
          )
        `,
        [attemptId, runId],
      );

      await admin.query(
        `
          INSERT INTO publications (
            id,
            identity_hash,
            identity_strength,
            identity_basis,
            jurisdiction_level,
            uf,
            agency,
            act_type,
            act_number,
            title,
            published_on,
            effective_on,
            primary_official_url,
            first_collected_at
          )
          VALUES
            (
              $1,
              $2,
              'STRONG',
              '{"test":true}'::jsonb,
              'STATE',
              'SP',
              'SEFAZ-SP',
              'PORTARIA',
              '99/2026',
              'Publicação estadual API-01',
              current_date,
              current_date + 1,
              NULL,
              now()
            ),
            (
              $3,
              $4,
              'STRONG',
              '{"test":true}'::jsonb,
              'FEDERAL',
              NULL,
              'RFB',
              'IN',
              '100/2026',
              'Publicação federal API-01',
              current_date - 1,
              NULL,
              'https://example.test/federal/100',
              now() - interval '1 day'
            )
        `,
        [
          publicationSpId,
          hash64(publicationSpId),
          publicationFederalId,
          hash64(publicationFederalId),
        ],
      );

      await admin.query(
        `
          INSERT INTO publication_origins (
            publication_id,
            source_id,
            external_id,
            official_url
          )
          VALUES
            (
              $1,
              $2,
              'api-sp-item',
              'https://example.test/sp/99'
            ),
            (
              $3,
              $4,
              'api-fed-item',
              'https://example.test/federal/100'
            )
        `,
        [
          publicationSpId,
          sourceSpId,
          publicationFederalId,
          sourceFederalId,
        ],
      );

      await admin.query(
        `
          INSERT INTO collection_run_publications (
            collection_run_id,
            publication_id,
            disposition,
            detected_at
          )
          VALUES (
            $1,
            $2,
            'NEW_PUBLICATION',
            now()
          )
        `,
        [runId, publicationSpId],
      );

      await app.ready();

      await t.test(
        'sources exposes status and counts, including a source with no runs',
        async () => {
          const response = await app.inject({
            method: 'GET',
            url: '/public/v1/sources',
            headers: {
              origin:
                'https://public.example',
            },
          });

          assert.equal(
            response.statusCode,
            200,
          );
          assert.equal(
            response.headers[
              'access-control-allow-origin'
            ],
            'https://public.example',
          );
          assert.equal(
            response.headers[
              'access-control-allow-credentials'
            ],
            undefined,
          );
          assert.equal(
            response.headers[
              'cache-control'
            ],
            'public, max-age=300',
          );

          const body = response.json<{
            generatedAt: string;
            items: Array<{
              code: string;
              status: string;
              importedToday: number;
              totalPublications: number;
              lastRunStatus: string | null;
            }>;
          }>();

          assert.ok(
            !Number.isNaN(
              Date.parse(body.generatedAt),
            ),
          );

          const stateSource =
            body.items.find(
              (item) =>
                item.code === sourceSpCode,
            );
          assert.ok(stateSource);
          assert.equal(
            stateSource.status,
            'ONLINE',
          );
          assert.equal(
            stateSource.lastRunStatus,
            'SUCCESS',
          );
          assert.equal(
            stateSource.importedToday,
            1,
          );
          assert.equal(
            stateSource.totalPublications,
            1,
          );

          const federalSource =
            body.items.find(
              (item) =>
                item.code ===
                sourceFederalCode,
            );
          assert.ok(federalSource);
          assert.equal(
            federalSource.status,
            'NOT_CONSULTED',
          );
          assert.equal(
            federalSource.lastRunStatus,
            null,
          );
          assert.equal(
            federalSource.importedToday,
            0,
          );
          assert.equal(
            federalSource.totalPublications,
            1,
          );
        },
      );

      await t.test(
        'publications filters by UF/source/jurisdiction and returns no content body',
        async () => {
          const sp = await app.inject({
            method: 'GET',
            url: '/public/v1/publications?uf=SP&limit=3',
          });

          assert.equal(sp.statusCode, 200);

          const spBody = sp.json<{
            items: Array<
              Record<string, unknown>
            >;
          }>();

          const statePublication =
            spBody.items.find(
              (item) =>
                item.id === publicationSpId,
            );

          assert.ok(statePublication);
          assert.equal(
            statePublication.officialUrl,
            'https://example.test/sp/99',
          );
          assert.equal(
            'contentText' in
              statePublication,
            false,
          );
          assert.equal(
            'content' in statePublication,
            false,
          );

          const federal =
            await app.inject({
              method: 'GET',
              url:
                '/public/v1/publications' +
                `?jurisdiction=FEDERAL&source=${sourceFederalCode}&limit=3`,
            });

          assert.equal(
            federal.statusCode,
            200,
          );
          const federalItems =
            federal.json<{
              items: Array<{
                id: string;
                uf: string | null;
              }>;
            }>().items;
          assert.ok(
            federalItems.some(
              (item) =>
                item.id ===
                publicationFederalId &&
                item.uf === null,
            ),
          );

          const empty = await app.inject({
            method: 'GET',
            url: '/public/v1/publications?uf=ZZ&limit=3',
          });

          assert.equal(
            empty.statusCode,
            200,
          );
          assert.deepEqual(
            empty.json(),
            { items: [] },
          );
        },
      );

      await t.test(
        'stats exposes aggregate public counts',
        async () => {
          const response = await app.inject({
            method: 'GET',
            url: '/public/v1/stats',
          });

          assert.equal(
            response.statusCode,
            200,
          );

          const body = response.json<{
            totalPublications: number;
            totalSources: number;
            activeSources: number;
            importedToday: number;
            generatedAt: string;
          }>();

          assert.ok(
            body.totalPublications >= 2,
          );
          assert.ok(
            body.totalSources >= 2,
          );
          assert.ok(
            body.activeSources >= 2,
          );
          assert.ok(
            body.importedToday >= 1,
          );
          assert.ok(
            !Number.isNaN(
              Date.parse(body.generatedAt),
            ),
          );
        },
      );

      await t.test(
        'configured CORS answers browser preflight with GET only',
        async () => {
          const response = await app.inject({
            method: 'OPTIONS',
            url: '/public/v1/stats',
            headers: {
              origin:
                'https://public.example',
              'access-control-request-method':
                'GET',
            },
          });

          assert.equal(
            response.statusCode,
            204,
          );
          assert.equal(
            response.headers[
              'access-control-allow-origin'
            ],
            'https://public.example',
          );
          assert.equal(
            response.headers[
              'access-control-allow-methods'
            ],
            'GET',
          );
          assert.equal(
            response.headers[
              'access-control-allow-credentials'
            ],
            undefined,
          );
          assert.equal(
            response.headers[
              'cache-control'
            ],
            undefined,
          );
        },
      );

      await t.test(
        'configured CORS rejects unknown browser origins',
        async () => {
          const response = await app.inject({
            method: 'GET',
            url: '/public/v1/stats',
            headers: {
              origin:
                'https://evil.example',
            },
          });

          assert.equal(
            response.statusCode,
            403,
          );
          assert.deepEqual(
            response.json(),
            {
              error:
                'origin_not_allowed',
            },
          );
          assert.equal(
            response.headers[
              'cache-control'
            ],
            undefined,
          );
        },
      );
    } finally {
      await app.close();

      await admin.query(
        `
          DELETE FROM collection_runs
          WHERE id = $1
        `,
        [runId],
      );

      await admin.query(
        `
          DELETE FROM publications
          WHERE id = ANY($1::uuid[])
        `,
        [[
          publicationSpId,
          publicationFederalId,
        ]],
      );

      await admin.query(
        `
          DELETE FROM sources
          WHERE id = ANY($1::uuid[])
        `,
        [[
          sourceSpId,
          sourceFederalId,
        ]],
      );

      await admin.end();
    }
  },
);
