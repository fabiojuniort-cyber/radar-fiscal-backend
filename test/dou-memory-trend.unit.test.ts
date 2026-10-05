import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionMemorySample } from '../src/modules/collection/collection.memory.js';
import { createPackageMemoryRecorder } from '../scripts/dou-memory-trend.js';

const memoryFields = ['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers'] as const;
function sample(archives: number, bytes: number, overrides: Partial<CollectionMemorySample> = {}): CollectionMemorySample {
  return {
    phase: 'archive_parsed', archives, publications: archives * 2, xmlEntries: archives * 3,
    rss: bytes, heapUsed: bytes, heapTotal: bytes, external: bytes, arrayBuffers: bytes, ...overrides,
  };
}
function trend(values: number[]) {
  const recorder = createPackageMemoryRecorder(values.length);
  values.forEach((bytes, index) => recorder.record(sample(index + 1, bytes), index * 10));
  return recorder.summarize();
}
function near(actual: number | null, expected: number) {
  assert.equal(typeof actual, 'number');
  assert.ok(Math.abs(actual! - expected) <= Math.max(1, Math.abs(expected)) * 1e-12, `${actual} is not close to ${expected}`);
}

test('increasing, constant and decreasing samples calculate all five memory metrics', () => {
  for (const [values, expectedDelta, expectedSlope] of [
    [[10, 20, 30, 40], 30, 10],
    [[20, 20, 20, 20], 0, 0],
    [[40, 30, 20, 10], -30, -10],
  ] as const) {
    const { afterPackages, packageMemoryTrend: summary } = trend([...values]);
    assert.deepEqual({ ...summary, metrics: undefined }, {
      sampleCount: 4, intervals: 3, firstPackage: 1, lastPackage: 4, metrics: undefined,
    });
    assert.deepEqual(afterPackages.map(value => value.packageIndex), [1, 2, 3, 4]);
    assert.deepEqual(Object.keys(summary.metrics).sort(), [...memoryFields].sort());
    for (const field of memoryFields) {
      const metric = summary.metrics[field];
      assert.equal(metric.firstBytes, values[0]);
      assert.equal(metric.lastBytes, values[3]);
      assert.equal(metric.deltaBytes, expectedDelta);
      near(metric.meanDeltaBytesPerPackage, expectedSlope);
      near(metric.leastSquaresSlopeBytesPerPackage, expectedSlope);
    }
  }
});

test('non-linear OLS uses every package and is not the endpoint mean', () => {
  const recorder = createPackageMemoryRecorder(4);
  [0, 100, 0, 30].forEach((bytes, index) => recorder.record(sample(index + 1, bytes, { heapUsed: index * 10 }), index));
  const { metrics } = recorder.summarize().packageMemoryTrend;
  // x deviations [-1.5,-0.5,0.5,1.5], denominator 5:
  // (0 - 50 + 0 + 45) / 5 = -1, although the endpoint mean is +10.
  assert.equal(metrics.rss.meanDeltaBytesPerPackage, 10);
  near(metrics.rss.leastSquaresSlopeBytesPerPackage, -1);
  near(metrics.heapUsed.leastSquaresSlopeBytesPerPackage, 10);
});

test('a single package reports null trends, not an inferred zero slope', () => {
  const { packageMemoryTrend: summary } = trend([42]);
  assert.equal(summary.sampleCount, 1);
  assert.equal(summary.intervals, 0);
  assert.equal(summary.firstPackage, 1);
  assert.equal(summary.lastPackage, 1);
  for (const field of memoryFields) assert.deepEqual(summary.metrics[field], {
    firstBytes: 42, lastBytes: 42, deltaBytes: 0,
    meanDeltaBytesPerPackage: null, leastSquaresSlopeBytesPerPackage: null,
  });
});

test('other phases are ignored even with irrelevant invalid counters and after completion', () => {
  const recorder = createPackageMemoryRecorder(1);
  const ignored = sample(Number.NaN, Number.NaN, { phase: 'archive_downloaded' });
  recorder.record(ignored, Number.NaN);
  assert.throws(() => recorder.summarize(), /Incomplete/);
  recorder.record(sample(1, 0), 0);
  for (let index = 0; index < 100; index += 1) recorder.record(ignored, -1);
  assert.equal(recorder.summarize().afterPackages.length, 1);
});

