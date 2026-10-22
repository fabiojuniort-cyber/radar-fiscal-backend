import { buildNfcShadow, NfcShadowError, originalToShadow, shadowToOriginal, type NfcShadowMap, type Span } from './nfc-shadow.js';

/**
 * ANAT-UNICODE-01b/B2 (issue #116) — NFC recovery decision and exact mapping helpers. The recovery context is issued
 * and registered ONLY by readAnatomyInput (private registry in readers.ts, no exported setter) from the effective
 * canonical text and its sourceMap; callers cannot register a context or map through the exported API. This is not
 * a security boundary against malicious code running in the same process (review B2-R1-01).
 *
 * Policy (COORD decision):
 * - NFC documents never get a context: the current path runs unchanged.
 * - Recovery: canonical text not NFC, every decoded attribute NFC, runtime Unicode 17.0, shadow built with every
 *   sourceMap boundary forced and usable, every text-node span exact. Matching uses the shadow; parts, cells and
 *   entities are published at the original positions and literals. The result stays partial (nfc_shadow_matching).
 * - Anything else stays in the UNICODE-01a document quarantine, with the reason as a diagnostic.
 */
export const NFC_DIAGNOSTICS = Object.freeze({
  nonNfcText: 'non_nfc_text', shadowMatching: 'nfc_shadow_matching', spanWidened: 'nfc_span_widened',
  shadowUnusable: 'nfc_shadow_unusable', runtimeUnsupported: 'unicode_runtime_unsupported',
} as const);
export type QuarantineCode = typeof NFC_DIAGNOSTICS.spanWidened | typeof NFC_DIAGNOSTICS.shadowUnusable | typeof NFC_DIAGNOSTICS.runtimeUnsupported;

export interface ShadowContext { readonly map: NfcShadowMap }
export type RecoveryDecision =
  | { mode: 'recover'; context: ShadowContext }
  | { mode: 'quarantine'; code: QuarantineCode | typeof NFC_DIAGNOSTICS.nonNfcText; detail: string };

/** Raised when a span cannot be shown exact (or the map refuses it); the caller quarantines the whole document. */
export class NfcQuarantineError extends Error {
  constructor(readonly code: QuarantineCode, message: string) { super(`${code}: ${message}`); this.name = 'NfcQuarantineError'; }
}

/** Decides recovery vs quarantine for a non-NFC canonical text; `boundaries` are all sourceMap span limits. */
export function decideRecovery(canonicalText: string, boundaries: readonly number[], decodedAttributeNonNfc: boolean): RecoveryDecision {
  if (decodedAttributeNonNfc) return { mode: 'quarantine', code: NFC_DIAGNOSTICS.nonNfcText, detail: 'a decoded HTML attribute is not in NFC (attributes are never normalised)' };
  const forced = [...new Set(boundaries)].filter((b) => b > 0 && b < canonicalText.length).sort((a, b) => a - b);
  let map: NfcShadowMap;
  try { map = buildNfcShadow(canonicalText, { forcedBoundaries: forced }); } catch (error) {
    if (error instanceof NfcShadowError && error.code === 'unsupported_runtime') return { mode: 'quarantine', code: NFC_DIAGNOSTICS.runtimeUnsupported, detail: error.message };
    return { mode: 'quarantine', code: NFC_DIAGNOSTICS.shadowUnusable, detail: error instanceof Error ? error.message : 'shadow construction failed' };
  }
  if (!map.usable) return { mode: 'quarantine', code: NFC_DIAGNOSTICS.shadowUnusable, detail: map.diagnostics.map((d) => d.message).join(' ') };
  return { mode: 'recover', context: { map } };
}

/** Original → shadow, exact or quarantine. */
export function exactToShadow(context: ShadowContext, span: Span, what: string): Span {
  const mapped = mapOrQuarantine(() => originalToShadow(context.map, span), what);
  if (!mapped.exact) throw new NfcQuarantineError(NFC_DIAGNOSTICS.spanWidened, `${what} [${span.start}, ${span.end}) is not exact in the NFC shadow`);
  return mapped.span;
}
/** Shadow → original, exact or quarantine. */
export function exactToOriginal(context: ShadowContext, span: Span, what: string): Span {
  const mapped = mapOrQuarantine(() => shadowToOriginal(context.map, span), what);
  if (!mapped.exact) throw new NfcQuarantineError(NFC_DIAGNOSTICS.spanWidened, `${what} shadow [${span.start}, ${span.end}) widens to original [${mapped.span.start}, ${mapped.span.end})`);
  return mapped.span;
}
function mapOrQuarantine<T>(fn: () => T, what: string): T {
  try { return fn(); } catch (error) {
    throw new NfcQuarantineError(NFC_DIAGNOSTICS.shadowUnusable, `${what}: ${error instanceof Error ? error.message : 'mapping failed'}`);
  }
}
