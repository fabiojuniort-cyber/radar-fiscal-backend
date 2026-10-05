import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { basename, join } from 'node:path';
import test, { type TestContext } from 'node:test';

import type { ConnectorPublication } from '../src/modules/collection/connector.contract.js';
import { ConnectorError } from '../src/modules/collection/connector.error.js';
import { normalizePublication } from '../src/modules/collection/publication.normalizer.js';
import {
  MAX_PUBLICATION_RECORD_BYTES,
  MAX_PUBLICATION_SPOOL_BYTES,
  PublicationSpool,
} from '../src/modules/collection/publication-spool.js';

interface SpoolInternals {
  directory: string;
  handle: FileHandle;
  byteCount: number;
}

const internals = (spool: PublicationSpool): SpoolInternals =>
  spool as unknown as SpoolInternals;
const filename = (spool: PublicationSpool): string =>
  join(internals(spool).directory, 'publications.bin');

function publication(index = 1): ConnectorPublication {
  return {
    title: `RESOLUÇÃO Nº ${index}, de 18 de setembro de 2026`,
    agency: 'Órgão de Teste',
    sphere: 'FEDERAL',
    actType: 'RESOLUÇÃO',
    actNumber: String(index),
    publishedAt: new Date('2026-09-18T03:00:00.000Z'),
    effectiveAt: new Date('2026-10-01T03:00:00.000Z'),
    content: `Art. 1º Conteúdo integral ${index}: ação e informação.\n\nArt. 2º Fim.`,
    presentationHtml: '<p>Art. 1º Conteúdo integral.</p>',
    officialUrl: `https://example.invalid/publication/${index}`,
    externalId: `publication-${index}`,
    identityKey: `canonical-${index}`,
    contentHashPolicy: 'HTML_PRIMARY_MATERIAL_FILES',
    metadata: {
      nested: { publishedAt: '2026-09-18T03:00:00.000Z', effectiveAt: '2026-10-01T03:00:00.000Z' },
      list: [1, false, null, 'ação'],
      '__publicationSpoolDate': 'ordinary metadata',
    },
    originMetadata: { edition: '180', page: 3 },
    files: [{
      url: `https://example.invalid/publication/${index}.pdf`,
      name: 'Anexo.pdf',
      mimeType: 'application/pdf',
      rawSha256: 'ab'.repeat(32),
      sizeBytes: 512,
      versionRole: 'MATERIAL_CONTENT',
      metadata: { publishedAt: '2026-09-18T03:00:00.000Z' },
    }],
  };
}

function isSpoolError(error: unknown): boolean {
  assert.ok(error instanceof ConnectorError);
  assert.equal(error.kind, 'PROCESSING_ERROR');
  assert.equal(error.retryable, false);
  assert.match(error.code, /^PUBLICATION_SPOOL_/);
  assert.equal(error.cause, undefined);
  return true;
}

async function makeSpool(t: TestContext, signal?: AbortSignal): Promise<PublicationSpool> {
  const spool = await PublicationSpool.create(signal);
  t.after(async () => { await spool.dispose(); });
  return spool;
}

async function readAll(spool: PublicationSpool): Promise<ConnectorPublication[]> {
  const publications: ConnectorPublication[] = [];
  for await (const item of spool) publications.push(item);
  return publications;
}

async function assertRemoved(directory: string): Promise<void> {
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
}

test('publication spool round trips ordered publications, dates, full bodies, and normalization hashes', async (t) => {
  const spool = await makeSpool(t);
  const expected = [publication(1), publication(2), publication(3)];
  assert.equal(spool.count, 0);
  assert.equal(spool.bytes, 0);
  for (const item of expected) await spool.append(item);
  await spool.seal();

  const actual = await readAll(spool);
  assert.deepEqual(actual, expected);
  assert.equal(spool.count, expected.length);
  assert.equal(spool.bytes, (await fs.stat(filename(spool))).size);
  assert.ok(spool.bytes > expected.reduce((total, item) => total + Buffer.byteLength(item.content!), 0));
  for (let index = 0; index < expected.length; index++) {
    assert.ok(actual[index]!.publishedAt instanceof Date);
    assert.ok(actual[index]!.effectiveAt instanceof Date);
    assert.equal(typeof (actual[index]!.metadata!.nested as Record<string, unknown>).publishedAt, 'string');
    assert.equal(typeof actual[index]!.files![0]!.metadata!.publishedAt, 'string');
    assert.deepEqual(
      normalizePublication({ sourceId: 'dou', publication: actual[index]! }),
      normalizePublication({ sourceId: 'dou', publication: expected[index]! }),
    );
  }
});

