import { createHash, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConnectorPublication } from './connector.contract.js';
import { ConnectorError } from './connector.error.js';

// Larger than the existing 16 x 128 MiB DOU XML ceiling, including JSON
// escaping, framing and metadata. These are disk ceilings, not allocations.
export const MAX_PUBLICATION_SPOOL_BYTES = 8 * 1024 * 1024 * 1024;
export const MAX_PUBLICATION_RECORD_BYTES = 512 * 1024 * 1024;
export const PUBLICATION_SPOOL_CLEANUP_GRACE_MS = 1_000;
const HEADER_BYTES = 4 + 32;

class PublicationSpoolError extends ConnectorError {
  constructor(code: string) {
    // Never attach filesystem errors/causes: they can contain private paths or
    // publication text. Only a bounded operational code crosses this boundary.
    super(`Publication spool failed (${code})`, {
      kind: 'PROCESSING_ERROR', code: `PUBLICATION_SPOOL_${code}`, retryable: false,
    });
  }
}

function spoolError(code: string): PublicationSpoolError {
  return new PublicationSpoolError(code);
}

/** A stuck filesystem must not defeat the connector hard timeout. Cleanup
 * continues safely in the background (only temporary I/O, never persistence),
 * while the caller gets a terminal, sanitized failure after bounded grace. */
export async function disposePublicationSpool(
  spool: { dispose(): Promise<void> } | undefined,
  graceMs = PUBLICATION_SPOOL_CLEANUP_GRACE_MS,
): Promise<void> {
  if (!spool) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      spool.dispose(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(spoolError('CLEANUP_TIMEOUT')), graceMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof PublicationSpoolError) throw error;
    throw spoolError('CLEANUP_FAILED');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function checkSignal(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw spoolError('CANCELLED');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON plus an out-of-band list preserves explicitly undefined fields without
 * reserving any user metadata keys or reviving nested date-looking strings. */
function serialize(publication: ConnectorPublication): Buffer {
  const undefinedPaths: string[][] = [];
  const envelope = { publication, undefinedPaths };
  const paths = new WeakMap<object, string[]>([[envelope, []]]);
  try {
    for (const field of ['publishedAt', 'effectiveAt'] as const) {
      const date = publication[field];
      if (date !== undefined && (!(date instanceof Date) || !Number.isFinite(date.getTime()))) {
        throw spoolError('SERIALIZATION_FAILED');
      }
    }
    const json = JSON.stringify(envelope, function (key, value: unknown) {
      if (key === '' && value === envelope) return value;
      const parentPath = paths.get(this as object);
      if (!parentPath || (parentPath[0] !== 'publication' && this !== envelope)) return value;
      if (this === envelope && key !== 'publication') return value;
      const path = [...parentPath, key];
      const original = (this as Record<string, unknown>)[key];
      if (original instanceof Date) {
        if (this !== publication || (key !== 'publishedAt' && key !== 'effectiveAt')) {
          throw spoolError('SERIALIZATION_FAILED');
        }
      } else if (original !== null && typeof original === 'object') {
        // JSON is the connector metadata contract; reject lossy custom objects
        // instead of silently changing their representation on replay.
        const prototype = Object.getPrototypeOf(original);
        if ((!Array.isArray(original) && prototype !== Object.prototype && prototype !== null)
          || original !== value) throw spoolError('SERIALIZATION_FAILED');
      }
      if (value === undefined) {
        undefinedPaths.push(path.slice(1));
        return null;
      }
      if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint'
        || (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0)))) {
        throw spoolError('SERIALIZATION_FAILED');
      }
      if (value !== null && typeof value === 'object') paths.set(value, path);
      return value;
    });
    const length = Buffer.byteLength(json, 'utf8');
    if (length > MAX_PUBLICATION_RECORD_BYTES) throw spoolError('RECORD_LIMIT_EXCEEDED');
    return Buffer.from(json, 'utf8');
  } catch (error) {
    if (error instanceof PublicationSpoolError) throw error;
    throw spoolError('SERIALIZATION_FAILED');
  }
}

