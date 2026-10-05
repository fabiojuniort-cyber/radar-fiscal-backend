import assert from 'node:assert/strict';
import test from 'node:test';
import { DOU_XML_SECTIONS, DouConnector, douCollectionDates } from '../src/modules/collection/dou.connector.js';
import { fixtureFetch } from './dou.fixtures.js';
import { buildConnectorRegistry } from '../src/modules/collection/connector-registry.factory.js';
const context = () => ({ sourceId:'dou',runId:'run',attemptId:'attempt',signal:new AbortController().signal });
const credentials = () => ({ email:'test@example.invalid',password:'fixture' });

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
