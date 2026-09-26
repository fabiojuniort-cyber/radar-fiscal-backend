import { sql, type Transaction } from 'kysely';

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

type PublicationSourceRole =
  | 'PRIMARY'
  | 'ENRICHMENT'
  | 'VALIDATION'
  | 'UNSPECIFIED';

function publicationSourceRole(
  metadata: unknown,
): PublicationSourceRole {
  if (
    metadata === null ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata)
  ) {
    return 'UNSPECIFIED';
  }

  const value = (metadata as Record<string, unknown>)
    .sourceRole;

  return value === 'PRIMARY' ||
    value === 'ENRICHMENT' ||
    value === 'VALIDATION'
    ? value
    : 'UNSPECIFIED';
}

function isPrimaryAuthoritativeVersionPolicy(
  metadata: unknown,
): boolean {
  if (
    metadata === null ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata)
  ) {
    return false;
  }

  return (metadata as Record<string, unknown>)
    .versionPolicy === 'PRIMARY_AUTHORITATIVE';
}

async function enrichCanonicalPublication(
  trx: Transaction<DB>,
  publicationId: string,
  publication: NormalizedPublication,
): Promise<void> {
  if (
    publicationSourceRole(publication.metadata) !==
      'ENRICHMENT' ||
    publication.effectiveOn === undefined
  ) {
    return;
  }

  await trx
    .updateTable('publications')
    .set({
      effective_on: publication.effectiveOn,
      updated_at: new Date(),
    })
    .where('id', '=', publicationId)
    .where('effective_on', 'is', null)
    .execute();
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
        input.publication.originMetadata,
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
            input.publication.originMetadata,
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
  const pageReference =
    input.publication.originMetadata
      .officialUrlGranularity === 'PAGE';
  if (pageReference && !input.publication.externalId) {
    throw new PublicationOriginConflictError('A page reference requires an official external identifier.');
  }
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

  const urlOrigin = pageReference ? undefined : await trx
    .selectFrom('publication_origins')
    .select(['id', 'publication_id'])
    .where('source_id', '=', input.sourceId)
    .where(sql<boolean>`metadata->>'officialUrlGranularity' IS DISTINCT FROM 'PAGE'`)
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
          input.publication.originMetadata,
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
        input.publication.originMetadata,
      ),
    })
    .execute();
}

function metadataRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function legacyMaterialFileHashes(
  metadata: unknown,
): string[] | undefined {
  const row = metadataRecord(metadata);
  const files = row?.files;
  if (files === undefined) {
    return [];
  }
  if (!Array.isArray(files)) {
    return undefined;
  }

  const hashes: string[] = [];
  for (const fileValue of files) {
    const file = metadataRecord(fileValue);
    const fileMetadata = metadataRecord(
      file?.metadata,
    );
    const kind = fileMetadata?.kind;

    if (
      kind === 'AUTHENTICATED_PUBLICATION_PDF'
    ) {
      continue;
    }
    if (kind !== 'ATTACHMENT') {
      return undefined;
    }

    const hash = file?.rawSha256;
    if (
      typeof hash !== 'string' ||
      !/^[a-fA-F0-9]{64}$/.test(hash)
    ) {
      return undefined;
    }
    hashes.push(hash.toLowerCase());
  }

  return hashes.sort();
}

function incomingMaterialFileHashes(
  publication: NormalizedPublication,
): string[] | undefined {
  const hashes: string[] = [];
  for (const file of publication.files) {
    if (file.versionRole === 'PROVENANCE') {
      continue;
    }
    if (
      typeof file.rawSha256 !== 'string' ||
      !/^[a-fA-F0-9]{64}$/.test(
        file.rawSha256,
      )
    ) {
      return undefined;
    }
    hashes.push(file.rawSha256.toLowerCase());
  }
  return hashes.sort();
}

function sameHashes(
  left: string[],
  right: string[],
): boolean {
  return left.length === right.length &&
    left.every(
      (hash, index) => hash === right[index],
    );
}