function deserialize(bytes: Buffer): ConnectorPublication {
  try {
    const envelope: unknown = JSON.parse(bytes.toString('utf8'));
    if (!isObject(envelope) || !isObject(envelope.publication) || !Array.isArray(envelope.undefinedPaths)) {
      throw spoolError('CORRUPT');
    }
    const publication = envelope.publication;
    for (const path of envelope.undefinedPaths as unknown[]) {
      if (!Array.isArray(path) || path.length === 0 || !path.every(key => typeof key === 'string')) {
        throw spoolError('CORRUPT');
      }
      let parent: Record<string, unknown> = publication;
      for (const key of path.slice(0, -1) as string[]) {
        if (!Object.hasOwn(parent, key) || parent[key] === null || typeof parent[key] !== 'object') {
          throw spoolError('CORRUPT');
        }
        parent = parent[key] as Record<string, unknown>;
      }
      const key = path.at(-1) as string;
      if (!Object.hasOwn(parent, key) || parent[key] !== null) throw spoolError('CORRUPT');
      Object.defineProperty(parent, key, { value: undefined, enumerable: true, configurable: true, writable: true });
    }
    for (const field of ['publishedAt', 'effectiveAt']) {
      if (publication[field] === undefined) continue;
      if (typeof publication[field] !== 'string') throw spoolError('CORRUPT');
      const date = new Date(publication[field]);
      if (!Number.isFinite(date.getTime()) || date.toISOString() !== publication[field]) throw spoolError('CORRUPT');
      publication[field] = date;
    }
    if (typeof publication.title !== 'string' || typeof publication.officialUrl !== 'string'
      || (publication.sphere !== 'FEDERAL' && publication.sphere !== 'STATE')) throw spoolError('CORRUPT');
    return publication as unknown as ConnectorPublication;
  } catch {
    throw spoolError('CORRUPT');
  }
}

/** Attempt-local, fail-closed staging. Callers must await every append: there
 * is deliberately no queue that could retain all publications in memory. */
export class PublicationSpool implements AsyncIterable<ConnectorPublication> {
  private publicationCount = 0;
  private byteCount = 0;
  private sealed = false;
  private writing = false;
  private disposed = false;
  private failure: ConnectorError | undefined;
  private disposal: Promise<void> | undefined;
  private readonly pendingIO = new Set<Promise<unknown>>();
  private readonly onAbort = (): void => {
    this.failure ??= spoolError('CANCELLED');
    void this.dispose().catch(() => { /* dispose also remains observable to its owner */ });
  };

  private constructor(
    private readonly directory: string,
    private readonly handle: FileHandle,
    private readonly signal: AbortSignal | undefined,
  ) {}

  static async create(signal?: AbortSignal): Promise<PublicationSpool> {
    let directory: string | undefined;
    let handle: FileHandle | undefined;
    try {
      checkSignal(signal);
      directory = await fs.mkdtemp(join(tmpdir(), 'publication-spool-'));
      checkSignal(signal);
      await fs.chmod(directory, 0o700);
      checkSignal(signal);
      handle = await fs.open(join(directory, 'publications.bin'), 'wx+', 0o600);
      checkSignal(signal);
      const spool = new PublicationSpool(directory, handle, signal);
      signal?.addEventListener('abort', spool.onAbort, { once: true });
      return spool;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (directory) await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
      if (error instanceof PublicationSpoolError) throw error;
      throw spoolError('CREATE_FAILED');
    }
  }

  get count(): number { return this.publicationCount; }
  get bytes(): number { return this.byteCount; }

  private checkUsable(): void {
    checkSignal(this.signal);
    if (this.failure) throw this.failure;
    if (this.disposed) throw spoolError('DISPOSED');
  }

  private async io<T>(operation: () => Promise<T>): Promise<T> {
    this.checkUsable();
    const pending = operation();
    this.pendingIO.add(pending);
    try {
      const result = await pending;
      this.checkUsable();
      return result;
    } finally {
      this.pendingIO.delete(pending);
    }
  }

  private async fail(error: unknown, fallback: string): Promise<never> {
    this.failure ??= error instanceof PublicationSpoolError ? error : spoolError(fallback);
    await this.dispose().catch(() => undefined);
    throw this.failure;
  }