test('configuration is bounded to integers 1 through 16; extras are never truncated', () => {
  for (const value of [0, -1, 17, 1.5, Number.NaN, Infinity, -Infinity, undefined, '4']) {
    assert.throws(() => createPackageMemoryRecorder(value as number), /integer from 1 to 16/);
  }
  const recorder = createPackageMemoryRecorder(16);
  for (let index = 1; index <= 16; index += 1) recorder.record(sample(index, index), index);
  assert.equal(recorder.summarize().afterPackages.length, 16);
  assert.throws(() => recorder.record(sample(17, 17), 17), /extra/);
  assert.throws(() => recorder.record(sample(16, 16), 16), /extra/);
  assert.equal(recorder.summarize().afterPackages.length, 16);
});

test('archives must be complete, ordered and unique; rejected samples do not consume a slot', () => {
  const recorder = createPackageMemoryRecorder(3);
  assert.throws(() => recorder.summarize(), /Incomplete/);
  for (const archives of [0, 2, 1.5, -1, undefined, Number.NaN, Infinity]) {
    const invalid = sample(1, 0);
    Object.assign(invalid, { archives });
    assert.throws(() => recorder.record(invalid, 0), /sequential/);
  }
  recorder.record(sample(1, 0), 0);
  assert.throws(() => recorder.record(sample(1, 0), 0), /sequential/);
  assert.throws(() => recorder.record(sample(3, 0), 0), /sequential/);
  assert.throws(() => recorder.summarize(), /Incomplete/);
  recorder.record(sample(2, 0), 0);
  recorder.record(sample(3, 0), 0);
  assert.equal(recorder.summarize().packageMemoryTrend.sampleCount, 3);
});

test('elapsed time, publication counts, XML counts and all memory counters must be finite and non-negative', () => {
  for (const field of ['elapsedMs', 'publications', 'xmlEntries', ...memoryFields]) {
    for (const invalid of [Number.NaN, Infinity, -Infinity, -1, undefined, '10']) {
      const recorder = createPackageMemoryRecorder(1);
      const value = sample(1, 0);
      if (field !== 'elapsedMs') Object.assign(value, { [field]: invalid });
      assert.throws(() => recorder.record(value, field === 'elapsedMs' ? invalid as number : 0), /finite and non-negative/);
      recorder.record(sample(1, 0), 0);
      assert.equal(recorder.summarize().afterPackages.length, 1);
    }
  }
});

test('snapshots retain only whitelisted scalar fields and summaries return independent copies', () => {
  const recorder = createPackageMemoryRecorder(2);
  const original = Object.assign(sample(1, 10), {
    archiveBytes: 777, spoolBytes: 888, filename: 'private.xml', body: 'PRIVATE_BODY',
    token: 'PRIVATE_TOKEN', nested: { body: 'PRIVATE_NESTED' },
  });
  recorder.record(original, 5);
  original.rss = 999;
  recorder.record(sample(2, 20), 10);
  const first = recorder.summarize();
  assert.deepEqual(Object.keys(first.afterPackages[0]!).sort(), [
    'packageIndex', 'elapsedMs', 'publications', 'xmlEntries', ...memoryFields,
  ].sort());
  assert.equal(first.afterPackages[0]!.rss, 10);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE|private\.xml|filename|archiveBytes|spoolBytes|nested|token|body/);
  first.afterPackages[0]!.rss = 123;
  first.afterPackages.push({ ...first.afterPackages[0]! });
  first.packageMemoryTrend.metrics.rss.firstBytes = 456;
  const second = recorder.summarize();
  assert.equal(second.afterPackages.length, 2);
  assert.equal(second.afterPackages[0]!.rss, 10);
  assert.equal(second.packageMemoryTrend.metrics.rss.firstBytes, 10);
});

test('OLS remains finite for very large finite counters', () => {
  const { metrics } = trend([0, Number.MAX_VALUE, 0, Number.MAX_VALUE]).packageMemoryTrend;
  for (const field of memoryFields) {
    near(metrics[field].leastSquaresSlopeBytesPerPackage, Number.MAX_VALUE * 0.2);
    assert.ok(Number.isFinite(metrics[field].meanDeltaBytesPerPackage));
  }
});
