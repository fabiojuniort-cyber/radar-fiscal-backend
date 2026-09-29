import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { TextDecoder } from 'node:util';

import {
  gitBlobSha,
  sha256Hex,
} from './baseline.canonical-json.js';
import type {
  SourceLock,
  VerifiedSource,
} from './baseline.types.js';

function assertHex(value: string, size: number, label: string): void {
  if (!new RegExp(`^[a-f0-9]{${size}}$`).test(value)) {
    throw new Error(
      `BASELINE_SOURCE_INTEGRITY_FAILURE: invalid ${label}`,
    );
  }
}

export async function verifyMirror(
  mirrorPath: string,
  lockPath: string,
): Promise<VerifiedSource> {
  const [bytes, lockRaw] = await Promise.all([
    readFile(resolve(process.cwd(), mirrorPath)),
    readFile(resolve(process.cwd(), lockPath), 'utf8'),
  ]);

  let lock: SourceLock;

  try {
    lock = JSON.parse(lockRaw) as SourceLock;
  } catch {
    throw new Error(
      'BASELINE_SOURCE_INTEGRITY_FAILURE: invalid source-lock JSON',
    );
  }

  if (
    lock.schemaVersion !==
    'tribusca.taxonomy.source-lock/v1'
  ) {
    throw new Error(
      'BASELINE_SOURCE_INTEGRITY_FAILURE: unsupported source-lock schema',
    );
  }

  assertHex(lock.canonicalBlobSha, 40, 'blob SHA');
  assertHex(lock.canonicalSha256, 64, 'SHA-256');

  let text: string;

  try {
    text = new TextDecoder('utf-8', {
      fatal: true,
    }).decode(bytes);
  } catch {
    throw new Error(
      'BASELINE_SOURCE_INTEGRITY_FAILURE: mirror is not valid UTF-8',
    );
  }

  const actualBlob = gitBlobSha(bytes);
  const actualSha256 = sha256Hex(bytes);

  if (
    actualBlob !== lock.canonicalBlobSha ||
    actualSha256 !== lock.canonicalSha256
  ) {
    throw new Error(
      [
        'BASELINE_SOURCE_INTEGRITY_FAILURE',
        `expectedBlob=${lock.canonicalBlobSha}`,
        `actualBlob=${actualBlob}`,
        `expectedSha256=${lock.canonicalSha256}`,
        `actualSha256=${actualSha256}`,
      ].join(': '),
    );
  }

  return {
    lock,
    bytes,
    text,
    gitBlobSha: actualBlob,
    sha256: actualSha256,
  };
}
