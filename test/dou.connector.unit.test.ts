import assert from 'node:assert/strict';
import test from 'node:test';
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type QueryResult } from 'kysely';
import type { DB } from '../src/infrastructure/database/database.types.js';
import { DOU_XML_SECTIONS, DouConnector, douCollectionDates, type DouState } from '../src/modules/collection/dou.connector.js';
import { DouReserveClient } from '../src/modules/collection/dou-reserve.client.js';
import { beginDouCoverage, coverageDates, markDouCoverage, mergeDouOriginProvenance } from '../src/modules/collection/dou-coverage.js';
import { readDouSourceState } from '../src/modules/collection/dou-source-state.repository.js';
import { executeConnector } from '../src/modules/collection/connector.executor.js';
import { summarizeDouCoverage } from '../src/modules/operations/source-health.js';
import { normalizePublication } from '../src/modules/collection/publication.normalizer.js';
import { fixtureDouZipLink, fixtureEntries, fixtureFetch, makeZip } from './dou.fixtures.js';
const septemberZipIndex = fixtureDouZipLink('S01092026.zip') + fixtureDouZipLink('S03092026.zip');
import { buildConnectorRegistry } from '../src/modules/collection/connector-registry.factory.js';
const context = () => ({ sourceId:'dou',runId:'run',attemptId:'attempt',signal:new AbortController().signal });
const credentials = () => ({ email:'test@example.invalid',password:'fixture' });

test('reserve revisits a changed monthly ZIP for delayed extras and returns to primary on the next successful run', async () => {
  const normal = await fixtureEntries('DO1');
  const extra = await fixtureEntries('DO1E');
  const empty = await makeZip([]);
  const first = await makeZip(normal);
  const second = await makeZip([
    ...normal.map(entry => ({ ...entry, name: `20260918/DO1/${entry.name}` })),
    ...extra.map((entry, index) => ({ ...entry, name: `20260918/DO1E/${index === 0 ? entry.name.replace(/\.xml$/, '.XML') : entry.name}` })),
    { name: '20260917/DO1/515_20260917_10000.xml', bytes: Buffer.from('unselected payload') },
    { name: '20260918/DO1/1_BCB_2_001.jpg', bytes: Buffer.from('ffd8ffe0', 'hex') },
    { name: '20260918/DO1/Thumbs.db', bytes: Buffer.from('d0cf11e0a1b11ae1', 'hex') },
    { name: '2026-09-17-DO1E.zip', bytes: Buffer.from('out-of-scope known daily ZIP') },
  ]);
  let snapshot = first;
  let primaryReturns = false;
  let reserveRequests = 0;
  const primary = await fixtureFetch();
  const fetchInlabs: typeof fetch = async (input, init) =>
    primaryReturns ? primary(input, init) : new Response(null, { status: 404 });
  const fallback: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'www.in.gov.br');
    assert.equal(new Headers(init?.headers).has('cookie'), false);
    if (url.pathname === '/leiturajornal') return new Response('<html>Portal reference unavailable</html>');
    reserveRequests++;
    if (url.pathname.endsWith('/base-de-dados')) {
      assert.equal(url.search, '?ano=2026&mes=Setembro');
      return new Response([
        fixtureDouZipLink('S01092026_Atualizado171650.zip'),
        fixtureDouZipLink('S03092026_Atualizado171929.zip'),
        '<a href="https://example.invalid/fake">S01102026_Atualizado171650.zip</a>',
        '<a href="/documents/wrong-month">S01102026_Atualizado171650.zip</a>',
      ].join(''));
    }
    assert.equal(url.searchParams.get('download'), 'true');
    return new Response(new Uint8Array(url.pathname.includes('/S01') ? snapshot : empty));
  };
  let state: DouState = { archives: {} };
  const connector = new DouConnector({
    credentials, fetch: fetchInlabs, reserve: new DouReserveClient(fallback),
    dates: ['2026-09-18'], now: () => new Date('2026-09-21T12:00:00Z'), readState: async () => state,
  });
  function remember(result: Awaited<ReturnType<DouConnector['collect']>>) {
    state = {
      archives: result.metadata!.douArchives as DouState['archives'],
      reserveArchives: result.metadata!.douReserveArchives as NonNullable<DouState['reserveArchives']>,
      reserveCoverage: result.metadata!.douCoverage as NonNullable<DouState['reserveCoverage']>,
    };
  }
  const normalOnly = await connector.collect(context());
  assert.equal(normalOnly.publications.length, 4);
  assert.deepEqual(normalOnly.partialFailures, []);
  const observation = (normalOnly.metadata!.dou as { archives: Record<string, unknown>[] }).archives[0]!;
  assert.equal(observation.extrasComplete, false);
  assert.deepEqual(observation.unobservedSections, ['DO1E']);
  remember(normalOnly);

  assert.equal((await connector.collect(context())).publications.length, 0);
  snapshot = second;
  const withExtra = await connector.collect(context());
  assert.equal(withExtra.publications.length, 10);
  assert.ok(withExtra.publications.every(publication => publication.metadata?.ingestionChannel === 'DOU_OPEN_DATA_ZIP'));
  assert.ok(withExtra.publications.every(publication => publication.officialUrl.includes('pesquisa.in.gov.br')));
  assert.ok(withExtra.publications.some(publication => publication.externalId?.includes(':DO1E:')));
  remember(withExtra);

  const requestsBeforeRecovery = reserveRequests;
  primaryReturns = true;
  const recovered = await connector.collect(context());
  assert.equal(reserveRequests, requestsBeforeRecovery);
  assert.equal(recovered.publications.length, 10);
  assert.ok(recovered.publications.every(publication => publication.metadata?.ingestionChannel === 'INLABS'));
  assert.deepEqual(recovered.metadata?.douReserveArchives, state.reserveArchives);
  const normalize = (publication: typeof recovered.publications[number]) => {
    const { identityHash, contentHash, officialUrl } = normalizePublication({ sourceId: 'dou', publication });
    return [publication.externalId, identityHash, contentHash, officialUrl];
  };
  assert.deepEqual(recovered.publications.map(normalize).sort(), withExtra.publications.map(normalize).sort());
  const reserveObservation = withExtra.publications.find(p => p.externalId === recovered.publications[0]!.externalId)!;
  const primaryObservation = recovered.publications[0]!;
  const baseOrigin = normalizePublication({ sourceId: 'dou', publication: primaryObservation }).originMetadata;
  const reserveOrigin = normalizePublication({ sourceId: 'dou', publication: reserveObservation }).originMetadata;
  const fromPrimaryToReserve = mergeDouOriginProvenance(baseOrigin, reserveOrigin);
  const fromReserveToPrimary = mergeDouOriginProvenance(fromPrimaryToReserve, baseOrigin);
  assert.equal(fromPrimaryToReserve.ingestionChannel, 'DOU_OPEN_DATA_ZIP');
  assert.equal(fromReserveToPrimary.ingestionChannel, 'INLABS');
  assert.deepEqual(fromReserveToPrimary.douArchiveByChannel, fromPrimaryToReserve.douArchiveByChannel);
  assert.deepEqual(Object.keys(fromReserveToPrimary.douArchiveByChannel as object).sort(), ['DOU_OPEN_DATA_ZIP', 'INLABS']);
  remember(recovered);
  primaryReturns = false;
  const backToReserve = await connector.collect(context());
  assert.equal(backToReserve.publications.length, 10, 'a known reserve SHA still emits provenance after channel change');
  assert.deepEqual(backToReserve.publications.map(normalize).sort(), recovered.publications.map(normalize).sort());
});