test('publication spool preserves absent properties separately from explicit undefined fields', async (t) => {
  const spool = await makeSpool(t);
  const withUndefined = {
    ...publication(),
    agency: undefined,
    effectiveAt: undefined,
    metadata: {
      '': undefined,
      ['__proto__']: undefined,
      explicit: undefined,
      nested: { undefinedValue: undefined, '': { deep: undefined }, iso: '2026-10-01T03:00:00.000Z' },
      values: [undefined, null, { missing: undefined }],
    },
    files: [{ url: 'https://example.invalid/file.pdf', name: undefined, metadata: { missing: undefined } }],
  } as unknown as ConnectorPublication;
  const withoutOptional: ConnectorPublication = {
    title: 'Minimal publication', sphere: 'FEDERAL', officialUrl: 'https://example.invalid/minimal',
  };
  await spool.append(withUndefined);
  await spool.append(withoutOptional);
  await spool.seal();

  const [first, second] = await readAll(spool);
  assert.deepEqual(first, withUndefined);
  assert.deepEqual(second, withoutOptional);
  assert.ok(Object.hasOwn(first!, 'effectiveAt'));
  assert.ok(Object.hasOwn(first!.metadata!, 'explicit'));
  assert.equal(Object.hasOwn(second!, 'effectiveAt'), false);
  assert.equal(Object.hasOwn(second!, 'metadata'), false);
  assert.deepEqual(
    normalizePublication({ sourceId: 'dou', publication: first! }),
    normalizePublication({ sourceId: 'dou', publication: withUndefined }),
  );
});

test('publication spool uses one private file and length-delimited SHA-256 checked records', async (t) => {
  const spool = await makeSpool(t);
  const directory = internals(spool).directory;
  assert.match(basename(directory), /^publication-spool-/);
  assert.deepEqual(await fs.readdir(directory), ['publications.bin']);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(filename(spool))).mode & 0o777, 0o600);
  await spool.append(publication());
  await spool.seal();

  const bytes = await fs.readFile(filename(spool));
  const length = bytes.readUInt32BE(0);
  assert.equal(bytes.length, 4 + 32 + length);
  assert.equal(spool.bytes, bytes.length);
  assert.deepEqual(bytes.subarray(4, 36), createHash('sha256').update(bytes.subarray(36)).digest());
  assert.doesNotThrow(() => JSON.parse(bytes.subarray(36).toString('utf8')));
});

test('empty sealed publication spools are valid and dispose is idempotent', async (t) => {
  const spool = await makeSpool(t);
  const directory = internals(spool).directory;
  await spool.seal();
  assert.deepEqual(await readAll(spool), []);
  assert.equal(spool.count, 0);
  assert.equal(spool.bytes, 0);
  await Promise.all([spool.dispose(), spool.dispose()]);
  await spool.dispose();
  await assertRemoved(directory);
});

test('publication spool cannot be read before sealing or used after disposal', async (t) => {
  const unsealed = await makeSpool(t);
  await unsealed.append(publication());
  await assert.rejects(readAll(unsealed), isSpoolError);

  const disposed = await makeSpool(t);
  await disposed.dispose();
  await assert.rejects(disposed.append(publication()), isSpoolError);
  await assert.rejects(disposed.seal(), isSpoolError);
  await assert.rejects(readAll(disposed), isSpoolError);
});

