/**
 * CONFAZ/Tax13: parse only an *effectivity hint* from an official editorial
 * change note. A parsed date is not proof that an entire legal provision is
 * currently in force. The authorizing act must be fetched and independently
 * verified before an attestation can be persisted.
 */
export type ConfazEffectivityHintKind =
  | 'NEW_WORDING'
  | 'PREVIOUS_WORDING'
  | 'REVOKED'
  | 'ORIGINAL_WORDING';

export interface ConfazEffectivityHint {
  kind: ConfazEffectivityHintKind;
  /** Inclusive reference start where explicitly stated. */
  from: string | null;
  /** Inclusive reference end where explicitly stated. */
  through: string | null;
  modifyingAct: string | null;
  evidenceLevel: 'EDITORIAL_HINT_ONLY';
  canAttestCurrent: false;
}

const DATE = '(\\d{1,2}\\.\\d{1,2}\\.\\d{2,4})';
const VALID_FROM = new RegExp('\\befeitos?\\s+a\\s+partir\\s+de\\s+' + DATE, 'i');
const VALID_UNTIL = new RegExp('\\befeitos?\\s+at[eé]\\s+' + DATE, 'i');
const VALID_RANGE = new RegExp('\\befeitos?\\s+de\\s+' + DATE + '\\s+a\\s+' + DATE, 'i');
const ACT = /\b(?:pelo|pela)\s+(Conv\.?\s*(?:ICMS\s*)?\d{1,3}\/\d{2,4})/i;

function normalizeDate(value: string | undefined): string | null {
  if (!value) return null;
  const [dayString, monthString, yearString] = value.split('.');
  const day = Number(dayString);
  const month = Number(monthString);
  const yearNum = Number(yearString);
  if (!dayString || !monthString || !yearString ||
      !Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(yearNum)) return null;
  const year = yearString.length === 2
    ? (yearNum >= 80 ? 1900 + yearNum : 2000 + yearNum)
    : yearNum;
  if (year < 1900 || year > 2099) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day) return null;
  return String(year).padStart(4, '0') + '-' +
    String(month).padStart(2, '0') + '-' +
    String(day).padStart(2, '0');
}

export function parseConfazEffectivityHint(note: string): ConfazEffectivityHint | null {
  const line = note.replace(/\s+/g, ' ').trim();
  if (!line || line.length > 2_000) return null;
  const kind: ConfazEffectivityHintKind | null =
    /^nova reda[çc][ãa]o\b/i.test(line) ? 'NEW_WORDING'
    : /^reda[çc][ãa]o anterior\b/i.test(line) ? 'PREVIOUS_WORDING'
    : /^revogad[oa]\b/i.test(line) ? 'REVOKED'
    : /^reda[çc][ãa]o original\b/i.test(line) ? 'ORIGINAL_WORDING'
    : null;
  if (!kind) return null;
  const from = VALID_FROM.exec(line);
  const until = VALID_UNTIL.exec(line);
  const range = VALID_RANGE.exec(line);
  const start = normalizeDate(from?.[1] ?? range?.[1]);
  const end = normalizeDate(until?.[1] ?? range?.[2]);
  // A malformed or explicitly conflicting time range cannot become trusted.
  if ((from && !start) || (range && (!start || !end)) ||
      (until && !end) || (start && end && start > end)) return null;
  const act = ACT.exec(line);
  return {
    kind,
    from: start,
    through: end,
    modifyingAct: act?.[1]?.replace(/\s+/g, ' ') ?? null,
    evidenceLevel: 'EDITORIAL_HINT_ONLY',
    canAttestCurrent: false,
  };
}
