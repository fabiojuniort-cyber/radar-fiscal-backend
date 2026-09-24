import 'dotenv/config';

import { RfbNormasClient } from '../modules/collection/rfb-normas.client.js';
import {
  buildRfbApiRepresentationUrl,
  parseRfbApiRepresentation,
} from '../modules/collection/rfb-normas.parser.js';

const idAto = process.env.RFB_PROBE_ID ?? '143587';
const client = new RfbNormasClient();
const signal = new AbortController().signal;

const original = await client.getJson(buildRfbApiRepresentationUrl(idAto, 'original'), signal);
const parsed = parseRfbApiRepresentation(original.payload);
const downloads: Array<Record<string, unknown>> = [];

for (const attachment of parsed.attachments) {
  try {
    const file = await client.downloadFile(
      attachment.url,
      signal,
      {},
      attachment.name,
    );
    downloads.push({
      externalId: attachment.externalId,
      name: attachment.name ?? null,
      url: attachment.url,
      status: file.status,
      ...(file.status === 'DOWNLOADED'
        ? {
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes,
            rawSha256: file.rawSha256,
            filename: file.filename ?? null,
          }
        : {}),
    });
  } catch (error) {
    downloads.push({
      externalId: attachment.externalId,
      name: attachment.name ?? null,
      url: attachment.url,
      status: 'ERROR',
      code: error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : null,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

console.log('RFB_NORMAS_ITEM_PROBE=' + JSON.stringify({
  idAto,
  title: parsed.title ?? null,
  attachmentCount: parsed.attachments.length,
  attachments: parsed.attachments,
  downloads,
}));
