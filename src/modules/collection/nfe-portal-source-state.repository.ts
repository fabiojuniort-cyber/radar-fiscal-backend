import type { Kysely } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';
import type {
  NfePortalDocumentFamily,
  NfePortalDocumentStatus,
} from './nfe-portal.parser.js';

export interface NfePortalKnownOrigin {
  externalId?: string;
  officialUrl: string;
  lastSeenAt: Date;
  publishedOn?: string;
  family?: NfePortalDocumentFamily;
  status?: NfePortalDocumentStatus;
  rawSha256?: string;
}

export interface NfePortalSourceState {
  connectorConfig: Record<string, unknown>;
  knownOrigins: NfePortalKnownOrigin[];
}

function asRecord(
  value: unknown,
): Record<string, unknown> {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    return value as Record<string, unknown>;
  }

  return {};
}

function text(
  value: unknown,
): string | undefined {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : undefined;
}

function family(
  value: unknown,
): NfePortalDocumentFamily | undefined {
  return value === 'NOTE_TECHNICAL' ||
    value === 'TECHNICAL_REPORT' ||
    value === 'XML_SCHEMA' ||
    value === 'MANUAL' ||
    value === 'MISC_TECHNICAL'
    ? value
    : undefined;
}

function status(
  value: unknown,
): NfePortalDocumentStatus | undefined {
  return value === 'ACTIVE' ||
    value === 'INACTIVE' ||
    value === 'UNKNOWN'
    ? value
    : undefined;
}

export async function readNfePortalSourceState(
  db: Kysely<DB>,
  sourceId: string,
): Promise<NfePortalSourceState> {
  const source = await db
    .selectFrom('sources')
    .select('connector_config')
    .where('id', '=', sourceId)
    .executeTakeFirstOrThrow();

  const origins = await db
    .selectFrom('publication_origins as origin')
    .innerJoin(
      'publications as publication',
      'publication.id',
      'origin.publication_id',
    )
    .select([
      'origin.external_id',
      'origin.official_url',
      'origin.last_seen_at',
      'origin.metadata',
      'publication.published_on',
    ])
    .where('origin.source_id', '=', sourceId)
    .orderBy('origin.last_seen_at', 'desc')
    .execute();

  return {
    connectorConfig: asRecord(
      source.connector_config,
    ),
    knownOrigins: origins.map((origin) => {
      const metadata = asRecord(origin.metadata);
      const file = asRecord(metadata.primaryFile);

      return {
        ...(origin.external_id
          ? { externalId: origin.external_id }
          : {}),
        officialUrl: origin.official_url,
        lastSeenAt: origin.last_seen_at,
        ...(origin.published_on
          ? {
              publishedOn:
                origin.published_on
                  .toISOString()
                  .slice(0, 10),
            }
          : {}),
        ...(family(metadata.documentFamily)
          ? {
              family:
                family(metadata.documentFamily)!,
            }
          : {}),
        ...(status(metadata.portalStatus)
          ? {
              status:
                status(metadata.portalStatus)!,
            }
          : {}),
        ...(text(file.rawSha256)
          ? { rawSha256: text(file.rawSha256)! }
          : {}),
      };
    }),
  };
}
