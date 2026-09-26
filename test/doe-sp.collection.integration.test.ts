import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import type { DB } from '../src/infrastructure/database/database.types.js';
import { acquireNextCollectionRun, createCollectionRun } from '../src/modules/collection/collection-run.repository.js';
import { processAcquiredCollectionRun } from '../src/modules/collection/collection.engine.js';
import { ConnectorRegistry } from '../src/modules/collection/connector.registry.js';
import { DoeSpConnector } from '../src/modules/collection/doe-sp.connector.js';
import { readDoeSpSourceState } from '../src/modules/collection/doe-sp-source-state.repository.js';
import { ID, list0901, list0902, list0904, structured0902, structured0904 } from './doe-sp.fixtures.js';
import { portal } from './doe-sp.portal.js';

test('DOE-SP through the collection engine: persistence, checkpoint reuse and forced replay without duplicates or versions', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required for DOE-SP integration tests.');

  const pool = new Pool({ connectionString: adminUrl, max: 3 });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  const sourceId = randomUUID();
  let sequence = 0;
  let force = false;

  const api = portal({
    days: {
      '2026-09-01': { structured: { items: [] }, list: list0901 },
      '2026-09-02': { structured: structured0902, list: list0902 },
      '2026-09-04': { structured: structured0904, list: list0904 },
    },
  });
  const registry = new ConnectorRegistry();
  const connector = new DoeSpConnector({
    fetch: api.fetch,
    now: () => new Date('2026-09-04T12:00:00Z'),
    readState: (source) => readDoeSpSourceState(db, source),
    lookbackDays: 2,
    bootstrapStartDate: '2026-09-01',
  });
  registry.register({
    key: connector.key,
    collect: (context) => new DoeSpConnector({
      fetch: api.fetch,
      now: () => new Date('2026-09-04T12:00:00Z'),
      readState: (source) => readDoeSpSourceState(db, source),
      lookbackDays: 2,
      bootstrapStartDate: '2026-09-01',
      forceReprocess: force,
    }).collect(context),
  });

  async function run() {
    const runId = await createCollectionRun(db, {
      sourceId,
      scheduledFor: new Date(Date.now() - 60_000 + sequence++),
      triggerType: 'MANUAL',
    });
    const acquired = await acquireNextCollectionRun(db, `doe-sp-worker-${sourceId}`);
    assert.ok(acquired);
    assert.equal(acquired.id, runId);
    return processAcquiredCollectionRun(db, registry, acquired, { timeoutMs: 10_000, heartbeatIntervalMs: 0 });
  }

  try {
    await db.insertInto('sources').values({
      id: sourceId,
      code: `doe-sp-${sourceId}`,
      name: 'DOE-SP integration fixture',
      jurisdiction_level: 'STATE',
      uf: 'SP',
      agency: 'Imprensa Oficial / Prodesp',
      base_url: 'https://doe.sp.gov.br/',
      connector_key: 'doe-sp',
      max_attempts: 1,
    }).execute();

    const first = await run();
    assert.equal(first.status, 'SUCCESS');
    assert.equal(first.metrics.newPublications, 3);
    assert.equal(first.metrics.newVersions, 0);

    const origins = await db.selectFrom('publication_origins')
      .select(['publication_id', 'external_id', 'official_url', 'metadata'])
      .where('source_id', '=', sourceId)
      .execute();
    assert.equal(origins.length, 3);
    assert.deepEqual(origins.map((origin) => origin.external_id).sort(), [ID.sre43, ID.dicar59, ID.retification].sort());
    assert.ok(origins.every((origin) => origin.official_url.startsWith('https://doe.sp.gov.br/executivo/')));
    const originFiles = origins.flatMap((origin) =>
      (((origin.metadata as Record<string, unknown>).files as Array<Record<string, unknown>>) ?? []),
    );
    assert.equal(originFiles.length, 4); // 3 authenticated PDFs + 1 attachment remain provenance by origin
    assert.equal(
      originFiles.filter((file) =>
        (file.metadata as Record<string, unknown> | undefined)?.kind ===
        'AUTHENTICATED_PUBLICATION_PDF',
      ).length,
      3,
    );
    assert.equal(
      originFiles.filter((file) =>
        (file.metadata as Record<string, unknown> | undefined)?.kind ===
        'ATTACHMENT',
      ).length,
      1,
    );

    const publications = await db.selectFrom('publications as p')
      .innerJoin('publication_origins as po', 'po.publication_id', 'p.id')
      .select(['p.act_type', 'p.act_number', 'p.agency', 'p.uf', 'p.jurisdiction_level', 'p.identity_strength'])
      .where('po.source_id', '=', sourceId)
      .execute();
    const sre = publications.find((row) => row.act_number === '43/2026');
    assert.equal(sre?.identity_strength, 'STRONG');
    assert.equal(sre?.uf, 'SP');
    assert.equal(sre?.jurisdiction_level, 'STATE');
    assert.equal(publications.filter((row) => row.identity_strength === 'SOURCE_SCOPED').length, 1);

    const versions = await db.selectFrom('publication_versions as v')
      .innerJoin('publication_origins as po', 'po.publication_id', 'v.publication_id')
      .select(['v.source_metadata'])
      .where('po.source_id', '=', sourceId)
      .execute();
    const files = versions.flatMap((row) => ((row.source_metadata as Record<string, unknown>).files as Array<Record<string, unknown>>) ?? []);
    assert.equal(files.length, 1); // only material attachment remains version-relevant
    assert.equal(
      (files[0]?.metadata as Record<string, unknown> | undefined)?.kind,
      'ATTACHMENT',
    );
    assert.ok(files.every((file) => /^[a-f0-9]{64}$/.test(String(file.rawSha256)) && Number(file.sizeBytes) > 0));

    const detailsBeforeReplay = api.count('/v2/publications/');
    const replay = await run();
    assert.equal(replay.status, 'SUCCESS_NO_RESULTS');
    assert.equal(api.count('/v2/publications/'), detailsBeforeReplay, 'checkpoint reused: no detail refetch');

    force = true;
    const forced = await run();
    assert.equal(forced.status, 'SUCCESS');
    assert.equal(forced.metrics.newPublications, 0);
    assert.equal(forced.metrics.newVersions, 0);
    assert.equal(forced.metrics.existingPublications, 1); // window (2 days) re-read; backfill is not repeated

    const counts = await db.selectFrom('publication_origins as po')
      .innerJoin('publication_versions as v', 'v.publication_id', 'po.publication_id')
      .select((eb) => [eb.fn.countAll<string>().as('versions'), eb.fn.count<string>('po.id').distinct().as('origins')])
      .where('po.source_id', '=', sourceId)
      .executeTakeFirstOrThrow();
    assert.equal(Number(counts.versions), 3);
    assert.equal(Number(counts.origins), 3);

    const state = await readDoeSpSourceState(db, sourceId);
    assert.deepEqual(state.pendingRanges, []);
    assert.equal(state.coverageFrom, '2026-09-01');
  } finally {
    const publicationIds = [...new Set(
      (await db.selectFrom('publication_origins').select('publication_id').where('source_id', '=', sourceId).execute())
        .map((row) => row.publication_id),
    )];
    await db.deleteFrom('collection_checkpoints').where('source_id', '=', sourceId).execute();
    await db.deleteFrom('collection_runs').where('source_id', '=', sourceId).execute();
    await db.deleteFrom('publication_origins').where('source_id', '=', sourceId).execute();
    if (publicationIds.length) await db.deleteFrom('publications').where('id', 'in', publicationIds).execute();
    await db.deleteFrom('sources').where('id', '=', sourceId).execute();
    await db.destroy();
  }
});