async function currentLegacyVersionEquivalent(
  trx: Transaction<DB>,
  publicationId: string,
  publication: NormalizedPublication,
  currentVersion: {
    id: string;
    content_hash: string;
    content_text: string | null;
    source_metadata: Json | null;
  },
): Promise<boolean> {
  if (
    publication.contentHashVersion !== 2 ||
    metadataRecord(
      currentVersion.source_metadata,
    )?.contentHashVersion === 2
  ) {
    return false;
  }

  const canonical = await trx
    .selectFrom('publications')
    .select([
      'title',
      'effective_on',
    ])
    .where('id', '=', publicationId)
    .executeTakeFirstOrThrow();

  const currentEffectiveOn =
    canonical.effective_on
      ?.toISOString()
      .slice(0, 10) ?? null;
  const incomingEffectiveOn =
    publication.effectiveOn ?? null;
  const legacyHashes = legacyMaterialFileHashes(
    currentVersion.source_metadata,
  );
  const incomingHashes =
    incomingMaterialFileHashes(publication);

  return (
    canonical.title === publication.title &&
    currentVersion.content_text ===
      (publication.contentText ?? null) &&
    currentEffectiveOn === incomingEffectiveOn &&
    legacyHashes !== undefined &&
    incomingHashes !== undefined &&
    sameHashes(legacyHashes, incomingHashes)
  );
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
  const incomingRole = publicationSourceRole(
    publication.metadata,
  );

  const currentVersion = await trx
    .selectFrom('publication_versions')
    .select([
      'id',
      'content_hash',
      'content_text',
      'source_metadata',
    ])
    .where('publication_id', '=', publicationId)
    .where('is_current', '=', true)
    .executeTakeFirst();

  const existingVersion = await trx
    .selectFrom('publication_versions')
    .select([
      'id',
      'is_current',
      'source_metadata',
    ])
    .where('publication_id', '=', publicationId)
    .where(
      'content_hash',
      '=',
      publication.contentHash,
    )
    .executeTakeFirst();

  const currentRole = currentVersion
    ? publicationSourceRole(
        currentVersion.source_metadata,
      )
    : 'UNSPECIFIED';
  const incomingPrimaryAuthoritative =
    isPrimaryAuthoritativeVersionPolicy(
      publication.metadata,
    );
  const currentPrimaryAuthoritative =
    currentVersion
      ? isPrimaryAuthoritativeVersionPolicy(
          currentVersion.source_metadata,
        )
      : false;

  if (existingVersion) {
    if (incomingRole === 'PRIMARY') {
      if (!existingVersion.is_current) {
        await trx
          .updateTable('publication_versions')
          .set({ is_current: false })
          .where('publication_id', '=', publicationId)
          .where('is_current', '=', true)
          .execute();

        await trx
          .updateTable('publication_versions')
          .set({ is_current: true })
          .where('id', '=', existingVersion.id)
          .execute();
      }

      if (
        publicationSourceRole(
          existingVersion.source_metadata,
        ) !== 'PRIMARY'
      ) {
        await trx
          .updateTable('publication_versions')
          .set({
            source_metadata: asJson(
              publication.metadata,
            ),
          })
          .where('id', '=', existingVersion.id)
          .execute();
      }

      await trx
        .updateTable('publications')
        .set({
          title: publication.title,
          ...(publication.effectiveOn !== undefined
            ? { effective_on: publication.effectiveOn }
            : {}),
          primary_official_url:
            publication.officialUrl,
          last_seen_at: new Date(),
          updated_at: new Date(),
        })
        .where('id', '=', publicationId)
        .execute();
    }

    await enrichCanonicalPublication(
      trx,
      publicationId,
      publication,
    );

    return {
      publicationVersionId: existingVersion.id,
      disposition: 'EXISTING_PUBLICATION',
    };
  }

  if (
    currentVersion &&
    !existingVersion &&
    await currentLegacyVersionEquivalent(
      trx,
      publicationId,
      publication,
      currentVersion,
    )
  ) {
    if (incomingRole === 'PRIMARY') {
      await trx
        .updateTable('publications')
        .set({
          title: publication.title,
          ...(publication.effectiveOn !== undefined
            ? {
                effective_on:
                  publication.effectiveOn,
              }
            : {}),
          primary_official_url:
            publication.officialUrl,
          last_seen_at: new Date(),
          updated_at: new Date(),
        })
        .where('id', '=', publicationId)
        .execute();
    }

    await enrichCanonicalPublication(
      trx,
      publicationId,
      publication,
    );

    return {
      publicationVersionId: currentVersion.id,
      disposition: 'EXISTING_PUBLICATION',
    };
  }

  if (
    currentVersion &&
    currentRole === 'PRIMARY' &&
    incomingRole === 'ENRICHMENT' &&
    incomingPrimaryAuthoritative
  ) {
    await enrichCanonicalPublication(
      trx,
      publicationId,
      publication,
    );

    return {
      publicationVersionId: currentVersion.id,
      disposition: 'EXISTING_PUBLICATION',
    };
  }

  if (
    currentVersion &&
    currentRole === 'ENRICHMENT' &&
    currentPrimaryAuthoritative &&
    incomingRole === 'PRIMARY'
  ) {
    await trx
      .updateTable('publication_versions')
      .set({
        content_hash: publication.contentHash,
        content_text:
          publication.contentText ?? null,
        relevant_excerpt: null,
        source_metadata: asJson(
          publication.metadata,
        ),
        is_current: true,
      })
      .where('id', '=', currentVersion.id)
      .execute();

    await trx
      .updateTable('publications')
      .set({
        title: publication.title,
        ...(publication.effectiveOn !== undefined
          ? { effective_on: publication.effectiveOn }
          : {}),
        primary_official_url:
          publication.officialUrl,
        last_seen_at: new Date(),
        updated_at: new Date(),
      })
      .where('id', '=', publicationId)
      .execute();

    return {
      publicationVersionId: currentVersion.id,
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

  const preserveCurrentPrimary =
    currentVersion !== undefined &&
    publicationSourceRole(
      currentVersion.source_metadata,
    ) === 'PRIMARY' &&
    incomingRole !== 'PRIMARY';

  if (!preserveCurrentPrimary) {
    await trx
      .updateTable('publication_versions')
      .set({
        is_current: false,
      })
      .where('publication_id', '=', publicationId)
      .where('is_current', '=', true)
      .execute();
  }

  const version = await trx
    .insertInto('publication_versions')
    .values({
      publication_id: publicationId,
      version_no: nextVersionNo,
      content_hash: publication.contentHash,
      content_text:
        publication.contentText ?? null,
      relevant_excerpt: null,
      source_metadata: asJson(
        publication.metadata,
      ),
      is_current: !preserveCurrentPrimary,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  if (!preserveCurrentPrimary) {
    await trx
      .updateTable('publications')
      .set({
        title: publication.title,
        ...(publication.effectiveOn !== undefined
          ? { effective_on: publication.effectiveOn }
          : {}),
        primary_official_url:
          publication.officialUrl,
        last_seen_at: new Date(),
        updated_at: new Date(),
      })
      .where('id', '=', publicationId)
      .execute();
  }

  await enrichCanonicalPublication(
    trx,
    publicationId,
    publication,
  );

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