test('reserve is opt-in and never handles authentication rejection or rate limiting', async () => {
  let reserveRequests = 0;
  const reserve = new DouReserveClient(async () => { reserveRequests++; throw new Error('unexpected reserve call'); });
  for (const [status, code] of [[401, 'INLABS_AUTH_FAILED'], [429, 'INLABS_RATE_LIMITED']] as const) {
    const connector = new DouConnector({ credentials, reserve, dates: ['2026-09-18'], fetch: async () => new Response(null, { status }) });
    await assert.rejects(connector.collect(context()), { code });
  }
  const connector = new DouConnector({ credentials, dates: ['2026-09-18'], fetch: async () => new Response(null, { status: 404 }) });
  await assert.rejects(connector.collect(context()), { code: 'INLABS_HTTP_ERROR' });
  assert.equal(reserveRequests, 0);
});

test('a later INLABS outage cannot mix a partially emitted primary run with reserve output', async () => {
  const primary = await fixtureFetch();
  let reserveRequests = 0;
  let published = 0;
  const connector = new DouConnector({
    credentials, dates: ['2026-09-18'],
    reserve: new DouReserveClient(async () => { reserveRequests++; throw new Error('unexpected reserve call'); }),
    fetch: async (input, init) => new URL(String(input)).searchParams.get('dl')?.endsWith('DO1E.zip')
      ? new Response(null, { status: 503 })
      : primary(input, init),
  });
  await assert.rejects(connector.collectIncremental(context(), async () => { published++; }), { code: 'INLABS_UNAVAILABLE' });
  assert.ok(published > 0);
  assert.equal(reserveRequests, 0);
});

test('an unconfirmed monthly edition does not create a success or follow an external redirect', async () => {
  const empty = await makeZip([]);
  let redirect: string | undefined;
  const requested: string[] = [];
  const connector = new DouConnector({
    credentials, dates: ['2026-09-18'], fetch: async () => new Response(null, { status: 503 }),
    reserve: new DouReserveClient(async input => {
      const url = new URL(String(input));
      requested.push(url.hostname);
      if (url.pathname.endsWith('/base-de-dados')) return new Response(septemberZipIndex);
      if (url.pathname === '/leiturajornal') return new Response('<html>Portal reference unavailable</html>');
      return redirect && url.pathname.includes('/S01')
        ? new Response(null, { status: 302, headers: { location: redirect } })
        : new Response(new Uint8Array(empty));
    }),
  });
  const result = await connector.collect(context());
  assert.equal(result.completion?.complete, false);
  assert.equal(result.metadata?.douConsultation, 'OK');
  assert.equal(result.metadata?.douCoverageStatus, 'INCOMPLETE');
  redirect = 'https://example.invalid/S01092026.zip';
  await assert.rejects(connector.collect(context()), { code: 'DOU_RESERVE_HTTP_ERROR' });
  redirect = 'https://www.in.gov.br/other/S01092026.zip';
  await assert.rejects(connector.collect(context()), { code: 'DOU_RESERVE_HTTP_ERROR' });
  assert.deepEqual(requested, Array(9).fill('www.in.gov.br'));
});

