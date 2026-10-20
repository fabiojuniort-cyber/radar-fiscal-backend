import { NFC_NO_BOUNDARY_BEFORE, NFC_SHADOW_TABLE_SHA256, NFC_SHADOW_UNICODE_VERSION } from './nfc-shadow-table.js';

/**
 * ANAT-UNICODE-01b/B1 (issue #116) — pure NFC shadow and UTF-16 span map. NOT imported by the reader, the
 * extractor, the engine or the adapter: the UNICODE-01a quarantine stays in force until a separately reviewed
 * integration (B2).
 *
 * The text is cut into normalisation segments at NFC boundaries (a code point with ccc = 0 and NFC_QC = Yes has a
 * boundary before it; UAX #15 §9). Each segment is normalised to NFC on its own; the shadow is their concatenation and
 * must equal `original.normalize('NFC')` (checked). Spans are half-open [start, end) in UTF-16 units. A shadow span
 * maps back to the original as the union of the segments it touches; when it starts or ends inside a segment's NFC
 * form the result is widened and reported, never silently clipped. Forced boundaries (text-node limits) must already
 * be NFC boundaries; otherwise the map is unusable for recognition (e.g. Hangul L|V, LV|T, a mark after a limit).
 * Guarantee: a mapped span never splits a surrogate pair or a normalisation segment. Extended grapheme clusters
 * (UAX #29, e.g. emoji ZWJ sequences) are out of scope.
 */
export const NFC_SHADOW_LIMITS = Object.freeze({ maxInputUtf16: 2 * 1024 * 1024, maxForcedBoundaries: 1024 * 1024 });
export { NFC_SHADOW_TABLE_SHA256, NFC_SHADOW_UNICODE_VERSION };

export interface Span { start: number; end: number }
export type NfcShadowDiagnostic =
  | { code: 'forced_boundary_inside_segment'; offset: number; message: string }
  | { code: 'nfc_concatenation_mismatch'; offset: null; message: string };
export interface NfcShadowMap {
  unicodeVersion: typeof NFC_SHADOW_UNICODE_VERSION;
  original: string;
  shadow: string;
  /** True when the original is already NFC with no unsupported forced boundary: the map is the identity. */
  identity: boolean;
  /** False when any diagnostic exists: the shadow must not be used for recognition (quarantine stays). */
  usable: boolean;
  diagnostics: NfcShadowDiagnostic[];
  /** Segment i covers original [origStart[i], origStart[i+1]) and shadow [shadowStart[i], shadowStart[i+1]). */
  origStart: Uint32Array;
  shadowStart: Uint32Array;
}
export type MappedSpan = { span: Span; exact: true }
  | { span: Span; exact: false; widening: { requested: Span; mapped: Span; reason: 'inside_normalization_segment' } };

export class NfcShadowError extends Error {
  constructor(readonly code: 'unsupported_runtime' | 'input_too_large' | 'invalid_boundaries' | 'invalid_span', message: string) {
    super(`${code}: ${message}`); this.name = 'NfcShadowError';
  }
}

/** Fails closed when the runtime's Unicode version differs from the table's (no presumed compatibility). */
export function assertNfcShadowRuntime(runtimeUnicode: string | undefined = process.versions.unicode): void {
  if (runtimeUnicode !== NFC_SHADOW_UNICODE_VERSION) {
    throw new NfcShadowError('unsupported_runtime', `table is Unicode ${NFC_SHADOW_UNICODE_VERSION}, runtime is ${runtimeUnicode ?? 'unknown'}`);
  }
}

const TABLE = NFC_NO_BOUNDARY_BEFORE;
/** Binary search over the flattened inclusive ranges. */
export function hasNfcBoundaryBefore(cp: number): boolean {
  let lo = 0; let hi = TABLE.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1; const a = TABLE[2 * mid]!; const b = TABLE[2 * mid + 1]!;
    if (cp < a) hi = mid - 1; else if (cp > b) lo = mid + 1; else return false;
  }
  return true;
}

const isHigh = (u: number) => u >= 0xd800 && u <= 0xdbff;
const isLow = (u: number) => u >= 0xdc00 && u <= 0xdfff;
/** True when offset `i` lies between the two units of a surrogate pair. */
function splitsPair(text: string, i: number): boolean {
  return i > 0 && i < text.length && isHigh(text.charCodeAt(i - 1)) && isLow(text.charCodeAt(i));
}

/**
 * Builds the shadow and map. `forcedBoundaries` are original UTF-16 offsets (strictly increasing integers in
 * (0, length)) where provenance changes (text nodes); each must be an NFC boundary. Cost: one pass over code points,
 * one normalize() per segment, one normalize() of the whole text for the invariant, two Uint32Arrays of segments + 1.
 */
