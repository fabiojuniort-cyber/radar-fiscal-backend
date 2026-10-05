import type { PublicationSpoolFilesystem } from './publication-spool.filesystem.js';

/** Shape-only, fixed-cardinality telemetry: never collect source bodies or filenames. */
export type CollectionMemoryPhase =
  | 'collect_start' | 'archive_downloaded' | 'archive_parsed'
  | 'spool_ready' | 'collect_complete' | 'persist_start' | 'persist_progress'
  | 'persist_complete' | 'cleanup';

export interface CollectionMemoryCounters extends Partial<PublicationSpoolFilesystem> {
  archives?: number;
  publications?: number;
  xmlEntries?: number;
  archiveBytes?: number;
  spoolBytes?: number;
}

export interface CollectionMemorySample extends CollectionMemoryCounters {
  phase: CollectionMemoryPhase;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
}

export type CollectionMemoryProbe = (
  phase: CollectionMemoryPhase,
  counters?: CollectionMemoryCounters,
) => void;

export function createCollectionMemoryProbe(
  emit: (sample: CollectionMemorySample) => void,
): CollectionMemoryProbe {
  return (phase, counters = {}) => {
    // Do not retain samples in an attempt: logger/benchmark consumers decide
    // their own bounded aggregation. Explicit fields prevent accidental bodies.
    const { rss, heapUsed, heapTotal, external, arrayBuffers } = process.memoryUsage();
    emit({ phase, rss, heapUsed, heapTotal, external, arrayBuffers,
      ...(counters.archives !== undefined ? { archives: counters.archives } : {}),
      ...(counters.publications !== undefined ? { publications: counters.publications } : {}),
      ...(counters.xmlEntries !== undefined ? { xmlEntries: counters.xmlEntries } : {}),
      ...(counters.archiveBytes !== undefined ? { archiveBytes: counters.archiveBytes } : {}),
      ...(counters.spoolBytes !== undefined ? { spoolBytes: counters.spoolBytes } : {}),
      ...(counters.spoolFilesystem !== undefined ? { spoolFilesystem: counters.spoolFilesystem } : {}),
      ...(counters.spoolStorage !== undefined ? { spoolStorage: counters.spoolStorage } : {}),
      ...(counters.spoolFilesystemProbe !== undefined ? { spoolFilesystemProbe: counters.spoolFilesystemProbe } : {}),
      ...(counters.spoolFreeBytes !== undefined ? { spoolFreeBytes: counters.spoolFreeBytes } : {}),
    });
  };
}
