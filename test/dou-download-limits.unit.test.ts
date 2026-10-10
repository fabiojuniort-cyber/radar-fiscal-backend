import assert from 'node:assert/strict';
import test from 'node:test';
import { douLimitsSchema, DOU_DEFAULT_LIMITS, MIB } from '../src/modules/collection/dou-download-limits.js';
import { DouConnector } from '../src/modules/collection/dou.connector.js';

test('DOU admin limits: defaults match safe parser ceilings', () => {
  assert.deepEqual(douLimitsSchema.parse(DOU_DEFAULT_LIMITS), DOU_DEFAULT_LIMITS);
  assert.equal(DOU_DEFAULT_LIMITS.pdfMiB, 20);
  assert.equal(DOU_DEFAULT_LIMITS.zipMiB * MIB, 64 * 1024 * 1024);
  assert.equal(DOU_DEFAULT_LIMITS.expandedZipMiB, 128);
  assert.equal(DOU_DEFAULT_LIMITS.xmlEntryMiB, 8);
});

test('DOU admin limits: reject overflow, floats, invalid keys and decompression lower than ZIP', () => {
  const value = { ...DOU_DEFAULT_LIMITS };
  for (const invalid of [
    { ...value, zipMiB: 65 }, { ...value, pdfMiB: 21 },
    { ...value, expandedZipMiB: 129 }, { ...value, xmlEntryMiB: 9 },
    { ...value, pdfMiB: 1.5 }, { ...value, zipMiB: 0 },
    { ...value, zipMiB: 64, expandedZipMiB: 32 },
    { ...value, bypass: true },
  ]) assert.equal(douLimitsSchema.safeParse(invalid).success, false);
  assert.equal(douLimitsSchema.safeParse({ ...value, zipMiB: 32 }).success, true);
});

test('DOU worker consults injected limits and refuses oversize without treating it as empty day', async () => {
  const seen: string[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === '/logar.php') return new Response(null, {
      status: 302, headers: { location: 'index.php', 'set-cookie': 'inlabs_session_cookie=fixture' },
    });
    const file = url.searchParams.get('dl');
    if (file) {
      seen.push(file);
      return new Response('PK', {
        headers: { 'content-length': String(2 * MIB), 'content-type': 'application/zip' },
      });
    }
    return new Response('<html>INLABS Index</html>');
  }) as typeof fetch;

  const readLimitsIds: string[] = [];
  const connector = new DouConnector({
    credentials: () => ({ email: 'test@example.invalid', password: 'fixture' }),
    now: () => new Date('2026-09-21T12:00:00Z'), dates: ['2026-09-18'], fetch,
    readLimits: async sourceId => {
      readLimitsIds.push(sourceId);
      return { ...DOU_DEFAULT_LIMITS, zipMiB: 1 };
    },
  });
  await assert.rejects(connector.collect({
    sourceId: 'dou', runId: 'run', attemptId: 'attempt',
    signal: new AbortController().signal,
  }), /INLABS_RESPONSE_TOO_LARGE/);
  assert.deepEqual(readLimitsIds, ['dou']);
  assert.deepEqual(seen, ['2026-09-18-DO1.zip']);
});
