import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  R6_LOCK_PATH,
  R6_MIRROR_PATH,
  TAX04_LOCK_PATH,
  TAX04_MIRROR_PATH,
} from '../src/modules/taxonomy/baseline/baseline.constants.js';
import {
  verifyMirror,
} from '../src/modules/taxonomy/baseline/baseline.integrity.js';

test('baseline source mirrors are byte-identical to approved artifacts', async () => {
  const r6 = await verifyMirror(
    R6_MIRROR_PATH,
    R6_LOCK_PATH,
  );
  const tax04 = await verifyMirror(
    TAX04_MIRROR_PATH,
    TAX04_LOCK_PATH,
  );

  assert.equal(
    r6.gitBlobSha,
    '4f3b906d5ca2044ed05b3397890a5fc45c44e8c1',
  );
  assert.equal(
    r6.sha256,
    '7f68d7be2dfc5486f4fb5c88259de629976b1daa54b62cf9248f4e6efbbadfd2',
  );
  assert.equal(
    tax04.gitBlobSha,
    '0fbd4d0759954978fc81e208e3f3f2f02c8239b4',
  );
  assert.equal(
    tax04.sha256,
    '55eaf16dde93d2904e77e3c706afff73db106c1472c4e23205cddf8b903cac0b',
  );
});

test('one-byte R6 tamper is blocked', async () => {
  const dir = await mkdtemp(
    join(tmpdir(), 'taxonomy-r6-tamper-'),
  );

  try {
    const [source, lock] = await Promise.all([
      readFile(R6_MIRROR_PATH),
      readFile(R6_LOCK_PATH, 'utf8'),
    ]);
    const tampered = Buffer.from(source);
    tampered[0] = tampered[0] === 35 ? 36 : 35;

    await writeFile(join(dir, 'source.md'), tampered);
    await writeFile(join(dir, 'lock.json'), lock);

    await assert.rejects(
      verifyMirror(
        join(dir, 'source.md'),
        join(dir, 'lock.json'),
      ),
      /BASELINE_SOURCE_INTEGRITY_FAILURE/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('divergent source lock is blocked', async () => {
  const dir = await mkdtemp(
    join(tmpdir(), 'taxonomy-lock-tamper-'),
  );

  try {
    const [source, lockRaw] = await Promise.all([
      readFile(TAX04_MIRROR_PATH),
      readFile(TAX04_LOCK_PATH, 'utf8'),
    ]);
    const lock = JSON.parse(lockRaw) as {
      canonicalSha256: string;
    };
    lock.canonicalSha256 = '0'.repeat(64);

    await writeFile(join(dir, 'source.md'), source);
    await writeFile(
      join(dir, 'lock.json'),
      JSON.stringify(lock),
    );

    await assert.rejects(
      verifyMirror(
        join(dir, 'source.md'),
        join(dir, 'lock.json'),
      ),
      /BASELINE_SOURCE_INTEGRITY_FAILURE/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
