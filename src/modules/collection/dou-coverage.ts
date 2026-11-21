import { ConnectorError } from './connector.error.js';

export const DOU_COVERAGE_SECTIONS = ['DO1', 'DO1E', 'DO3', 'DO3E'] as const;
export type DouCoverageSection = typeof DOU_COVERAGE_SECTIONS[number];
export type DouChannel = 'INLABS' | 'DOU_OPEN_DATA_ZIP';
type EditionCounts = Record<string, number>;
export type DouEditionInventory = Partial<Record<DouCoverageSection, EditionCounts>>;

interface CoverageRow {
  date: string;
  section: DouCoverageSection;
  status: 'PENDING' | 'CONFIRMED_BY_COUNT' | 'ESCALATED';
  lastAttemptAt: string;
  dueAt: string;
  deadline: string;
  consultation: 'FAILED' | 'OK';
  reason: string;
  editions: Record<string, { observed: number; expected: number | null }>;
}

export interface DouCoverage {
  version: 1;
  rows: Record<string, CoverageRow>;
  lastChannel?: DouChannel;
}

const DAY_MS = 86_400_000;
const MAX_ROWS = 400;
const editionPattern = /^\d{1,5}(?:-[A-Z]{1,3})?$/;
export const isDouEdition = (edition: string): boolean => editionPattern.test(edition);

export function douLocalDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function isoDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value;
}

function deadlineOf(date: string): string {
  const value = new Date(date + 'T12:00:00Z');
  value.setUTCDate(1);
  value.setUTCMonth(value.getUTCMonth() + 1);
  let weekdays = 0;
  for (;;) {
    if (value.getUTCDay() !== 0 && value.getUTCDay() !== 6 && ++weekdays === 5) return value.toISOString().slice(0, 10);
    value.setUTCDate(value.getUTCDate() + 1);
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function safeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 5000;
}

export function readDouCoverage(value: unknown): DouCoverage | undefined {
  const snapshot = record(value);
  const rows = record(snapshot?.rows);
  if (snapshot?.version !== 1 || !rows || Object.keys(rows).length > MAX_ROWS) return undefined;
  const output: DouCoverage = { version: 1, rows: {} };
  if (snapshot.lastChannel === 'INLABS' || snapshot.lastChannel === 'DOU_OPEN_DATA_ZIP') output.lastChannel = snapshot.lastChannel;
  for (const [key, raw] of Object.entries(rows)) {
    const row = record(raw);
    const editions = record(row?.editions);
    if (!row || !isoDate(row.date) || !DOU_COVERAGE_SECTIONS.includes(row.section as DouCoverageSection) ||
        key !== `${row.date}:${row.section}` || row.deadline !== deadlineOf(row.date) ||
        !['PENDING', 'CONFIRMED_BY_COUNT', 'ESCALATED'].includes(String(row.status)) ||
        !['FAILED', 'OK'].includes(String(row.consultation)) ||
        typeof row.reason !== 'string' || !/^[A-Z0-9_]{1,70}$/.test(row.reason) ||
        typeof row.lastAttemptAt !== 'string' || typeof row.dueAt !== 'string' ||
        !Number.isFinite(Date.parse(row.lastAttemptAt)) || !Number.isFinite(Date.parse(row.dueAt)) ||
        !editions || Object.keys(editions).length > 32) return undefined;
    for (const [edition, item] of Object.entries(editions)) {
      const counts = record(item);
      if (!isDouEdition(edition) || !safeCount(counts?.observed) || (counts?.expected !== null && !safeCount(counts?.expected))) return undefined;
    }
    output.rows[key] = row as unknown as CoverageRow;
  }
  return output;
}

export function coverageDates(coverage: DouCoverage, ordinaryDates: readonly string[], now: Date): string[] {
  const recent = ordinaryDates.slice(0, 3);
  const today = douLocalDate(now);
  // Expired rows are selected once even when starved, so their unresolved
  // coverage is escalated and remains visible to operations.
  const due = Object.values(coverage.rows)
    .filter(row => row.status === 'PENDING' && !recent.includes(row.date) &&
      (row.deadline < today || Date.parse(row.dueAt) <= now.getTime()))
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.date.localeCompare(b.date) || a.section.localeCompare(b.section));
  return due[0] ? [...recent, due[0].date] : recent;
}