test('DOE-SP HTML-primary: Portaria SRE 42 duplicate origins persist as one publication/version without borrowing PDF provenance', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required for DOE-SP integration tests.');

  const pool = new Pool({ connectionString: adminUrl, max: 3 });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  const sourceId = randomUUID();
  const date = '2025-07-29';
  const badId = '6098db3e-c841-40de-c0fc-08ddce07602e';
  const goodId = '645399a3-5a4e-44f7-c5cd-08ddcdea30ea';
  const badAuth = '2025.07.28.1.1.27.5.214.1229474';
  const goodAuth = '2025.07.28.1.1.27.5.214.1229788';
  const publicationTypeId = 'cb4ba2b1-3c31-4d79-85be-0c348ef04c66';
  const title = 'PORTARIA SRE 42, DE 28 DE JULHO DE 2025';
  const hierarchy =
    'Executivo > Atos Normativos > Secretaria da Fazenda e Planejamento > Subsecretaria da Receita Estadual';
  const content =
    '<p>Texto oficial integral e idêntico da Portaria SRE 42.</p>';
  const items = [
    {
      isLegacy: false,
      id: badId,
      publicationTypeId,
      date: date + 'T01:00:00',
      title,
      slug:
        'executivo/secretaria-da-fazenda-e-planejamento/portaria-sre-42-html-primary-a',
      excerpt: 'Altera disciplina tributária.',
      hierarchy,
      totalTermsFound: 0,
    },
    {
      isLegacy: false,
      id: goodId,
      publicationTypeId,
      date: date + 'T01:00:01',
      title,
      slug:
        'executivo/secretaria-da-fazenda-e-planejamento/portaria-sre-42-html-primary-b',
      excerpt: 'Altera disciplina tributária.',
      hierarchy,
      totalTermsFound: 0,
    },
  ];
  const detailsFixture = {
    [badId]: {
      id: badId,
      title,
      slug: items[0]!.slug,
      date,
      journal: 'Executivo',
      section: 'Subsecretaria da Receita Estadual',
      firstLevelSectionName: 'Atos Normativos',
      secondLevelSectionName: 'Secretaria da Fazenda e Planejamento',
      publicationType: 'Portaria',
      editionPages: [],
      content,
      attachments: [],
      authCode: badAuth,
    },
    [goodId]: {
      id: goodId,
      title,
      slug: items[1]!.slug,
      date,
      journal: 'Executivo',
      section: 'Subsecretaria da Receita Estadual',
      firstLevelSectionName: 'Atos Normativos',
      secondLevelSectionName: 'Secretaria da Fazenda e Planejamento',
      publicationType: 'Portaria',
      editionPages: [],
      content,
      attachments: [],
      authCode: goodAuth,
    },
  };
  const api = portal({
    days: {
      [date]: {
        structured: {
          journalName: 'Executivo',
          items: [{
            id: '257b103f-1eb2-4f24-a170-4e553c7e4aac',
            name: 'Atos Normativos',
            children: [{
              id: 'e0e06c19-4428-471f-7d57-08db6b94d2bf',
              name: 'SECRETARIA DA FAZENDA E PLANEJAMENTO',
              publications: items.map((item) => ({
                id: item.id,
                title: item.title,
                slug: item.slug,
              })),
            }],
          }],
        },
        list: {
          pages: 1,
          pageSize: 10,
          publications: items,
        },
      },
    },
    details: detailsFixture,
    failures: [{
      match:
        '/v2/authentication/download/' + badAuth,
      status: 404,
    }],
  });

  const registry = new ConnectorRegistry();
  registry.register({
    key: 'doe-sp',
    collect: (context) =>
      new DoeSpConnector({
        fetch: api.fetch,
        now: () =>
          new Date(date + 'T15:00:00Z'),
        readState: (source) =>
          readDoeSpSourceState(db, source),
        lookbackDays: 1,
        bootstrapStartDate: date,
        forceReprocess: true,
      }).collect(context),
  });

  async function run(sequence: number) {
    const runId = await createCollectionRun(db, {
      sourceId,
      scheduledFor: new Date(
        Date.parse(date + 'T16:00:00Z') + sequence,
      ),
      triggerType: 'MANUAL',
    });
    const acquired = await acquireNextCollectionRun(
      db,
      `doe-sp-html-primary-${sourceId}`,
    );
    assert.ok(acquired);
    assert.equal(acquired.id, runId);
    return processAcquiredCollectionRun(
      db,
      registry,
      acquired,
      {
        timeoutMs: 10_000,
        heartbeatIntervalMs: 0,
      },
    );
  }

  try {
    await db.insertInto('sources').values({
      id: sourceId,
      code: `doe-sp-html-primary-${sourceId}`,
      name: 'DOE-SP HTML-primary duplicate-origin fixture',
      jurisdiction_level: 'STATE',
      uf: 'SP',
      agency: 'Imprensa Oficial / Prodesp',
      base_url: 'https://doe.sp.gov.br/',
      connector_key: 'doe-sp',
      max_attempts: 1,
    }).execute();

    const first = await run(0);
    assert.equal(first.status, 'SUCCESS');
    assert.equal(first.metrics.newPublications, 1);
    assert.equal(first.metrics.existingPublications, 1);
    assert.equal(first.metrics.newVersions, 0);

    const origins = await db
      .selectFrom('publication_origins')
      .select([
        'publication_id',
        'external_id',
        'metadata',
      ])
      .where('source_id', '=', sourceId)
      .execute();
    assert.equal(origins.length, 2);
    assert.equal(
      new Set(
        origins.map((origin) => origin.publication_id),
      ).size,
      1,
    );

    const badOrigin = origins.find(
      (origin) => origin.external_id === badId,
    )!;
    const goodOrigin = origins.find(
      (origin) => origin.external_id === goodId,
    )!;
    const badMetadata =
      badOrigin.metadata as Record<string, unknown>;
    const goodMetadata =
      goodOrigin.metadata as Record<string, unknown>;

    assert.equal(
      badMetadata.authenticatedPdf,
      'UNAVAILABLE_REDUNDANT',
    );
    assert.equal(
      (badMetadata.authenticatedPdfError as
        Record<string, unknown>)?.httpStatus,
      404,
    );
    assert.equal(
      badMetadata.files,
      undefined,
      '404 origin must not receive the PDF owned by the other official origin',
    );

    const goodFiles =
      goodMetadata.files as
        Array<Record<string, unknown>>;
    assert.equal(goodFiles.length, 1);
    assert.equal(
      (goodFiles[0]?.metadata as
        Record<string, unknown>)?.kind,
      'AUTHENTICATED_PUBLICATION_PDF',
    );
    assert.equal(
      goodFiles[0]?.versionRole,
      'PROVENANCE',
    );

    const versions = await db
      .selectFrom('publication_versions')
      .select([
        'id',
        'content_hash',
        'source_metadata',
      ])
      .where(
        'publication_id',
        '=',
        badOrigin.publication_id,
      )
      .execute();
    assert.equal(
      versions.length,
      1,
      'two equivalent official origins must not create an artificial content version',
    );
    const versionMetadata =
      versions[0]!.source_metadata as
        Record<string, unknown>;
    assert.equal(
      versionMetadata.contentHashVersion,
      2,
    );
    assert.equal(
      versionMetadata.files,
      undefined,
      'redundant authenticated PDF must stay out of canonical v2 version metadata',
    );

    const replay = await run(1);
    assert.equal(replay.status, 'SUCCESS');
    assert.equal(replay.metrics.newPublications, 0);
    assert.equal(replay.metrics.newVersions, 0);
    assert.equal(replay.metrics.existingPublications, 2);

    const afterReplay = await db
      .selectFrom('publication_versions')
      .select(['id', 'content_hash'])
      .where(
        'publication_id',
        '=',
        badOrigin.publication_id,
      )
      .execute();
    assert.equal(afterReplay.length, 1);
    assert.equal(
      afterReplay[0]?.id,
      versions[0]?.id,
    );
    assert.equal(
      afterReplay[0]?.content_hash,
      versions[0]?.content_hash,
    );
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
      .deleteFrom('collection_checkpoints')
      .where('source_id', '=', sourceId)
      .execute();
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
});
