import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  Kysely,
  PostgresDialect,
} from 'kysely';
import { Pool } from 'pg';

import type { DB } from '../src/infrastructure/database/database.types.js';
import { normalizePublication } from '../src/modules/collection/publication.normalizer.js';
import { persistPublication } from '../src/modules/collection/publication.persistence.js';

test(
  'same semantic publication enriches preserved layout without creating a new version',
  async () => {
    const adminUrl =
      process.env.DATABASE_ADMIN_URL;

    assert.ok(
      adminUrl,
      'DATABASE_ADMIN_URL is required.',
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
    const runIds = [
      randomUUID(),
      randomUUID(),
    ];
    const attemptIds = [
      randomUUID(),
      randomUUID(),
    ];

    try {
      await db
        .insertInto('sources')
        .values({
          id: sourceId,
          code:
            'presentation-' + sourceId,
          name:
            'Presentation integration source',
          jurisdiction_level:
            'FEDERAL',
          base_url:
            'https://example.test',
          connector_key:
            'presentation-test',
        })
        .execute();

      await db
        .insertInto('collection_runs')
        .values(
          runIds.map((id, index) => ({
            id,
            source_id: sourceId,
            scheduled_for: new Date(
              `2026-09-30T0${index}:00:00Z`,
            ),
            trigger_type:
              'MANUAL' as const,
          })),
        )
        .execute();

      await db
        .insertInto('collection_attempts')
        .values(
          attemptIds.map(
            (id, index) => ({
              id,
              collection_run_id:
                runIds[index]!,
              attempt_no: 1,
              status:
                'RUNNING' as const,
            }),
          ),
        )
        .execute();

      const common = {
        title: 'Portaria 10/2026',
        agency: 'Órgão X',
        sphere: 'FEDERAL' as const,
        actType: 'Portaria',
        actNumber: '10/2026',
        publishedAt: new Date(
          '2026-09-30T00:00:00Z',
        ),
        officialUrl:
          'https://example.test/portaria-10',
        externalId:
          'portaria-10-2026',
        metadata: {
          sourceRole: 'PRIMARY',
        },
      };

      const flat =
        normalizePublication({
          sourceId,
          publication: {
            ...common,
            content:
              'CAPÍTULO I Art. 1º Texto oficial. I - item.',
          },
        });

      const structuredText = [
        'CAPÍTULO I',
        '',
        'Art. 1º  Texto oficial.',
        '    I - item.',
      ].join('\n');

      const structured =
        normalizePublication({
          sourceId,
          publication: {
            ...common,
            content:
              structuredText,
          },
        });

      assert.equal(
        flat.contentHash,
        structured.contentHash,
      );

      const first = await db
        .transaction()
        .execute((trx) =>
          persistPublication(trx, {
            sourceId,
            runId: runIds[0]!,
            attemptId:
              attemptIds[0]!,
            publication: flat,
          }),
        );

      const second = await db
        .transaction()
        .execute((trx) =>
          persistPublication(trx, {
            sourceId,
            runId: runIds[1]!,
            attemptId:
              attemptIds[1]!,
            publication: structured,
          }),
        );

      assert.equal(
        second.disposition,
        'EXISTING_PUBLICATION',
      );
      assert.equal(
        second.publicationVersionId,
        first.publicationVersionId,
      );

      const versions = await db
        .selectFrom(
          'publication_versions',
        )
        .select([
          'id',
          'content_text',
          'source_metadata',
        ])
        .where(
          'publication_id',
          '=',
          first.publicationId,
        )
        .execute();

      assert.equal(
        versions.length,
        1,
      );
      assert.equal(
        versions[0]?.content_text,
        structuredText,
      );
      assert.equal(
        (
          versions[0]
            ?.source_metadata as
            | Record<
                string,
                unknown
              >
            | undefined
        )?.presentation !==
          undefined,
        true,
      );
    } finally {
      const publicationIds =
        await db
          .selectFrom(
            'publication_origins',
          )
          .select(
            'publication_id',
          )
          .where(
            'source_id',
            '=',
            sourceId,
          )
          .execute()
          .then((rows) => [
            ...new Set(
              rows.map(
                (row) =>
                  row.publication_id,
              ),
            ),
          ]);

      await db
        .deleteFrom('collection_runs')
        .where(
          'source_id',
          '=',
          sourceId,
        )
        .execute();

      await db
        .deleteFrom(
          'publication_origins',
        )
        .where(
          'source_id',
          '=',
          sourceId,
        )
        .execute();

      if (
        publicationIds.length > 0
      ) {
        await db
          .deleteFrom('publications')
          .where(
            'id',
            'in',
            publicationIds,
          )
          .execute();
      }

      await db
        .deleteFrom('sources')
        .where('id', '=', sourceId)
        .execute();

      await db.destroy();
    }
  },
);