test('monthly nested ZIP validates folder date, package section, XML section and leaf uniqueness', async () => {
  const [fixture] = await fixtureEntries('DO1');
  assert.ok(fixture);
  const valid = { ...fixture, name: `20260918/DO1/${fixture.name}` };
  let entries = [valid];
  const connector = new DouConnector({
    credentials, dates: ['2026-09-18'], fetch: async () => new Response(null, { status: 503 }),
    reserve: new DouReserveClient(async input => new URL(String(input)).pathname.endsWith('/base-de-dados')
      ? new Response(septemberZipIndex)
      : new Response(new Uint8Array(await makeZip(String(input).includes('S03') ? [] : entries)))),
  });
  assert.equal((await connector.collect(context())).publications.length, 1);
  entries = [{ ...valid, name: `20260917/DO1/${fixture.name}` }];
  await assert.rejects(connector.collect(context()), { code: 'DOU_ZIP_FOLDER_DATE_MISMATCH' });
  entries = [{ ...valid, name: `20260918/DO3/${fixture.name}` }];
  await assert.rejects(connector.collect(context()), { code: 'DOU_UNSAFE_ZIP_PATH' });
  entries = [{ ...valid, name: `20260918/DO1E/${fixture.name}` }];
  await assert.rejects(connector.collect(context()), { code: 'DOU_ZIP_FOLDER_SECTION_MISMATCH' });
  entries = [valid, fixture];
  await assert.rejects(connector.collect(context()), { code: 'DOU_UNSAFE_ZIP' });
});

test('official ZIP discovery requests each selected year-month once', async () => {
  const requested: string[] = [];
  const client = new DouReserveClient(async input => {
    requested.push(new URL(String(input)).search);
    return new Response(fixtureDouZipLink('S03122026.zip') + fixtureDouZipLink('S01012027.zip'));
  });
  const result = await client.index(['2026-12', '2027-01', '2026-12'], AbortSignal.timeout(2000));
  assert.deepEqual(requested, ['?ano=2026&mes=Dezembro', '?ano=2027&mes=Janeiro']);
  assert.deepEqual([...result.keys()], ['S03122026', 'S01012027']);
});

test('official ZIP filenames must agree and priority is independent of anchor order', async () => {
  const monthly = fixtureDouZipLink('S01112026.zip');
  const monthlyMirror = fixtureDouZipLink('S01112026.zip', 2);
  const updated = fixtureDouZipLink('S01112026_Atualizado150000.zip');
  const secondUpdated = fixtureDouZipLink('S01112026_Atualizado170000.zip', 2);
  const wrong = fixtureDouZipLink('S03112026.zip', 1, 'S01112026.zip');
  const resolve = (links: string[]) => new DouReserveClient(async () => new Response(links.join('')))
    .index(['2026-11'], AbortSignal.timeout(2_000));
  for (const links of [[monthly, monthlyMirror, updated], [updated, monthlyMirror, monthly]]) {
    assert.equal((await resolve(links)).get('S01112026')?.filename, 'S01112026_Atualizado150000.zip');
  }
  assert.equal((await resolve([wrong])).size, 0);
  assert.equal((await resolve([fixtureDouZipLink('S01112026.zip', 1, 'ZIP')])).size, 0);
  assert.equal((await resolve([fixtureDouZipLink('S01112026.zip', 1, 'S01112026_unexpected.zip')])).size, 0);
  assert.equal((await resolve(['<a href="/archive/S01112026.zip">S01112026.zip</a>'])).size, 0);
  assert.equal((await resolve([monthly, updated, secondUpdated])).size, 0);
  for (const invalidUpdate of [
    '<a href="/novo-caminho/pkg">S01112026_Atualizado150000.zip</a>',
    '<a>S01112026_Atualizado250000.zip</a>',
  ]) {
    for (const order of [[monthly, invalidUpdate], [invalidUpdate, monthly]]) {
      assert.equal((await resolve(order)).has('S01112026'), false);
    }
  }
});

test('portal counts are recorded separately and the due queue advances across a month rollover', async () => {
  const inventory = new DouReserveClient(async input => {
    const url = new URL(String(input));
    const section = url.searchParams.get('secao')?.toUpperCase();
    const portalSection = section === 'DO1E' ? 'DO1_EXTRA_C' : section;
    const jsonArray = section === 'DO1E' ? [{ pubName: portalSection, editionNumber: '218-C' }] : [];
    return new Response(`<script id="params" type="application/json">${JSON.stringify({
      dateUrl: url.searchParams.get('data'), section: portalSection, typeNormDay: { DO1E: true, DO3E: false }, jsonArray,
    })}</script>`);
  });
  const expectedEd = await inventory.editions('2026-11-19', AbortSignal.timeout(2_000));
  assert.deepEqual(expectedEd, { DO1: {}, DO1E: { '218-C': 1 }, DO3: {}, DO3E: {} });
  const nov20 = new Date('2026-11-20T20:00:00Z');
  let ledger = markDouCoverage(beginDouCoverage(undefined, nov20), ['2026-11-18', '2026-11-19', '2026-11-20'], nov20, {
    channel: 'DOU_OPEN_DATA_ZIP', observed: {}, expected: { '2026-11-19:DO1E': { '218-C': 1 } },
  });
  assert.deepEqual(ledger.rows['2026-11-19:DO1E']!.editions, { '218-C': { observed: 0, expected: 1 } });
  assert.equal(ledger.rows['2026-11-19:DO1E']!.deadline, '2026-12-07');
  const dec8 = new Date('2026-12-08T15:00:00Z');
  const recent = ['2026-12-08', '2026-12-07', '2026-12-06', '2026-12-01'];
  assert.deepEqual(coverageDates(ledger, recent, dec8), [...recent.slice(0, 3), '2026-11-18']);
  ledger = markDouCoverage(ledger, ['2026-11-18'], dec8, { error: 'DOU_RESERVE_PACKAGE_UNLISTED' });
  assert.equal(ledger.rows['2026-11-18:DO1']!.status, 'ESCALATED');
  assert.equal(ledger.rows['2026-11-18:DO1']!.consultation, 'FAILED');
  assert.deepEqual(coverageDates(ledger, recent, dec8), [...recent.slice(0, 3), '2026-11-19']);
  ledger = markDouCoverage(ledger, ['2026-11-19'], dec8, {
    channel: 'DOU_OPEN_DATA_ZIP', observed: { '2026-11-19:DO1E': { '218-C': 1 } },
    expected: { '2026-11-19:DO1E': { '218-C': 1 } },
  });
  assert.equal(ledger.rows['2026-11-19:DO1E']!.status, 'CONFIRMED_BY_COUNT');
  assert.deepEqual(coverageDates(ledger, recent, dec8), [...recent.slice(0, 3), '2026-11-20']);
});