export function beginDouCoverage(previous: DouCoverage | undefined, now: Date): DouCoverage {
  const oldestFinal = new Date(now.getTime() - 65 * DAY_MS).toISOString().slice(0, 10);
  return {
    version: 1,
    ...(previous?.lastChannel ? { lastChannel: previous.lastChannel } : {}),
    rows: Object.fromEntries(Object.entries(previous?.rows ?? {}).filter(([, row]) =>
      row.date >= oldestFinal || row.status !== 'CONFIRMED_BY_COUNT')),
  };
}

export function markDouCoverage(
  ledger: DouCoverage,
  dates: readonly string[],
  now: Date,
  result: { observed: Record<string, EditionCounts>; expected: Record<string, EditionCounts>; channel: DouChannel } | { error: string },
): DouCoverage {
  const today = douLocalDate(now);
  const rows = { ...ledger.rows };
  for (const date of dates) {
    const deadline = deadlineOf(date);
    for (const section of DOU_COVERAGE_SECTIONS) {
      const key = `${date}:${section}`;
      const old = rows[key];
      const failed = 'error' in result;
      const observed = failed ? {} : result.observed[key] ?? {};
      const expected = failed ? undefined : result.expected[key];
      const editions = failed
        ? old?.editions ?? {}
        : Object.fromEntries([...new Set([...Object.keys(observed), ...Object.keys(expected ?? {}), ...Object.keys(old?.editions ?? {})])]
          .sort().map(edition => [edition, {
            observed: observed[edition] ?? 0,
            expected: expected === undefined ? old?.editions[edition]?.expected ?? null : expected[edition] ?? 0,
          }]));
      const matches = expected !== undefined && Object.values(editions).every(item => item.observed === item.expected);
      const expired = today > deadline;
      rows[key] = {
        date, section, deadline, editions, lastAttemptAt: now.toISOString(),
        dueAt: new Date(now.getTime() + DAY_MS).toISOString(),
        consultation: failed ? 'FAILED' : 'OK',
        status: expired && matches ? 'CONFIRMED_BY_COUNT' : expired ? 'ESCALATED' : 'PENDING',
        reason: failed ? result.error : expected === undefined ? 'REFERENCE_UNAVAILABLE' : !matches ? 'EDITION_COUNT_DIVERGENCE' : expired ? 'COUNTS_MATCHED_AT_CLOSE' : 'EDITORIAL_WINDOW_OPEN',
      };
    }
  }
  if (Object.keys(rows).length > MAX_ROWS || Object.values(rows).some(row => Object.keys(row.editions).length > 32)) {
    throw new ConnectorError('DOU_COVERAGE_LEDGER_LIMIT', { code: 'DOU_COVERAGE_LEDGER_LIMIT', kind: 'PROCESSING_ERROR', retryable: false });
  }
  return { ...ledger, rows, ...(!('error' in result) ? { lastChannel: result.channel } : {}) };
}

function archiveEvidence(value: unknown): Record<string, unknown> | undefined {
  const archive = record(value);
  if (!archive || !isoDate(archive.date) || !DOU_COVERAGE_SECTIONS.includes(archive.section as DouCoverageSection) ||
      typeof archive.filename !== 'string' || typeof archive.officialUrl !== 'string' ||
      typeof archive.rawSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(archive.rawSha256)) return undefined;
  return {
    date: archive.date, section: archive.section, filename: archive.filename,
    officialUrl: archive.officialUrl, rawSha256: archive.rawSha256,
  };
}

/** Preserve the latest archive evidence for each channel on one canonical origin. */
export function mergeDouOriginProvenance(existing: unknown, incoming: Record<string, unknown>): Record<string, unknown> {
  const channel = incoming.ingestionChannel;
  if (channel !== 'INLABS' && channel !== 'DOU_OPEN_DATA_ZIP') return incoming;
  const archive = archiveEvidence(record(incoming.dou)?.archive);
  if (!archive) return incoming;
  const previous = record(existing);
  const previousByChannel = record(previous?.douArchiveByChannel);
  if (channel === 'INLABS' && previous?.ingestionChannel !== 'DOU_OPEN_DATA_ZIP' && !previousByChannel?.DOU_OPEN_DATA_ZIP) return incoming;
  const byChannel: Partial<Record<DouChannel, Record<string, unknown>>> = {};
  for (const previousChannel of ['INLABS', 'DOU_OPEN_DATA_ZIP'] as const) {
    const evidence = archiveEvidence(previousByChannel?.[previousChannel]) ??
      (previous?.ingestionChannel === previousChannel ? archiveEvidence(record(previous.dou)?.archive) : undefined);
    if (evidence) byChannel[previousChannel] = evidence;
  }
  byChannel[channel] = archive;
  return { ...incoming, douArchiveByChannel: byChannel };
}
