import { Buffer } from 'node:buffer';

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

interface ArtifactReconciliationEvidence {
  originId: string;
  priorMetadata: Record<string, unknown>;
  equivalentExternalId: string;
  alreadyReconciled: boolean;
}

interface ArtifactReconciliationHistoryEntry {
  kind: 'ORIGIN_ARTIFACT_RECOVERY';
  previousOriginMetadata: Record<string, unknown>;
}

const ARTIFACT_RECONCILIATION_HISTORY_MAX_ENTRIES = 8;
const ARTIFACT_RECONCILIATION_HISTORY_MAX_BYTES = 4_096;
const ARTIFACT_RECONCILIATION_HISTORY_MAX_TEXT = 256;

function metadataRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedAuditText(
  value: unknown,
): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized
    ? normalized.slice(
        0,
        ARTIFACT_RECONCILIATION_HISTORY_MAX_TEXT,
      )
    : undefined;
}

function sanitizeHistoricalOriginMetadata(
  metadata: unknown,
): Record<string, unknown> {
  const row = metadataRecord(metadata);
  if (!row) return {};

  const sanitized: Record<string, unknown> = {};
  const sourceRole = publicationSourceRole(row);
  if (sourceRole !== 'UNSPECIFIED') {
    sanitized.sourceRole = sourceRole;
  }

  if (
    row.authenticatedPdf === 'CAPTURED' ||
    row.authenticatedPdf === 'NO_AUTH_CODE' ||
    row.authenticatedPdf ===
      'NOT_RENDERED_BY_SOURCE' ||
    row.authenticatedPdf ===
      'AUTH_PDF_404_EQUIVALENT_REPRESENTATION'
  ) {
    sanitized.authenticatedPdf =
      row.authenticatedPdf;
  }

  const equivalence = metadataRecord(
    row.artifactEquivalence,
  );
  const equivalenceExternalId =
    boundedAuditText(
      equivalence?.equivalentExternalId,
    );
  if (
    equivalence?.kind ===
      'PROVEN_EQUIVALENT_REPRESENTATION' &&
    equivalenceExternalId
  ) {
    sanitized.artifactEquivalence = {
      kind:
        'PROVEN_EQUIVALENT_REPRESENTATION',
      equivalentExternalId:
        equivalenceExternalId,
    };
  }

  const representation = metadataRecord(
    row.equivalentRepresentation,
  );
  if (representation) {
    const safeRepresentation:
      Record<string, unknown> = {};
    const externalId = boundedAuditText(
      representation.externalId,
    );
    if (externalId) {
      safeRepresentation.externalId =
        externalId;
    }

    if (
      typeof representation.textSha256 ===
        'string' &&
      /^[a-fA-F0-9]{64}$/.test(
        representation.textSha256,
      )
    ) {
      safeRepresentation.textSha256 =
        representation.textSha256
          .toLowerCase();
    }

    const authenticatedPdf = metadataRecord(
      representation.authenticatedPdf,
    );
    const ownerExternalId =
      boundedAuditText(
        authenticatedPdf?.ownerExternalId,
      );
    if (ownerExternalId) {
      safeRepresentation.authenticatedPdf = {
        ownerExternalId,
      };
    }

    if (
      Object.keys(safeRepresentation)
        .length > 0
    ) {
      sanitized.equivalentRepresentation =
        safeRepresentation;
    }
  }

  const pdfError = metadataRecord(
    row.authenticatedPdfError,
  );
  if (
    pdfError?.code === 'DOE_SP_HTTP_ERROR' &&
    Number.isInteger(pdfError.httpStatus) &&
    (pdfError.httpStatus as number) >= 100 &&
    (pdfError.httpStatus as number) <= 599
  ) {
    sanitized.authenticatedPdfError = {
      code: 'DOE_SP_HTTP_ERROR',
      httpStatus: pdfError.httpStatus,
    };
  }

  return sanitized;
}

function sanitizeHistoryEntry(
  value: unknown,
): ArtifactReconciliationHistoryEntry | undefined {
  const row = metadataRecord(value);
  if (
    row?.kind !== 'ORIGIN_ARTIFACT_RECOVERY'
  ) {
    return undefined;
  }

  const previousOriginMetadata =
    sanitizeHistoricalOriginMetadata(
      row.previousOriginMetadata,
    );
  if (
    Object.keys(previousOriginMetadata)
      .length === 0
  ) {
    return undefined;
  }

  return {
    kind: 'ORIGIN_ARTIFACT_RECOVERY',
    previousOriginMetadata,
  };
}

