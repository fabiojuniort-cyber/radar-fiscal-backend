import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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
  'origin metadata keeps the production-proven DOE-SP alternate PDF only on the valid origin',
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

    const sourceId = randomUUID();
    const runGood = randomUUID();
    const runBad = randomUUID();
    const runRecover = randomUUID();
    const runReplay = randomUUID();
    const attemptGood = randomUUID();
    const attemptBad = randomUUID();
    const attemptRecover = randomUUID();
    const attemptReplay = randomUUID();
    const goodId =
      '645399a3-5a4e-44f7-c5cd-08ddcdea30ea';
    const badId =
      '6098db3e-c841-40de-c0fc-08ddce07602e';
    const productionSha =
      '8a7e747ac3233fb9dd33df41416086c2860b5c2f2099d7bd0df106bfa26f4f30';
    const productionSize = 466_065;
    const validFile = {
      url:
        'https://do-api-web-search.doe.sp.gov.br/v2/authentication/download/2025.07.28.1.1.27.5.214.1229788',
      mimeType: 'application/pdf',
      rawSha256: productionSha,
      sizeBytes: productionSize,
      metadata: {
        kind: 'AUTHENTICATED_PUBLICATION_PDF',
        origin: 'DOE_SP',
      },
    };
    const recoveredPdfBytes = Buffer.from(
      '%PDF-1.4\n% recovered-own-6098\n%%EOF\n',
      'utf8',
    );
    const recoveredSha = createHash('sha256')
      .update(recoveredPdfBytes)
      .digest('hex');
    const recoveredSize =
      recoveredPdfBytes.byteLength;
    assert.notEqual(recoveredSha, productionSha);
    const recoveredFile = {
      url:
        'https://do-api-web-search.doe.sp.gov.br/v2/authentication/download/2025.07.28.1.1.27.5.214.1229474',
      mimeType: 'application/pdf',
      rawSha256: recoveredSha,
      sizeBytes: recoveredSize,
      metadata: {
        kind: 'AUTHENTICATED_PUBLICATION_PDF',
        origin: 'DOE_SP',
      },
    };
    const common = {
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
        'Texto canônico idêntico da Portaria SRE 42.',
    };

    try {
      await db
        .insertInto('sources')
        .values({
          id: sourceId,
          code: `doe-sp-provenance-${sourceId}`,
          name: 'DOE-SP provenance persistence fixture',
          jurisdiction_level: 'STATE',
          uf: 'SP',
          agency: 'Imprensa Oficial / Prodesp',
          base_url: 'https://doe.sp.gov.br/',
          connector_key: 'doe-sp',
        })
        .execute();

      await db
        .insertInto('collection_runs')
        .values([
          {
            id: runGood,
            source_id: sourceId,
            scheduled_for:
              new Date('2026-09-25T10:00:00Z'),
            trigger_type: 'MANUAL',
          },
          {
            id: runBad,
            source_id: sourceId,
            scheduled_for:
              new Date('2026-09-25T10:01:00Z'),
            trigger_type: 'MANUAL',
          },
          {
            id: runRecover,
            source_id: sourceId,
            scheduled_for:
              new Date('2026-09-25T10:02:00Z'),
            trigger_type: 'MANUAL',
          },
          {
            id: runReplay,
            source_id: sourceId,
            scheduled_for:
              new Date('2026-09-25T10:03:00Z'),
            trigger_type: 'MANUAL',
          },
        ])
        .execute();

      await db
        .insertInto('collection_attempts')
        .values([
          {
            id: attemptGood,
            collection_run_id: runGood,
            attempt_no: 1,
            status: 'RUNNING',
          },
          {
            id: attemptBad,
            collection_run_id: runBad,
            attempt_no: 1,
            status: 'RUNNING',
          },
          {
            id: attemptRecover,
            collection_run_id: runRecover,
            attempt_no: 1,
            status: 'RUNNING',
          },
          {
            id: attemptReplay,
            collection_run_id: runReplay,
            attempt_no: 1,
            status: 'RUNNING',
          },
        ])
        .execute();

      const good = normalizePublication({
        sourceId,
        publication: {
          ...common,
          officialUrl:
            'https://doe.sp.gov.br/executivo/portaria-sre-42-valid',
          externalId: goodId,
          files: [validFile],
          metadata: {
            sourceRole: 'PRIMARY',
            authenticatedPdf: 'CAPTURED',
          },
        },
      });

      const bad = normalizePublication({
        sourceId,
        publication: {
          ...common,
          officialUrl:
            'https://doe.sp.gov.br/executivo/portaria-sre-42-404',
          externalId: badId,
          versionFiles: [validFile],
          artifactEquivalence: {
            kind:
              'PROVEN_EQUIVALENT_REPRESENTATION',
            equivalentExternalId: goodId,
          },
          metadata: {
            sourceRole: 'VALIDATION',
            authenticatedPdf:
              'AUTH_PDF_404_EQUIVALENT_REPRESENTATION',
            equivalentRepresentation: {
              externalId: goodId,
              authenticatedPdf: {
                ownerExternalId: goodId,
                rawSha256: productionSha,
                sizeBytes: productionSize,
              },
            },
            authenticatedPdfError: {
              code: 'DOE_SP_HTTP_ERROR',
              httpStatus: 404,
              endpoint:
                '/v2/authentication/download/{authCode}',
            },
          },
        },
      });

      const persistedGood = await db
        .transaction()
        .execute((trx) =>
          persistPublication(trx, {
            sourceId,
            runId: runGood,
            attemptId: attemptGood,
            publication: good,
          }),
        );
      const persistedBad = await db
        .transaction()
        .execute((trx) =>
          persistPublication(trx, {
            sourceId,
            runId: runBad,
            attemptId: attemptBad,
            publication: bad,
          }),
        );

      assert.equal(
        persistedBad.publicationId,
        persistedGood.publicationId,
      );
      assert.equal(
        persistedBad.publicationVersionId,
        persistedGood.publicationVersionId,
      );

      const origins = await db
        .selectFrom('publication_origins')
        .select(['external_id', 'publication_id', 'metadata'])
        .where('source_id', '=', sourceId)
        .execute();
      assert.equal(origins.length, 2);
      assert.equal(
        new Set(
          origins.map((row) => row.publication_id),
        ).size,
        1,
      );

      const goodOrigin = origins.find(
        (row) => row.external_id === goodId,
      )!;
      const badOrigin = origins.find(
        (row) => row.external_id === badId,
      )!;
      const goodMetadata =
        goodOrigin.metadata as Record<string, unknown>;
      const badMetadata =
        badOrigin.metadata as Record<string, unknown>;
      const goodFiles =
        goodMetadata.files as Array<Record<string, unknown>>;

      assert.equal(goodFiles.length, 1);
      assert.equal(
        goodFiles[0]?.rawSha256,
        productionSha,
      );
      assert.equal(
        goodFiles[0]?.sizeBytes,
        productionSize,
      );
      assert.equal(
        Object.hasOwn(badMetadata, 'files'),
        false,
      );
      assert.equal(
        badMetadata.authenticatedPdf,
        'AUTH_PDF_404_EQUIVALENT_REPRESENTATION',
      );

      const badItem = await db
        .selectFrom('collection_items')
        .select('raw_metadata')
        .where('collection_run_id', '=', runBad)
        .where('external_id', '=', badId)
        .executeTakeFirstOrThrow();
      const badItemMetadata =
        badItem.raw_metadata as Record<string, unknown>;
      assert.equal(
        Object.hasOwn(badItemMetadata, 'files'),
        false,
      );

      const versions = await db
        .selectFrom('publication_versions')
        .select(['source_metadata'])
        .where(
          'publication_id',
          '=',
          persistedGood.publicationId,
        )
        .execute();
      assert.equal(versions.length, 1);
      const versionFiles =
        (versions[0]!.source_metadata as Record<string, unknown>)
          .files as Array<Record<string, unknown>>;
      assert.equal(
        versionFiles[0]?.rawSha256,
        productionSha,
      );
      assert.equal(
        versionFiles[0]?.sizeBytes,
        productionSize,
      );
      const canonicalVersionId =
        persistedGood.publicationVersionId;
      const canonicalVersion = await db
        .selectFrom('publication_versions')
        .select(['content_hash'])
        .where('id', '=', canonicalVersionId)
        .executeTakeFirstOrThrow();

      const recovered = normalizePublication({
        sourceId,
        publication: {
          ...common,
          officialUrl:
            'https://doe.sp.gov.br/executivo/portaria-sre-42-404',
          externalId: badId,
          files: [recoveredFile],
          artifactReconciliation: {
            kind: 'RECOVER_ORIGIN_ARTIFACT',
          },
          metadata: {
            sourceRole: 'PRIMARY',
            authenticatedPdf: 'CAPTURED',
          },
        },
      });

      const recoveredResult = await db
        .transaction()
        .execute((trx) =>
          persistPublication(trx, {
            sourceId,
            runId: runRecover,
            attemptId: attemptRecover,
            publication: recovered,
          }),
        );

      assert.equal(
        recoveredResult.disposition,
        'EXISTING_PUBLICATION',
      );
      assert.equal(
        recoveredResult.publicationId,
        persistedGood.publicationId,
      );
      assert.equal(
        recoveredResult.publicationVersionId,
        canonicalVersionId,
      );

      const afterRecoveryVersions = await db
        .selectFrom('publication_versions')
        .select(['id', 'content_hash', 'source_metadata'])
        .where(
          'publication_id',
          '=',
          persistedGood.publicationId,
        )
        .execute();
      assert.equal(afterRecoveryVersions.length, 1);
      assert.equal(
        afterRecoveryVersions[0]!.id,
        canonicalVersionId,
      );
      assert.equal(
        afterRecoveryVersions[0]!.content_hash,
        canonicalVersion.content_hash,
      );
      const canonicalFilesAfterRecovery =
        (afterRecoveryVersions[0]!.source_metadata as Record<string, unknown>)
          .files as Array<Record<string, unknown>>;
      assert.equal(
        canonicalFilesAfterRecovery[0]?.rawSha256,
        productionSha,
      );

      const originsAfterRecovery = await db
        .selectFrom('publication_origins')
        .select(['external_id', 'metadata'])
        .where('source_id', '=', sourceId)
        .execute();
      assert.equal(originsAfterRecovery.length, 2);
      const recoveredBadOrigin =
        originsAfterRecovery.find(
          (row) => row.external_id === badId,
        )!;
      const recoveredGoodOrigin =
        originsAfterRecovery.find(
          (row) => row.external_id === goodId,
        )!;
      const recoveredBadMetadata =
        recoveredBadOrigin.metadata as Record<string, unknown>;
      const recoveredGoodMetadata =
        recoveredGoodOrigin.metadata as Record<string, unknown>;
      assert.equal(
        recoveredBadMetadata.authenticatedPdf,
        'CAPTURED',
      );
      const recoveredBadFiles =
        recoveredBadMetadata.files as Array<Record<string, unknown>>;
      assert.equal(
        recoveredBadFiles[0]?.rawSha256,
        recoveredSha,
      );
      assert.equal(
        recoveredBadFiles[0]?.sizeBytes,
        recoveredSize,
      );
      const recoveredGoodFiles =
        recoveredGoodMetadata.files as Array<Record<string, unknown>>;
      assert.equal(
        recoveredGoodFiles[0]?.rawSha256,
        productionSha,
      );
      assert.equal(
        recoveredGoodFiles[0]?.sizeBytes,
        productionSize,
      );

      const reconciliation =
        recoveredBadMetadata.artifactReconciliation as Record<string, unknown>;
      assert.equal(reconciliation.state, 'RECONCILED');
      assert.equal(
        reconciliation.equivalentExternalId,
        goodId,
      );
      const history =
        recoveredBadMetadata.artifactReconciliationHistory as Array<Record<string, unknown>>;
      assert.equal(history.length, 1);
      const previous =
        history[0]?.previousOriginMetadata as Record<string, unknown>;
      assert.equal(
        previous.authenticatedPdf,
        'AUTH_PDF_404_EQUIVALENT_REPRESENTATION',
      );
      const previousEquivalent =
        previous.equivalentRepresentation as Record<string, unknown>;
      assert.equal(
        previousEquivalent.externalId,
        goodId,
      );

      const replayResult = await db
        .transaction()
        .execute((trx) =>
          persistPublication(trx, {
            sourceId,
            runId: runReplay,
            attemptId: attemptReplay,
            publication: recovered,
          }),
        );
      assert.equal(
        replayResult.disposition,
        'EXISTING_PUBLICATION',
      );
      assert.equal(
        replayResult.publicationVersionId,
        canonicalVersionId,
      );
      const replayVersions = await db
        .selectFrom('publication_versions')
        .select('id')
        .where(
          'publication_id',
          '=',
          persistedGood.publicationId,
        )
        .execute();
      assert.equal(replayVersions.length, 1);
      const replayOrigins = await db
        .selectFrom('publication_origins')
        .select(['external_id', 'metadata'])
        .where('source_id', '=', sourceId)
        .execute();
      assert.equal(replayOrigins.length, 2);
      const replayBadMetadata =
        replayOrigins.find(
          (row) => row.external_id === badId,
        )!.metadata as Record<string, unknown>;
      const replayHistory =
        replayBadMetadata.artifactReconciliationHistory as Array<Record<string, unknown>>;
      assert.equal(replayHistory.length, 1);
    } finally {
      const publicationIds = [
        ...new Set(
          (
            await db
              .selectFrom('publication_origins')
              .select('publication_id')
              .where('source_id', '=', sourceId)
              .execute()
          ).map((row) => row.publication_id),
        ),
      ];
      await db
        .deleteFrom('collection_runs')
        .where('source_id', '=', sourceId)
        .execute();
      await db
        .deleteFrom('publication_origins')
        .where('source_id', '=', sourceId)
        .execute();
      if (publicationIds.length) {
        await db
          .deleteFrom('publications')
          .where('id', 'in', publicationIds)
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