test('runtime bootstrap persists every eligible date and advances unknown dates after rollover', async () => {
  const now = new Date('2026-12-02T12:00:00Z');
  let state: DouState = { archives: {} };
  const months: string[] = [];
  const connector = new DouConnector({
    credentials, now: () => now, readState: async () => state,
    fetch: async () => new Response(null, { status: 404 }),
    reserve: new DouReserveClient(async input => {
      months.push(new URL(String(input)).searchParams.get('mes')!);
      return new Response('<html>known package missing</html>');
    }),
  });
  async function failed() {
    const result = await executeConnector({ connector, sourceId: 'dou', runId: 'fixture', attemptId: 'a', timeoutMs: 10_000 });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('unexpected sealed spool');
    assert.equal(result.code, 'DOU_RESERVE_PACKAGE_UNLISTED');
    return JSON.parse(JSON.stringify(result.metadata?.douCoverage)) as NonNullable<DouState['reserveCoverage']>;
  }
  const initial = await failed();
  assert.deepEqual(months, ['Dezembro', 'Novembro']);
  assert.equal(Object.keys(initial.rows).length, 32 * 4);
  assert.equal(initial.rows['2026-11-01:DO1']!.consultation, 'FAILED');
  assert.equal(initial.rows['2026-11-19:DO1E']!.consultation, 'NOT_ATTEMPTED');
  assert.equal(initial.rows['2026-10-31:DO1'], undefined);
  assert.equal(initial.rows['2026-12-03:DO1'], undefined);
  state = { archives: {}, reserveCoverage: initial };
  const continued = await failed();
  assert.equal(continued.rows['2026-11-02:DO1']!.consultation, 'FAILED');
  assert.equal(continued.rows['2026-11-03:DO1']!.consultation, 'NOT_ATTEMPTED');
});

test('a collection hiatus seeds missing dates and preserves aged escalations without growing the live queue forever', () => {
  const nov19 = new Date('2026-11-19T12:00:00Z');
  const old = markDouCoverage(beginDouCoverage(undefined, nov19, true), ['2026-11-19'], nov19, {
    channel: 'DOU_OPEN_DATA_ZIP', observed: {}, expected: { '2026-11-19:DO3E': { '218-A': 1 } },
  });
  const dec4 = new Date('2026-12-04T12:00:00Z');
  let ledger = beginDouCoverage(old, dec4, true);
  assert.equal(ledger.rows['2026-11-25:DO1E']!.consultation, 'NOT_ATTEMPTED');
  assert.equal(ledger.rows['2026-12-01:DO1']!.consultation, 'NOT_ATTEMPTED');
  assert.deepEqual(ledger.rows['2026-11-19:DO3E']!.editions, { '218-A': { observed: 0, expected: 1 } });
  ledger = beginDouCoverage(ledger, new Date('2027-02-05T12:00:00Z'), true);
  assert.equal(ledger.rows['2026-11-19:DO3E'], undefined);
  assert.equal(ledger.archivedEscalations?.['2026-11-19:DO3E']!.status, 'ESCALATED');
  assert.deepEqual(ledger.archivedEscalations?.['2026-11-19:DO3E']!.editions, { '218-A': { observed: 0, expected: 1 } });
  const archivedAtFeb = ledger.archivedEscalationCount!;
  for (let month = 3; month <= 12; month++) {
    ledger = beginDouCoverage(ledger, new Date(Date.UTC(2027, month - 1, 5, 12)), true);
    assert.ok(Object.keys(ledger.rows).length <= 66 * 4);
  }
  assert.ok(ledger.archivedEscalationCount! > archivedAtFeb);
});

