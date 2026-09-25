import { createHash } from 'node:crypto';

import type {
  ConnectorPublication,
  ConnectorSphere,
} from './connector.contract.js';

export type PublicationIdentityStrength =
  | 'STRONG'
  | 'SOURCE_SCOPED';

export interface NormalizedPublicationIdentityBasis {
  version: 1;
  scope: ConnectorSphere;
  uf?: string;
  agency?: string;
  actType?: string;
  actNumber?: string;
  publishedOn?: string;
  sourceId?: string;
  sourceKeyType?: 'CANONICAL_KEY' | 'EXTERNAL_ID' | 'OFFICIAL_URL';
  sourceKey?: string;
}

export interface NormalizedPublicationFile {
  url: string;
  name?: string;
  mimeType?: string;
  externalId?: string;
  rawSha256?: string;
  sizeBytes?: number;
  sourceEtag?: string;
  sourceLastModified?: string;
  metadata?: Record<string, unknown>;
}

export interface NormalizedPublication {
  title: string;
  agency?: string;
  jurisdictionLevel: ConnectorSphere;
  uf?: string;
  actType?: string;
  actNumber?: string;
  publishedOn?: string;
  effectiveOn?: string;
  contentText?: string;
  officialUrl: string;
  externalId?: string;
  sourceItemKey: string;
  /** Metadata persisted with the logical/canonical version. */
  metadata: Record<string, unknown>;
  /** Metadata persisted with the concrete source origin and collection item. */
  originMetadata: Record<string, unknown>;
  /** Canonical/version artifact set. */
  files: NormalizedPublicationFile[];
  identityStrength: PublicationIdentityStrength;
  identityBasis: NormalizedPublicationIdentityBasis;
  identityHash: string;
  contentHash: string;
}

export interface NormalizePublicationInput {
  sourceId: string;
  publication: ConnectorPublication;
}

export class PublicationNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicationNormalizationError';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeRequiredText(
  value: string,
  field: string,
): string {
  const normalized = value.replace(/\s+/g, ' ').trim();

  if (!normalized) {
    throw new PublicationNormalizationError(
      `${field} must not be blank`,
    );
  }

  return normalized;
}

function normalizeOptionalText(
  value: string | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, ' ').trim();

  return normalized || undefined;
}

function normalizeIdentityToken(
  value: string | undefined,
): string | undefined {
  const normalized = normalizeOptionalText(value);

  return normalized?.toLocaleUpperCase('pt-BR');
}

function normalizeDate(
  value: Date | undefined,
  field: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (Number.isNaN(value.getTime())) {
    throw new PublicationNormalizationError(
      `${field} must be a valid Date`,
    );
  }

  return value.toISOString().slice(0, 10);
}

function normalizeFiles(
  files: ConnectorPublication['files'],
): NormalizedPublicationFile[] {
  if (!files) {
    return [];
  }

  return files.map((file) => {
    const url = normalizeRequiredText(
      file.url,
      'file.url',
    );
    const rawSha256 =
      normalizeOptionalText(file.rawSha256);

    if (
      rawSha256 &&
      !/^[a-fA-F0-9]{64}$/.test(rawSha256)
    ) {
      throw new PublicationNormalizationError(
        'file.rawSha256 must contain 64 hexadecimal characters',
      );
    }

    if (
      file.sizeBytes !== undefined &&
      (!Number.isSafeInteger(file.sizeBytes) ||
        file.sizeBytes < 0)
    ) {
      throw new PublicationNormalizationError(
        'file.sizeBytes must be a non-negative safe integer',
      );
    }

    return {
      url,
      ...(normalizeOptionalText(file.name)
        ? { name: normalizeOptionalText(file.name)! }
        : {}),
      ...(normalizeOptionalText(file.mimeType)
        ? {
            mimeType:
              normalizeOptionalText(file.mimeType)!,
          }
        : {}),
      ...(normalizeOptionalText(file.externalId)
        ? {
            externalId:
              normalizeOptionalText(
                file.externalId,
              )!,
          }
        : {}),
      ...(rawSha256
        ? {
            rawSha256:
              rawSha256.toLowerCase(),
          }
        : {}),
      ...(file.sizeBytes !== undefined
        ? { sizeBytes: file.sizeBytes }
        : {}),
      ...(normalizeOptionalText(file.sourceEtag)
        ? {
            sourceEtag:
              normalizeOptionalText(
                file.sourceEtag,
              )!,
          }
        : {}),
      ...(normalizeOptionalText(
        file.sourceLastModified,
      )
        ? {
            sourceLastModified:
              normalizeOptionalText(
                file.sourceLastModified,
              )!,
          }
        : {}),
      ...(file.metadata
        ? { metadata: file.metadata }
        : {}),
    };
  });
}

