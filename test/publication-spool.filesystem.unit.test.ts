import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import test from 'node:test';

import { executeConnector } from '../src/modules/collection/connector.executor.js';
import { createCollectionMemoryProbe } from '../src/modules/collection/collection.memory.js';
import { PublicationSpool } from '../src/modules/collection/publication-spool.js';
import {
  filesystemFromMountInfo,
  inspectPublicationSpoolFilesystem,
} from '../src/modules/collection/publication-spool.filesystem.js';

const stat = (type: number) => ({ type, bavail: 512, bsize: 4096 });

for (const [type, filesystem, storage] of [
  [0x01021994, 'tmpfs', 'memory_backed'],
  [0x858458f6, 'ramfs', 'memory_backed'],
  [0xef53, 'ext', 'local_filesystem'],
  [0x58465342, 'xfs', 'local_filesystem'],
  [0x9123683e, 'btrfs', 'local_filesystem'],
  [0x794c7630, 'overlay', 'unknown'],
] as const) {
  test(`spool statfs identifies ${filesystem} conservatively`, async t => {
    t.mock.method(fs, 'statfs', async () => stat(type));
    t.mock.method(fs, 'open', async () => { throw new Error('mountinfo should not be needed'); });
    assert.deepEqual(await inspectPublicationSpoolFilesystem('/private/spool'), {
      spoolFilesystem: filesystem, spoolStorage: storage,
      spoolFilesystemProbe: 'statfs', spoolFreeBytes: 512 * 4096,
    });
  });
}

test('spool mountinfo chooses the closest mount with escaped paths and path boundaries', () => {
  const mounts = [
    '31 20 0:1 / / rw - ext4 /dev/private rw',
    '32 31 0:2 / /tmp rw - tmpfs private rw',
    '33 32 0:3 / /tmp/spools\\040private rw - overlay private rw',
    '34 32 0:4 / /tmp/strange rw - unsupported secret rw',
  ].join('\n');
  assert.equal(filesystemFromMountInfo('/tmp/run', mounts), 'tmpfs');
  assert.equal(filesystemFromMountInfo('/tmp/spools private/run', mounts), 'overlay');
  assert.equal(filesystemFromMountInfo('/tmp/strange/run', mounts), 'unknown');
  assert.equal(filesystemFromMountInfo('/tmp2/run', mounts), 'ext');
  assert.equal(filesystemFromMountInfo('/tmp/run', 'malformed private mount info'), 'unknown');
  assert.equal(filesystemFromMountInfo('/tmp/run', `${mounts}\n35 32 0:5 / /tmp rw - ext4 none rw`), 'unknown');
});

test('spool uses bounded mountinfo fallback when statfs is unavailable', async t => {
  if (process.platform !== 'linux') return;
  let closed = false;
  let read = false;
  const text = '31 20 0:1 / /private rw - tmpfs none rw\n';
  t.mock.method(fs, 'statfs', async () => { throw new Error('private statfs cause'); });
  t.mock.method(fs, 'realpath', async () => '/private/spool');
  t.mock.method(fs, 'open', async () => ({
    read: async (buffer: Buffer, offset: number, _length: number, _position: number | null) => {
      const bytesRead = read ? 0 : buffer.write(text, offset);
      read = true;
      return { bytesRead, buffer };
    },
    close: async () => { closed = true; },
  }));
  assert.deepEqual(await inspectPublicationSpoolFilesystem('/private/spool'), {
    spoolFilesystem: 'tmpfs', spoolStorage: 'memory_backed', spoolFilesystemProbe: 'mountinfo',
  });
  assert.equal(closed, true);
});