  async append(publication: ConnectorPublication): Promise<void> {
    try {
      this.checkUsable();
      if (this.sealed) throw spoolError('SEALED');
      if (this.writing) throw spoolError('CONCURRENT_WRITE');
      this.writing = true;
      const record = serialize(publication);
      const frameBytes = HEADER_BYTES + record.length;
      if (this.byteCount + frameBytes > MAX_PUBLICATION_SPOOL_BYTES) throw spoolError('TOTAL_LIMIT_EXCEEDED');
      const header = Buffer.allocUnsafe(HEADER_BYTES);
      header.writeUInt32BE(record.length);
      createHash('sha256').update(record).digest().copy(header, 4);
      await this.writeAll(header, this.byteCount);
      await this.writeAll(record, this.byteCount + HEADER_BYTES);
      this.checkUsable();
      this.byteCount += frameBytes;
      this.publicationCount += 1;
    } catch (error) {
      await this.fail(error, 'WRITE_FAILED');
    } finally {
      this.writing = false;
    }
  }

  private async writeAll(buffer: Buffer, position: number): Promise<void> {
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesWritten } = await this.io(() => this.handle.write(buffer, offset, buffer.length - offset, position + offset));
      if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > buffer.length - offset) {
        throw spoolError('WRITE_FAILED');
      }
      offset += bytesWritten;
    }
  }

  async seal(): Promise<void> {
    try {
      this.checkUsable();
      if (this.sealed) return;
      if (this.writing) throw spoolError('CONCURRENT_WRITE');
      this.writing = true;
      await this.io(() => this.handle.sync());
      const stat = await this.io(() => this.handle.stat());
      if (stat.size !== this.byteCount) throw spoolError('CORRUPT');
      this.sealed = true;
    } catch (error) {
      await this.fail(error, 'SEAL_FAILED');
    } finally {
      this.writing = false;
    }
  }

  private async readAll(buffer: Buffer, position: number): Promise<void> {
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await this.io(() => this.handle.read(buffer, offset, buffer.length - offset, position + offset));
      if (!Number.isInteger(bytesRead) || bytesRead <= 0 || bytesRead > buffer.length - offset) throw spoolError('CORRUPT');
      offset += bytesRead;
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ConnectorPublication> {
    try {
      this.checkUsable();
      if (!this.sealed) throw spoolError('NOT_SEALED');
      const stat = await this.io(() => this.handle.stat());
      if (stat.size !== this.byteCount) throw spoolError('CORRUPT');
      let position = 0;
      let count = 0;
      while (position < this.byteCount) {
        if (this.byteCount - position < HEADER_BYTES) throw spoolError('CORRUPT');
        const header = Buffer.allocUnsafe(HEADER_BYTES);
        await this.readAll(header, position);
        const length = header.readUInt32BE();
        if (length === 0 || length > MAX_PUBLICATION_RECORD_BYTES || length > this.byteCount - position - HEADER_BYTES) {
          throw spoolError('CORRUPT');
        }
        const record = Buffer.allocUnsafe(length);
        await this.readAll(record, position + HEADER_BYTES);
        if (!timingSafeEqual(header.subarray(4), createHash('sha256').update(record).digest())) throw spoolError('CORRUPT');
        const publication = deserialize(record);
        position += HEADER_BYTES + length;
        count += 1;
        this.checkUsable();
        yield publication;
        this.checkUsable();
      }
      if (position !== this.byteCount || count !== this.publicationCount) throw spoolError('CORRUPT');
      const finalStat = await this.io(() => this.handle.stat());
      if (finalStat.size !== this.byteCount) throw spoolError('CORRUPT');
    } catch (error) {
      await this.fail(error, 'READ_FAILED');
    }
  }

  async dispose(): Promise<void> {
    if (!this.disposal) {
      this.disposed = true;
      this.signal?.removeEventListener('abort', this.onAbort);
      this.disposal = (async () => {
        await Promise.allSettled(this.pendingIO);
        let failed = false;
        try { await this.handle.close(); } catch { failed = true; }
        try { await fs.rm(this.directory, { recursive: true, force: true, maxRetries: 3 }); } catch { failed = true; }
        if (failed) throw spoolError('CLEANUP_FAILED');
      })();
    }
    return this.disposal;
  }
}