function boundArtifactReconciliationHistory(
  entries: ArtifactReconciliationHistoryEntry[],
): ArtifactReconciliationHistoryEntry[] {
  let bounded = entries.slice(
    -ARTIFACT_RECONCILIATION_HISTORY_MAX_ENTRIES,
  );

  while (
    bounded.length > 0 &&
    Buffer.byteLength(
      JSON.stringify(bounded),
      'utf8',
    ) >
      ARTIFACT_RECONCILIATION_HISTORY_MAX_BYTES
  ) {
    bounded = bounded.slice(1);
  }

  return bounded;
}

function sanitizeArtifactReconciliationHistory(
  value: unknown,
): ArtifactReconciliationHistoryEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return boundArtifactReconciliationHistory(
    value
      .map(sanitizeHistoryEntry)
      .filter(
        (
          entry,
        ): entry is ArtifactReconciliationHistoryEntry =>
          entry !== undefined,
      ),
  );
}

function withoutIncomingReconciliationHistory(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const safe = { ...metadata };
  delete safe.artifactReconciliationHistory;
  return safe;
}

function preserveExistingReconciliationHistory(
  incoming: Record<string, unknown>,
  persistedMetadata: unknown,
): Record<string, unknown> {
  const persisted = metadataRecord(
    persistedMetadata,
  );
  const history =
    sanitizeArtifactReconciliationHistory(
      persisted?.artifactReconciliationHistory,
    );

  return history.length > 0
    ? {
        ...incoming,
        artifactReconciliationHistory:
          history,
      }
    : incoming;
}

function reconciliationEvidence(
  metadata: unknown,
): Omit<
  ArtifactReconciliationEvidence,
  'originId' | 'priorMetadata'
> | undefined {
  const row = metadataRecord(metadata);
  if (!row) return undefined;

  const equivalence = metadataRecord(
    row.artifactEquivalence,
  );
  if (
    equivalence?.kind ===
      'PROVEN_EQUIVALENT_REPRESENTATION' &&
    typeof equivalence.equivalentExternalId ===
      'string' &&
    equivalence.equivalentExternalId
  ) {
    return {
      equivalentExternalId:
        equivalence.equivalentExternalId,
      alreadyReconciled: false,
    };
  }

  const reconciliation = metadataRecord(
    row.artifactReconciliation,
  );
  if (
    reconciliation?.kind ===
      'ORIGIN_ARTIFACT_RECOVERY' &&
    reconciliation.state === 'RECONCILED' &&
    typeof reconciliation.equivalentExternalId ===
      'string' &&
    reconciliation.equivalentExternalId
  ) {
    return {
      equivalentExternalId:
        reconciliation.equivalentExternalId,
      alreadyReconciled: true,
    };
  }

  return undefined;
}

async function loadArtifactReconciliationEvidence(
  trx: Transaction<DB>,
  input: PersistPublicationInput,
  publicationId: string,
): Promise<
  ArtifactReconciliationEvidence | undefined
> {
  if (
    input.publication.artifactReconciliation?.kind !==
      'RECOVER_ORIGIN_ARTIFACT' ||
    input.publication.identityStrength !== 'STRONG' ||
    !input.publication.externalId
  ) {
    return undefined;
  }

  const origin = await trx
    .selectFrom('publication_origins')
    .select(['id', 'publication_id', 'metadata'])
    .where('source_id', '=', input.sourceId)
    .where(
      'external_id',
      '=',
      input.publication.externalId,
    )
    .executeTakeFirst();

  if (
    !origin ||
    origin.publication_id !== publicationId
  ) {
    return undefined;
  }

  const evidence = reconciliationEvidence(
    origin.metadata,
  );
  if (!evidence) return undefined;

  return {
    originId: origin.id,
    priorMetadata:
      metadataRecord(origin.metadata) ?? {},
    ...evidence,
  };
}

function dateOnly(
  value: unknown,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === 'string') {
    return value.slice(0, 10);
  }

  return null;
}

async function canReuseCurrentVersionForArtifactReconciliation(
  trx: Transaction<DB>,
  publicationId: string,
  publication: NormalizedPublication,
  currentVersion:
    | {
        id: string;
        content_text: string | null;
      }
    | undefined,
  evidence:
    ArtifactReconciliationEvidence | undefined,
): Promise<boolean> {
  if (
    !evidence ||
    !currentVersion ||
    publication.identityStrength !== 'STRONG'
  ) {
    return false;
  }

  const canonical = await trx
    .selectFrom('publications')
    .select([
      'identity_hash',
      'identity_strength',
      'title',
      'effective_on',
    ])
    .where('id', '=', publicationId)
    .executeTakeFirst();

  if (
    !canonical ||
    canonical.identity_strength !== 'STRONG' ||
    canonical.identity_hash !==
      publication.identityHash
  ) {
    return false;
  }

  return canonical.title === publication.title &&
    (currentVersion.content_text ?? null) ===
      (publication.contentText ?? null) &&
    dateOnly(canonical.effective_on) ===
      (publication.effectiveOn ?? null);
}

