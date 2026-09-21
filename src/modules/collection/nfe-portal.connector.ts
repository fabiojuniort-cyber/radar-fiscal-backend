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
  inspectNfePortalFile,
} from './nfe-portal.file.js';
import {
  NfePortalClient,
} from './nfe-portal.client.js';
import {
  parseNfePortalList,
  type NfePortalDocumentFamily,
  type NfePortalEntry,
  type NfePortalListDefinition,
} from './nfe-portal.parser.js';
import type {
  NfePortalKnownOrigin,
  NfePortalSourceState,
} from './nfe-portal-source-state.repository.js';

export const NFE_PORTAL_CONNECTOR_KEY =
  'nfe-portal';

const PORTAL_BASE_URL =
  'https://www.nfe.fazenda.gov.br';

export const NFE_PORTAL_LISTS:
  readonly NfePortalListDefinition[] = [
    {
      family: 'NOTE_TECHNICAL',
      label: 'Notas Técnicas',
      url:
        `${PORTAL_BASE_URL}/portal/listaConteudo.aspx?tipoConteudo=04BIflQt1aY%3D`,
    },
    {
      family: 'TECHNICAL_REPORT',
      label: 'Informes Técnicos',
      url:
        `${PORTAL_BASE_URL}/portal/listaConteudo.aspx?tipoConteudo=hXzemuyNHW4%3D`,
    },
    {
      family: 'XML_SCHEMA',
      label: 'Esquemas XML',
      url:
        `${PORTAL_BASE_URL}/portal/listaConteudo.aspx?tipoConteudo=BMPFMBoln3w%3D`,
    },
    {
      family: 'MANUAL',
      label: 'Manuais',
      url:
        `${PORTAL_BASE_URL}/portal/listaConteudo.aspx?tipoConteudo=ndIjl%2BiEFdE%3D`,
    },
    {
      family: 'MISC_TECHNICAL',
      label: 'Documentos técnicos diversos',
      url:
        `${PORTAL_BASE_URL}/portal/listaConteudo.aspx?tipoConteudo=%2FNJarYc9nus%3D`,
    },
  ] as const;

const DEFAULT_BOOTSTRAP_LOOKBACK_DAYS = 120;
const DEFAULT_BOOTSTRAP_LIMIT_PER_FAMILY = 20;
const DEFAULT_REFRESH_KNOWN_PER_FAMILY = 2;
const MAX_CONTENT_TEXT = 2_000_000;

interface ParsedConfig {
  bootstrapLookbackDays: number;
  bootstrapLimitPerFamily: number;
  refreshKnownPerFamily: number;
}

export interface NfePortalConnectorOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  readSourceState?: (
    sourceId: string,
  ) => Promise<NfePortalSourceState>;
  bootstrapLookbackDays?: number;
  bootstrapLimitPerFamily?: number;
  refreshKnownPerFamily?: number;
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

function positiveInteger(
  value: unknown,
  fallback: number,
  maximum: number,
): number {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= maximum
    ? value
    : fallback;
}

function parseConfig(
  state: NfePortalSourceState,
  options: NfePortalConnectorOptions,
): ParsedConfig {
  const config = asRecord(state.connectorConfig);

  return {
    bootstrapLookbackDays:
      options.bootstrapLookbackDays ??
      positiveInteger(
        config.bootstrapLookbackDays,
        DEFAULT_BOOTSTRAP_LOOKBACK_DAYS,
        730,
      ),
    bootstrapLimitPerFamily:
      options.bootstrapLimitPerFamily ??
      positiveInteger(
        config.bootstrapLimitPerFamily,
        DEFAULT_BOOTSTRAP_LIMIT_PER_FAMILY,
        100,
      ),
    refreshKnownPerFamily:
      options.refreshKnownPerFamily ??
      positiveInteger(
        config.refreshKnownPerFamily,
        DEFAULT_REFRESH_KNOWN_PER_FAMILY,
        20,
      ),
  };
}

function originKey(
  entry: Pick<
    NfePortalEntry,
    'externalId' | 'officialUrl'
  >,
): string {
  return entry.externalId ?? entry.officialUrl;
}

function knownKey(
  origin: NfePortalKnownOrigin,
): string {
  return origin.externalId ?? origin.officialUrl;
}

function publishedTime(
  entry: NfePortalEntry,
): number {
  return entry.publishedAt?.getTime() ?? 0;
}

