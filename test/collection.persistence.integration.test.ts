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


test(
  'HTML-primary v2 reuses a semantically equivalent legacy DOE-SP version without mutating its hash or borrowing PDF provenance',
  async () => {
    const adminUrl = process.env.DATABASE_ADMIN_URL;
    assert.ok(adminUrl);

    const pool = new Pool({
      connectionString: adminUrl,
      max: 2,
    });
    const db = new Kysely<DB>({
      dialect: new PostgresDialect({ pool }),
    });
    const sourceId = randomUUID();
    const runIds = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    const attemptIds = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    const pdfHash = '8'.repeat(64);

    try {
      await db.insertInto('sources').values({
        id: sourceId,
        code: 'doe-html-primary-' + sourceId,
        name: 'DOE HTML primary compatibility',
        jurisdiction_level: 'STATE',
        uf: 'SP',
        base_url: 'https://doe.sp.gov.br/',
        connector_key: 'test-doe-html-primary',
      }).execute();
      await db.insertInto('collection_runs').values(
        runIds.map((id, index) => ({
          id,
          source_id: sourceId,
          scheduled_for: new Date(
            `2026-09-26T0${index}:00:00Z`,
          ),
          trigger_type: 'MANUAL' as const,
        })),
      ).execute();
      await db.insertInto('collection_attempts').values(
        attemptIds.map((id, index) => ({
          id,
          collection_run_id: runIds[index]!,
          attempt_no: 1,
          status: 'RUNNING' as const,
        })),
      ).execute();

      const shared = {
        title:
          'PORTARIA SRE 42, DE 28 DE JULHO DE 2025',
        agency: 'SEFAZ-SP/SRE',
        sphere: 'STATE' as const,
        stateCode: 'SP',
        actType: 'PORTARIA',
        actNumber: '42/2025',
        publishedAt:
          new Date('2025-07-29T00:00:00Z'),
        content:
          'Texto oficial integral e idêntico da Portaria SRE 42.',
      };

      const legacy = normalizePublication({
        sourceId,
        publication: {
          ...shared,
          officialUrl:
            'https://doe.sp.gov.br/portaria-sre-42/origem-com-pdf',
          externalId: '645399a3-5a4e-44f7-c5cd-08ddcdea30ea',
          files: [{
            url:
              'https://do-api-publication-pdf.doe.sp.gov.br/authenticated.pdf',
            rawSha256: pdfHash,
            sizeBytes: 466_065,
            metadata: {
              kind:
                'AUTHENTICATED_PUBLICATION_PDF',
              origin: 'DOE_SP',
            },
          }],
          metadata: {
            sourceRole: 'PRIMARY',
            authCode: 'auth-valid',
            authenticatedPdf: 'CAPTURED',
          },
        },
      });

      const first = await db.transaction().execute(
        (trx) => persistPublication(trx, {
          sourceId,
          runId: runIds[0]!,
          attemptId: attemptIds[0]!,
          publication: legacy,
        }),
      );
      assert.equal(
        first.disposition,
        'NEW_PUBLICATION',
      );

      const legacyVersionBefore = await db
        .selectFrom('publication_versions')
        .select([
          'id',
          'content_hash',
          'source_metadata',
        ])
        .where('id', '=', first.publicationVersionId)
        .executeTakeFirstOrThrow();

      const htmlOnly404 = normalizePublication({
        sourceId,
        publication: {
          ...shared,
          officialUrl:
            'https://doe.sp.gov.br/portaria-sre-42/origem-pdf-404',
          externalId: '6098db3e-c841-40de-c0fc-08ddce07602e',
          contentHashPolicy:
            'HTML_PRIMARY_MATERIAL_FILES',
          metadata: {
            sourceRole: 'PRIMARY',
          },
          originMetadata: {
            authCode: 'auth-404',
            authenticatedPdf:
              'UNAVAILABLE_REDUNDANT',
            authenticatedPdfError: {
              code: 'DOE_SP_HTTP_ERROR',
              httpStatus: 404,
            },
          },
        },
      });

      assert.notEqual(
        htmlOnly404.contentHash,
        legacy.contentHash,
        'v2 intentionally differs from the historical v1 hash',
      );

      const second = await db.transaction().execute(
        (trx) => persistPublication(trx, {
          sourceId,
          runId: runIds[1]!,
          attemptId: attemptIds[1]!,
          publication: htmlOnly404,
        }),
      );
      assert.equal(
        second.disposition,
        'EXISTING_PUBLICATION',
      );
      assert.equal(
        second.publicationId,
        first.publicationId,
      );
      assert.equal(
        second.publicationVersionId,
        first.publicationVersionId,
      );

      const replay = await db.transaction().execute(
        (trx) => persistPublication(trx, {
          sourceId,
          runId: runIds[2]!,
          attemptId: attemptIds[2]!,
          publication: htmlOnly404,
        }),
      );
      assert.equal(
        replay.disposition,
        'EXISTING_PUBLICATION',
      );
      assert.equal(
        replay.publicationVersionId,
        first.publicationVersionId,
      );

      const versions = await db
        .selectFrom('publication_versions')
        .select([
          'id',
          'content_hash',
          'source_metadata',
        ])
        .where('publication_id', '=', first.publicationId)
        .execute();
      assert.equal(versions.length, 1);
      assert.equal(
        versions[0]?.content_hash,
        legacyVersionBefore.content_hash,
        'legacy contentHash must remain untouched',
      );
      assert.deepEqual(
        versions[0]?.source_metadata,
        legacyVersionBefore.source_metadata,
        'legacy version files/source_metadata must remain untouched',
      );

      const htmlOnlyVersionMetadata =
        htmlOnly404.metadata as Record<string, unknown>;
      assert.equal(htmlOnlyVersionMetadata.authCode, undefined);
      assert.equal(
        htmlOnlyVersionMetadata.authenticatedPdf,
        undefined,
      );
      assert.equal(
        htmlOnlyVersionMetadata.authenticatedPdfError,
        undefined,
      );

      const origins = await db
        .selectFrom('publication_origins')
        .select(['external_id', 'metadata'])
        .where('publication_id', '=', first.publicationId)
        .execute();
      assert.equal(origins.length, 2);
      const withPdf = origins.find(
        (row) =>
          row.external_id ===
          '645399a3-5a4e-44f7-c5cd-08ddcdea30ea',
      )!;
      const withoutPdf = origins.find(
        (row) =>
          row.external_id ===
          '6098db3e-c841-40de-c0fc-08ddce07602e',
      )!;
      const withPdfFiles =
        (withPdf.metadata as Record<string, unknown>)
          .files as Array<Record<string, unknown>>;
      assert.equal(withPdfFiles.length, 1);
      assert.equal(
        withPdfFiles[0]?.rawSha256,
        pdfHash,
      );
      assert.equal(
        (withoutPdf.metadata as Record<string, unknown>)
          .files,
        undefined,
        '404 origin must never inherit another origin PDF',
      );
      assert.equal(
        ((withoutPdf.metadata as Record<string, unknown>)
          .authenticatedPdfError as
          Record<string, unknown>)?.httpStatus,
        404,
      );
    } finally {
      const publicationIds = await db
        .selectFrom('publication_origins')
        .select('publication_id')
        .where('source_id', '=', sourceId)
        .execute()
        .then((rows) => [
          ...new Set(
            rows.map((row) => row.publication_id),
          ),
        ]);
      await db.deleteFrom('collection_runs')
        .where('source_id', '=', sourceId)
        .execute();
      await db.deleteFrom('publication_origins')
        .where('source_id', '=', sourceId)
        .execute();
      if (publicationIds.length) {
        await db.deleteFrom('publications')
          .where('id', 'in', publicationIds)
          .execute();
      }
      await db.deleteFrom('sources')
        .where('id', '=', sourceId)
        .execute();
      await db.destroy();
    }
  },
);

