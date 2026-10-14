import assert from 'node:assert/strict';
import test from 'node:test';
import {InventoryCache} from '../src/modules/collection/collection-filter.inventory-cache.js';

test('cold/warm HTTP reads never wait, single-flight and policy/collection invalidation',async()=>{
  let key='r225:collection1';let calls=0;let now=1;
  let resolve!: (v:string[])=>void;
  const cache=new InventoryCache(async()=>key,async()=>{calls++;return new Promise<string[]>(r=>{resolve=r;});},()=>now);
  const start=performance.now();
  assert.equal(cache.read().inventory.status,'WARMING');
  for(let i=0;i<1000;i++)cache.read();
  assert.ok(performance.now()-start<3000);
  await new Promise(r=>setImmediate(r));assert.equal(calls,1);
  resolve(['first']);await cache.settled();
  assert.deepEqual(cache.read().items,['first']);assert.equal(cache.read().inventory.status,'READY');
  now+=16000;cache.read();await cache.settled();assert.equal(calls,1);
  key='r226:collection1';now+=16000;
  assert.deepEqual(cache.read().items,['first']);
  await new Promise(r=>setImmediate(r));resolve(['new policy']);await cache.settled();
  assert.deepEqual(cache.read().items,['new policy']);
  key='r226:collection2';now+=16000;cache.read();
  await new Promise(r=>setImmediate(r));resolve(['new collection']);await cache.settled();
  assert.equal(calls,3);assert.deepEqual(cache.read().items,['new collection']);
  await cache.close();
});

test('drift never publishes partial inventory and failures keep last completed snapshot',async()=>{
  let key='one';let fail=false;
  const cache=new InventoryCache(async()=>key,async()=>{if(fail)throw Error('db');key='two';return ['mixed'];});
  cache.read();await cache.settled();assert.deepEqual(cache.read().items,[]);
  await cache.settled();assert.deepEqual(cache.read().items,['mixed']);
  key='three';fail=true;cache.read(true);await cache.settled();
  assert.equal(cache.read().inventory.status,'FAILED');assert.deepEqual(cache.read().items,['mixed']);
  await cache.close();
});
