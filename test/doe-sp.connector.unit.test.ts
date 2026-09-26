import assert from 'node:assert/strict';
import test from 'node:test';

import type { ConnectorTimeBudget } from '../src/modules/collection/connector.contract.js';
import { ConnectorError } from '../src/modules/collection/connector.error.js';
import {
  DoeSpConnector,
  EMPTY_DOE_SP_STATE,
  addDays,
  saoPauloDate,
  type DoeSpSourceState,
} from '../src/modules/collection/doe-sp.connector.js';
import { parseDoeSpSourceState, reopenFailedItems } from '../src/modules/collection/doe-sp-source-state.repository.js';
import { normalizePublication } from '../src/modules/collection/publication.normalizer.js';
import {
  ID,
  list0901,
  list0902,
  list0904,
  structured0902,
  structured0904,
} from './doe-sp.fixtures.js';
import { portal, type DayFixture } from './doe-sp.portal.js';

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const context = (signal = new AbortController().signal, budget?: ConnectorTimeBudget) => ({
  sourceId: SOURCE_ID,
  runId: '22222222-2222-4222-8222-222222222222',
  attemptId: '33333333-3333-4333-8333-333333333333',
  signal,
  ...(budget ? { budget } : {}),
});
/** 2026-09-04 09:00 in São Paulo. */
const NOW = new Date('2026-09-04T12:00:00Z');
const DAY_0904: DayFixture = { structured: structured0904, list: list0904 };

function connector(options: {
  days?: Record<string, DayFixture>;
  state?: DoeSpSourceState;
  failures?: Array<{ match: string; status: number }>;
  lookbackDays?: number;
  bootstrapStartDate?: string;
  forceReprocess?: boolean;
  now?: Date;
}) {
  const api = portal({ days: options.days ?? { '2026-09-04': DAY_0904 }, ...(options.failures ? { failures: options.failures } : {}) });
  const instance = new DoeSpConnector({
    fetch: api.fetch,
    now: () => options.now ?? NOW,
    readState: async () => options.state ?? EMPTY_DOE_SP_STATE,
    lookbackDays: options.lookbackDays ?? 1,
    ...(options.bootstrapStartDate ? { bootstrapStartDate: options.bootstrapStartDate } : {}),
    forceReprocess: options.forceReprocess ?? false,
    client: { timeoutMs: 1_000 },
  });
  return { api, instance };
}

function checkpointState(result: Awaited<ReturnType<DoeSpConnector['collect']>>): DoeSpSourceState {
  return parseDoeSpSourceState(result.checkpoint?.state);
}

test('dates: São Paulo calendar day and arithmetic', () => {
  assert.equal(saoPauloDate(new Date('2026-09-05T02:30:00Z')), '2026-09-04');
  assert.equal(addDays('2026-09-01', -1), '2026-08-31');
});

test('first run: collects only included acts, as individual publications with files and evidence', async () => {
  const { api, instance } = connector({});
  const result = await instance.collect(context());

  assert.deepEqual(result.publications.map((item) => item.externalId), [ID.sre43]);
  assert.equal(result.partialFailures, undefined);
  assert.equal(result.completion, undefined);

  const sre = result.publications.find((item) => item.externalId === ID.sre43)!;
  assert.equal(sre.agency, 'SEFAZ-SP/SRE');
  assert.equal(sre.actNumber, '43/2026');
  assert.equal(sre.metadata?.captureCategory, 'SEFAZ_TAX_ADMINISTRATION');
  assert.equal(sre.sphere, 'STATE');
  assert.equal(sre.stateCode, 'SP');
  assert.equal(sre.publishedAt?.toISOString(), '2026-09-04T00:00:00.000Z');
  assert.equal(sre.metadata?.editionNumber, 169);
  assert.equal(sre.metadata?.supplementaryEditionCount, 1);
  assert.equal(sre.files?.length, 1);
  assert.equal(sre.files?.[0]?.mimeType, 'application/pdf');
  assert.match(sre.files?.[0]?.rawSha256 ?? '', /^[a-f0-9]{64}$/);
  assert.equal(sre.files?.[0]?.metadata?.kind, 'AUTHENTICATED_PUBLICATION_PDF');
  assert.equal(sre.metadata?.ementa, 'Altera a Portaria CAT 125/11, de 9 de setembro de 2011, que institui o Sistema Ambiente de Pagamentos e o Documento de Arrecadação de Receitas Estaduais - DARE-SP.');

  const meta = result.metadata?.doeSp as Record<string, any>;
  assert.equal(meta.filtering.discoveredCount, 9);
  assert.equal(meta.filtering.includedCount, 1);
  assert.equal(meta.filtering.excludedCount, 8);
  assert.deepEqual(meta.filtering.excludedByReason, {
    GOVERNOR_ACT_WITHOUT_TAX_TERMS: 2,
    PGE_WITHOUT_TAX_TERMS: 1,
    OTHER_ORGAN_WITHOUT_TAX_TERMS: 2,
    INDIVIDUAL_TAX_ADMINISTRATIVE_ACT: 2,
    NUMBERED_DECREE_WITHOUT_TAX_TERMS: 1,
  });
  // Excluded samples carry no title (they may identify taxpayers).
  assert.ok(meta.filtering.excludedSamples.every((sample: Record<string, unknown>) => !('title' in sample)));
  // Details only for included acts.
  assert.equal(api.count('/v2/publications/'), 1);

  const state = checkpointState(result);
  assert.deepEqual(state.days['2026-09-04']?.included, [ID.sre43]);
  assert.match(state.days['2026-09-04']?.idsHash ?? '', /^[a-f0-9]{64}$/);
  assert.equal(state.windowEnd, '2026-09-04');
  assert.deepEqual(state.pendingRanges, []);
});