test(
  'HTML-primary v2 reuses reproducible legacy DOE-SP version without PDF while preserving new PDF only on its origin',
  async () => {
    const adminUrl = process.env.DATABASE_ADMIN_URL;
    assert.ok(adminUrl);

    const pool = new Pool({
      connectionString: adminUrl,
      max: 2,
    });
    const db = new Kysely<DB>({
      dialect: new PostgresDialect({ pool }),
    });
    const sourceId = randomUUID();
    const runIds = [randomUUID(), randomUUID()];
    const attemptIds = [randomUUID(), randomUUID()];
    const pdfHash = '9'.repeat(64);

    try {
      await db.insertInto('sources').values({
        id: sourceId,
        code: 'doe-html-no-pdf-' + sourceId,
        name: 'DOE HTML legacy no-PDF compatibility',
        jurisdiction_level: 'STATE',
        uf: 'SP',
        base_url: 'https://doe.sp.gov.br/',
        connector_key: 'test-doe-html-no-pdf',
      }).execute();
      await db.insertInto('collection_runs').values(
        runIds.map((id, index) => ({
          id,
          source_id: sourceId,
          scheduled_for: new Date(
            `2026-09-26T1${index}:00:00Z`,
          ),
          trigger_type: 'MANUAL' as const,
        })),
      ).execute();
      await db.insertInto('collection_attempts').values(
        attemptIds.map((id, index) => ({
          id,
          collection_run_id: runIds[index]!,
          attempt_no: 1,
          status: 'RUNNING' as const,
        })),
      ).execute();

      const shared = {
        title:
          'PORTARIA SRE 43, DE 29 DE JULHO DE 2025',
        agency: 'SEFAZ-SP/SRE',
        sphere: 'STATE' as const,
        stateCode: 'SP',
        actType: 'PORTARIA',
        actNumber: '43/2025',
        publishedAt:
          new Date('2025-07-30T00:00:00Z'),
        content:
          'Texto oficial integral da Portaria SRE 43.',
      };

      const legacy = normalizePublication({
        sourceId,
        publication: {
          ...shared,
          officialUrl:
            'https://doe.sp.gov.br/portaria-sre-43/legado-sem-pdf',
          externalId: 'legacy-no-pdf',
          metadata: {
            sourceRole: 'PRIMARY',
            authenticatedPdf:
              'NOT_RENDERED_BY_SOURCE',
          },
        },
      });

      const first = await db.transaction().execute(
        (trx) => persistPublication(trx, {
          sourceId,
          runId: runIds[0]!,
          attemptId: attemptIds[0]!,
          publication: legacy,
        }),
      );
      assert.equal(first.disposition, 'NEW_PUBLICATION');

      const legacyBefore = await db
        .selectFrom('publication_versions')
        .select([
          'id',
          'content_hash',
          'source_metadata',
        ])
        .where('id', '=', first.publicationVersionId)
        .executeTakeFirstOrThrow();

      const v2WithPdf = normalizePublication({
        sourceId,
        publication: {
          ...shared,
          officialUrl:
            'https://doe.sp.gov.br/portaria-sre-43/nova-origem-com-pdf',
          externalId: 'v2-with-pdf',
          contentHashPolicy:
            'HTML_PRIMARY_MATERIAL_FILES',
          files: [{
            url:
              'https://do-api-publication-pdf.doe.sp.gov.br/authenticated-43.pdf',
            rawSha256: pdfHash,
            sizeBytes: 123_456,
            versionRole: 'PROVENANCE',
            metadata: {
              kind:
                'AUTHENTICATED_PUBLICATION_PDF',
              origin: 'DOE_SP',
            },
          }],
          metadata: {
            sourceRole: 'PRIMARY',
          },
          originMetadata: {
            authCode: 'auth-43',
            authenticatedPdf: 'CAPTURED',
          },
        },
      });

      const second = await db.transaction().execute(
        (trx) => persistPublication(trx, {
          sourceId,
          runId: runIds[1]!,
          attemptId: attemptIds[1]!,
          publication: v2WithPdf,
        }),
      );

      assert.equal(
        second.disposition,
        'EXISTING_PUBLICATION',
      );
      assert.equal(
        second.publicationId,
        first.publicationId,
      );
      assert.equal(
        second.publicationVersionId,
        first.publicationVersionId,
      );

      const versions = await db
        .selectFrom('publication_versions')
        .select([
          'id',
          'content_hash',
          'source_metadata',
        ])
        .where('publication_id', '=', first.publicationId)
        .execute();
      assert.equal(versions.length, 1);
      assert.equal(
        versions[0]?.content_hash,
        legacyBefore.content_hash,
      );
      assert.deepEqual(
        versions[0]?.source_metadata,
        legacyBefore.source_metadata,
      );

      const origins = await db
        .selectFrom('publication_origins')
        .select(['external_id', 'metadata'])
        .where('publication_id', '=', first.publicationId)
        .execute();
      assert.equal(origins.length, 2);
      const newOrigin = origins.find(
        (row) => row.external_id === 'v2-with-pdf',
      )!;
      const newFiles =
        (newOrigin.metadata as Record<string, unknown>)
          .files as Array<Record<string, unknown>>;
      assert.equal(newFiles.length, 1);
      assert.equal(newFiles[0]?.rawSha256, pdfHash);
    } finally {
      const publicationIds = await db
        .selectFrom('publication_origins')
        .select('publication_id')
        .where('source_id', '=', sourceId)
        .execute()
        .then((rows) => [
          ...new Set(
            rows.map((row) => row.publication_id),
          ),
        ]);
      await db.deleteFrom('collection_runs')
        .where('source_id', '=', sourceId)
        .execute();
      await db.deleteFrom('publication_origins')
        .where('source_id', '=', sourceId)
        .execute();
      if (publicationIds.length) {
        await db.deleteFrom('publications')
          .where('id', 'in', publicationIds)
          .execute();
      }
      await db.deleteFrom('sources')
        .where('id', '=', sourceId)
        .execute();
      await db.destroy();
    }
  },
);