function selectEntries(
  entries: NfePortalEntry[],
  state: NfePortalSourceState,
  config: ParsedConfig,
  now: Date,
): NfePortalEntry[] {
  const known = new Map(
    state.knownOrigins.map((origin) => [
      knownKey(origin),
      origin,
    ]),
  );

  const cutoff =
    now.getTime() -
    config.bootstrapLookbackDays * 86_400_000;

  const ordered = [...entries].sort(
    (a, b) =>
      publishedTime(b) - publishedTime(a),
  );

  const selected = new Map<
    string,
    NfePortalEntry
  >();

  const familyKnown = state.knownOrigins.filter(
    (origin) =>
      origin.family === entries[0]?.family,
  );

  const unknownWithoutDate: NfePortalEntry[] = [];

  for (const entry of ordered) {
    const existing = known.get(originKey(entry));

    if (!existing) {
      if (
        entry.publishedAt &&
        entry.publishedAt.getTime() >= cutoff
      ) {
        selected.set(originKey(entry), entry);
      } else if (!entry.publishedAt) {
        unknownWithoutDate.push(entry);
      }
      continue;
    }

    if (
      existing.status !== undefined &&
      existing.status !== entry.status
    ) {
      selected.set(originKey(entry), entry);
    }
  }

  if (familyKnown.length === 0) {
    for (
      const entry of unknownWithoutDate.slice(
        0,
        config.bootstrapLimitPerFamily,
      )
    ) {
      selected.set(originKey(entry), entry);
    }
  }

  const knownRecent = ordered
    .filter((entry) =>
      known.has(originKey(entry)),
    )
    .slice(0, config.refreshKnownPerFamily);

  for (const entry of knownRecent) {
    selected.set(originKey(entry), entry);
  }

  const olderKnown = ordered.filter(
    (entry) =>
      known.has(originKey(entry)) &&
      !selected.has(originKey(entry)),
  );

  if (olderKnown.length > 0) {
    const slot =
      Math.floor(now.getTime() / 3_600_000) %
      olderKnown.length;
    const entry = olderKnown[slot];
    if (entry) {
      selected.set(originKey(entry), entry);
    }
  }

  return [...selected.values()].slice(
    0,
    config.bootstrapLimitPerFamily +
      config.refreshKnownPerFamily +
      1,
  );
}

function actTypeFor(
  family: NfePortalDocumentFamily,
): string {
  switch (family) {
    case 'NOTE_TECHNICAL':
      return 'NOTA TÉCNICA';
    case 'TECHNICAL_REPORT':
      return 'INFORME TÉCNICO';
    case 'XML_SCHEMA':
      return 'ESQUEMA XML';
    case 'MANUAL':
      return 'MANUAL TÉCNICO';
    case 'MISC_TECHNICAL':
      return 'DOCUMENTO TÉCNICO';
  }
}

function actNumberFor(
  entry: NfePortalEntry,
): string | undefined {
  if (
    (entry.family === 'NOTE_TECHNICAL' ||
      entry.family === 'TECHNICAL_REPORT') &&
    entry.documentNumber
  ) {
    return entry.version
      ? `${entry.documentNumber} v${entry.version}`
      : entry.documentNumber;
  }

  return undefined;
}

function contentFor(
  entry: NfePortalEntry,
  extractedText: string | undefined,
): string | undefined {
  const description = entry.description?.trim();

  if (extractedText) {
    const combined = description
      ? `${entry.title}\n\n${description}\n\n${extractedText}`
      : `${entry.title}\n\n${extractedText}`;

    return combined.slice(0, MAX_CONTENT_TEXT);
  }

  if (description) {
    return `${entry.title}\n\n${description}`;
  }

  return entry.title;
}

function filenameFromUrl(
  value: string,
): string | undefined {
  try {
    const path = new URL(value).pathname;
    const last = path.split('/').pop();
    return last && /\.[A-Za-z0-9]{2,8}$/.test(last)
      ? last
      : undefined;
  } catch {
    return undefined;
  }
}

function connectorError(
  error: unknown,
  url: string,
): ConnectorError {
  if (error instanceof ConnectorError) {
    return error;
  }

  return new ConnectorError(
    'Portal NF-e item processing failed',
    {
      kind: 'PROCESSING_ERROR',
      code: 'NFE_PORTAL_ITEM_PROCESSING_FAILED',
      retryable: false,
      metadata: { url },
      cause: error,
    },
  );
}

