import assert from 'node:assert/strict';
import test from 'node:test';

import { TtlCache } from '../src/infrastructure/cache/ttl-cache.js';

function clock(start = 1_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('serves a fresh value without calling the loader again', async () => {
  const time = clock();
  const cache = new TtlCache<number>({ ttlMs: 100, now: time.now });
  let calls = 0;
  const loader = async () => ++calls;

  assert.equal(await cache.get('k', loader), 1);
  time.advance(99);
  assert.equal(await cache.get('k', loader), 1);
  assert.equal(calls, 1);

  time.advance(1);
  assert.equal(await cache.get('k', loader), 2);
  assert.equal(calls, 2);
});

test('concurrent misses share a single load', async () => {
  const cache = new TtlCache<string>({ ttlMs: 100 });
  const gate = deferred<string>();
  let calls = 0;
  const loader = () => {
    calls += 1;
    return gate.promise;
  };

  const results = Promise.all([
    cache.get('k', loader),
    cache.get('k', loader),
    cache.get('k', loader),
  ]);
  gate.resolve('value');

  assert.deepEqual(await results, ['value', 'value', 'value']);
  assert.equal(calls, 1);
});

test('failed loads are not cached', async () => {
  const cache = new TtlCache<number>({ ttlMs: 100 });

  await assert.rejects(
    cache.get('k', async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(await cache.get('k', async () => 7), 7);
});

test('stale values are served while one background reload runs', async () => {
  const time = clock();
  const errors: unknown[] = [];
  const cache = new TtlCache<number>({
    ttlMs: 100,
    staleMs: 500,
    now: time.now,
    onBackgroundError: (error) => errors.push(error),
  });

  assert.equal(await cache.get('k', async () => 1), 1);
  time.advance(150);

  const gate = deferred<number>();
  let calls = 0;
  const slowLoader = () => {
    calls += 1;
    return gate.promise;
  };

  assert.equal(await cache.get('k', slowLoader), 1);
  assert.equal(await cache.get('k', slowLoader), 1);
  assert.equal(calls, 1);

  gate.resolve(2);
  await gate.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await cache.get('k', slowLoader), 2);

  time.advance(150);
  assert.equal(
    await cache.get('k', async () => {
      throw new Error('refresh failed');
    }),
    2,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1);

  // The previous value survives a failed refresh; the next read retries.
  assert.equal(await cache.get('k', async () => 3), 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await cache.get('k', async () => 4), 3);
});

test('values past the stale window are reloaded synchronously', async () => {
  const time = clock();
  const cache = new TtlCache<number>({
    ttlMs: 100,
    staleMs: 100,
    now: time.now,
  });

  assert.equal(await cache.get('k', async () => 1), 1);
  time.advance(201);
  assert.equal(await cache.get('k', async () => 2), 2);
});

test('key version invalidates fresh and stale entries immediately', async () => {
  let version = 10;
  let calls = 0;
  const cache = new TtlCache<number>({
    ttlMs: 10_000,
    staleMs: 10_000,
    keyVersion: async () => version,
  });
  const loader = async () => ++calls;

  assert.equal(await cache.get('aggregate', loader), 1);
  assert.equal(await cache.get('aggregate', loader), 1);
  assert.equal(calls, 1);

  version += 1;

  assert.equal(
    await cache.get('aggregate', loader),
    2,
    'a version advance must bypass an otherwise fresh cached value',
  );
  assert.equal(await cache.get('aggregate', loader), 2);
  assert.equal(calls, 2);
});

test('ttl of zero disables caching without resolving a key version', async () => {
  let versionCalls = 0;
  const cache = new TtlCache<number>({
    ttlMs: 0,
    keyVersion: async () => {
      versionCalls += 1;
      return 1;
    },
  });
  let calls = 0;
  const loader = async () => ++calls;

  await cache.get('k', loader);
  await cache.get('k', loader);
  assert.equal(calls, 2);
  assert.equal(versionCalls, 0);
});

test('evicts the oldest keys beyond maxEntries', async () => {
  const cache = new TtlCache<string>({ ttlMs: 1_000, maxEntries: 2 });
  let calls = 0;
  const loader = (value: string) => async () => {
    calls += 1;
    return value;
  };

  await cache.get('a', loader('a'));
  await cache.get('b', loader('b'));
  await cache.get('c', loader('c'));
  assert.equal(calls, 3);

  await cache.get('c', loader('c'));
  await cache.get('b', loader('b'));
  assert.equal(calls, 3);

  await cache.get('a', loader('a'));
  assert.equal(calls, 4);
});