test('publication spool rejects appending after seal', async (t) => {
  const spool = await makeSpool(t);
  await spool.append(publication());
  await spool.seal();
  await assert.rejects(spool.append(publication(2)), isSpoolError);
});

test('publication spool completes short writes without dropping record bytes', async (t) => {
  const spool = await makeSpool(t);
  const handle = internals(spool).handle;
  const originalWrite = handle.write.bind(handle);
  const write = t.mock.method(handle, 'write', async (buffer: Buffer, offset: number, length: number, position: number) =>
    originalWrite(buffer, offset, Math.min(length, 7), position));
  await spool.append(publication());
  await spool.seal();
  assert.ok(write.mock.callCount() > 2);
  assert.deepEqual(await readAll(spool), [publication()]);
});

test('publication spool fails closed on a zero-byte write', async (t) => {
  const spool = await makeSpool(t);
  t.mock.method(internals(spool).handle, 'write', async (buffer: Buffer) => ({ bytesWritten: 0, buffer }));
  await assert.rejects(spool.append(publication()), isSpoolError);
  assert.equal(spool.count, 0);
  await assert.rejects(spool.append(publication(2)), isSpoolError);
  await assert.rejects(spool.seal(), isSpoolError);
  await assert.rejects(readAll(spool), isSpoolError);
  await spool.dispose();
  await assertRemoved(internals(spool).directory);
});

test('publication spool failed writes are irreversible and expose no paths, content, or filesystem cause', async (t) => {
  const spool = await makeSpool(t);
  const handle = internals(spool).handle;
  const directory = internals(spool).directory;
  const secret = 'PRIVATE_BODY_DO_NOT_LOG';
  const write = t.mock.method(handle, 'write', async () => {
    throw Object.assign(new Error(`ENOSPC ${directory} ${secret}`), { code: 'ENOSPC', path: filename(spool) });
  });
  await assert.rejects(spool.append({ ...publication(), content: secret }), (error: unknown) => {
    isSpoolError(error);
    const visible = `${String(error)} ${JSON.stringify(error)}`;
    assert.equal(visible.includes(directory), false);
    assert.equal(visible.includes(secret), false);
    assert.equal(visible.includes('ENOSPC'), false);
    return true;
  });
  write.mock.restore();
  await assert.rejects(spool.append(publication()), isSpoolError);
  await assert.rejects(spool.seal(), isSpoolError);
  await assert.rejects(readAll(spool), isSpoolError);
  await spool.dispose();
  await assertRemoved(directory);
});

test('publication spool serialization errors are sanitized and make earlier records unavailable', async (t) => {
  const spool = await makeSpool(t);
  await spool.append(publication());
  const circular: Record<string, unknown> = { secret: 'PRIVATE_CIRCULAR_METADATA' };
  circular.self = circular;
  await assert.rejects(spool.append({ ...publication(2), metadata: circular }), (error: unknown) => {
    isSpoolError(error);
    assert.equal(String(error).includes('PRIVATE_CIRCULAR_METADATA'), false);
    return true;
  });
  await assert.rejects(spool.append(publication(3)), isSpoolError);
  await assert.rejects(spool.seal(), isSpoolError);
  await assert.rejects(readAll(spool), isSpoolError);
});

test('publication spool sanitizes foreign ConnectorError instances thrown by getters and toJSON', async (t) => {
  for (const source of ['getter', 'toJSON']) {
    await t.test(source, async (subtest) => {
      const spool = await makeSpool(subtest);
      const throwForeignError = (): never => {
        throw new ConnectorError('PRIVATE_SERIALIZATION_ERROR /private/content.json', {
          kind: 'PROCESSING_ERROR', code: 'PRIVATE_FOREIGN_CODE', retryable: true,
          cause: new Error('PRIVATE_ORIGINAL_CAUSE'), metadata: { body: 'PRIVATE_METADATA' },
        });
      };
      const item = publication();
      if (source === 'getter') {
        Object.defineProperty(item.metadata!, 'secret', { enumerable: true, get: throwForeignError });
      } else {
        item.metadata = { toJSON: throwForeignError };
      }
      await assert.rejects(spool.append(item), (error: unknown) => {
        isSpoolError(error);
        const visible = `${String(error)} ${JSON.stringify(error)}`;
        assert.equal(visible.includes('PRIVATE_'), false);
        assert.equal(visible.includes('/private/content.json'), false);
        return true;
      });
      await assert.rejects(spool.seal(), isSpoolError);
    });
  }
});