test('replay reuses the checkpoint: no list, no detail, no download, no publication', async () => {
  const first = await connector({}).instance.collect(context());
  const { api, instance } = connector({ state: checkpointState(first) });
  const replay = await instance.collect(context());
  assert.equal(replay.publications.length, 0);
  assert.equal(replay.partialFailures, undefined);
  assert.equal(api.count('/v2/summary/list'), 0);
  assert.equal(api.count('/v2/publications/'), 0);
  assert.equal(api.count('/v2/authentication/'), 0);
  const day = (replay.metadata?.doeSp as Record<string, any>).days[0];
  assert.equal(day.skippedUnchanged, true);
  assert.deepEqual(checkpointState(replay).days['2026-09-04']?.included, checkpointState(first).days['2026-09-04']?.included);
});

test('forced replay produces byte-identical identity and content hashes (0 artificial versions)', async () => {
  const first = await connector({}).instance.collect(context());
  const forced = await connector({ state: checkpointState(first), forceReprocess: true }).instance.collect(context());
  const hashes = (result: typeof first) => result.publications
    .map((publication) => normalizePublication({ sourceId: SOURCE_ID, publication }))
    .map((item) => `${item.sourceItemKey}|${item.identityHash}|${item.contentHash}`)
    .sort();
  assert.deepEqual(hashes(forced), hashes(first));
  const normalized = first.publications.map((publication) => normalizePublication({ sourceId: SOURCE_ID, publication }));
  assert.ok(normalized.every((item) => item.identityStrength === 'STRONG'));
});

test('a new act in the day (supplement) is picked up alone', async () => {
  const first = await connector({}).instance.collect(context());
  const extraId = '739fada3-fd86-49b8-1845-08df197a65f4';
  const withExtra: DayFixture = {
    structured: {
      ...structured0904,
      items: [{ ...structured0904.items[0]!, children: [...structured0904.items[0]!.children, {
        id: 'e0e06c19-4428-471f-7d57-08db6b94d2bf', name: 'SECRETARIA DA FAZENDA E PLANEJAMENTO', publications: [{ id: extraId, title: 'PORTARIA SRE 45, DE 4 DE SETEMBRO DE 2026', slug: 'executivo/secretaria-da-fazenda-e-planejamento/portaria-sre-45' }],
      }] }],
    },
    list: { ...list0904, publications: [...list0904.publications, {
      isLegacy: false, id: extraId, publicationTypeId: 'cb4ba2b1-3c31-4d79-85be-0c348ef04c66', date: '2026-09-04T00:00:00',
      title: 'PORTARIA SRE 45, DE 4 DE SETEMBRO DE 2026', slug: 'executivo/secretaria-da-fazenda-e-planejamento/portaria-sre-45', excerpt: 'Altera a Portaria CAT 126/11',
      hierarchy: 'Executivo > Atos Normativos > Secretaria da Fazenda e Planejamento > Subsecretaria da Receita Estadual', totalTermsFound: 0,
    }] },
  };
  const api = portal({
    days: { '2026-09-04': withExtra },
    details: { [extraId]: {
      id: extraId, title: 'PORTARIA SRE 45, DE 4 DE SETEMBRO DE 2026', slug: 'executivo/secretaria-da-fazenda-e-planejamento/portaria-sre-45',
      date: '2026-09-04', journal: 'Executivo', publicationType: 'Portaria', content: '<p>Altera a Portaria CAT 126/11.</p>', attachments: [], authCode: '2026.09.04.1.1.28.3.214.9999999',
    } },
  });
  const result = await new DoeSpConnector({
    fetch: api.fetch, now: () => NOW, lookbackDays: 1, forceReprocess: false,
    readState: async () => checkpointState(first),
  }).collect(context());
  assert.deepEqual(result.publications.map((item) => item.externalId), [extraId]);
  assert.equal(result.publications[0]!.metadata?.editionHint, 'SUPPLEMENTARY_OR_EXTRA');
  assert.equal(api.count('/v2/publications/'), 1);
  assert.equal(checkpointState(result).days['2026-09-04']?.included.length, 2);
});

