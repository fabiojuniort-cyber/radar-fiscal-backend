import { sql, type Kysely } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';
import { readCurrentCheckpoint } from './checkpoint.repository.js';
import {
  CGIBS_CONNECTOR_KEY,
  CGIBS_STATE_VERSION,
  type CgibsPersistedOrigins,
  type CgibsSourceState,
  type CgibsStoredFile,
} from './cgibs.connector.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function storedFile(value: unknown): CgibsStoredFile | undefined {
  const item = record(value);
  if (!item) return undefined;
  if (typeof item.rawSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.rawSha256)) return undefined;
  if (typeof item.sizeBytes !== 'number' || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0) return undefined;
  if (typeof item.mimeType !== 'string' || !item.mimeType.trim()) return undefined;
  if (typeof item.checkedAt !== 'string' || !Number.isFinite(Date.parse(item.checkedAt))) return undefined;

  return {
    rawSha256: item.rawSha256,
    sizeBytes: item.sizeBytes,
    mimeType: item.mimeType,
    checkedAt: item.checkedAt,
    ...(typeof item.filename === 'string' && item.filename ? { filename: item.filename } : {}),
    ...(typeof item.sourceEtag === 'string' && item.sourceEtag ? { sourceEtag: item.sourceEtag } : {}),
    ...(typeof item.sourceLastModified === 'string' && item.sourceLastModified ? { sourceLastModified: item.sourceLastModified } : {}),
    ...(typeof item.identityKey === 'string' && item.identityKey.startsWith('CGIBS|') && item.identityKey.length <= 4096
      ? { identityKey: item.identityKey }
      : {}),
  };
}

/**
 * What the database already holds for the origins of this source.
 *
 * `identityKeys` is the identity each origin owns, for identities derived
 * from the listing (canonical key). A CGIBS origin is the stable path of one
 * published file, so the document it names never changes: a different act is
 * a different file and therefore a different origin. The identity it already
 * owns is the reference whenever the checkpoint does not carry one (first run
 * after this change, dropped checkpoint, or an item that failed in the last
 * run), because persistence rejects any other key for that origin.
 *
 * `linked` is every origin that already has a publication, including the
 * numbered acts whose identity is strong rather than canonical. It is the
 * proof that lets an unchanged file be skipped instead of re-emitted: an
 * origin missing from it has nothing persisted yet and must be emitted even
 * when its bytes are unchanged.
 */
export async function readCgibsPersistedOrigins(
  db: Kysely<DB>,
  sourceId: string,
): Promise<CgibsPersistedOrigins> {
  const linked = await db
    .selectFrom('publication_origins as o')
    .innerJoin('publications as p', 'p.id', 'o.publication_id')
    .select([
      'o.external_id',
      sql<string | null>`p.identity_basis ->> 'sourceKey'`.as('source_key'),
      sql<string | null>`p.identity_basis ->> 'sourceKeyType'`.as('source_key_type'),
    ])
    .where('o.source_id', '=', sourceId)
    .where('o.external_id', 'is not', null)
    .execute();

  const identityKeys: Record<string, string> = {};
  const persisted = new Set<string>();
  for (const row of linked) {
    const externalId = row.external_id;
    if (!externalId) continue;
    persisted.add(externalId);
    const key = row.source_key;
    if (row.source_key_type === 'CANONICAL_KEY' && key && key.startsWith('CGIBS|') && key.length <= 4096) {
      identityKeys[externalId] = key;
    }
  }
  return { identityKeys, linked: persisted };
}

export async function readCgibsSourceState(
  db: Kysely<DB>,
  sourceId: string,
): Promise<CgibsSourceState> {
  const stored = await readCurrentCheckpoint(db, sourceId, CGIBS_CONNECTOR_KEY, {
    stateVersion: CGIBS_STATE_VERSION,
    // A CGIBS run is PARTIAL_SUCCESS whenever a single one of the ~100
    // catalog items fails, and the checkpoint is a per-file map: discarding
    // all of it would make every known file look new and re-download the
    // whole catalog on every run. Every other incremental connector of this
    // codebase accepts PARTIAL_SUCCESS for the same reason.
    acceptedRunStatuses: ['SUCCESS', 'SUCCESS_NO_RESULTS', 'PARTIAL_SUCCESS'],
  });

  const rawItems = record(stored?.state.items);
  const items: Record<string, CgibsStoredFile> = {};

  if (rawItems) {
    for (const [key, value] of Object.entries(rawItems)) {
      const parsed = storedFile(value);
      if (parsed) items[key] = parsed;
    }
  }

  return { items };
}