test('publication spool rejects concurrent appends and cannot seal their partial output', async (t) => {
  const spool = await makeSpool(t);
  const handle = internals(spool).handle;
  const originalWrite = handle.write.bind(handle);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.mock.method(handle, 'write', async (...args: Parameters<FileHandle['write']>) => {
    entered.resolve();
    await release.promise;
    return originalWrite(...args);
  });
  const first = assert.rejects(spool.append(publication()), isSpoolError);
  await entered.promise;
  const second = assert.rejects(spool.append(publication(2)), isSpoolError);
  release.resolve();
  await Promise.all([first, second]);
  await assert.rejects(spool.seal(), isSpoolError);
  await assert.rejects(readAll(spool), isSpoolError);
});

test('publication spool disposal waits safely for an in-flight write and rejects its completion', async (t) => {
  const spool = await makeSpool(t);
  const handle = internals(spool).handle;
  const originalWrite = handle.write.bind(handle);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.mock.method(handle, 'write', async (...args: Parameters<FileHandle['write']>) => {
    entered.resolve();
    await release.promise;
    return originalWrite(...args);
  });
  const append = assert.rejects(spool.append(publication()), isSpoolError);
  await entered.promise;
  let disposed = false;
  const disposing = spool.dispose().then(() => { disposed = true; });
  await Promise.resolve();
  assert.equal(disposed, false);
  release.resolve();
  await Promise.all([append, disposing]);
  await assertRemoved(internals(spool).directory);
});

test('publication spool refuses a pre-aborted signal without exposing the abort reason', async () => {
  const controller = new AbortController();
  controller.abort(new Error('PRIVATE_ABORT_REASON'));
  await assert.rejects(PublicationSpool.create(controller.signal), (error: unknown) => {
    isSpoolError(error);
    assert.equal(String(error).includes('PRIVATE_ABORT_REASON'), false);
    return true;
  });
});

test('publication spool cancellation disposes an idle spool without another operation', async (t) => {
  const controller = new AbortController();
  const spool = await makeSpool(t, controller.signal);
  await spool.append(publication());
  const handle = internals(spool).handle;
  const originalClose = handle.close.bind(handle);
  const closed = Promise.withResolvers<void>();
  t.mock.method(handle, 'close', async () => {
    await originalClose();
    closed.resolve();
  });
  controller.abort(new Error('PRIVATE_ABORT_REASON'));
  await closed.promise;
  await spool.dispose();
  await assertRemoved(internals(spool).directory);
  await assert.rejects(spool.append(publication()), isSpoolError);
  await assert.rejects(readAll(spool), isSpoolError);
});

test('publication spool cancellation during a write rejects after I/O and cleans up', async (t) => {
  const controller = new AbortController();
  const spool = await makeSpool(t, controller.signal);
  const handle = internals(spool).handle;
  const originalWrite = handle.write.bind(handle);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.mock.method(handle, 'write', async (...args: Parameters<FileHandle['write']>) => {
    entered.resolve();
    await release.promise;
    return originalWrite(...args);
  });
  const append = assert.rejects(spool.append(publication()), isSpoolError);
  await entered.promise;
  controller.abort();
  release.resolve();
  await append;
  await spool.dispose();
  await assertRemoved(internals(spool).directory);
});

test('publication spool completes short reads and preserves all records', async (t) => {
  const spool = await makeSpool(t);
  await spool.append(publication());
  await spool.append(publication(2));
  await spool.seal();
  const handle = internals(spool).handle;
  const originalRead = handle.read.bind(handle);
  const read = t.mock.method(handle, 'read', async (buffer: Buffer, offset: number, length: number, position: number) =>
    originalRead(buffer, offset, Math.min(length, 7), position));
  assert.deepEqual(await readAll(spool), [publication(), publication(2)]);
  assert.ok(read.mock.callCount() > 4);
});

