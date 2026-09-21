import { inflateSync } from 'node:zlib';

import yauzl from 'yauzl';

export type NfePortalFileKind =
  | 'PDF'
  | 'ZIP'
  | 'TEXT'
  | 'BINARY';

export interface NfePortalFileInspection {
  kind: NfePortalFileKind;
  zipEntries?: string[];
  extractedText?: string;
  textExtractionReliable?: boolean;
}

function startsWith(
  bytes: Uint8Array,
  values: number[],
): boolean {
  return values.every(
    (value, index) => bytes[index] === value,
  );
}

export function detectNfePortalFileKind(
  bytes: Uint8Array,
  contentType?: string,
  filename?: string,
): NfePortalFileKind {
  if (
    startsWith(bytes, [0x25, 0x50, 0x44, 0x46]) ||
    /application\/pdf/i.test(contentType ?? '') ||
    /\.pdf$/i.test(filename ?? '')
  ) {
    return 'PDF';
  }

  if (
    startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    /application\/(?:zip|x-zip-compressed)/i.test(
      contentType ?? '',
    ) ||
    /\.(?:zip|xlsx)$/i.test(filename ?? '')
  ) {
    return 'ZIP';
  }

  if (
    /(?:text\/|application\/(?:xml|json|csv))/i.test(
      contentType ?? '',
    ) ||
    /\.(?:xml|xsd|csv|txt|json)$/i.test(
      filename ?? '',
    )
  ) {
    return 'TEXT';
  }

  return 'BINARY';
}

export async function zipManifest(
  bytes: Uint8Array,
  maxEntries = 1000,
): Promise<string[]> {
  return await new Promise<string[]>(
    (resolve, reject) => {
      yauzl.fromBuffer(
        Buffer.from(bytes),
        {
          lazyEntries: true,
          validateEntrySizes: true,
        },
        (error, zip) => {
          if (error || !zip) {
            reject(
              error ??
                new Error(
                  'Unable to open ZIP archive',
                ),
            );
            return;
          }

          const entries: string[] = [];
          let settled = false;

          const finish = (
            err?: Error,
          ) => {
            if (settled) return;
            settled = true;
            zip.close();
            if (err) reject(err);
            else resolve(entries);
          };

          zip.on('error', (err) =>
            finish(
              err instanceof Error
                ? err
                : new Error(String(err)),
            ),
          );

          zip.on('end', () => finish());

          zip.on('entry', (entry) => {
            if (entries.length >= maxEntries) {
              finish(
                new Error(
                  'ZIP manifest exceeds entry limit',
                ),
              );
              return;
            }

            const name = entry.fileName
              .replace(/\\/g, '/')
              .replace(/^\.\//, '');

            if (
              name.startsWith('/') ||
              name.includes('../')
            ) {
              finish(
                new Error(
                  'Unsafe ZIP entry path',
                ),
              );
              return;
            }

            entries.push(name);
            zip.readEntry();
          });

          zip.readEntry();
        },
      );
    },
  );
}

function decodePdfLiteral(
  value: string,
): string {
  return value
    .replace(/\\([nrtbf])/g, (_, token: string) => {
      const map: Record<string, string> = {
        n: '\n',
        r: '\r',
        t: '\t',
        b: '\b',
        f: '\f',
      };
      return map[token] ?? token;
    })
    .replace(/\\([()\\])/g, '$1')
    .replace(/\\([0-7]{1,3})/g, (_, octal: string) =>
      String.fromCharCode(
        Number.parseInt(octal, 8),
      ),
    );
}

function extractPdfStrings(
  content: string,
): string[] {
  const results: string[] = [];

  for (const block of content.matchAll(
    /BT([\s\S]*?)ET/g,
  )) {
    const body = block[1] ?? '';

    for (const literal of body.matchAll(
      /\(((?:\\.|[^\\)])*)\)\s*(?:Tj|'|")/g,
    )) {
      if (literal[1]) {
        results.push(
          decodePdfLiteral(literal[1]),
        );
      }
    }

    for (const array of body.matchAll(
      /\[((?:[^\]]|\](?!\s*TJ))*)\]\s*TJ/g,
    )) {
      const value = array[1] ?? '';

      const parts = [
        ...value.matchAll(
          /\(((?:\\.|[^\\)])*)\)/g,
        ),
      ]
        .map((match) =>
          decodePdfLiteral(match[1] ?? ''),
        )
        .filter(Boolean);

      if (parts.length > 0) {
        results.push(parts.join(''));
      }
    }
  }

  return results;
}

function candidatePdfStreams(
  bytes: Uint8Array,
): string[] {
  const source = Buffer.from(bytes).toString(
    'latin1',
  );
  const streams: string[] = [];

  for (const match of source.matchAll(
    /<<(.*?)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g,
  )) {
    const dict = match[1] ?? '';
    const raw = match[2] ?? '';

    if (/\/FlateDecode\b/.test(dict)) {
      try {
        streams.push(
          inflateSync(
            Buffer.from(raw, 'latin1'),
          ).toString('latin1'),
        );
      } catch {
        continue;
      }
    } else {
      streams.push(raw);
    }
  }

  streams.push(source);
  return streams;
}

function normalizeText(
  value: string,
): string {
  return value
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function textConfidence(
  value: string,
  expectedTitle: string,
): boolean {
  if (value.length < 120) return false;

  const printable = [...value].filter(
    (char) =>
      char === '\n' ||
      char === '\t' ||
      char.charCodeAt(0) >= 32,
  ).length;

  if (printable / value.length < 0.95) {
    return false;
  }

  const normalize = (input: string) =>
    input
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, ' ')
      .trim();

  const titleWords = normalize(expectedTitle)
    .split(' ')
    .filter((word) => word.length >= 3)
    .slice(0, 8);

  const body = normalize(value);
  const matches = titleWords.filter(
    (word) => body.includes(word),
  ).length;

  return (
    titleWords.length === 0 ||
    matches >= Math.min(3, titleWords.length)
  );
}

export function tryExtractPdfText(
  bytes: Uint8Array,
  expectedTitle: string,
): {
  text?: string;
  reliable: boolean;
} {
  const parts: string[] = [];

  for (const stream of candidatePdfStreams(
    bytes,
  )) {
    parts.push(...extractPdfStrings(stream));
  }

  const text = normalizeText(parts.join(' '));

  if (!textConfidence(text, expectedTitle)) {
    return { reliable: false };
  }

  return {
    text,
    reliable: true,
  };
}

export async function inspectNfePortalFile(
  bytes: Uint8Array,
  options: {
    contentType?: string;
    filename?: string;
    expectedTitle: string;
  },
): Promise<NfePortalFileInspection> {
  const kind = detectNfePortalFileKind(
    bytes,
    options.contentType,
    options.filename,
  );

  if (kind === 'ZIP') {
    try {
      return {
        kind,
        zipEntries: await zipManifest(bytes),
      };
    } catch {
      return { kind };
    }
  }

  if (kind === 'PDF') {
    const extracted = tryExtractPdfText(
      bytes,
      options.expectedTitle,
    );

    return {
      kind,
      ...(extracted.text
        ? { extractedText: extracted.text }
        : {}),
      textExtractionReliable:
        extracted.reliable,
    };
  }

  if (kind === 'TEXT') {
    const text = normalizeText(
      new TextDecoder('utf-8', {
        fatal: false,
      }).decode(bytes),
    );

    return {
      kind,
      ...(text ? { extractedText: text } : {}),
      textExtractionReliable:
        text.length > 0,
    };
  }

  return { kind };
}
