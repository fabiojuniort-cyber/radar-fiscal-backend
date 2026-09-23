import type {
  CollectionConnector,
  ConnectorExecutionContext,
  ConnectorFile,
  ConnectorPartialFailure,
  ConnectorPublication,
  ConnectorResult,
} from './connector.contract.js';
import { ConnectorError } from './connector.error.js';
import {
  NfeEncatClient,
  type NfeEncatClientOptions,
  type NfeEncatDownloadedFile,
} from './nfe-encat.client.js';
import {
  parseNfeEncatListing,
  type NfeEncatFileType,
  type NfeEncatListingItem,
  type NfeEncatPortalFamily,
} from './nfe-encat.parser.js';

export const NFE_ENCAT_CONNECTOR_KEY = 'nfe-encat';
/** Version of the checkpoint payload stored in collection_checkpoints. */
export const NFE_ENCAT_STATE_VERSION = 1;

const DEFAULT_REVISIT_AFTER_MS =
  24 * 60 * 60 * 1_000;
const DEFAULT_MAX_RECHECKS_PER_RUN = 16;

export const NFE_ENCAT_LISTINGS: ReadonlyArray<{
  family: NfeEncatPortalFamily;
  url: string;
}> = [
  {
    family: 'TECHNICAL_NOTES',
    url: 'https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=04BIflQt1aY=',
  },
  {
    family: 'TECHNICAL_REPORTS',
    url: 'https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=hXzemuyNHW4=',
  },
  {
    family: 'SCHEMAS',
    url: 'https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=BMPFMBoln3w=',
  },
  {
    family: 'MANUALS',
    url: 'https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=ndIjl+iEFdE=',
  },
] as const;

export interface NfeEncatStoredFile {
  rawSha256: string;
  sizeBytes: number;
  mimeType: string;
  filename?: string;
  sourceEtag?: string;
  sourceLastModified?: string;
  checkedAt: string;
}

export interface NfeEncatSourceState {
  items: Record<string, NfeEncatStoredFile>;
}

export interface NfeEncatConnectorOptions {
  fetch?: typeof fetch;
  now?: () => Date;
  readState?: (sourceId: string) => Promise<NfeEncatSourceState>;
  client?: Omit<NfeEncatClientOptions, 'fetch'>;
  revisitAfterMs?: number;
  maxRechecksPerRun?: number;
}

function stateKey(item: Pick<NfeEncatListingItem, 'portalFamily' | 'contentToken'>): string {
  return `${item.portalFamily}:${item.contentToken}`;
}

function checkedAtMs(
  stored: NfeEncatStoredFile,
): number {
  const value = Date.parse(stored.checkedAt);
  return Number.isFinite(value) ? value : 0;
}

function selectKnownRechecks(
  discovered: NfeEncatListingItem[],
  state: NfeEncatSourceState,
  now: Date,
  revisitAfterMs: number,
  maxRechecksPerRun: number,
): Set<string> {
  const nowMs = now.getTime();

  const candidates = discovered
    .map((item) => {
      const key = stateKey(item);
      const previous = state.items[key];

      return previous
        ? {
            key,
            checkedAtMs: checkedAtMs(previous),
          }
        : undefined;
    })
    .filter(
      (
        candidate,
      ): candidate is {
        key: string;
        checkedAtMs: number;
      } =>
        candidate !== undefined &&
        nowMs - candidate.checkedAtMs >=
          revisitAfterMs,
    )
    .sort(
      (left, right) =>
        left.checkedAtMs - right.checkedAtMs ||
        left.key.localeCompare(right.key),
    )
    .slice(0, maxRechecksPerRun);

  return new Set(
    candidates.map((candidate) => candidate.key),
  );
}

function connectorFailure(error: unknown): { code: string; message: string } {
  if (error instanceof ConnectorError) return { code: error.code, message: error.message };
  return {
    code: 'NFE_ENCAT_UNHANDLED_ITEM_ERROR',
    message: error instanceof Error ? error.message : 'Unknown NF-e/ENCAT item error',
  };
}

function expectedMimeMatches(expected: NfeEncatFileType, downloaded: NfeEncatDownloadedFile): boolean {
  if (expected === 'UNKNOWN') return true;
  if (expected === 'PDF') return downloaded.mimeType === 'application/pdf';
  if (expected === 'ZIP') return downloaded.mimeType === 'application/zip' || downloaded.mimeType === 'application/x-zip-compressed';
  if (expected === 'XML') return downloaded.mimeType === 'application/xml' || downloaded.mimeType === 'text/xml';
  return false;
}