test('18 November to 8 December restart records each missing day, escalates expired November and exposes 65-day archive', () => {
  const nov18 = new Date('2026-11-18T15:00:00Z');
  const dec8 = new Date('2026-12-08T15:00:00Z');
  const saved = beginDouCoverage(undefined, nov18, true);
  // Legacy on-disk snapshots have rows but no date watermark.
  const { recordedThrough: _watermark, ...legacy } = saved;
  const resumed = beginDouCoverage(JSON.parse(JSON.stringify(legacy)), dec8, true);
  assert.equal(resumed.recordedThrough, '2026-12-08');
  assert.equal(resumed.rows['2026-11-18:DO1']!.status, 'ESCALATED');
  for (let time = Date.parse('2026-11-19'); time <= Date.parse('2026-12-08'); time += 86_400_000) {
    const date = new Date(time).toISOString().slice(0, 10);
    for (const section of DOU_XML_SECTIONS) {
      const row = resumed.rows[`${date}:${section}`]!;
      assert.equal(row.consultation, 'NOT_ATTEMPTED');
      assert.equal(row.status, date.startsWith('2026-11') ? 'ESCALATED' : 'PENDING');
      if (date.startsWith('2026-11')) assert.equal(row.reason, 'EDITORIAL_WINDOW_MISSED_DURING_GAP');
    }
  }
  assert.ok(!coverageDates(resumed, ['2026-12-08','2026-12-07','2026-12-06'], dec8).includes('2026-11-19'));
  const operator = summarizeDouCoverage(resumed);
  assert.ok(operator.activeEscalations.some(row => row.date === '2026-11-19'));
  assert.ok(operator.pilotExclusions.some(row => row.date === '2026-10-09' && row.status === 'PENDING_OUTSIDE_PILOT'));
  const afterRetention = beginDouCoverage(resumed, new Date('2027-03-01T15:00:00Z'), true);
  const aged = summarizeDouCoverage(afterRetention);
  assert.ok(aged.archivedEscalationCount > 0);
  assert.ok(aged.archivedInLastObservation.some(row => row.date === '2026-11-19'));
  assert.ok(aged.archivedGapInLastObservation);
  assert.ok(!aged.activeEscalations.some(row => row.date === '2026-11-19'));
  const following = summarizeDouCoverage(beginDouCoverage(afterRetention, new Date('2027-03-01T20:00:00Z'), true));
  assert.equal(following.archivedEscalationCount, aged.archivedEscalationCount);
  assert.equal(following.archivedInLastObservation.length, 0);
});

test('reserve fails a whole spool on missing, ambiguous or invalid later packages and preserves debt across restart', async t => {
  const contents = await fixtureEntries('DO1');
  const good = await makeZip(contents);
  const [first] = contents;
  assert.ok(first);
  const do3 = { ...first, bytes: Buffer.from(Buffer.from(first.bytes).toString().replace('pubName="DO1"', 'pubName="DO3"')) };
  const crc = Buffer.from(await makeZip([do3]));
  const directory = crc.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(directory > 0);
  crc.writeUInt32LE((crc.readUInt32LE(directory + 16) ^ 0xffffffff) >>> 0, directory + 16);
  const badPath = await makeZip([{ ...do3, name: `unknown/${first.name}` }]);
  const badXml = await makeZip([do3, { name: '515_20260918_99.xml', bytes: Buffer.from('<invalid/>') }]);
  const hiddenXml = await makeZip([do3, { ...do3, name: do3.name.replace(/\.xml$/, '.XML.backup') }]);
  const disguisedXml = await makeZip([do3, { ...do3, name: 'not-an-image.jpg' }]);
  const duplicateExtension = await makeZip([do3, { ...do3, name: do3.name.replace(/\.xml$/, '.XML') }]);
  const nestedDaily = await makeZip([do3, { name: '2026-09-18-DO3E.zip', bytes: good }]);
  const index = septemberZipIndex;
  const cases = [
    { index: fixtureDouZipLink('S01092026.zip'), bytes: crc, code: 'DOU_RESERVE_PACKAGE_UNLISTED', late: false },
    { index: index + fixtureDouZipLink('S03092026.zip', 2), bytes: crc, code: 'DOU_RESERVE_PACKAGE_UNLISTED', late: false },
    { index, bytes: crc, code: 'DOU_ZIP_CRC_MISMATCH', late: true },
    { index, bytes: badPath, code: 'DOU_UNSAFE_ZIP_PATH', late: true },
    { index, bytes: badXml, code: 'DOU_INVALID_XML_ROOT', late: true },
    { index, bytes: hiddenXml, code: 'DOU_UNRECOGNIZED_ZIP_MEMBER', late: true },
    { index, bytes: disguisedXml, code: 'DOU_UNRECOGNIZED_ZIP_MEMBER', late: true },
    { index, bytes: duplicateExtension, code: 'DOU_UNSAFE_ZIP', late: true },
    { index, bytes: nestedDaily, code: 'DOU_NESTED_DAILY_ZIP_UNSUPPORTED', late: true },
  ];

  let persistedObservation: unknown;
  const previousTrustedMetadata = { douArchives: { '2026-09-18-DO1.zip': 'a'.repeat(64) } };
  let previousCoverage = markDouCoverage(beginDouCoverage(undefined, new Date('2026-09-18T15:00:00Z')), ['2026-09-18'], new Date('2026-09-18T15:00:00Z'), {
    channel: 'DOU_OPEN_DATA_ZIP', observed: {}, expected: { '2026-09-18:DO1E': { '218-C': 14 } },
  });
  for (const fixture of cases) {
    const phases: string[] = [];
    const connector = new DouConnector({
      credentials, dates: ['2026-09-18'], now: () => new Date('2026-09-19T15:00:00Z'), fetch: async () => new Response(null, { status: 503 }),
      readState: async () => ({ archives: {}, reserveCoverage: previousCoverage }),
      reserve: new DouReserveClient(async input => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/base-de-dados')) return new Response(fixture.index);
        return new Response(new Uint8Array(url.pathname.includes('/S01') ? good : fixture.bytes));
      }),
    });
    const outcome = await executeConnector({ connector, sourceId: 'dou', runId: 'fixture', attemptId: 'a', timeoutMs: 10_000,
      memory: phase => { phases.push(phase); },
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) throw new Error('unexpected sealed spool');
    assert.equal(outcome.code, fixture.code);
    assert.equal(phases.includes('archive_parsed'), fixture.late);
    assert.ok(!phases.includes('collect_complete'));
    assert.ok(outcome.metadata?.douCoverage);
    assert.equal(outcome.metadata?.douReserveArchives, undefined);
    // Simulate the JSONB value persisted by finishCollectionAttempt on failure.
    persistedObservation = JSON.parse(JSON.stringify(outcome.metadata));
  }
  const driver = new DummyDriver();
  driver.acquireConnection = async () => ({
    async executeQuery<R>(query): Promise<QueryResult<R>> {
      assert.match(query.sql, /^select /);
      if (query.sql.includes('select "trigger_type"')) return { rows: [{ trigger_type: 'SCHEDULED' }] as R[] };
      if (query.sql.includes('MATERIAL_CONTENT_DEFERRED')) return { rows: [{ metadata: previousTrustedMetadata, finished_at: new Date('2026-09-18'), status: 'SUCCESS' }] as R[] };
      assert.match(query.sql, /metadata \? 'douCoverage'/);
      assert.match(query.sql, /finished_at" is not null/);
      return { rows: [{ coverage: (persistedObservation as { douCoverage: unknown }).douCoverage }] as R[] };
    },
    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {},
  });
  const db = new Kysely<DB>({ dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => driver,
    createIntrospector: database => new PostgresIntrospector(database),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  } });
  t.after(() => db.destroy());
  const restarted = await readDouSourceState(db, 'dou', 'next-process', true);
  assert.deepEqual(restarted.archives, previousTrustedMetadata.douArchives);
  assert.equal(restarted.reserveCoverage?.rows['2026-09-18:DO1E']!.consultation, 'FAILED');
  assert.deepEqual(restarted.reserveCoverage?.rows['2026-09-18:DO1E']!.editions, { '218-C': { observed: 0, expected: 14 } });
  assert.equal(restarted.reserveArchives, undefined);
});

