import { createHash } from 'node:crypto';
import { Parser } from 'htmlparser2';

import { sanitizeLegalPresentationHtml } from '../../collection/legal-presentation.js';

/**
 * TAX13/B4: content-addressed evidence, NOT an automatic vigência oracle.
 * Only the server's registered source adapter / reviewer may attest these
 * records. Raw HTML data-legal-status and remote metadata are never trusted.
 */
export type LegalValidityStatus =
  | 'CURRENT'
  | 'PREVIOUS'
  | 'REVOKED'
  | 'EDITORIAL'
  | 'UNVERIFIED';

export type LegalEvidenceMethod =
  | 'OFFICIAL_CONSOLIDATION'
  | 'OFFICIAL_AMENDMENT'
  | 'ORIGINAL_PUBLICATION'
  | 'HUMAN_REVIEW';

export interface LegalEvidenceSegment {
  start: number;
  end: number;
  /** SHA256 of the exact decoded-text slice at [start,end). */
  textSha256: string;
  status: LegalValidityStatus;
  method: LegalEvidenceMethod;
  evidenceUrls: string[];
  /** Optional act identifiers, only for audit/context. */
  supportingActs?: string[];
}

export interface LegalScopeEvidenceV1 {
  version: 1;
  publicationVersionId: string;
  sourceId: string;
  officialUrl: string;
  /** SHA256 of the persisted sanitized HTML, not its source page wrapper. */
  htmlSha256: string;
  validAsOf: string;
  verifiedAt: string;
  /** The evidence becomes stale on or after this date. */
  recheckOn: string;
  coverage: 'COMPLETE' | 'PARTIAL' | 'UNVERIFIED';
  segments: LegalEvidenceSegment[];
}

export interface LegalScopeValidationContext {
  publicationVersionId: string;
  sourceId: string;
  officialUrl: string;
  sanitizedHtml: string;
  validAsOf: string;
  /**
   * Must come from internal source-registry authorization and audited review,
   * never from the original web page, parser, or caller-supplied JSON.
   */
  trustedAttestor: boolean;
  trustedEvidenceHosts: readonly string[];
}

export interface LegalScopeValidation {
  valid: boolean;
  reason: string | null;
  coverage: LegalScopeEvidenceV1['coverage'] | 'UNVERIFIED';
  currentText: string;
  /** Distinct attested CURRENT intervals. A lexical term may not span two intervals. */
  currentFragments: string[];
  currentSegments: number;
}

/** Legal reference date in Brazil, not the worker host's UTC date. */
export function brazilLegalReferenceDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo', year: 'numeric',
    month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const field = (key: string) => parts.find((part) => part.type === key)?.value;
  const yyyy = field('year');
  const mm = field('month');
  const dd = field('day');
  if (!yyyy || !mm || !dd) throw new Error('BRAZIL_REFERENCE_DATE_UNAVAILABLE');
  return yyyy + '-' + mm + '-' + dd;
}

const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

const DIGEST = /^[a-f0-9]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(text: string): boolean {
  if (!DATE.test(text)) return false;
  const date = new Date(text + 'T00:00:00.000Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function checkedHttps(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || !url.hostname) return null;
    return url;
  } catch {
    return null;
  }
}

interface LegalTextSpan {
  start: number;
  end: number;
  /** Classification of the source DOM context, never trusted as proof of CURRENT. */
  excluded: boolean;
}