function actTypeFor(item: NfeEncatListingItem): string {
  switch (item.portalFamily) {
    case 'TECHNICAL_NOTES': return 'NOTA TÉCNICA';
    case 'TECHNICAL_REPORTS': return 'INFORME TÉCNICO';
    case 'SCHEMAS': return 'ESQUEMA XML NF-E/NFC-E';
    case 'MANUALS': return 'MANUAL NF-E/NFC-E';
  }
}

function actNumberFor(item: NfeEncatListingItem): string | undefined {
  if (!item.documentNumber) return undefined;
  return item.officialVersion
    ? `${item.documentNumber} v${item.officialVersion}`
    : item.documentNumber;
}

function connectorFile(item: NfeEncatListingItem, stored: NfeEncatStoredFile): ConnectorFile {
  return {
    url: item.officialUrl,
    externalId: item.contentToken,
    rawSha256: stored.rawSha256,
    sizeBytes: stored.sizeBytes,
    mimeType: stored.mimeType,
    ...(stored.filename ? { name: stored.filename } : {}),
    ...(stored.sourceEtag ? { sourceEtag: stored.sourceEtag } : {}),
    ...(stored.sourceLastModified ? { sourceLastModified: stored.sourceLastModified } : {}),
    metadata: {
      portalFamily: item.portalFamily,
      fileType: item.fileType,
      contentToken: item.contentToken,
    },
  };
}

function publicationFor(item: NfeEncatListingItem, stored: NfeEncatStoredFile): ConnectorPublication {
  return {
    title: item.title,
    agency: 'ENCAT',
    sphere: 'FEDERAL',
    actType: actTypeFor(item),
    ...(actNumberFor(item) ? { actNumber: actNumberFor(item)! } : {}),
    ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
    ...(item.description ? { content: item.description } : {}),
    officialUrl: item.officialUrl,
    externalId: item.externalId,
    files: [connectorFile(item, stored)],
    metadata: {
      documentFamily: item.documentFamily,
      ...(item.officialVersion ? { officialVersion: item.officialVersion } : {}),
      documentStatus: item.documentStatus,
      portalFamily: item.portalFamily,
      portalSection: item.portalSection,
      ...(item.environment ? { environment: item.environment } : {}),
      contentToken: item.contentToken,
      listingUrl: item.listingUrl,
      ...(item.description ? { description: item.description } : {}),
      fileType: item.fileType,
    },
  };
}

export class NfeEncatConnector implements CollectionConnector {
  readonly key = NFE_ENCAT_CONNECTOR_KEY;
  readonly version = '0.1.0';
  readonly #options: NfeEncatConnectorOptions;

  constructor(options: NfeEncatConnectorOptions = {}) {
    const revisitAfterMs =
      options.revisitAfterMs ??
      DEFAULT_REVISIT_AFTER_MS;
    const maxRechecksPerRun =
      options.maxRechecksPerRun ??
      DEFAULT_MAX_RECHECKS_PER_RUN;

    if (
      !Number.isSafeInteger(revisitAfterMs) ||
      revisitAfterMs < 0
    ) {
      throw new RangeError(
        'revisitAfterMs must be a non-negative integer',
      );
    }

    if (
      !Number.isSafeInteger(maxRechecksPerRun) ||
      maxRechecksPerRun < 0
    ) {
      throw new RangeError(
        'maxRechecksPerRun must be a non-negative integer',
      );
    }

    this.#options = options;
  }