test('DOU runtime registration is explicitly gated',()=>{
  assert.equal(buildConnectorRegistry({includeDou:false}).has('dou'),false);
  assert.equal(buildConnectorRegistry({includeDou:true}).has('dou'),true);
});

test('official XML fixtures pass through the connector and stable receipt skips unchanged packages',async()=>{
  const fetch = await fixtureFetch();
  const first = await new DouConnector({credentials,now:()=>new Date("2026-09-21T12:00:00Z"),fetch,dates:['2026-09-18']}).collect(context());
  assert.equal(first.publications.length,10); assert.deepEqual(first.partialFailures,[]);
  assert.equal((first.metadata!.dou as any).xmlCount,12);
  assert.equal((first.metadata!.dou as any).confazMatterCount,0);
  assert.deepEqual((first.metadata!.dou as any).sections, DOU_XML_SECTIONS);
  assert.equal((first.metadata!.dou as any).coverage,'DOU_SECTIONS_1_3_NORMAL_AND_EXTRA');
  const second = await new DouConnector({credentials,now:()=>new Date("2026-09-21T12:00:00Z"),fetch,dates:['2026-09-18'],readState:async()=>({archives:first.metadata!.douArchives as Record<string,string>})}).collect(context());
  assert.equal(second.publications.length,0);
  const states = Object.fromEntries((second.metadata!.dou as any).archives.map((a:any)=>[a.section,a.state]));
  assert.equal(states.DO1,'UNCHANGED'); assert.equal(states.DO1E,'UNCHANGED');
  for (const section of ['DO3','DO3E']) assert.equal(states[section],'NOT_AVAILABLE');
  assert.equal(states.DO2, undefined); assert.equal(states.DO2E, undefined);
});

test('collector never requests DO2/DO2E and exposes the four-section policy literally', async () => {
  const base = await fixtureFetch();
  const downloads: string[] = [];
  const fetch = (async (input, init) => {
    const url = new URL(String(input));
    const dl = url.searchParams.get('dl');
    if (dl) downloads.push(dl);
    return base(input, init);
  }) as typeof globalThis.fetch;

  const result = await new DouConnector({ credentials, now: () => new Date('2026-09-21T12:00:00Z'), fetch, dates: ['2026-09-18'] }).collect(context());

  assert.deepEqual(DOU_XML_SECTIONS, ['DO1', 'DO1E', 'DO3', 'DO3E']);
  assert.deepEqual(downloads, [
    '2026-09-18-DO1.zip',
    '2026-09-18-DO1E.zip',
    '2026-09-18-DO3.zip',
    '2026-09-18-DO3E.zip',
  ]);
  assert.equal(downloads.some((name) => name.includes('DO2')), false);
  assert.deepEqual((result.metadata!.dou as any).sections, ['DO1', 'DO1E', 'DO3', 'DO3E']);
});

