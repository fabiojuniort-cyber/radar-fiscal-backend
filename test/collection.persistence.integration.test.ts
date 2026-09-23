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


test(
  'SPED gov.br PRIMARY and legacy ENRICHMENT share one publication and keep two origins',
  async () => {
    const adminUrl = process.env.DATABASE_ADMIN_URL;
    assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required for collection integration tests.');

    const pool = new Pool({ connectionString: adminUrl, max: 2 });
    const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
    const sourceId = randomUUID();
    const runPrimary = randomUUID();
    const runLegacy = randomUUID();
    const attemptPrimary = randomUUID();
    const attemptLegacy = randomUUID();

    try {
      await db.insertInto('sources').values({
        id: sourceId,
        code: `sped-mirror-${sourceId}`,
        name: 'SPED mirror correlation test',
        jurisdiction_level: 'FEDERAL',
        base_url: 'https://www.gov.br/sped/pt-br/',
        connector_key: 'sped',
      }).execute();

      await db.insertInto('collection_runs').values([
        {
          id: runPrimary,
          source_id: sourceId,
          scheduled_for: new Date('2026-09-22T10:00:00Z'),
          trigger_type: 'MANUAL',
        },
        {
          id: runLegacy,
          source_id: sourceId,
          scheduled_for: new Date('2026-09-22T11:00:00Z'),
          trigger_type: 'MANUAL',
        },
      ]).execute();

      await db.insertInto('collection_attempts').values([
        {
          id: attemptPrimary,
          collection_run_id: runPrimary,
          attempt_no: 1,
          status: 'RUNNING',
        },
        {
          id: attemptLegacy,
          collection_run_id: runLegacy,
          attempt_no: 1,
          status: 'RUNNING',
        },
      ]).execute();

      const identityKey =
        'SPED|EFD_ICMS_IPI|GUIDE|EFD ICMS/IPI GUIA PRATICO|3.2.4|OFFICIAL_VERSION';

      const primary = normalizePublication({
        sourceId,
        publication: {
          title: 'Guia Prático EFD ICMS IPI versão 3.2.4',
          agency: 'SPED/RFB',
          sphere: 'FEDERAL',
          actType: 'GUIA PRÁTICO SPED',
          actNumber: 'v3.2.4',
          officialUrl:
            'https://www.gov.br/sped/pt-br/assuntos/escrituracoes-digitais/efd-icms-ipi/guia-3-2-4',
          externalId:
            'govbr:/sped/pt-br/assuntos/escrituracoes-digitais/efd-icms-ipi/guia-3-2-4',
          identityKey,
          content: 'Conteúdo canônico do gov.br.',
          metadata: {
            sourceRole: 'PRIMARY',
            sourcePortal: 'GOVBR',
            documentFamily: 'EFD ICMS/IPI Guia Prático',
            officialVersion: '3.2.4',
          },
        },
      });

      const primaryResult = await db.transaction().execute((trx) =>
        persistPublication(trx, {
          sourceId,
          runId: runPrimary,
          attemptId: attemptPrimary,
          publication: primary,
        }),
      );

      assert.equal(primaryResult.disposition, 'NEW_PUBLICATION');

      const legacy = normalizePublication({
        sourceId,
        publication: {
          title: 'Guia Prático EFD ICMS/IPI - Versão 3.2.4',
          agency: 'SPED/RFB',
          sphere: 'FEDERAL',
          actType: 'GUIA PRÁTICO SPED',
          actNumber: 'v3.2.4',
          officialUrl: 'https://sped.rfb.gov.br/item/show/9999',
          externalId: 'item:9999',
          identityKey,
          content: 'Conteúdo histórico do portal legado.',
          metadata: {
            sourceRole: 'ENRICHMENT',
            sourcePortal: 'LEGACY',
            documentFamily: 'EFD ICMS/IPI Guia Prático',
            officialVersion: '3.2.4',
          },
        },
      });

      const legacyResult = await db.transaction().execute((trx) =>
        persistPublication(trx, {
          sourceId,
          runId: runLegacy,
          attemptId: attemptLegacy,
          publication: legacy,
        }),
      );

      assert.equal(legacyResult.publicationId, primaryResult.publicationId);
      assert.equal(legacyResult.disposition, 'NEW_VERSION');

      const publications = await db
        .selectFrom('publications')
        .select(['id', 'primary_official_url'])
        .where('id', '=', primaryResult.publicationId)
        .execute();

      assert.equal(publications.length, 1);
      assert.equal(
        publications[0]?.primary_official_url,
        primary.officialUrl,
      );

      const origins = await db
        .selectFrom('publication_origins')
        .select(['external_id', 'official_url', 'metadata'])
        .where('publication_id', '=', primaryResult.publicationId)
        .orderBy('external_id')
        .execute();

      assert.equal(origins.length, 2);
      assert.deepEqual(
        new Set(origins.map((origin) =>
          (origin.metadata as Record<string, unknown>)?.sourceRole,
        )),
        new Set(['PRIMARY', 'ENRICHMENT']),
      );

      const versions = await db
        .selectFrom('publication_versions')
        .select(['version_no', 'is_current', 'source_metadata'])
        .where('publication_id', '=', primaryResult.publicationId)
        .orderBy('version_no')
        .execute();

      assert.equal(versions.length, 2);
      assert.equal(versions.filter((version) => version.is_current).length, 1);
      assert.equal(
        (versions.find((version) => version.is_current)?.source_metadata as Record<string, unknown>)
          ?.sourceRole,
        'PRIMARY',
      );
    } finally {
      const publicationIds = await db
        .selectFrom('publication_origins')
        .select('publication_id')
        .where('source_id', '=', sourceId)
        .execute()
        .then((rows) => [...new Set(rows.map((row) => row.publication_id))]);

      await db.deleteFrom('collection_runs').where('source_id', '=', sourceId).execute();
      await db.deleteFrom('publication_origins').where('source_id', '=', sourceId).execute();
      if (publicationIds.length > 0) {
        await db.deleteFrom('publications').where('id', 'in', publicationIds).execute();
      }
      await db.deleteFrom('sources').where('id', '=', sourceId).execute();
      await db.destroy();
    }
  },
);
