import type { Transaction } from 'kysely';

import type {
  DB,
  Json,
} from '../../infrastructure/database/database.types.js';
import type { NormalizedPublication } from './publication.normalizer.js';

export type PublicationDisposition =
  | 'NEW_PUBLICATION'
  | 'EXISTING_PUBLICATION'
  | 'NEW_VERSION';

export interface PersistPublicationInput {
  sourceId: string;
  runId: string;
  attemptId: string;
  publication: NormalizedPublication;
}

export interface PersistPublicationResult {
  publicationId: string;
  publicationVersionId: string;
  disposition: PublicationDisposition;
}

export class PublicationOriginConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicationOriginConflictError';
  }
}

function asJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

function itemStatus(
  disposition: PublicationDisposition,
):
  | 'PROCESSED_NEW'
  | 'PROCESSED_EXISTING'
  | 'NEW_VERSION' {
  switch (disposition) {
    case 'NEW_PUBLICATION':
      return 'PROCESSED_NEW';
    case 'EXISTING_PUBLICATION':
      return 'PROCESSED_EXISTING';
    case 'NEW_VERSION':
      return 'NEW_VERSION';
  }
}

async function upsertCollectionItem(
  trx: Transaction<DB>,
  input: PersistPublicationInput,
): Promise<void> {
  await trx
    .insertInto('collection_items')
    .values({
      collection_run_id: input.runId,
      first_attempt_id: input.attemptId,
      source_item_key: input.publication.sourceItemKey,
      external_id: input.publication.externalId ?? null,
      source_url: input.publication.officialUrl,
      status: 'DISCOVERED',
      raw_metadata: asJson(
        input.publication.metadata,
      ),
    })
    .onConflict((conflict) =>
      conflict
        .columns([
          'collection_run_id',
          'source_item_key',
        ])
        .doUpdateSet({
          external_id:
            input.publication.externalId ?? null,
          source_url:
            input.publication.officialUrl,
          raw_metadata: asJson(
            input.publication.metadata,
          ),
          updated_at: new Date(),
        }),
    )
    .execute();
}

async function getOrCreatePublication(
  trx: Transaction<DB>,
  publication: NormalizedPublication,
): Promise<{
  publicationId: string;
  inserted: boolean;
}> {
  const inserted = await trx
    .insertInto('publications')
    .values({
      identity_hash: publication.identityHash,
      identity_version: 1,
      identity_strength: publication.identityStrength,
      identity_basis: asJson(
        publication.identityBasis,
      ),
      jurisdiction_level:
        publication.jurisdictionLevel,
      uf: publication.uf ?? null,
      agency: publication.agency ?? null,
      act_type: publication.actType ?? null,
      act_number: publication.actNumber ?? null,
      title: publication.title,
      published_on: publication.publishedOn ?? null,
      effective_on: publication.effectiveOn ?? null,
      primary_official_url: publication.officialUrl,
    })
    .onConflict((conflict) =>
      conflict.column('identity_hash').doNothing(),
    )
    .returning('id')
    .executeTakeFirst();

  if (inserted) {
    return {
      publicationId: inserted.id,
      inserted: true,
    };
  }

  const existing = await trx
    .selectFrom('publications')
    .select('id')
    .where(
      'identity_hash',
      '=',
      publication.identityHash,
    )
    .forUpdate()
    .executeTakeFirstOrThrow();

  await trx
    .updateTable('publications')
    .set({
      last_seen_at: new Date(),
      updated_at: new Date(),
    })
    .where('id', '=', existing.id)
    .execute();

  return {
    publicationId: existing.id,
    inserted: false,
  };
}

async function upsertOrigin(
  trx: Transaction<DB>,
  input: PersistPublicationInput,
  publicationId: string,
): Promise<void> {
  const externalOrigin = input.publication.externalId
    ? await trx
        .selectFrom('publication_origins')
        .select(['id', 'publication_id'])
        .where('source_id', '=', input.sourceId)
        .where(
          'external_id',
          '=',
          input.publication.externalId,
        )
        .executeTakeFirst()
    : undefined;

  const urlOrigin = await trx
    .selectFrom('publication_origins')
    .select(['id', 'publication_id'])
    .where('source_id', '=', input.sourceId)
    .where(
      'official_url',
      '=',
      input.publication.officialUrl,
    )
    .executeTakeFirst();

  if (
    externalOrigin &&
    urlOrigin &&
    externalOrigin.id !== urlOrigin.id
  ) {
    throw new PublicationOriginConflictError(
      'External ID and official URL point to different publication origins.',
    );
  }

  const origin = externalOrigin ?? urlOrigin;

  if (
    origin &&
    origin.publication_id !== publicationId
  ) {
    throw new PublicationOriginConflictError(
      'Publication origin is already linked to another publication identity.',
    );
  }

  if (origin) {
    await trx
      .updateTable('publication_origins')
      .set({
        external_id:
          input.publication.externalId ?? null,
        official_url: input.publication.officialUrl,
        last_seen_at: new Date(),
        metadata: asJson(
          input.publication.metadata,
        ),
      })
      .where('id', '=', origin.id)
      .execute();

    return;
  }

  await trx
    .insertInto('publication_origins')
    .values({
      publication_id: publicationId,
      source_id: input.sourceId,
      external_id:
        input.publication.externalId ?? null,
      official_url: input.publication.officialUrl,
      metadata: asJson(
        input.publication.metadata,
      ),
    })
    .execute();
}