export function buildNfcShadow(original: string, options: { forcedBoundaries?: readonly number[] } = {}): NfcShadowMap {
  assertNfcShadowRuntime();
  if (typeof original !== 'string') throw new NfcShadowError('invalid_span', 'text must be a string');
  if (original.length > NFC_SHADOW_LIMITS.maxInputUtf16) throw new NfcShadowError('input_too_large', `more than ${NFC_SHADOW_LIMITS.maxInputUtf16} UTF-16 units`);
  const forced = options.forcedBoundaries ?? [];
  if (forced.length > NFC_SHADOW_LIMITS.maxForcedBoundaries) throw new NfcShadowError('input_too_large', 'too many forced boundaries');
  for (let k = 0; k < forced.length; k++) {
    const b = forced[k]!;
    if (!Number.isInteger(b) || b <= 0 || b >= original.length || (k > 0 && b <= forced[k - 1]!)) {
      throw new NfcShadowError('invalid_boundaries', `forced boundary ${String(b)} must be a strictly increasing integer in (0, ${original.length})`);
    }
    if (splitsPair(original, b)) throw new NfcShadowError('invalid_boundaries', `forced boundary ${b} splits a surrogate pair`);
  }
  const diagnostics: NfcShadowDiagnostic[] = [];
  const starts: number[] = [];
  let f = 0;
  for (let i = 0; i < original.length;) {
    const cp = original.codePointAt(i)!;
    const width = cp > 0xffff ? 2 : 1;
    const isForced = f < forced.length && forced[f] === i;
    if (isForced) f++;
    if (i === 0 || hasNfcBoundaryBefore(cp)) starts.push(i);
    else if (isForced) {
      diagnostics.push({ code: 'forced_boundary_inside_segment', offset: i,
        message: `Forced boundary at ${i} is not an NFC boundary (U+${cp.toString(16).toUpperCase().padStart(4, '0')} composes or reorders with the preceding text).` });
      starts.push(i); // keep provenance: never let a segment cross a forced boundary
    }
    i += width;
  }
  const n = starts.length;
  const origStart = new Uint32Array(n + 1); const shadowStart = new Uint32Array(n + 1);
  const parts: string[] = new Array(n);
  let s = 0;
  for (let k = 0; k < n; k++) {
    const a = starts[k]!; const b = k + 1 < n ? starts[k + 1]! : original.length;
    const seg = original.slice(a, b).normalize('NFC');
    origStart[k] = a; shadowStart[k] = s; parts[k] = seg; s += seg.length;
  }
  origStart[n] = original.length; shadowStart[n] = s;
  const shadow = parts.join('');
  if (shadow !== original.normalize('NFC')) {
    diagnostics.push({ code: 'nfc_concatenation_mismatch', offset: null, message: 'Concatenated segment NFC differs from NFC of the whole text.' });
  }
  const usable = diagnostics.length === 0;
  return { unicodeVersion: NFC_SHADOW_UNICODE_VERSION, original, shadow, identity: usable && shadow === original, usable, diagnostics, origStart, shadowStart };
}

function validateSpan(span: Span, text: string, label: string): void {
  if (!span || !Number.isInteger(span.start) || !Number.isInteger(span.end)) throw new NfcShadowError('invalid_span', `${label} span bounds must be integers`);
  if (span.start < 0 || span.end < span.start || span.end > text.length) throw new NfcShadowError('invalid_span', `${label} span [${span.start}, ${span.end}) is negative, inverted or outside 0..${text.length}`);
  if (splitsPair(text, span.start) || splitsPair(text, span.end)) throw new NfcShadowError('invalid_span', `${label} span [${span.start}, ${span.end}) splits a surrogate pair`);
}
/** Index of the segment containing unit `x` of the given side (0 ≤ x < length). */
function segmentAt(starts: Uint32Array, x: number): number {
  let lo = 0; let hi = starts.length - 2;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid]! <= x) lo = mid; else hi = mid - 1; }
  return lo; // segments are never empty on either side (NFC of a non-empty segment is non-empty)
}
/** Exact position of a segment boundary on the other side, or -1 when `x` is not a boundary. */
function boundaryIndex(starts: Uint32Array, x: number): number {
  let lo = 0; let hi = starts.length - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; const v = starts[mid]!; if (v === x) return mid; if (v < x) lo = mid + 1; else hi = mid - 1; }
  return -1;
}

function mapSpan(from: Uint32Array, to: Uint32Array, fromText: string, span: Span, label: string): MappedSpan {
  validateSpan(span, fromText, label);
  if (span.start === span.end) {
    // Empty interval: defined only at a segment boundary (maps to that boundary); inside a segment it is refused.
    const k = boundaryIndex(from, span.start);
    if (k < 0) throw new NfcShadowError('invalid_span', `empty ${label} span at ${span.start} lies inside a normalisation segment`);
    return { span: { start: to[k]!, end: to[k]! }, exact: true };
  }
  const first = segmentAt(from, span.start); const last = segmentAt(from, span.end - 1);
  const mapped = { start: to[first]!, end: to[last + 1]! };
  const exact = from[first] === span.start && from[last + 1] === span.end;
  return exact ? { span: mapped, exact: true }
    : { span: mapped, exact: false, widening: { requested: { ...span }, mapped: { ...mapped }, reason: 'inside_normalization_segment' } };
}

/** Shadow span → original span (union of touched segments). Refuses maps flagged unusable. */
export function shadowToOriginal(map: NfcShadowMap, span: Span): MappedSpan {
  if (!map.usable) throw new NfcShadowError('invalid_span', 'map is unusable (see diagnostics); keep the quarantine');
  return mapSpan(map.shadowStart, map.origStart, map.shadow, span, 'shadow');
}
/** Original span → shadow span (exact when it is a union of whole segments; widened otherwise). */
export function originalToShadow(map: NfcShadowMap, span: Span): MappedSpan {
  if (!map.usable) throw new NfcShadowError('invalid_span', 'map is unusable (see diagnostics); keep the quarantine');
  return mapSpan(map.origStart, map.shadowStart, map.original, span, 'original');
}
