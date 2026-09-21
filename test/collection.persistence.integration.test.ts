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
  'publication persistence deduplicates, versions and keeps weak identities separate',
  async () => {
    const adminUrl = process.env.DATABASE_ADMIN_URL;

    assert.ok(
      adminUrl,
      'DATABASE_ADMIN_URL is required for collection integration tests.',
    );

    const pool = new Pool({
      connectionString: adminUrl,
      max: 2,
    });

    const db = new Kysely<DB>({
      dialect: new PostgresDialect({ pool }),
    });

    const sourceA = randomUUID();
    const sourceB = randomUUID();

    const runs = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];

    const attempts = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];

    try {
      await db
        .insertInto('sources')
        .values([
          {
            id: sourceA,
            code: `test-source-a-${sourceA}`,
            name: 'Collection Persistence Source A',
            jurisdiction_level: 'FEDERAL',
            base_url: 'https://source-a.example.test',
            connector_key:
              `collection-test-a-${sourceA}`,
          },
          {
            id: sourceB,
            code: `test-source-b-${sourceB}`,
            name: 'Collection Persistence Source B',
            jurisdiction_level: 'FEDERAL',
            base_url: 'https://source-b.example.test',
            connector_key:
              `collection-test-b-${sourceB}`,
          },
        ])
        .execute();

      await db
        .insertInto('collection_runs')
        .values([
          {
            id: runs[0]!,
            source_id: sourceA,
            scheduled_for: new Date(
              '2026-09-19T10:00:00Z',
            ),
            trigger_type: 'MANUAL',
          },
          {
            id: runs[1]!,
            source_id: sourceA,
            scheduled_for: new Date(
              '2026-09-19T11:00:00Z',
            ),
            trigger_type: 'MANUAL',
          },
          {
            id: runs[2]!,
            source_id: sourceB,
            scheduled_for: new Date(
              '2026-09-19T12:00:00Z',
            ),
            trigger_type: 'MANUAL',
          },
          {
            id: runs[3]!,
            source_id: sourceA,
            scheduled_for: new Date(
              '2026-09-19T13:00:00Z',
            ),
            trigger_type: 'MANUAL',
          },
          {
            id: runs[4]!,
            source_id: sourceB,
            scheduled_for: new Date(
              '2026-09-19T14:00:00Z',
            ),
            trigger_type: 'MANUAL',
          },
        ])
        .execute();

      await db
        .insertInto('collection_attempts')
        .values(
          attempts.map((attemptId, index) => ({
            id: attemptId,
            collection_run_id: runs[index]!,
            attempt_no: 1,
            status: 'RUNNING',
          })),
        )
        .execute();

      const basePublication = normalizePublication({
        sourceId: sourceA,
        publication: {
          title: 'Convênio ICMS 100/2026',
          agency: 'CONFAZ',
          sphere: 'FEDERAL',
          actType: 'Convênio ICMS',
          actNumber: '100/2026',
          publishedAt: new Date(
            '2026-09-19T00:00:00Z',
          ),
          content: 'Conteúdo original.',
          officialUrl:
            'https://source-a.example.test/100-2026',
          externalId: '100-2026',
          metadata: {
            sourceRole: 'PRIMARY',
            ingestionChannel: 'INLABS',
          },
        },
      });

      const first = await db
        .transaction()
        .execute((trx) =>
          persistPublication(trx, {
            sourceId: sourceA,
            runId: runs[0]!,
            attemptId: attempts[0]!,
            publication: basePublication,
          }),
        );

      assert.equal(
        first.disposition,
        'NEW_PUBLICATION',
      );

      const duplicate = await db
        .transaction()
        .execute((trx) =>
          persistPublication(trx, {
            sourceId: sourceA,
            runId: runs[0]!,
            attemptId: attempts[0]!,
            publication: basePublication,
          }),
        );

      assert.equal(
        duplicate.disposition,
        'EXISTING_PUBLICATION',
      );
      assert.equal(
        duplicate.publicationId,
        first.publicationId,
      );
      assert.equal(
        duplicate.publicationVersionId,
        first.publicationVersionId,
      );

      const runAItems = await db
        .selectFrom('collection_items')
        .select(['id', 'status'])
        .where(
          'collection_run_id',
          '=',
          runs[0]!,
        )
        .execute();

      const runALinks = await db
        .selectFrom('collection_run_publications')
        .select(['publication_id', 'disposition'])
        .where(
          'collection_run_id',
          '=',
          runs[0]!,
        )
        .execute();

      assert.equal(runAItems.length, 1);
      assert.equal(
        runAItems[0]?.status,
        'PROCESSED_NEW',
      );
      assert.equal(runALinks.length, 1);
      assert.equal(
        runALinks[0]?.disposition,
        'NEW_PUBLICATION',
      );

      const changedPublication =
        normalizePublication({
          sourceId: sourceA,
          publication: {
            title: 'Convênio ICMS 100/2026',
            agency: 'CONFAZ',
            sphere: 'FEDERAL',
            actType: 'Convênio ICMS',
            actNumber: '100/2026',
            publishedAt: new Date(
              '2026-09-19T00:00:00Z',
            ),
            content: 'Conteúdo atualizado.',
            officialUrl:
              'https://source-a.example.test/100-2026',
            externalId: '100-2026',
            metadata: {
              sourceRole: 'PRIMARY',
              ingestionChannel: 'INLABS',
            },
          },
        });

      const changed = await db
        .transaction()
        .execute((trx) =>
          persistPublication(trx, {
            sourceId: sourceA,
            runId: runs[1]!,
            attemptId: attempts[1]!,
            publication: changedPublication,
          }),
        );

      assert.equal(changed.disposition, 'NEW_VERSION');
      assert.equal(
        changed.publicationId,
        first.publicationId,
      );
      assert.notEqual(
        changed.publicationVersionId,
        first.publicationVersionId,
      );

      const versions = await db
        .selectFrom('publication_versions')
        .select([
          'version_no',
          'is_current',
          'content_hash',
        ])
        .where(
          'publication_id',
          '=',
          first.publicationId,
        )
        .orderBy('version_no')
        .execute();

      assert.equal(versions.length, 2);
      assert.deepEqual(
        versions.map((version) => ({
          versionNo: version.version_no,
          isCurrent: version.is_current,
        })),
        [
          {
            versionNo: 1,
            isCurrent: false,
          },
          {
            versionNo: 2,
            isCurrent: true,
          },
        ],
      );

      const mirroredStrongIdentity =
        normalizePublication({
          sourceId: sourceB,
          publication: {
            title: 'Convênio ICMS 100/2026',
            agency: 'CONFAZ',
            sphere: 'FEDERAL',
            actType: 'Convênio ICMS',
            actNumber: '100/2026',
            publishedAt: new Date(
              '2026-09-19T15:00:00Z',
            ),
            content: 'Conteúdo enriquecido do portal.',
            effectiveAt: new Date(
              '2026-10-01T00:00:00Z',
            ),
            officialUrl:
              'https://source-b.example.test/100-2026',
            externalId: 'mirror-100-2026',
            metadata: {
              sourceRole: 'ENRICHMENT',
              ingestionChannel: 'CONFAZ_PORTAL',
            },
          },
        });

      const mirrored = await db
        .transaction()
        .execute((trx) =>
          persistPublication(trx, {
            sourceId: sourceB,
            runId: runs[2]!,
            attemptId: attempts[2]!,
            publication: mirroredStrongIdentity,
          }),
        );

      assert.equal(
        mirrored.publicationId,
        first.publicationId,
      );
      assert.equal(
        mirrored.disposition,
        'NEW_VERSION',
      );

      const versionsAfterEnrichment = await db
        .selectFrom('publication_versions')
        .select([
          'version_no',
          'is_current',
          'source_metadata',
        ])
        .where(
          'publication_id',
          '=',
          first.publicationId,
        )
        .orderBy('version_no')
        .execute();

      assert.equal(
        versionsAfterEnrichment.length,
        3,
      );
      assert.deepEqual(
        versionsAfterEnrichment.map(
          (version) => ({
            versionNo: version.version_no,
            isCurrent: version.is_current,
            sourceRole:
              (
                version.source_metadata as
                  | Record<string, unknown>
                  | null
              )?.sourceRole ?? null,
          }),
        ),
        [
          {
            versionNo: 1,
            isCurrent: false,
            sourceRole: 'PRIMARY',
          },
          {
            versionNo: 2,
            isCurrent: true,
            sourceRole: 'PRIMARY',
          },
          {
            versionNo: 3,
            isCurrent: false,
            sourceRole: 'ENRICHMENT',
          },
        ],
      );

      const canonicalPublication = await db
        .selectFrom('publications')
        .select([
          'primary_official_url',
          'title',
          'effective_on',
        ])
        .where('id', '=', first.publicationId)
        .executeTakeFirstOrThrow();

      assert.equal(
        canonicalPublication.primary_official_url,
        'https://source-a.example.test/100-2026',
      );
      assert.equal(
        canonicalPublication.effective_on
          ?.toISOString()
          .slice(0, 10),
        '2026-10-01',
      );

      const origins = await db
        .selectFrom('publication_origins')
        .select(['source_id', 'publication_id'])
        .where(
          'publication_id',
          '=',
          first.publicationId,
        )
        .orderBy('source_id')
        .execute();

      assert.equal(origins.length, 2);

      const weakA = normalizePublication({
        sourceId: sourceA,
        publication: {
          title: 'Comunicado tributário',
          sphere: 'FEDERAL',
          content: 'Mesmo conteúdo.',
          officialUrl:
            'https://source-a.example.test/comunicado',
        },
      });

      const weakB = normalizePublication({
        sourceId: sourceB,
        publication: {
          title: 'Comunicado tributário',
          sphere: 'FEDERAL',
          content: 'Mesmo conteúdo.',
          officialUrl:
            'https://source-b.example.test/comunicado',
        },
      });

      const persistedWeakA = await db
        .transaction()
        .execute((trx) =>
          persistPublication(trx, {
            sourceId: sourceA,
            runId: runs[3]!,
            attemptId: attempts[3]!,
            publication: weakA,
          }),
        );

      const persistedWeakB = await db
        .transaction()
        .execute((trx) =>
          persistPublication(trx, {
            sourceId: sourceB,
            runId: runs[4]!,
            attemptId: attempts[4]!,
            publication: weakB,
          }),
        );

      assert.notEqual(
        persistedWeakA.publicationId,
        persistedWeakB.publicationId,
      );
    } finally {
      const publicationIds = await db
        .selectFrom('publication_origins')
        .select('publication_id')
        .where(
          'source_id',
          'in',
          [sourceA, sourceB],
        )
        .execute()
        .then((rows) => [
          ...new Set(
            rows.map((row) => row.publication_id),
          ),
        ]);

      await db
        .deleteFrom('collection_runs')
        .where('id', 'in', runs)
        .execute();

      await db
        .deleteFrom('publication_origins')
        .where(
          'source_id',
          'in',
          [sourceA, sourceB],
        )
        .execute();

      if (publicationIds.length > 0) {
        await db
          .deleteFrom('publications')
          .where('id', 'in', publicationIds)
          .execute();
      }

      await db
        .deleteFrom('sources')
        .where(
          'id',
          'in',
          [sourceA, sourceB],
        )
        .execute();

      await db.destroy();
    }
  },
);
