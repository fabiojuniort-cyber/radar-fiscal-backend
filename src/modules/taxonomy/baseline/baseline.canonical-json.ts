import { createHash } from 'node:crypto';

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalize(item));
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(
      value as Record<string, unknown>,
    ).sort(([left], [right]) => left.localeCompare(right));

    return Object.fromEntries(
      entries.map(([key, item]) => [key, normalize(item)]),
    );
  }

  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sha1Hex(value: Buffer): string {
  return createHash('sha1').update(value).digest('hex');
}

export function gitBlobSha(buffer: Buffer): string {
  const header = Buffer.from(
    `blob ${buffer.byteLength}\0`,
    'utf8',
  );

  return sha1Hex(Buffer.concat([header, buffer]));
}