test('F3 forwards routine contracts and relevant/uncertain excerpts to the shared type policy', async () => {
  const routine = 'Contratante: União. Contratada: Alfa Ltda. CNPJ: 12.345.678/0001-90. Pregão Eletrônico nº 7/2026. Objeto: aquisição de papel A4. Valor Global: R$ 1.000. Vigência: 12 meses.';
  const title = 'EXTRATO DE CONTRATO Nº 7/2026';
  const entry = (id: string, content: string, abstract = '', heading = title, part?: number) => ({
    name: `530_20260918_${id}${part ? `-${part}` : ''}.xml`,
    bytes: Buffer.from(`<xml><article id="${id}" idMateria="${id}" pubDate="18/09/2026" pubName="DO3" editionNumber="180" artCategory="Órgão público federal" artType="EXTRATO DE CONTRATO" numberPage="1" pdfPage="https://pesquisa.in.gov.br/imprensa/jsp/visualiza/index.jsp?data=18/09/2026&amp;jornal=530&amp;pagina=1"><body><Identifica><![CDATA[${heading}]]></Identifica><Ementa><![CDATA[${abstract}]]></Ementa><Texto><![CDATA[${content}]]></Texto></body></article></xml>`),
  });
  const bytes = await makeZip([
    entry('111', routine),
    entry('112', `${routine} Incorporação da contratada pela empresa Beta S.A., sucessora em todos os direitos e obrigações.`),
    entry('113', `${routine} A cláusula concede isenção do ICMS.`),
    entry('114', routine, 'Concede isenção do ICMS.'),
    entry('115', routine, '', title, 1),
    entry('115', 'Informações complementares.', '', 'Incorporação da contratada pela empresa Beta S.A.', 2),
    entry('116', routine, 'Tratamento do ICMS pendente de confirmação.'),
    entry('117', routine, 'Pagamento mediante nota fiscal e regularidade fiscal.', title, 1),
    entry('117', 'Informações complementares.', '', 'Designação do fiscal do contrato.', 2),
    entry('118', routine, '', title, 1),
    entry('118', 'Informações complementares.', 'Concede isenção do ICMS.', title, 2),
    entry('119', `<section>${routine}</section>`),
  ]);
  const fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/logar.php') return new Response(null, { status: 302, headers: { location: 'index.php', 'set-cookie': 'inlabs_session_cookie=test' } });
    const dl = url.searchParams.get('dl');
    if (!dl) return new Response('<html>Index</html>');
    return dl === '2026-09-18-DO3.zip' ? new Response(new Uint8Array(bytes)) : new Response(null, { status: 404 });
  }) as typeof globalThis.fetch;
  const result = await new DouConnector({ credentials, now: () => new Date('2026-09-21T12:00:00Z'), fetch, dates: ['2026-09-18'] }).collect(context());

  assert.deepEqual(result.partialFailures, []);
  assert.deepEqual(result.publications.map(publication => [publication.externalId, publication.metadata?.douScope]), [
    ['111', 'CONTRATACAO_ADMINISTRATIVA_ROTINEIRA', 'IGNORE', ['procurement_structure_confirmed', 'routine_object_office_supplies']],
    ['112', 'EMPRESARIAL_RELEVANTE', 'KEEP', ['corporate_reorganization', 'corporate_succession']],
    ['113', 'TRIBUTARIO_FISCAL', 'KEEP', ['tax_exemption_reduction_or_suspension']],
    ['114', 'TRIBUTARIO_FISCAL', 'KEEP', ['tax_exemption_reduction_or_suspension']],
    ['115', 'EMPRESARIAL_RELEVANTE', 'KEEP', ['corporate_reorganization']],
    ['116', 'AMBIGUO', 'REVIEW', ['possible_tax_relevance']],
    ['117', 'CONTRATACAO_ADMINISTRATIVA_ROTINEIRA', 'IGNORE', ['procurement_structure_confirmed', 'routine_object_office_supplies']],
    ['118', 'TRIBUTARIO_FISCAL', 'KEEP', ['tax_exemption_reduction_or_suspension']],
    ['119', 'AMBIGUO', 'REVIEW', ['incomplete_text_structure']],
  ].map(([id, category, decision, reasonCodes]) => [`2026-09-18:DO3:180:${id}`, { ruleVersion: 'dou-scope-v4', category, decision, reasonCodes, informationalOnly: true }]));
  assert.ok(result.publications.every(publication => publication.title === title && publication.actType === 'EXTRATO DE CONTRATO'));
  const metadata = result.metadata!.dou as any;
  assert.equal(metadata.assembledMatterCount, 9);
  assert.equal(metadata.publicationCount, 9);
  assert.equal(metadata.scope.ignoredCount, 0);
  assert.deepEqual(metadata.scope.ignoredByCategory, {});
  assert.deepEqual(metadata.scope.ignoredReferences, []);
  assert.equal(metadata.scope.informationalOnly, true);
  assert.equal(metadata.scope.legacyIgnoreCount, 2);
  assert.equal(metadata.scope.legacyIgnoreByCategory.CONTRATACAO_ADMINISTRATIVA_ROTINEIRA, 2);
  assert.equal(metadata.scope.legacyIgnoreReferences.length, 2);
});

test('changed package is parsed again without treating whole archive hash as publication content',async()=>{
  const first = await new DouConnector({credentials,now:()=>new Date("2026-09-21T12:00:00Z"),fetch:await fixtureFetch(),dates:['2026-09-18']}).collect(context());
  const second = await new DouConnector({credentials,now:()=>new Date("2026-09-21T12:00:00Z"),fetch:await fixtureFetch(true),dates:['2026-09-18'],readState:async()=>({archives:first.metadata!.douArchives as Record<string,string>})}).collect(context());
  assert.equal(second.publications.length,6);
});

