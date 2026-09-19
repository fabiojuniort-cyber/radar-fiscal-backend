import type { Kysely } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';
import type { ConfazSourceState } from './confaz.connector.js';

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

export async function readConfazSourceState(
  db: Kysely<DB>,
  sourceId: string,
): Promise<ConfazSourceState> {
  const source = await db
    .selectFrom('sources')
    .select('connector_config')
    .where('id', '=', sourceId)
    .executeTakeFirstOrThrow();

  const origins = await db
    .selectFrom('publication_origins')
    .select(['official_url', 'last_seen_at'])
    .where('source_id', '=', sourceId)
    .orderBy('last_seen_at', 'asc')
    .execute();

  return {
    connectorConfig: asRecord(source.connector_config),
    knownOrigins: origins.map((origin) => ({
      officialUrl: origin.official_url,
      lastSeenAt: origin.last_seen_at,
    })),
  };
}