test('an empty day is a legitimate zero-result consultation', async () => {
  const { instance } = connector({ days: {} });
  const result = await instance.collect(context());
  assert.equal(result.publications.length, 0);
  assert.equal(result.partialFailures, undefined);
  const day = (result.metadata?.doeSp as Record<string, any>).days[0];
  assert.equal(day.complete, true);
  assert.equal(day.discovered, 0);
});

test('source unavailable is an error, never zero publications', async () => {
  const { instance } = connector({ failures: [{ match: 'do-api-web-search', status: 503 }] });
  await assert.rejects(instance.collect(context()), (error: unknown) =>
    error instanceof ConnectorError && error.kind === 'SOURCE_UNAVAILABLE');

  const windowDown = connector({ failures: [{ match: '/v2/summary/', status: 502 }], lookbackDays: 2 });
  await assert.rejects(windowDown.instance.collect(context()), (error: unknown) =>
    error instanceof ConnectorError && error.kind === 'SOURCE_UNAVAILABLE');
});

test('complete official HTML skips redundant authenticated PDF and completes the day', async () => {
  const guarded = connector({
    failures: [{
      match: '/v2/authentication/download/2026.09.03.1.1.28.3.214',
      status: 500,
    }],
  });
  const result = await guarded.instance.collect(context());

  assert.deepEqual(
    result.publications.map((item) => item.externalId),
    [ID.sre43],
  );
  assert.equal(result.partialFailures, undefined);
  const publication = result.publications[0]!;
  assert.equal(
    publication.originMetadata?.authenticatedPdf,
    'NOT_REQUESTED_REDUNDANT',
  );
  assert.equal(
    publication.originMetadata?.contentRepresentation,
    'OFFICIAL_HTML',
  );
  assert.equal(publication.files, undefined);
  assert.equal(
    guarded.api.count('/v2/authentication/download/'),
    0,
  );

  const state = checkpointState(result);
  assert.deepEqual(
    state.days['2026-09-04']?.included,
    [ID.sre43],
  );
  assert.ok(
    (state.days['2026-09-04']?.idsHash ?? '').length > 0,
  );

  const replay = connector({ state });
  const second = await replay.instance.collect(context());
  assert.deepEqual(second.publications, []);
  assert.equal(
    replay.api.count('/v2/publications/'),
    0,
    'checkpoint must reuse the complete HTML capture',
  );
});

test('malformed list items are isolated as partial failures', async () => {
  const broken: DayFixture = {
    structured: structured0904,
    list: { ...list0904, publications: [...list0904.publications, { id: 'broken' }] },
  };
  const { instance } = connector({ days: { '2026-09-04': broken } });
  const result = await instance.collect(context());
  assert.equal(result.publications.length, 1);
  assert.equal(result.partialFailures?.[0]?.code, 'DOE_SP_MALFORMED_LIST_ITEM');
  assert.equal(checkpointState(result).days['2026-09-04']?.idsHash, '');
});