test(
  'HTML-primary legacy compatibility does not suppress real changes or insufficiently classified legacy files',
  async () => {
    const adminUrl = process.env.DATABASE_ADMIN_URL;
    assert.ok(adminUrl);

    const pool = new Pool({
      connectionString: adminUrl,
      max: 2,
    });
    const db = new Kysely<DB>({
      dialect: new PostgresDialect({ pool }),
    });
    const sourceId = randomUUID();
    const variants = [
      'title',
      'text',
      'effective',
      'attachment',
      'unknown-file',
      'hash-evidence',
    ] as const;
    const runIds = variants.flatMap(() => [
      randomUUID(),
      randomUUID(),
    ]);
    const attemptIds = runIds.map(() => randomUUID());
    const baseAttachmentHash = 'a'.repeat(64);
    const changedAttachmentHash = 'b'.repeat(64);

    try {
      await db.insertInto('sources').values({
        id: sourceId,
        code: 'doe-html-divergence-' + sourceId,
        name: 'DOE HTML divergence evidence',
        jurisdiction_level: 'STATE',
        uf: 'SP',
        base_url: 'https://doe.sp.gov.br/',
        connector_key: 'test-doe-html-divergence',
      }).execute();
      await db.insertInto('collection_runs').values(
        runIds.map((id, index) => ({
          id,
          source_id: sourceId,
          scheduled_for:
            new Date(
              Date.UTC(
                2026,
                8,
                26,
                Math.floor(index / 2),
                index % 2,
              ),
            ),
          trigger_type: 'MANUAL' as const,
        })),
      ).execute();
      await db.insertInto('collection_attempts').values(
        attemptIds.map((id, index) => ({
          id,
          collection_run_id: runIds[index]!,
          attempt_no: 1,
          status: 'RUNNING' as const,
        })),
      ).execute();

      for (
        let index = 0;
        index < variants.length;
        index += 1
      ) {
        const variant = variants[index]!;
        const actNumber = `${900 + index}/2026`;
        const common = {
          title: `PORTARIA SRE ${actNumber}`,
          agency: 'SEFAZ-SP/SRE',
          sphere: 'STATE' as const,
          stateCode: 'SP',
          actType: 'PORTARIA',
          actNumber,
          publishedAt:
            new Date('2026-09-26T00:00:00Z'),
          effectiveAt:
            new Date('2026-10-01T00:00:00Z'),
          content: 'Texto oficial original.',
          officialUrl:
            `https://doe.sp.gov.br/${variant}`,
          externalId: `legacy-${variant}`,
        };
        const legacyFiles =
          variant === 'unknown-file'
            ? [{
                url:
                  'https://doe.sp.gov.br/unknown.bin',
                rawSha256: 'c'.repeat(64),
                sizeBytes: 10,
                metadata: {
                  kind: 'UNKNOWN_LEGACY_FILE',
                },
              }]
            : [
                {
                  url:
                    'https://doe.sp.gov.br/auth.pdf',
                  rawSha256: 'd'.repeat(64),
                  sizeBytes: 20,
                  metadata: {
                    kind:
                      'AUTHENTICATED_PUBLICATION_PDF',
                  },
                },
                {
                  url:
                    'https://doe.sp.gov.br/material.pdf',
                  rawSha256:
                    baseAttachmentHash,
                  sizeBytes: 30,
                  metadata: {
                    kind: 'ATTACHMENT',
                  },
                },
              ];

        const legacy = normalizePublication({
          sourceId,
          publication: {
            ...common,
            files: legacyFiles,
            metadata: {
              sourceRole: 'PRIMARY',
            },
          },
        });
        const first = await db.transaction().execute(
          (trx) => persistPublication(trx, {
            sourceId,
            runId: runIds[index * 2]!,
            attemptId: attemptIds[index * 2]!,
            publication: legacy,
          }),
        );

        if (variant === 'hash-evidence') {
          await db
            .updateTable('publication_versions')
            .set({
              content_hash: 'e'.repeat(64),
            })
            .where('id', '=', first.publicationVersionId)
            .execute();
        }

        const incomingFiles =
          variant === 'unknown-file'
            ? undefined
            : [{
                url:
                  'https://doe.sp.gov.br/material.pdf',
                rawSha256:
                  variant === 'attachment'
                    ? changedAttachmentHash
                    : baseAttachmentHash,
                sizeBytes: 30,
                versionRole:
                  'MATERIAL_CONTENT' as const,
                metadata: {
                  kind: 'ATTACHMENT',
                },
              }];
        const incoming = normalizePublication({
          sourceId,
          publication: {
            ...common,
            ...(variant === 'title'
              ? {
                  title:
                    common.title + ' ALTERADA',
                }
              : {}),
            ...(variant === 'text'
              ? {
                  content:
                    'Texto oficial efetivamente alterado.',
                }
              : {}),
            ...(variant === 'effective'
              ? {
                  effectiveAt:
                    new Date(
                      '2026-10-02T00:00:00Z',
                    ),
                }
              : {}),
            contentHashPolicy:
              'HTML_PRIMARY_MATERIAL_FILES',
            ...(incomingFiles
              ? { files: incomingFiles }
              : {}),
            metadata: {
              sourceRole: 'PRIMARY',
            },
          },
        });

        const second = await db.transaction().execute(
          (trx) => persistPublication(trx, {
            sourceId,
            runId: runIds[index * 2 + 1]!,
            attemptId:
              attemptIds[index * 2 + 1]!,
            publication: incoming,
          }),
        );
        assert.equal(
          second.publicationId,
          first.publicationId,
        );
        assert.equal(
          second.disposition,
          'NEW_VERSION',
          `${variant} must remain explicit and may not be suppressed by legacy compatibility`,
        );
      }
    } finally {
      const publicationIds = await db
        .selectFrom('publication_origins')
        .select('publication_id')
        .where('source_id', '=', sourceId)
        .execute()
        .then((rows) => [
          ...new Set(
            rows.map((row) => row.publication_id),
          ),
        ]);
      await db.deleteFrom('collection_runs')
        .where('source_id', '=', sourceId)
        .execute();
      await db.deleteFrom('publication_origins')
        .where('source_id', '=', sourceId)
        .execute();
      if (publicationIds.length) {
        await db.deleteFrom('publications')
          .where('id', 'in', publicationIds)
          .execute();
      }
      await db.deleteFrom('sources')
        .where('id', '=', sourceId)
        .execute();
      await db.destroy();
    }
  },
);