function buildIdentity(
  input: {
    sourceId: string;
    scope: ConnectorSphere;
    uf?: string;
    agency?: string;
    actType?: string;
    actNumber?: string;
    publishedOn?: string;
    identityKey?: string;
    externalId?: string;
    officialUrl: string;
  },
): {
  strength: PublicationIdentityStrength;
  basis: NormalizedPublicationIdentityBasis;
} {
  if (input.identityKey) {
    return {
      strength: 'SOURCE_SCOPED',
      basis: {
        version: 1,
        scope: input.scope,
        ...(input.uf ? { uf: input.uf } : {}),
        sourceId: input.sourceId,
        sourceKeyType: 'CANONICAL_KEY',
        sourceKey: input.identityKey,
      },
    };
  }

  const strongAgency = normalizeIdentityToken(input.agency);
  const strongActType = normalizeIdentityToken(input.actType);
  const strongActNumber = normalizeIdentityToken(input.actNumber);

  if (
    strongAgency &&
    strongActType &&
    strongActNumber &&
    input.publishedOn
  ) {
    const basis: NormalizedPublicationIdentityBasis = {
      version: 1,
      scope: input.scope,
      ...(input.uf ? { uf: input.uf } : {}),
      agency: strongAgency,
      actType: strongActType,
      actNumber: strongActNumber,
      publishedOn: input.publishedOn,
    };

    return {
      strength: 'STRONG',
      basis,
    };
  }

  const sourceKey = input.externalId ?? input.officialUrl;
  const sourceKeyType =
    input.externalId !== undefined
      ? 'EXTERNAL_ID'
      : 'OFFICIAL_URL';

  return {
    strength: 'SOURCE_SCOPED',
    basis: {
      version: 1,
      scope: input.scope,
      ...(input.uf ? { uf: input.uf } : {}),
      sourceId: input.sourceId,
      sourceKeyType,
      sourceKey,
    },
  };
}

export function normalizePublication(
  input: NormalizePublicationInput,
): NormalizedPublication {
  const sourceId = normalizeRequiredText(
    input.sourceId,
    'sourceId',
  );

  const title = normalizeRequiredText(
    input.publication.title,
    'title',
  );

  const officialUrl = normalizeRequiredText(
    input.publication.officialUrl,
    'officialUrl',
  );

  const agency = normalizeOptionalText(
    input.publication.agency,
  );
  const actType = normalizeOptionalText(
    input.publication.actType,
  );
  const actNumber = normalizeOptionalText(
    input.publication.actNumber,
  );
  const externalId = normalizeOptionalText(
    input.publication.externalId,
  );
  const identityKey = normalizeOptionalText(
    input.publication.identityKey,
  );
  const contentText = normalizeOptionalText(
    input.publication.content,
  );
  const originFiles = normalizeFiles(
    input.publication.files,
  );
  const files = normalizeFiles(
    input.publication.versionFiles ??
      input.publication.files,
  );

  const publishedOn = normalizeDate(
    input.publication.publishedAt,
    'publishedAt',
  );
  const effectiveOn = normalizeDate(
    input.publication.effectiveAt,
    'effectiveAt',
  );

  let uf: string | undefined;

  if (input.publication.sphere === 'STATE') {
    const normalizedUf = normalizeIdentityToken(
      input.publication.stateCode,
    );

    if (!normalizedUf || !/^[A-Z]{2}$/.test(normalizedUf)) {
      throw new PublicationNormalizationError(
        'stateCode is required for STATE publications and must contain two letters',
      );
    }

    uf = normalizedUf;
  } else if (
    normalizeOptionalText(input.publication.stateCode) !== undefined
  ) {
    throw new PublicationNormalizationError(
      'stateCode must be omitted for FEDERAL publications',
    );
  }

  const identity = buildIdentity({
    sourceId,
    scope: input.publication.sphere,
    ...(uf ? { uf } : {}),
    ...(agency ? { agency } : {}),
    ...(actType ? { actType } : {}),
    ...(actNumber ? { actNumber } : {}),
    ...(publishedOn ? { publishedOn } : {}),
    ...(identityKey ? { identityKey } : {}),
    ...(externalId ? { externalId } : {}),
    officialUrl,
  });

  const identityHash = sha256(
    JSON.stringify(identity.basis),
  );

  /*
   * Intentionally excludes source metadata and official URL.
   * Source metadata may contain volatile crawl fields and URLs may
   * differ between mirrors. A version changes when the canonical
   * title/content/effective date changes.
   */
  const contentHash = sha256(
    JSON.stringify({
      version: 1,
      title,
      contentText: contentText ?? null,
      effectiveOn: effectiveOn ?? null,
      rawFileHashes: files
        .map((file) => file.rawSha256)
        .filter(
          (hash): hash is string =>
            hash !== undefined,
        )
        .sort(),
    }),
  );

  return {
    title,
    ...(agency ? { agency } : {}),
    jurisdictionLevel: input.publication.sphere,
    ...(uf ? { uf } : {}),
    ...(actType ? { actType } : {}),
    ...(actNumber ? { actNumber } : {}),
    ...(publishedOn ? { publishedOn } : {}),
    ...(effectiveOn ? { effectiveOn } : {}),
    ...(contentText ? { contentText } : {}),
    officialUrl,
    ...(externalId ? { externalId } : {}),
    sourceItemKey: externalId ?? officialUrl,
    metadata: {
      ...(input.publication.metadata ?? {}),
      ...(files.length > 0
        ? { files }
        : {}),
    },
    originMetadata: {
      ...(input.publication.metadata ?? {}),
      ...(originFiles.length > 0
        ? { files: originFiles }
        : {}),
    },
    files,
    identityStrength: identity.strength,
    identityBasis: identity.basis,
    identityHash,
    contentHash,
  };
}