test('bootstrap walks back days once, with retifications isolated and attachments hashed', async () => {
  const days = {
    '2026-09-01': { structured: { items: [] }, list: list0901 },
    '2026-09-02': { structured: structured0902, list: list0902 },
    '2026-09-04': DAY_0904,
  };
  const { api, instance } = connector({ days, bootstrapStartDate: '2026-09-01' });
  const result = await instance.collect(context());
  assert.deepEqual(result.publications.map((item) => item.externalId).sort(), [ID.sre43, ID.dicar59, ID.retification].sort());
  const state = checkpointState(result);
  assert.deepEqual(state.pendingRanges, []);
  assert.equal(state.coverageFrom, '2026-09-01');
  assert.equal(Object.keys(state.days).length, 1, 'only the incremental window is kept in the checkpoint');
  // Backfill days skip the structured probe.
  assert.equal(api.count('/v2/summary/structured?Date=2026-09-01'), 0);

  const retification = result.publications.find((item) => item.externalId === ID.retification)!;
  assert.equal(retification.actType, 'RETIFICAÇÃO');
  assert.equal(retification.identityKey, `DOE_SP|RETIFICACAO|${ID.retification}`);
  assert.equal(retification.actNumber, undefined);
  assert.equal(normalizePublication({ sourceId: SOURCE_ID, publication: retification }).identityStrength, 'SOURCE_SCOPED');

  const dicar = result.publications.find((item) => item.externalId === ID.dicar59)!;
  assert.equal(dicar.agency, 'SEFAZ-SP/DICAR');
  assert.equal(dicar.files?.length, 1);
  const attachment = dicar.files?.find((file) => file.metadata?.kind === 'ATTACHMENT');
  assert.equal(
    dicar.metadata?.officialContentCompleteness,
    'PARTIAL_OFFICIAL_CONTENT',
    'page alone is not integral when a material attachment exists',
  );
  assert.equal(
    dicar.contentHashPolicy,
    'HTML_PRIMARY_MATERIAL_FILES',
  );
  assert.equal(attachment?.versionRole, 'MATERIAL_CONTENT');
  assert.equal(
    dicar.originMetadata?.authenticatedPdf,
    'NOT_REQUESTED_REDUNDANT',
  );
  assert.equal(
    dicar.originMetadata?.contentRepresentation,
    'OFFICIAL_HTML',
  );
  assert.equal(attachment?.name, 'Anexo_Com DICAR-59 - Publicação Juros ITCMD e IPVA - SET-26.pdf');
  assert.equal(attachment?.externalId, 'ede64d5b-2bdc-4c9b-bfd3-841a1c69eded');
  assert.match(attachment?.rawSha256 ?? '', /^[a-f0-9]{64}$/);

  // Extending the bootstrap later only queues the new, earlier range.
  const extended = await connector({ days, state, bootstrapStartDate: '2026-08-30' }).instance.collect(context());
  assert.equal(checkpointState(extended).coverageFrom, '2026-08-30');
  assert.deepEqual(extended.publications.map((item) => item.externalId), []);
});

test('time budget stops at a safe point and resumes from the checkpoint', async () => {
  const days = {
    '2026-09-01': { structured: { items: [] }, list: list0901 },
    '2026-09-02': { structured: structured0902, list: list0902 },
    '2026-09-04': DAY_0904,
  };
  let calls = 0;
  const budget: ConnectorTimeBudget = {
    deadlineAt: new Date(Date.now() + 60_000),
    softDeadlineAt: new Date(Date.now() + 30_000),
    remainingMs: () => 30_000,
    // Window day passes; stop before the first backfill day.
    shouldYield: () => ++calls > 4,
  };
  const { instance } = connector({ days, bootstrapStartDate: '2026-09-01' });
  const partial = await instance.collect(context(undefined, budget));
  assert.equal(partial.completion?.complete, false);
  assert.equal(partial.completion?.reason, 'TIME_BUDGET_REACHED');
  const state = checkpointState(partial);
  assert.ok(state.pendingRanges.length > 0);

  const resumed = await connector({ days, state, bootstrapStartDate: '2026-09-01' }).instance.collect(context());
  assert.equal(resumed.completion, undefined);
  assert.deepEqual(checkpointState(resumed).pendingRanges, []);
  const all = new Set([...partial.publications, ...resumed.publications].map((item) => item.externalId));
  assert.deepEqual([...all].sort(), [ID.sre43, ID.dicar59, ID.retification].sort());
});

test('downtime longer than the window is queued as a gap', async () => {
  const state: DoeSpSourceState = { coverageFrom: '2026-08-01', windowEnd: '2026-08-30', pendingRanges: [], days: {} };
  const result = await connector({ state, days: { '2026-09-04': DAY_0904 } }).instance.collect(context());
  const meta = result.metadata?.doeSp as Record<string, any>;
  assert.equal(meta.backfillDaysProcessed, 4); // 2026-08-31 .. 2026-09-03
  assert.deepEqual(checkpointState(result).pendingRanges, []);
});

test('cancellation propagates', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(connector({}).instance.collect(context(controller.signal)), (error: unknown) =>
    error instanceof ConnectorError && error.kind === 'CANCELLED');
});

test('state repository: items that failed persistence are reopened', () => {
  const state: DoeSpSourceState = {
    coverageFrom: '2026-09-01', windowEnd: '2026-09-04', pendingRanges: [],
    days: { '2026-09-04': { idsHash: 'a'.repeat(64), total: 9, included: [ID.sre43, ID.decree70843], checkedAt: NOW.toISOString() } },
  };
  const reopened = reopenFailedItems(state, [
    { externalId: ID.sre43, doeDate: '2026-09-04' },
    { externalId: ID.dicar59, doeDate: '2026-09-02' },
  ]);
  assert.deepEqual(reopened.days['2026-09-04']?.included, [ID.decree70843]);
  assert.equal(reopened.days['2026-09-04']?.idsHash, '');
  assert.deepEqual(reopened.pendingRanges, [{ from: '2026-09-02', to: '2026-09-02' }]);
  assert.deepEqual(parseDoeSpSourceState({ days: { bad: 1, '2026-09-04': { idsHash: 'x' } } }).days, {});
});
