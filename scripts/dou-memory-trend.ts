import type { CollectionMemorySample } from '../src/modules/collection/collection.memory.js';

const MEMORY_FIELDS = ['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers'] as const;
type MemoryField = typeof MEMORY_FIELDS[number];

export interface PackageMemorySnapshot {
  packageIndex: number;
  elapsedMs: number;
  publications: number;
  xmlEntries: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
}

export interface PackageMemoryMetric {
  firstBytes: number;
  lastBytes: number;
  deltaBytes: number;
  meanDeltaBytesPerPackage: number | null;
  leastSquaresSlopeBytesPerPackage: number | null;
}

export interface PackageMemoryTrend {
  sampleCount: number;
  intervals: number;
  firstPackage: number;
  lastPackage: number;
  metrics: Record<MemoryField, PackageMemoryMetric>;
}

function finiteNonNegative(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be finite and non-negative`);
  }
}

/** Benchmark-only, bounded snapshots; never retain a source sample or its extra fields. */
export function createPackageMemoryRecorder(expectedPackages: number): {
  record(sample: CollectionMemorySample, elapsedMs: number): void;
  summarize(): { afterPackages: PackageMemorySnapshot[]; packageMemoryTrend: PackageMemoryTrend };
} {
  if (!Number.isInteger(expectedPackages) || expectedPackages < 1 || expectedPackages > 16) {
    throw new RangeError('expectedPackages must be an integer from 1 to 16');
  }
  const snapshots: PackageMemorySnapshot[] = [];
  return {
    record(sample, elapsedMs) {
      if (sample.phase !== 'archive_parsed') return;
      if (snapshots.length >= expectedPackages) throw new RangeError('Unexpected extra archive_parsed sample');
      if (sample.archives !== snapshots.length + 1) throw new RangeError('archives must be sequential from 1 to expectedPackages');
      finiteNonNegative('elapsedMs', elapsedMs);
      finiteNonNegative('publications', sample.publications);
      finiteNonNegative('xmlEntries', sample.xmlEntries);
      for (const field of MEMORY_FIELDS) finiteNonNegative(field, sample[field]);
      snapshots.push({
        packageIndex: sample.archives, elapsedMs, publications: sample.publications, xmlEntries: sample.xmlEntries,
        rss: sample.rss, heapUsed: sample.heapUsed, heapTotal: sample.heapTotal,
        external: sample.external, arrayBuffers: sample.arrayBuffers,
      });
    },
    summarize() {
      if (snapshots.length !== expectedPackages) throw new RangeError('Incomplete package memory samples');
      const first = snapshots[0]!;
      const last = snapshots[snapshots.length - 1]!;
      const intervals = snapshots.length - 1;
      const meanIndex = (first.packageIndex + last.packageIndex) / 2;
      const denominator = snapshots.reduce((sum, sample) => sum + (sample.packageIndex - meanIndex) ** 2, 0);
      const metrics = Object.fromEntries(MEMORY_FIELDS.map(field => {
        const firstBytes = first[field];
        const lastBytes = last[field];
        const deltaBytes = lastBytes - firstBytes;
        // Center y on the first sample (OLS is translation invariant). Divide
        // the x weight before multiplying to avoid overflow for finite inputs.
        const slope = intervals === 0 ? null : snapshots.reduce((sum, sample) =>
          sum + ((sample.packageIndex - meanIndex) / denominator) * (sample[field] - firstBytes), 0);
        return [field, {
          firstBytes, lastBytes, deltaBytes,
          meanDeltaBytesPerPackage: intervals === 0 ? null : deltaBytes / intervals,
          leastSquaresSlopeBytesPerPackage: slope,
        }];
      })) as Record<MemoryField, PackageMemoryMetric>;
      return {
        afterPackages: snapshots.map(sample => ({ ...sample })),
        packageMemoryTrend: {
          sampleCount: snapshots.length, intervals,
          firstPackage: first.packageIndex, lastPackage: last.packageIndex, metrics,
        },
      };
    },
  };
}