test('incremental schedule uses Sao Paulo date and bounded reconciliation of older XML',()=>{
  const dates = douCollectionDates(new Date('2026-09-21T01:00:00Z'));
  assert.deepEqual(dates.slice(0,3),['2026-09-20','2026-09-19','2026-09-18']);
  assert.equal(dates.length,4);assert.ok(dates[3]!>='2026-08-01' && dates[3]!<'2026-09-18');
});

test('no available editions raises explicit pending-availability error',async()=>{
  const fetch = (async(input)=>String(input).endsWith('logar.php')
    ? new Response(null,{status:302,headers:{location:'index.php','set-cookie':'inlabs_session_cookie=test'}})
    : String(input).includes('&dl=') ? new Response(null,{status:404}) : new Response('<html>Index</html>')) as typeof globalThis.fetch;
  await assert.rejects(new DouConnector({credentials,now:()=>new Date("2026-09-21T12:00:00Z"),fetch,dates:['2026-09-18']}).collect(context()),/INLABS_EDITIONS_NOT_AVAILABLE/);
});

test('one archive answering with a non-ZIP body is isolated instead of failing the whole run', async () => {
  const base = await fixtureFetch();
  const fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.searchParams.get('dl') === '2026-09-18-DO1E.zip') {
      return new Response('<!doctype html><html><body>Erro inesperado</body></html>', {
        status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    // The daily index lists the package: its HTML answer is a real failure.
    if (!url.searchParams.get('dl') && url.pathname === '/index.php') {
      return new Response('<html><a href="index.php?p=2026-09-18&dl=2026-09-18-DO1E.zip">DO1E</a></html>');
    }
    return base(input, init);
  }) as typeof globalThis.fetch;

  const result = await new DouConnector({ credentials, now: () => new Date('2026-09-21T12:00:00Z'), fetch, dates: ['2026-09-18'] }).collect(context());

  assert.ok(result.publications.length > 0);
  assert.deepEqual(result.partialFailures, [{
    code: 'INLABS_INVALID_DOWNLOAD',
    message: '2026-09-18-DO1E.zip: INLABS_INVALID_DOWNLOAD',
    itemReference: '2026-09-18-DO1E.zip',
  }]);
  const archives = (result.metadata!.dou as any).archives as Array<Record<string, unknown>>;
  const invalid = archives.find(a => a.section === 'DO1E')!;
  assert.equal(invalid.state, 'INVALID_DOWNLOAD');
  assert.equal(invalid.bodyKind, 'HTML');
  assert.equal(invalid.httpStatus, 200);
  assert.equal(typeof invalid.byteLength, 'number');
  assert.equal('body' in invalid, false);
  const receipts = result.metadata!.douArchives as Record<string, string>;
  assert.ok(receipts['2026-09-18-DO1.zip']);
  assert.equal(receipts['2026-09-18-DO1E.zip'], undefined);
});

test('a date without editions answered with HTML 200 is NOT_AVAILABLE, not a partial failure', async () => {
  // Production, Sunday 2026-09-27: every package of the date returned the same
  // text/html page with HTTP 200, and the daily index lists no package.
  const base = await fixtureFetch();
  const indexRequests: string[] = [];
  const fetch = (async (input, init) => {
    const url = new URL(String(input));
    const dl = url.searchParams.get('dl');
    if (url.searchParams.get('p') === '2026-09-20') {
      if (!dl) {
        indexRequests.push(url.toString());
        return new Response('<!DOCTYPE html><html><body><div>Nenhum arquivo</div></body></html>');
      }
      return new Response('<!DOCTYPE html><html><head><title>INLABS</title></head><body>Selecione</body></html>', {
        status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    return base(input, init);
  }) as typeof globalThis.fetch;

  const result = await new DouConnector({
    credentials, now: () => new Date('2026-09-21T12:00:00Z'), fetch, dates: ['2026-09-20', '2026-09-18'],
  }).collect(context());

  assert.deepEqual(result.partialFailures, []);
  assert.ok(result.publications.length > 0, 'the other date is still collected');
  assert.equal(indexRequests.length, 1, 'the index of the date is read once');
  const archives = (result.metadata!.dou as any).archives as Array<Record<string, unknown>>;
  const sunday = archives.filter(a => a.date === '2026-09-20');
  assert.equal(sunday.length, DOU_XML_SECTIONS.length);
  for (const archive of sunday) {
    assert.equal(archive.state, 'NOT_AVAILABLE');
    assert.equal(archive.evidence, 'NOT_IN_DAILY_INDEX');
    assert.equal(archive.pageTitle, 'INLABS');
    assert.equal(JSON.stringify(archive).includes('Selecione'), false);
  }
  const receipts = result.metadata!.douArchives as Record<string, string>;
  assert.equal(Object.keys(receipts).some(name => name.startsWith('2026-09-20')), false, 'absence never gets a receipt');
});

test('session loss disguised as an archive still fails the attempt', async () => {
  const base = await fixtureFetch();
  const fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.searchParams.get('dl') === '2026-09-18-DO1E.zip') {
      return new Response('<html><form action="logar.php"><input name="password"></form></html>', { status: 200 });
    }
    return base(input, init);
  }) as typeof globalThis.fetch;

  await assert.rejects(
    new DouConnector({ credentials, now: () => new Date('2026-09-21T12:00:00Z'), fetch, dates: ['2026-09-18'] }).collect(context()),
    /INLABS_AUTH_FAILED/,
  );
});