export class NfePortalConnector
implements CollectionConnector {
  readonly key = NFE_PORTAL_CONNECTOR_KEY;
  readonly version = 'nfe-portal-1.0.0';

  readonly #client: NfePortalClient;
  readonly #now: () => Date;
  readonly #readSourceState:
    NfePortalConnectorOptions['readSourceState'];
  readonly #options: NfePortalConnectorOptions;

  constructor(
    options: NfePortalConnectorOptions = {},
  ) {
    this.#options = options;
    this.#client = new NfePortalClient({
      ...(options.fetchImpl
        ? { fetchImpl: options.fetchImpl }
        : {}),
    });
    this.#now = options.now ?? (() => new Date());
    this.#readSourceState =
      options.readSourceState;
  }

  async collect(
    context: ConnectorExecutionContext,
  ): Promise<ConnectorResult> {
    const now = this.#now();
    const state =
      (await this.#readSourceState?.(
        context.sourceId,
      )) ?? {
        connectorConfig: {},
        knownOrigins: [],
      };
    const config = parseConfig(
      state,
      this.#options,
    );

    const publications: ConnectorPublication[] = [];
    const partialFailures: ConnectorPartialFailure[] = [];
    const pageMetrics: Array<Record<string, unknown>> = [];

    let listPagesSucceeded = 0;
    let parsedEntryCount = 0;
    let selectedEntryCount = 0;
    let downloadedCount = 0;
    let pdfTextExtractedCount = 0;
    let zipManifestCount = 0;

    for (const definition of NFE_PORTAL_LISTS) {
      context.signal.throwIfAborted();

      let html: string;

      try {
        const result = await this.#client.fetchHtml(
          definition.url,
          context.signal,
        );
        html = result.html;
        listPagesSucceeded += 1;
      } catch (error) {
        if (context.signal.aborted) throw error;
        const parsed = connectorError(
          error,
          definition.url,
        );
        partialFailures.push({
          code: parsed.code,
          message: parsed.message,
          itemReference: definition.url,
        });
        pageMetrics.push({
          family: definition.family,
          listUrl: definition.url,
          state: 'FAILED',
          errorCode: parsed.code,
        });
        continue;
      }

      const entries = parseNfePortalList(
        html,
        definition,
      );

      if (entries.length === 0) {
        partialFailures.push({
          code: 'NFE_PORTAL_LIST_PARSE_EMPTY',
          message:
            `No ${definition.label} entries were parsed from the official portal page`,
          itemReference: definition.url,
        });
        pageMetrics.push({
          family: definition.family,
          listUrl: definition.url,
          state: 'PARSE_EMPTY',
        });
        continue;
      }

      parsedEntryCount += entries.length;

      const selected = selectEntries(
        entries,
        state,
        config,
        now,
      );
      selectedEntryCount += selected.length;

      pageMetrics.push({
        family: definition.family,
        listUrl: definition.url,
        state: 'PARSED',
        parsedEntries: entries.length,
        selectedEntries: selected.length,
        activeEntries: entries.filter(
          (entry) => entry.status === 'ACTIVE',
        ).length,
        inactiveEntries: entries.filter(
          (entry) => entry.status === 'INACTIVE',
        ).length,
      });

      for (const entry of selected) {
        context.signal.throwIfAborted();

        try {
          const download =
            await this.#client.download(
              entry.officialUrl,
              context.signal,
            );
          downloadedCount += 1;

          const fallbackName =
            filenameFromUrl(download.url);
          const filename =
            download.filename ?? fallbackName;

          const inspection =
            await inspectNfePortalFile(
              download.bytes,
              {
                ...(download.contentType
                  ? {
                      contentType:
                        download.contentType,
                    }
                  : {}),
                ...(filename ? { filename } : {}),
                expectedTitle: entry.title,
              },
            );

          if (
            inspection.kind === 'PDF' &&
            inspection.textExtractionReliable
          ) {
            pdfTextExtractedCount += 1;
          }

          if (
            inspection.kind === 'ZIP' &&
            inspection.zipEntries
          ) {
            zipManifestCount += 1;
          }

          const file: ConnectorFile = {
            url: download.url,
            ...(filename ? { name: filename } : {}),
            ...(download.contentType
              ? { mimeType: download.contentType }
              : {}),
            ...(entry.externalId
              ? {
                  externalId:
                    `${entry.externalId}:file`,
                }
              : {}),
            rawSha256: download.rawSha256,
            sizeBytes: download.bytes.byteLength,
            ...(download.etag
              ? { sourceEtag: download.etag }
              : {}),
            ...(download.lastModified
              ? {
                  sourceLastModified:
                    download.lastModified,
                }
              : {}),
            metadata: {
              fileKind: inspection.kind,
              ...(inspection.zipEntries
                ? {
                    zipEntries:
                      inspection.zipEntries,
                  }
                : {}),
              ...(inspection.kind === 'PDF'
                ? {
                    textExtractionReliable:
                      inspection.textExtractionReliable ??
                      false,
                    textExtractionMethod:
                      'PDF_TEXT_OPERATORS_NO_OCR',
                  }
                : {}),
            },
          };

          publications.push({
            title: entry.title,
            agency: 'ENCAT',
            sphere: 'FEDERAL',
            actType: actTypeFor(entry.family),
            ...(actNumberFor(entry)
              ? {
                  actNumber:
                    actNumberFor(entry)!,
                }
              : {}),
            ...(entry.publishedAt
              ? {
                  publishedAt:
                    entry.publishedAt,
                }
              : {}),
            content: contentFor(
              entry,
              inspection.extractedText,
            ),
            officialUrl: entry.officialUrl,
            ...(entry.externalId
              ? {
                  externalId:
                    entry.externalId,
                }
              : {}),
            files: [file],
            metadata: {
              source: 'PORTAL_NFE',
              sourceRole: 'PRIMARY',
              ingestionChannel:
                'PORTAL_NFE',
              officialUrlGranularity:
                'DOCUMENT',
              documentFamily:
                entry.family,
              documentFamilyKey:
                entry.familyKey,
              ...(entry.documentNumber
                ? {
                    documentNumber:
                      entry.documentNumber,
                  }
                : {}),
              ...(entry.version
                ? {
                    documentVersion:
                      entry.version,
                  }
                : {}),
              portalStatus: entry.status,
              documentScopes:
                entry.documentScopes,
              ...(entry.relatedDocument
                ? {
                    relatedDocument:
                      entry.relatedDocument,
                  }
                : {}),
              sourceListUrl:
                entry.sourceListUrl,
              primaryFile: {
                url: download.url,
                rawSha256:
                  download.rawSha256,
                sizeBytes:
                  download.bytes.byteLength,
                fileKind: inspection.kind,
                ...(filename
                  ? { filename }
                  : {}),
                ...(inspection.zipEntries
                  ? {
                      zipEntries:
                        inspection.zipEntries,
                    }
                  : {}),
              },
            },
          });
        } catch (error) {
          if (context.signal.aborted) throw error;

          const parsed = connectorError(
            error,
            entry.officialUrl,
          );

          partialFailures.push({
            code: parsed.code,
            message: parsed.message,
            itemReference:
              entry.officialUrl,
          });
        }
      }
    }

    if (listPagesSucceeded === 0) {
      const first = partialFailures[0];

      throw new ConnectorError(
        first
          ? `All Portal NF-e list pages failed. First failure: ${first.message}`
          : 'All Portal NF-e list pages failed',
        {
          kind: 'SOURCE_UNAVAILABLE',
          code: 'NFE_PORTAL_ALL_LISTS_FAILED',
          retryable: true,
          metadata: {
            failureCount:
              partialFailures.length,
          },
        },
      );
    }

    if (
      listPagesSucceeded > 0 &&
      parsedEntryCount === 0
    ) {
      throw new ConnectorError(
        'Portal NF-e pages were reachable but no supported documents could be parsed',
        {
          kind: 'PROCESSING_ERROR',
          code: 'NFE_PORTAL_PARSER_FAILED',
          retryable: false,
          metadata: {
            listPagesSucceeded,
            pageMetrics,
          },
        },
      );
    }

    return {
      publications,
      ...(partialFailures.length > 0
        ? { partialFailures }
        : {}),
      metadata: {
        source: 'PORTAL_NFE',
        connectorVersion: this.version,
        listPagesAttempted:
          NFE_PORTAL_LISTS.length,
        listPagesSucceeded,
        parsedEntryCount,
        selectedEntryCount,
        downloadedCount,
        publicationCount:
          publications.length,
        pdfTextExtractedCount,
        zipManifestCount,
        knownOriginCount:
          state.knownOrigins.length,
        incremental: {
          bootstrapLookbackDays:
            config.bootstrapLookbackDays,
          bootstrapLimitPerFamily:
            config.bootstrapLimitPerFamily,
          refreshKnownPerFamily:
            config.refreshKnownPerFamily,
          rotatingKnownRefresh: true,
        },
        pageMetrics,
      },
    };
  }
}