test('publication spool read failures are sanitized and cannot be retried', async (t) => {
  const spool = await makeSpool(t);
  await spool.append(publication());
  await spool.seal();
  const read = t.mock.method(internals(spool).handle, 'read', async () => {
    throw new Error(`PRIVATE_READ_ERROR ${filename(spool)}`);
  });
  await assert.rejects(readAll(spool), (error: unknown) => {
    isSpoolError(error);
    assert.equal(String(error).includes('PRIVATE_READ_ERROR'), false);
    assert.equal(String(error).includes(internals(spool).directory), false);
    return true;
  });
  read.mock.restore();
  await assert.rejects(readAll(spool), isSpoolError);
  await assertRemoved(internals(spool).directory);
});

test('publication spool cancellation during replay does not yield a publication after the read', async (t) => {
  const controller = new AbortController();
  const spool = await makeSpool(t, controller.signal);
  await spool.append(publication());
  await spool.seal();
  const handle = internals(spool).handle;
  const originalRead = handle.read.bind(handle);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.mock.method(handle, 'read', async (...args: Parameters<FileHandle['read']>) => {
    entered.resolve();
    await release.promise;
    return originalRead(...args);
  });
  const replay = assert.rejects(readAll(spool), isSpoolError);
  await entered.promise;
  controller.abort();
  release.resolve();
  await replay;
  await spool.dispose();
  await assertRemoved(internals(spool).directory);
});

test('publication spool seal failures discard all staged publications', async (t) => {
  const spool = await makeSpool(t);
  await spool.append(publication());
  t.mock.method(internals(spool).handle, 'sync', async () => {
    throw new Error(`PRIVATE_SYNC_ERROR ${filename(spool)}`);
  });
  await assert.rejects(spool.seal(), (error: unknown) => {
    isSpoolError(error);
    assert.equal(String(error).includes('PRIVATE_SYNC_ERROR'), false);
    assert.equal(String(error).includes(internals(spool).directory), false);
    return true;
  });
  await assert.rejects(readAll(spool), isSpoolError);
  await assertRemoved(internals(spool).directory);
});

test('publication spool rejects corruption, incomplete frames, and extra trailing bytes', async (t) => {
  const mutations: Array<[string, (bytes: Buffer) => Buffer]> = [
    ['truncated length', (bytes) => bytes.subarray(0, 2)],
    ['truncated digest', (bytes) => bytes.subarray(0, 20)],
    ['truncated JSON', (bytes) => bytes.subarray(0, bytes.length - 1)],
    ['modified digest', (bytes) => { bytes[4] = bytes[4]! ^ 1; return bytes; }],
    ['modified JSON', (bytes) => { bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1; return bytes; }],
    ['extra trailing bytes', (bytes) => Buffer.concat([bytes, Buffer.from([1])])],
    ['zero-sized record', (bytes) => { bytes.writeUInt32BE(0, 0); return bytes; }],
    ['oversized record', (bytes) => { bytes.writeUInt32BE(MAX_PUBLICATION_RECORD_BYTES + 1, 0); return bytes; }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, async (subtest) => {
      const spool = await makeSpool(subtest);
      await spool.append(publication());
      await spool.seal();
      await fs.writeFile(filename(spool), mutate(await fs.readFile(filename(spool))));
      await assert.rejects(readAll(spool), isSpoolError);
      await assert.rejects(readAll(spool), isSpoolError);
    });
  }
});

test('publication spool rejects invalid JSON even if the frame digest was recomputed', async (t) => {
  const spool = await makeSpool(t);
  await spool.append(publication());
  await spool.seal();
  const bytes = await fs.readFile(filename(spool));
  bytes[36] = 0x21;
  createHash('sha256').update(bytes.subarray(36)).digest().copy(bytes, 4);
  await fs.writeFile(filename(spool), bytes);
  await assert.rejects(readAll(spool), isSpoolError);
});