  async collect(context: ConnectorExecutionContext): Promise<ConnectorResult> {
    const now = this.#options.now?.() ?? new Date();
    const state = await this.#options.readState?.(context.sourceId) ?? { items: {} };
    const revisitAfterMs =
      this.#options.revisitAfterMs ??
      DEFAULT_REVISIT_AFTER_MS;
    const maxRechecksPerRun =
      this.#options.maxRechecksPerRun ??
      DEFAULT_MAX_RECHECKS_PER_RUN;
    const client = new NfeEncatClient({
      ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
      ...(this.#options.client ?? {}),
    });
    const publications: ConnectorPublication[] = [];
    const partialFailures: ConnectorPartialFailure[] = [];
    const listingResults: Array<Record<string, unknown>> = [];
    const discovered: NfeEncatListingItem[] = [];
    let listingsSucceeded = 0;
    let downloadedCount = 0;
    let notModifiedCount = 0;
    let reusedCheckpointCount = 0;
    let recheckedKnownCount = 0;
    let newItemDownloadCount = 0;

    try {
      for (const listing of NFE_ENCAT_LISTINGS) {
        context.signal.throwIfAborted();
        try {
          const response = await client.getListing(listing.url, context.signal);
          const items = parseNfeEncatListing(response.html, listing.family, listing.url);
          listingsSucceeded += 1;
          discovered.push(...items);
          listingResults.push({
            family: listing.family,
            listingUrl: listing.url,
            finalUrl: response.url,
            status: 'SUCCESS',
            itemCount: items.length,
          });
        } catch (error) {
          if (error instanceof ConnectorError && error.kind === 'CANCELLED') throw error;
          const failure = connectorFailure(error);
          partialFailures.push({
            code: failure.code,
            message: failure.message,
            itemReference: listing.url,
          });
          listingResults.push({
            family: listing.family,
            listingUrl: listing.url,
            status: 'FAILED',
            errorCode: failure.code,
          });
        }
      }

      if (listingsSucceeded === 0) {
        throw new ConnectorError('NFE_ENCAT_ALL_LISTINGS_FAILED', {
          code: 'NFE_ENCAT_ALL_LISTINGS_FAILED',
          kind: 'SOURCE_UNAVAILABLE',
          retryable: true,
          metadata: { listingResults },
        });
      }

      const nextItems: Record<string, NfeEncatStoredFile> = {};
      const recheckKeys = selectKnownRechecks(
        discovered,
        state,
        now,
        revisitAfterMs,
        maxRechecksPerRun,
      );

      for (const item of discovered) {
        context.signal.throwIfAborted();
        const key = stateKey(item);
        const previous = state.items[key];

        if (previous && !recheckKeys.has(key)) {
          nextItems[key] = previous;
          reusedCheckpointCount += 1;
          publications.push(
            publicationFor(item, previous),
          );
          continue;
        }

        if (previous) {
          recheckedKnownCount += 1;
        } else {
          newItemDownloadCount += 1;
        }

        try {
          const response = await client.downloadFile(
            item.officialUrl,
            context.signal,
            previous
              ? {
                  ...(previous.sourceEtag ? { etag: previous.sourceEtag } : {}),
                  ...(previous.sourceLastModified ? { lastModified: previous.sourceLastModified } : {}),
                }
              : {},
          );

          let stored: NfeEncatStoredFile;
          if (response.status === 'NOT_MODIFIED') {
            if (!previous) {
              throw new ConnectorError('NFE_ENCAT_304_WITHOUT_CHECKPOINT', {
                code: 'NFE_ENCAT_304_WITHOUT_CHECKPOINT',
                kind: 'PROCESSING_ERROR',
                retryable: false,
              });
            }
            notModifiedCount += 1;
            stored = {
              ...previous,
              checkedAt: now.toISOString(),
              ...(response.sourceEtag ? { sourceEtag: response.sourceEtag } : {}),
              ...(response.sourceLastModified ? { sourceLastModified: response.sourceLastModified } : {}),
            };
          } else {
            if (!expectedMimeMatches(item.fileType, response)) {
              throw new ConnectorError('NFE_ENCAT_FILE_TYPE_MISMATCH', {
                code: 'NFE_ENCAT_FILE_TYPE_MISMATCH',
                kind: 'PROCESSING_ERROR',
                retryable: false,
                metadata: { expected: item.fileType, received: response.mimeType },
              });
            }
            downloadedCount += 1;
            stored = {
              rawSha256: response.rawSha256,
              sizeBytes: response.sizeBytes,
              mimeType: response.mimeType,
              ...(response.filename ? { filename: response.filename } : {}),
              ...(response.sourceEtag ? { sourceEtag: response.sourceEtag } : {}),
              ...(response.sourceLastModified ? { sourceLastModified: response.sourceLastModified } : {}),
              checkedAt: now.toISOString(),
            };
          }
          nextItems[key] = stored;
          publications.push(publicationFor(item, stored));
        } catch (error) {
          if (error instanceof ConnectorError && error.kind === 'CANCELLED') throw error;
          if (previous) nextItems[key] = previous;
          const failure = connectorFailure(error);
          partialFailures.push({
            code: failure.code,
            message: failure.message,
            itemReference: item.contentToken,
          });
        }
      }

      return {
        publications,
        ...(partialFailures.length ? { partialFailures } : {}),
        metadata: {
          nfeEncat: {
            listingsSucceeded,
            listingsTotal: NFE_ENCAT_LISTINGS.length,
            listingResults,
            discoveredItemCount: discovered.length,
            publicationCount: publications.length,
            downloadedCount,
            notModifiedCount,
            reusedCheckpointCount,
            recheckedKnownCount,
            newItemDownloadCount,
            revisitAfterMs,
            maxRechecksPerRun,
            partialFailureCount: partialFailures.length,
            scope: ['NOTAS_TECNICAS', 'INFORMES_TECNICOS', 'SCHEMAS_NFE_NFCE', 'MANUAIS_NFE_NFCE'],
          },
        },
        checkpoint: {
          version: NFE_ENCAT_STATE_VERSION,
          state: { items: nextItems },
        },
      };
    } finally {
      client.close();
    }
  }
}
