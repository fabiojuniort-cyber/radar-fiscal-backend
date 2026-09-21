import assert from 'node:assert/strict';
import test from 'node:test';
import { DouConnector, douCollectionDates } from '../src/modules/collection/dou.connector.js';
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
  const second = await new DouConnector({credentials,now:()=>new Date("2026-09-21T12:00:00Z"),fetch,dates:['2026-09-18'],readState:async()=>({archives:first.metadata!.douArchives as Record<string,string>})}).collect(context());
  assert.equal(second.publications.length,0); assert.ok((second.metadata!.dou as any).archives.every((a:any)=>a.state==='UNCHANGED'));
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
