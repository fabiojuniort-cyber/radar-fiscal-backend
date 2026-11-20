import type { ConnectorExecutionContext, ConnectorPartialFailure, ConnectorPublication, ConnectorResult } from './connector.contract.js';
import { ConnectorError } from './connector.error.js';
import { DouReserveClient, douReservePackageKey } from './dou-reserve.client.js';
import { parseDouMonthlyZipDate } from './dou.parser.js';
import { classifyDouContractExcerpt } from './dou-scope.rules.js';

export type DouReserveReceipts = Record<string, { rawSha256: string; observedSections: string[] }>;

export function isDouReserveEligible(error: unknown): error is ConnectorError {
  if (!(error instanceof ConnectorError)) return false;
  return error.code === 'INLABS_MAINTENANCE' ||
    error.code === 'INLABS_UNAVAILABLE' ||
    error.code === 'INLABS_NETWORK_ERROR' ||
    (error.code === 'INLABS_HTTP_ERROR' && [404, 408, 410].includes(error.httpStatus ?? 0));
}

export async function collectDouReserve(
  client: DouReserveClient,
  dates: readonly string[],
  context: ConnectorExecutionContext,
  emit: (publication: ConnectorPublication) => Promise<void>,
  primaryError: ConnectorError,
  receipts: DouReserveReceipts,
): Promise<ConnectorResult> {
  const { signal } = context;
  const index = await client.index(signal);
  const datesByPackage = new Map<string, { dates: string[]; sections: string[] }>();
  for (const date of dates) {
    for (const section of ['01', '03'] as const) {
      const key = douReservePackageKey(date, section);
      const scope = datesByPackage.get(key) ?? { dates: [], sections: [`DO${section[1]}`, `DO${section[1]}E`] };
      scope.dates.push(date);
      datesByPackage.set(key, scope);
    }
  }
  const partialFailures: ConnectorPartialFailure[] = [];
  const archives: Array<Record<string, unknown>> = [];
  let xmlCount = 0;
  let publicationCount = 0;
  let assembledMatterCount = 0;
  let embeddedActCount = 0;
  let confazMatterCount = 0;
  let usablePackages = 0;
  let observedDateCount = 0;
  const editions = new Set<string>();
  for (const [key, scope] of datesByPackage) {
    const pkg = index.get(key);
    if (!pkg) {
      partialFailures.push({ code: 'DOU_RESERVE_PACKAGE_UNLISTED', message: 'Official monthly ZIP missing or ambiguous', itemReference: key });
      continue;
    }
    await client.withPackage(pkg, signal, async (path, rawSha256, bytes) => {
      context.memory?.('archive_downloaded', { archives: usablePackages + 1, archiveBytes: bytes, publications: publicationCount });
      for (const date of scope.dates) {
        const archive = { ...pkg, date, rawSha256, ingestionChannel: 'DOU_OPEN_DATA_ZIP' as const };
        const receiptKey = `${date}-${scope.sections[0]}`;
        const receipt = receipts[receiptKey];
        if (receipt?.rawSha256 === rawSha256) {
          observedDateCount++;
          archives.push({
            ...archive, state: 'UNCHANGED', observedSections: receipt.observedSections,
            unobservedSections: scope.sections.filter(section => !receipt.observedSections.includes(section)), extrasComplete: false,
          });
          continue;
        }
        const seen = new Set<string>();
        const observedSections = new Set<string>();
        const parsed = await parseDouMonthlyZipDate(path, archive, scope.sections, signal, async publication => {
          const reference = publication.externalId!;
          if (seen.has(reference)) {
            throw new ConnectorError('Repeated official DOU identity in monthly ZIP', { code: 'DOU_RESERVE_DUPLICATE_MATTER', kind: 'PROCESSING_ERROR', retryable: false });
          }
          seen.add(reference);
          const dou = publication.metadata?.dou as { section: string; edition: string; embeddedAct?: boolean };
          observedSections.add(dou.section);
          editions.add(`${date}:${dou.edition}`);
          if (dou.embeddedAct) embeddedActCount++;
          else assembledMatterCount++;
          if (publication.agency === 'CONFAZ') confazMatterCount++;
          const classification = classifyDouContractExcerpt(publication);
          await emit(classification ? {
            ...publication,
            metadata: { ...publication.metadata, douScope: { ...classification, informationalOnly: true } },
          } : publication);
          publicationCount++;
        });
        partialFailures.push(...parsed.partialFailures);
        xmlCount += parsed.xmlCount;
        if (observedSections.size) observedDateCount++;
        if (observedSections.size && !parsed.partialFailures.length) {
          receipts[receiptKey] = { rawSha256, observedSections: [...observedSections] };
        } else {
          delete receipts[receiptKey];
        }
        archives.push({
          ...archive,
          state: parsed.partialFailures.length ? 'PARTIAL' : observedSections.size ? 'OBSERVED' : 'PENDING_REVISIT',
          xmlCount: parsed.xmlCount,
          observedSections: [...observedSections],
          unobservedSections: scope.sections.filter(section => !observedSections.has(section)),
          // A monthly snapshot cannot prove that no other extra will be published.
          extrasComplete: false,
        });
      }
      usablePackages++;
      context.memory?.('archive_parsed', { archives: usablePackages, xmlEntries: xmlCount, publications: publicationCount });
    });
  }
  if (!observedDateCount) {
    throw new ConnectorError('No dated DOU XML in available monthly packages', { code: 'DOU_RESERVE_EDITIONS_UNCONFIRMED', kind: 'SOURCE_UNAVAILABLE', retryable: false });
  }
  return {
    publications: [],
    partialFailures,
    metadata: {
      dou: {
        ingestionChannel: 'DOU_OPEN_DATA_ZIP',
        primaryErrorCode: primaryError.code,
        primaryHttpStatus: primaryError.httpStatus ?? null,
        archives, xmlCount, assembledMatterCount, publicationCount, embeddedActCount, confazMatterCount,
        editions: [...editions],
        coverage: 'DOU_OPEN_DATA_SECTIONS_1_3_OBSERVED_ONLY',
        xmlTimelinessGuaranteed: false,
        supplementsVerified: false,
      },
    },
  };
}