test('truncated mount tables cannot misclassify an unobserved nested memory mount as disk', async t => {
  if (process.platform !== 'linux') return;
  let closed = false;
  t.mock.method(fs, 'statfs', async () => { throw new Error('unavailable'); });
  t.mock.method(fs, 'open', async () => ({
    read: async (buffer: Buffer, _offset: number, length: number) => {
      buffer.fill(32);
      buffer.write('31 20 0:1 / / rw - ext4 none rw\n');
      return { bytesRead: length, buffer };
    },
    close: async () => { closed = true; },
  }));
  assert.deepEqual(await inspectPublicationSpoolFilesystem('/private/spool'), {
    spoolFilesystem: 'unknown', spoolStorage: 'unknown', spoolFilesystemProbe: 'unavailable',
  });
  assert.equal(closed, true);
});

test('unknown statfs and invalid free-space counts stay conservative and sanitized', async t => {
  t.mock.method(fs, 'statfs', async () => ({ type: 42, bavail: Infinity, bsize: 4096 }));
  t.mock.method(fs, 'open', async () => { throw new Error('/private/path: secret cause'); });
  assert.deepEqual(await inspectPublicationSpoolFilesystem('/private/spool'), {
    spoolFilesystem: 'unknown', spoolStorage: 'unknown', spoolFilesystemProbe: 'statfs',
  });
});

test('a stalled filesystem diagnostic times out without failing the caller', async t => {
  t.mock.method(fs, 'statfs', () => new Promise(() => {}));
  assert.deepEqual(await inspectPublicationSpoolFilesystem('/private/spool', 5), {
    spoolFilesystem: 'unknown', spoolStorage: 'unknown', spoolFilesystemProbe: 'timeout',
  });
});

test('unavailable filesystem diagnostics do not prevent private spool creation or cleanup', async t => {
  const open = fs.open;
  t.mock.method(fs, 'statfs', async () => { throw new Error('private statfs error'); });
  t.mock.method(fs, 'open', async (...args: Parameters<typeof open>) => {
    if (args[0] === '/proc/self/mountinfo') throw new Error('private mountinfo error');
    return open(...args);
  });
  const spool = await PublicationSpool.create();
  try {
    assert.deepEqual(spool.filesystem, {
      spoolFilesystem: 'unknown', spoolStorage: 'unknown', spoolFilesystemProbe: 'unavailable',
    });
    assert.equal(Object.isFrozen(spool.filesystem), true);
    await spool.seal();
  } finally { await spool.dispose(); }
});

test('spool telemetry contains bounded labels and cannot leak paths or mount options', async t => {
  t.mock.method(fs, 'statfs', async () => stat(0x01021994));
  let observed: Record<string, unknown> | undefined;
  const outcome = await executeConnector({
    connector: {
      key: 'fixture', collect: async () => ({ publications: [] }),
      collectIncremental: async () => ({ publications: [] }),
    },
    sourceId: 'source', runId: 'run', attemptId: 'attempt', timeoutMs: 1000,
    memory: createCollectionMemoryProbe(sample => {
      if (sample.phase === 'spool_ready') observed = { ...sample };
    }),
  });
  assert.ok(outcome.ok);
  try {
    assert.ok(observed);
    assert.equal(observed.spoolFilesystem, 'tmpfs');
    assert.equal(observed.spoolStorage, 'memory_backed');
    assert.equal(observed.spoolFilesystemProbe, 'statfs');
    assert.deepEqual(Object.keys(observed).sort(), [
      'phase', 'rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers',
      'spoolFilesystem', 'spoolStorage', 'spoolFilesystemProbe', 'spoolFreeBytes',
    ].sort());
  } finally { await outcome.result.publicationStream?.dispose(); }
});

test('a failing filesystem telemetry consumer does not fail collection', async () => {
  const outcome = await executeConnector({
    connector: {
      key: 'fixture', collect: async () => ({ publications: [] }),
      collectIncremental: async () => ({ publications: [] }),
    },
    sourceId: 'source', runId: 'run', attemptId: 'attempt', timeoutMs: 1000,
    memory: phase => { if (phase === 'spool_ready') throw new Error('unavailable metrics sink'); },
  });
  assert.ok(outcome.ok);
  await outcome.result.publicationStream?.dispose();
});