async function getOrCreateVersion(
  trx: Transaction<DB>,
  publicationId: string,
  publication: NormalizedPublication,
  publicationInserted: boolean,
): Promise<{
  publicationVersionId: string;
  disposition: PublicationDisposition;
}> {
  const existingVersion = await trx
    .selectFrom('publication_versions')
    .select('id')
    .where('publication_id', '=', publicationId)
    .where(
      'content_hash',
      '=',
      publication.contentHash,
    )
    .executeTakeFirst();

  if (existingVersion) {
    return {
      publicationVersionId: existingVersion.id,
      disposition: 'EXISTING_PUBLICATION',
    };
  }

  const latestVersion = await trx
    .selectFrom('publication_versions')
    .select('version_no')
    .where('publication_id', '=', publicationId)
    .orderBy('version_no', 'desc')
    .executeTakeFirst();

  const nextVersionNo =
    (latestVersion?.version_no ?? 0) + 1;

  await trx
    .updateTable('publication_versions')
    .set({
      is_current: false,
    })
    .where('publication_id', '=', publicationId)
    .where('is_current', '=', true)
    .execute();

  const version = await trx
    .insertInto('publication_versions')
    .values({
      publication_id: publicationId,
      version_no: nextVersionNo,
      content_hash: publication.contentHash,
      content_text: publication.contentText ?? null,
      relevant_excerpt: null,
      source_metadata: asJson(
        publication.metadata,
      ),
      is_current: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  await trx
    .updateTable('publications')
    .set({
      title: publication.title,
      effective_on: publication.effectiveOn ?? null,
      primary_official_url:
        publication.officialUrl,
      last_seen_at: new Date(),
      updated_at: new Date(),
    })
    .where('id', '=', publicationId)
    .execute();

  return {
    publicationVersionId: version.id,
    disposition: publicationInserted
      ? 'NEW_PUBLICATION'
      : 'NEW_VERSION',
  };
}

async function linkRunPublication(
  trx: Transaction<DB>,
  input: PersistPublicationInput,
  result: PersistPublicationResult,
): Promise<void> {
  await trx
    .insertInto('collection_run_publications')
    .values({
      collection_run_id: input.runId,
      publication_id: result.publicationId,
      publication_version_id:
        result.publicationVersionId,
      disposition: result.disposition,
    })
    .onConflict((conflict) =>
      conflict
        .columns([
          'collection_run_id',
          'publication_id',
        ])
        .doNothing(),
    )
    .execute();

  await trx
    .updateTable('collection_items')
    .set({
      publication_id: result.publicationId,
      status: itemStatus(result.disposition),
      error_code: null,
      error_message: null,
      updated_at: new Date(),
    })
    .where(
      'collection_run_id',
      '=',
      input.runId,
    )
    .where(
      'source_item_key',
      '=',
      input.publication.sourceItemKey,
    )
    .where(
      'status',
      'in',
      ['DISCOVERED', 'FAILED'],
    )
    .execute();
}

export async function persistPublication(
  trx: Transaction<DB>,
  input: PersistPublicationInput,
): Promise<PersistPublicationResult> {
  await upsertCollectionItem(trx, input);

  const publication = await getOrCreatePublication(
    trx,
    input.publication,
  );

  await upsertOrigin(
    trx,
    input,
    publication.publicationId,
  );

  const version = await getOrCreateVersion(
    trx,
    publication.publicationId,
    input.publication,
    publication.inserted,
  );

  const result: PersistPublicationResult = {
    publicationId: publication.publicationId,
    publicationVersionId:
      version.publicationVersionId,
    disposition: version.disposition,
  };

  await linkRunPublication(trx, input, result);

  return result;
}


export interface RecordCollectionItemFailureInput {
  runId: string;
  attemptId: string;
  sourceItemKey: string;
  externalId?: string;
  sourceUrl?: string;
  metadata?: Record<string, unknown>;
  errorCode: string;
  errorMessage: string;
}

export async function recordCollectionItemFailure(
  trx: Transaction<DB>,
  input: RecordCollectionItemFailureInput,
): Promise<void> {
  await trx
    .insertInto('collection_items')
    .values({
      collection_run_id: input.runId,
      first_attempt_id: input.attemptId,
      source_item_key: input.sourceItemKey,
      external_id: input.externalId ?? null,
      source_url: input.sourceUrl ?? null,
      status: 'FAILED',
      error_code: input.errorCode,
      error_message: input.errorMessage,
      raw_metadata: asJson(input.metadata ?? {}),
    })
    .onConflict((conflict) =>
      conflict
        .columns([
          'collection_run_id',
          'source_item_key',
        ])
        .doUpdateSet({
          status: 'FAILED',
          error_code: input.errorCode,
          error_message: input.errorMessage,
          raw_metadata: asJson(input.metadata ?? {}),
          updated_at: new Date(),
        }),
    )
    .execute();
}