const NON_NORMATIVE_CLASSES = new Set([
  'TituloAcordo', 'AcordoTipo', 'Ementa', 'DataPublicao',
  'A2DataPublicacao', 'Remisso', 'A8-1Remissao', 'Subtitulo',
  'A6-1Subtitulo', 'RedaoAnt', 'A8-3RedacaoAnt',
  'RemissoAnt', 'A8-2RemissaoAnt',
]);
const HISTORICAL_TABLE_CLASS = /^(?:A\d+-\d+)?Tabela[A-Za-z]*verde$/;
const ANNEX_HEADING = /^anexo\s+(?:único|unico|[ivxlcdm]+|\d+)(?=\s*$|\s*[-–—:.(])/iu;
const HISTORICAL_ANNEX = /\b(?:revogad[oa]s?|redação\s+(?:anterior|original)|texto\s+anterior|substitu[íi]d[oa]s?|sem\s+(?:efeito|vigência))\b/iu;
const ACT_IDENTIFIER = /^(?:convênio(?:\s+icms)?|ajuste\s+sinief|ato\s+cotepe(?:\/icms)?|protocolo\s+icms|lei(?:\s+complementar)?|decreto|portaria|resolução)\s+(?:n[ºo°.]?\s*)?\d+(?:[./-]\d+)*(?:\s*,?\s+de\s+\d{1,2}\s+de\s+[\p{L}]+\s+de\s+\d{4})?\.?$/iu;
const EDITORIAL_REFERENCE = /^(?:publicad[oa]s?\s+(?:no|na|em)|ratificad[oa]s?\s+(?:no|na|pel[oa]s?)|alterad[oa]s?\s+(?:pel[oa]s?|por)|prorrogad[oa]s?\s+at[eé]|vide\s+(?:o|a|os|as|cl[áa]usula|art)|redação\s+anterior\b|texto\s+anterior\b|nova\s+redação\s+dada\s+pel[oa])/iu;
const REVOKED_PLACEHOLDER = /^(?:(?:cl[áa]usula|art(?:igo)?\.?|par[áa]grafo|inciso|al[íi]nea|item)\s+[\p{L}\p{N}º°ª.-]+|§\s*\d+[º°ª]?|[ivxlcdm]+|[a-z]|\d+[º°ª]?)\s*(?:[-–—:]\s*)?revogad[oa]s?\.?$/iu;

function standaloneNonNormative(value: string): boolean {
  const line = value.replace(/\s+/g, ' ').trim();
  return ANNEX_HEADING.test(line) || ACT_IDENTIFIER.test(line) ||
    EDITORIAL_REFERENCE.test(line) || REVOKED_PLACEHOLDER.test(line);
}

function excludedTag(name: string, attrs: Record<string, string>): boolean {
  const status = attrs['data-legal-status'];
  if (status !== undefined && status !== 'current') return true;
  if (/^h[1-6]$/.test(name) || name === 'title' || name === 'script' ||
      name === 'style' || name === 'noscript') return true;
  return (attrs.class ?? '').split(/\s+/).some((token) =>
    NON_NORMATIVE_CLASSES.has(token) || HISTORICAL_TABLE_CLASS.test(token));
}

/**
 * Store the original DOM text callback boundaries. Adjacent table cells,
 * paragraphs or unrelated HTML nodes must never be promoted to one CURRENT
 * legal passage only because the plain-text extractor concatenates them.
 *
 * The parser may split a text node at an entity boundary; treating those
 * callbacks as independent is intentionally conservative (fail-closed).
 */
function parsedLegalText(html: string): { text: string; spans: LegalTextSpan[] } {
  let text = '';
  const spans: LegalTextSpan[] = [];
  // Capture DOM ancestry in the *same* parser that defines UTF-16 offsets.
  // Never infer CURRENT from these classes: they are exclusion-only signals.
  const stack: Array<{ name: string; excluded: boolean }> = [];
  let historicalAnnex = false;
  const parser = new Parser({
    onopentag(name, attrs) {
      stack.push({
        name,
        excluded: (stack.at(-1)?.excluded ?? false) || excludedTag(name, attrs),
      });
    },
    onclosetag(name) {
      const index = stack.findLastIndex((item) => item.name === name);
      if (index >= 0) stack.length = index;
    },
    ontext(value) {
      if (!value) return;
      const line = value.replace(/\s+/g, ' ').trim();
      const annexHeading = ANNEX_HEADING.test(line);
      if (annexHeading) historicalAnnex = HISTORICAL_ANNEX.test(line);
      const start = text.length;
      text += value;
      spans.push({
        start,
        end: text.length,
        excluded: (stack.at(-1)?.excluded ?? false) ||
          historicalAnnex || standaloneNonNormative(value),
      });
    },
  }, { decodeEntities: true, lowerCaseTags: true });
  parser.end(html);
  return { text, spans };
}

/** Text-node order matches the sanitized legal body; offsets count JS UTF-16 units. */
export function renderedLegalText(html: string): string {
  return parsedLegalText(html).text;
}

const fail = (reason: string): LegalScopeValidation => ({
  valid: false, reason, coverage: 'UNVERIFIED', currentText: '', currentFragments: [], currentSegments: 0,
});

/**
 * Rejects a fabricated, expired, drifted, non-official or ambiguous manifest.
 * A well-formed manifest must ALSO be independently authorized by the
 * source registry; hashes alone cannot prove that a legal rule is in force.
 */
export function validateLegalScopeEvidence(
  evidence: LegalScopeEvidenceV1 | null | undefined,
  ctx: LegalScopeValidationContext,
): LegalScopeValidation {
  if (!ctx.trustedAttestor) return fail('UNTRUSTED_ATTESTOR');
  if (!evidence || evidence.version !== 1) return fail('EVIDENCE_MISSING');
  if (evidence.publicationVersionId !== ctx.publicationVersionId ||
      evidence.sourceId !== ctx.sourceId) return fail('WRONG_PUBLICATION_OR_SOURCE');
  const sourceUrl = checkedHttps(ctx.officialUrl);
  const recordedUrl = checkedHttps(evidence.officialUrl);
  if (!sourceUrl || !recordedUrl || sourceUrl.href !== recordedUrl.href) return fail('SOURCE_URL_MISMATCH');
  if (!validDate(ctx.validAsOf) || !validDate(evidence.validAsOf) ||
      ctx.validAsOf !== evidence.validAsOf) return fail('REFERENCE_DATE_MISMATCH');
  if (!validDate(evidence.recheckOn) || ctx.validAsOf >= evidence.recheckOn) return fail('EVIDENCE_EXPIRED');
  const verifiedAt = new Date(evidence.verifiedAt);
  if (Number.isNaN(verifiedAt.getTime()) || verifiedAt.toISOString() !== evidence.verifiedAt ||
      verifiedAt.getTime() > Date.now()) return fail('INVALID_VERIFICATION_TIME');
  // The public detail API sanitizes source_metadata.presentation.html at
  // read time. Hashing a different, raw HTML would let an audit refer to
  // hidden/removed text or to offsets that are not the content on screen.
  // Require identical canonical persisted bytes BEFORE validating any
  // positive legal fragments; a difference must be re-ingested/re-reviewed,
  // never normalized silently or used as a fallback.
  const canonicalHtml = sanitizeLegalPresentationHtml(ctx.sanitizedHtml);
  if (!canonicalHtml || canonicalHtml !== ctx.sanitizedHtml) {
    return fail('LEGAL_SCOPE_HTML_NOT_CANONICAL');
  }
  if (!DIGEST.test(evidence.htmlSha256) ||
      evidence.htmlSha256 !== sha256(ctx.sanitizedHtml)) return fail('HTML_HASH_MISMATCH');
  if (!['COMPLETE', 'PARTIAL', 'UNVERIFIED'].includes(evidence.coverage)) return fail('INVALID_COVERAGE');
  if (!Array.isArray(evidence.segments)) return fail('INVALID_SEGMENTS');
  if (evidence.segments.length > 50000) return fail('SEGMENT_LIMIT_EXCEEDED');
  const allowHosts = new Set(ctx.trustedEvidenceHosts.map((h) => h.toLowerCase()));
  if (!allowHosts.has(sourceUrl.hostname.toLowerCase())) return fail('SOURCE_NOT_REGISTERED');
  const { text, spans } = parsedLegalText(ctx.sanitizedHtml);
  const accepted: string[] = [];
  let lastEnd = 0;
  let textNodeIndex = 0;
  for (const segment of evidence.segments) {
    if (!segment || typeof segment !== 'object') return fail('INVALID_SEGMENT');
    if (!Number.isSafeInteger(segment.start) || !Number.isSafeInteger(segment.end) ||
        segment.start < lastEnd || segment.end <= segment.start || segment.end > text.length) {
      return fail('INVALID_SEGMENT_BOUNDS');
    }
    // COMPLETE means every non-whitespace text region was reviewed, including
    // historical/editorial/UNVERIFIED fragments. A partial manifest must
    // never assert exhaustive normative coverage.
    if (evidence.coverage === 'COMPLETE' &&
        text.slice(lastEnd, segment.start).trim() !== '') {
      return fail('INCOMPLETE_SCOPE_COVERAGE');
    }
    lastEnd = segment.end;
    if (!DIGEST.test(segment.textSha256) ||
        sha256(text.slice(segment.start, segment.end)) !== segment.textSha256) {
      return fail('FRAGMENT_HASH_MISMATCH');
    }
    if (!['CURRENT', 'PREVIOUS', 'REVOKED', 'EDITORIAL', 'UNVERIFIED'].includes(segment.status) ||
        !['OFFICIAL_CONSOLIDATION', 'OFFICIAL_AMENDMENT', 'ORIGINAL_PUBLICATION', 'HUMAN_REVIEW'].includes(segment.method)) {
      return fail('INVALID_SEGMENT_STATUS');
    }
    // Optional legal references are audit material exposed in a future draft.
    // Persisted JSON is still untrusted until its shape is validated here.
    if (segment.supportingActs !== undefined &&
        (!Array.isArray(segment.supportingActs) ||
         segment.supportingActs.length > 25 ||
         segment.supportingActs.some((act) =>
           typeof act !== 'string' || act.trim().length === 0 ||
           act.length > 256 || /[\u0000-\u001f]/.test(act)))) {
      return fail('INVALID_SUPPORTING_ACTS');
    }
    if (!Array.isArray(segment.evidenceUrls) || segment.evidenceUrls.length > 25) {
      return fail('INVALID_EVIDENCE_URLS');
    }
    for (const evidenceUrl of segment.evidenceUrls) {
      const url = checkedHttps(evidenceUrl);
      if (!url || !allowHosts.has(url.hostname.toLowerCase())) return fail('UNTRUSTED_EVIDENCE_URL');
    }
    if (segment.status === 'CURRENT') {
      // One CURRENT assertion must remain within one exact parser text
      // callback. A cross-cell/cross-paragraph interval could fabricate a
      // phrase not present in any individual legal passage. Historical
      // segments may still span multiple nodes for exhaustive audit coverage.
      while (textNodeIndex < spans.length &&
             spans[textNodeIndex]!.end <= segment.start) textNodeIndex++;
      const node = spans[textNodeIndex];
      if (!node || segment.start < node.start || segment.end > node.end) {
        return fail('CURRENT_SPANS_DISTINCT_TEXT_NODES');
      }
      if (node.excluded) return fail('CURRENT_IN_NON_NORMATIVE_SCOPE');
      // Original publication alone cannot prove no subsequent amendment.
      if (!['OFFICIAL_CONSOLIDATION', 'OFFICIAL_AMENDMENT'].includes(segment.method) ||
          segment.evidenceUrls.length === 0 || evidence.coverage === 'UNVERIFIED') {
        return fail('CURRENT_WITHOUT_OFFICIAL_PROOF');
      }
      accepted.push(text.slice(segment.start, segment.end));
    }
  }
  if (evidence.coverage === 'COMPLETE' && text.slice(lastEnd).trim() !== '') {
    return fail('INCOMPLETE_SCOPE_COVERAGE');
  }
  if (accepted.length === 0) {
    return { valid: true, reason: null, coverage: evidence.coverage, currentText: '', currentFragments: [], currentSegments: 0 };
  }
  return {
    valid: true,
    reason: null,
    coverage: evidence.coverage,
    currentText: accepted.join('\n'),
    currentFragments: accepted,
    currentSegments: accepted.length,
  };
}