function reconciliationHistory(
  evidence: ArtifactReconciliationEvidence,
): ArtifactReconciliationHistoryEntry[] {
  const existing =
    sanitizeArtifactReconciliationHistory(
      evidence.priorMetadata
        .artifactReconciliationHistory,
    );

  if (evidence.alreadyReconciled) {
    return existing;
  }

  const snapshot =
    sanitizeHistoricalOriginMetadata(
      evidence.priorMetadata,
    );
  if (Object.keys(snapshot).length === 0) {
    return existing;
  }

  const next: ArtifactReconciliationHistoryEntry = {
    kind: 'ORIGIN_ARTIFACT_RECOVERY',
    previousOriginMetadata: snapshot,
  };
  const serializedNext = JSON.stringify(next);
  const withoutDuplicate = existing.filter(
    (entry) =>
      JSON.stringify(entry) !== serializedNext,
  );

  return boundArtifactReconciliationHistory([
    ...withoutDuplicate,
    next,
  ]);
}

function reconciledOriginMetadata(
  incoming: Record<string, unknown>,
  evidence: ArtifactReconciliationEvidence,
  versionReused: boolean,
): Record<string, unknown> {
  const history = reconciliationHistory(
    evidence,
  );

  return {
    ...incoming,
    artifactReconciliation: {
      kind: 'ORIGIN_ARTIFACT_RECOVERY',
      state: versionReused
        ? 'RECONCILED'
        : 'RECOVERED_WITH_VERSION_CHANGE',
      equivalentExternalId:
        evidence.equivalentExternalId,
    },
    ...(history.length
      ? {
          artifactReconciliationHistory:
            history,
        }
      : {}),
  };
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
  reconciliation:
    | {
        evidence: ArtifactReconciliationEvidence;
        versionReused: boolean;
      }
    | undefined,
): Promise<void> {
  const incomingOriginMetadata =
    withoutIncomingReconciliationHistory(
      input.publication.originMetadata,
    );
  let originMetadata = reconciliation
    ? reconciledOriginMetadata(
        incomingOriginMetadata,
        reconciliation.evidence,
        reconciliation.versionReused,
      )
    : incomingOriginMetadata;
  const pageReference = originMetadata.officialUrlGranularity === 'PAGE';
  if (pageReference && !input.publication.externalId) {
    throw new PublicationOriginConflictError('A page reference requires an official external identifier.');
  }
  const externalOrigin = input.publication.externalId
    ? await trx
        .selectFrom('publication_origins')
        .select(['id', 'publication_id', 'metadata'])
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
    .select(['id', 'publication_id', 'metadata'])
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

  if (origin && !reconciliation) {
    originMetadata =
      preserveExistingReconciliationHistory(
        incomingOriginMetadata,
        origin.metadata,
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
          originMetadata,
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
        originMetadata,
      ),
    })
    .execute();
}

async function getOrCreateVersion(
  trx: Transaction<DB>,
  publicationId: string,
  publication: NormalizedPublication,
  publicationInserted: boolean,
  reconciliationEvidence:
    ArtifactReconciliationEvidence | undefined,
): Promise<{
  publicationVersionId: string;
  disposition: PublicationDisposition;
  artifactReconciliationApplied: boolean;
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

  const artifactReconciliationApplied =
    await canReuseCurrentVersionForArtifactReconciliation(
      trx,
      publicationId,
      publication,
      currentVersion
        ? {
            id: currentVersion.id,
            content_text:
              currentVersion.content_text,
          }
        : undefined,
      reconciliationEvidence,
    );

  if (
    artifactReconciliationApplied &&
    currentVersion
  ) {
    return {
      publicationVersionId:
        currentVersion.id,
      disposition: 'EXISTING_PUBLICATION',
      artifactReconciliationApplied: true,
    };
  }

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
      artifactReconciliationApplied: false,
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
      artifactReconciliationApplied: false,
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
      artifactReconciliationApplied: false,
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
    artifactReconciliationApplied: false,
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

  const reconciliationEvidence =
    await loadArtifactReconciliationEvidence(
      trx,
      input,
      publication.publicationId,
    );

  const version = await getOrCreateVersion(
    trx,
    publication.publicationId,
    input.publication,
    publication.inserted,
    reconciliationEvidence,
  );

  await upsertOrigin(
    trx,
    input,
    publication.publicationId,
    reconciliationEvidence
      ? {
          evidence:
            reconciliationEvidence,
          versionReused:
            version.artifactReconciliationApplied,
        }
      : undefined,
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
