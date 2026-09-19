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
  sourceKeyType?: 'EXTERNAL_ID' | 'OFFICIAL_URL';
  sourceKey?: string;
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
  metadata: Record<string, unknown>;
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

function buildIdentity(
  input: {
    sourceId: string;
    scope: ConnectorSphere;
    uf?: string;
    agency?: string;
    actType?: string;
    actNumber?: string;
    publishedOn?: string;
    externalId?: string;
    officialUrl: string;
  },
): {
  strength: PublicationIdentityStrength;
  basis: NormalizedPublicationIdentityBasis;
} {
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
  const contentText = normalizeOptionalText(
    input.publication.content,
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
    metadata: input.publication.metadata ?? {},
    identityStrength: identity.strength,
    identityBasis: identity.basis,
    identityHash,
    contentHash,
  };
}