test('publication spool enforces the total-byte bound before attempting a write', async (t) => {
  assert.equal(MAX_PUBLICATION_SPOOL_BYTES, 8 * 1024 ** 3);
  assert.equal(MAX_PUBLICATION_RECORD_BYTES, 512 * 1024 ** 2);
  const spool = await makeSpool(t);
  internals(spool).byteCount = MAX_PUBLICATION_SPOOL_BYTES;
  const write = t.mock.method(internals(spool).handle, 'write', async () => {
    assert.fail('a record exceeding the spool bound must not reach disk');
  });
  await assert.rejects(spool.append(publication()), isSpoolError);
  assert.equal(write.mock.callCount(), 0);
  assert.equal(spool.count, 0);
  await assert.rejects(spool.seal(), isSpoolError);
});

test('publication spool enforces the record-byte bound without a giant allocation', async (t) => {
  const spool = await makeSpool(t);
  const originalByteLength = Buffer.byteLength.bind(Buffer);
  const byteLength = t.mock.method(Buffer, 'byteLength', (...args: Parameters<typeof Buffer.byteLength>) => {
    if (typeof args[0] === 'string' && args[0].includes('RECORD_LIMIT_FIXTURE')) {
      return MAX_PUBLICATION_RECORD_BYTES + 1;
    }
    return originalByteLength(...args);
  });
  const write = t.mock.method(internals(spool).handle, 'write', async () => {
    assert.fail('an oversized record must not reach disk');
  });
  await assert.rejects(spool.append({ ...publication(), content: 'RECORD_LIMIT_FIXTURE' }), (error: unknown) => {
    isSpoolError(error);
    assert.equal((error as ConnectorError).code, 'PUBLICATION_SPOOL_RECORD_LIMIT_EXCEEDED');
    return true;
  });
  assert.ok(byteLength.mock.callCount() > 0);
  assert.equal(write.mock.callCount(), 0);
  assert.equal(spool.count, 0);
  await assert.rejects(spool.seal(), isSpoolError);
});

test('publication spool checks cancellation after opening its file and removes it', async (t) => {
  const controller = new AbortController();
  const originalOpen = fs.open.bind(fs);
  let directory: string | undefined;
  let openedHandle: FileHandle | undefined;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    const path = String(args[0]);
    if (path.endsWith('/publications.bin') && path.includes('/publication-spool-')) {
      directory = path.slice(0, -'/publications.bin'.length);
      openedHandle = handle;
      controller.abort(new Error('PRIVATE_OPEN_ABORT_REASON'));
    }
    return handle;
  });
  await assert.rejects(PublicationSpool.create(controller.signal), (error: unknown) => {
    isSpoolError(error);
    assert.equal(String(error).includes('PRIVATE_OPEN_ABORT_REASON'), false);
    return true;
  });
  assert.ok(directory);
  assert.ok(openedHandle);
  assert.equal(openedHandle.fd, -1);
  await assertRemoved(directory);
});

test('publication spool creation errors are sanitized and remove a partially created directory', async (t) => {
  const originalOpen = fs.open.bind(fs);
  let failedDirectory: string | undefined;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const path = String(args[0]);
    if (path.endsWith('/publications.bin') && path.includes('/publication-spool-')) {
      failedDirectory = path.slice(0, -'/publications.bin'.length);
      throw new Error(`PRIVATE_OPEN_ERROR ${path}`);
    }
    return originalOpen(...args);
  });
  await assert.rejects(PublicationSpool.create(), (error: unknown) => {
    isSpoolError(error);
    assert.equal(String(error).includes('PRIVATE_OPEN_ERROR'), false);
    assert.equal(String(error).includes(failedDirectory ?? 'PRIVATE_OPEN_ERROR'), false);
    return true;
  });
  assert.ok(failedDirectory);
  await assertRemoved(failedDirectory);
});
