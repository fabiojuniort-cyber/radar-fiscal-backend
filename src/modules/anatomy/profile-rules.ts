import { DEFAULT_PROFILES, PROFILE_FORMAT_VERSION, assertProtectionFloor, blockerPattern, escapeLiteral as esc, literalPattern, resolveEffectiveProfile, type EffectiveProfile,
  type ProfileFields } from './profile.js';

/**
 * ANAT P1.B — compiles an effective profile into the matchers used by the reader and the entity extractor.
 * Literals are always regex-escaped; the grammar around them (numbering after a label, boundaries, the built-in
 * numeric list) is fixed here and never comes from a profile. Fixed protections (domain patterns, size limits,
 * excluded tags, the conservative table policy) stay in the engine and are not part of the profile.
 */
export type ReaderSource = 'CONFAZ' | 'DOU' | 'DOE-SP' | 'RFB';
export interface CompiledRules {
  profileVersion: typeof PROFILE_FORMAT_VERSION;
  effectiveHash: string;
  source: ReaderSource;
  /** Fixed per source: CONFAZ classes count on the block and its descendants and feed DOM zones; others on the block only. */
  classScope: 'subtree' | 'own';
  reasonPrefix: string;
  classes: { historical: Set<string>; editorialNote: Set<string>; body: Set<string>; epigraph: string[]; summary: string[]; signature: string[] };
  preamble: RegExp; rectificationOriginal: RegExp; rectificationCorrected: RegExp;
  quoteBlockOpen: RegExp; quoteOpen: RegExp; quoteClose: RegExp; quoteOnly: RegExp;
  annex: RegExp; clause: RegExp; article: RegExp; paragraph: RegExp;
  ncmHeader: RegExp; ncmBlocker: RegExp; ncmMarker: RegExp;
  codeList: RegExp; rangeBridge: RegExp; exceptionMarker: RegExp;
}

const NEVER = '(?!)';
/** Longest first, so a literal that extends another (NCM/SH vs NCM) wins, as in the original alternations. */
const byLength = (items: readonly string[]) => [...items].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
const alt = (parts: string[]) => (parts.length ? `(?:${parts.join('|')})` : NEVER);
// Literal fragments come from profile.ts, the same ones validation uses for duplicates and header conflicts: spaces
// in a literal match any run of whitespace; NCM header literals also tolerate whitespace around "/".
const words = (lit: string) => literalPattern('labels', 'clause', lit);
const header = (lit: string) => literalPattern('ncm', 'columnHeaders', lit);
const strip = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '');
/**
 * Word end used after list tokens and exception markers: `\b` for ASCII-ending words; when any accent variant of the
 * same word ends in a non-ASCII letter (até/ate), the whole group uses `(?!\p{L})`, exactly as the original rules did.
 */
function wordEnd(items: readonly string[]): (lit: string) => string {
  const nonAsciiEnd = new Set(items.filter((i) => /[^\x00-\x7f]$/u.test(i)).map((i) => strip(i).toLocaleLowerCase('pt-BR')));
  return (lit) => (nonAsciiEnd.has(strip(lit).toLocaleLowerCase('pt-BR')) || /[^\x00-\x7f]$/u.test(lit) ? '(?!\\p{L})' : '\\b');
}

/**
 * Compiled rules are only accepted from this compiler (review of PR #249): the floor check runs here, the object and
 * its class sets are read-only, and the reader/extractor refuse any rules object this module did not produce.
 */
const issued = new WeakSet<object>();
export function assertCompiledRules(rules: object): void {
  if (!issued.has(rules)) throw new TypeError('Rules must come from compileProfileRules (protection floor check)');
}
const readOnlySet = (items: readonly string[]): Set<string> => {
  const set = new Set(items);
  set.add = set.delete = () => { throw new TypeError('Compiled rules are read-only'); };
  set.clear = () => { throw new TypeError('Compiled rules are read-only'); };
  return Object.freeze(set);
};

export function compileProfileRules(effective: Pick<EffectiveProfile, 'fields' | 'effectiveHash'>, source: ReaderSource): CompiledRules {
  const f: ProfileFields = effective.fields;
  assertProtectionFloor(f, source);
  const symbols = f.labels.paragraph.filter((l) => !/\p{L}/u.test(l));
  const phrases = f.labels.paragraph.filter((l) => /\p{L}/u.test(l));
  const listEnd = wordEnd(f.lists.tokens); const excEnd = wordEnd(f.exceptions.markers);
  const rules: CompiledRules = {
    profileVersion: PROFILE_FORMAT_VERSION, effectiveHash: effective.effectiveHash, source,
    classScope: source === 'CONFAZ' ? 'subtree' : 'own', reasonPrefix: source.toLowerCase().replace(/-/gu, '_'),
    classes: Object.freeze({ historical: readOnlySet(f.classes.historical), editorialNote: readOnlySet(f.classes.editorialNote), body: readOnlySet(f.classes.body),
      epigraph: Object.freeze([...f.classes.epigraph]) as string[], summary: Object.freeze([...f.classes.summary]) as string[], signature: Object.freeze([...f.classes.signature]) as string[] }),
    // Preamble starts keep the pre-profile rule (review of PR #249): a one-word start ends at `\\b` (CONSIDERANDO\\b);
    // a multi-word start is a plain prefix. Rectification starts end at a non-letter/digit boundary, as before.
    preamble: new RegExp(`^${alt(byLength(f.blockStarts.preamble).map((l) => `${literalPattern('blockStarts', 'preamble', l)}${l.includes(' ') ? '' : '\\b'}`))}`, 'iu'),
    rectificationOriginal: new RegExp(`^${alt(byLength(f.blockStarts.rectificationOriginal).map(words))}(?![\\p{L}\\p{N}])`, 'iu'),
    rectificationCorrected: new RegExp(`^${alt(byLength(f.blockStarts.rectificationCorrected).map(words))}(?![\\p{L}\\p{N}])`, 'iu'),
    quoteBlockOpen: new RegExp(`^\\s*${alt(f.quotes.open.map(esc))}`, 'u'),
    quoteOpen: new RegExp(`^${alt(f.quotes.open.map(esc))}`, 'u'),
    quoteClose: new RegExp(`${alt(f.quotes.close.map(esc))}(?:\\s*${alt(f.quotes.closeSuffix.map(esc))}\\.?)?\\s*$`, 'u'),
    quoteOnly: new RegExp(`^${alt(f.quotes.open.map(esc))}$`, 'u'),
    annex: new RegExp(`^${alt(byLength(f.labels.annex).map(words))}\\s+(?:[IVXLCDM]+|[0-9]+)(?:\\s*[-–—:(]|\\s*$)`, 'iu'),
    clause: new RegExp(`^${alt(byLength(f.labels.clause).map(words))}\\s+(?:primeira|segunda|terceira|quarta|quinta|sexta|s[ée]tima|oitava|nona|d[ée]cima|\\d+)`, 'iu'),
    article: new RegExp(`^${alt(byLength(f.labels.article).map(words))}\\s*\\d+[ºo°]?`, 'iu'),
    // A symbol label (no letters, e.g. §) requires a number; a phrase label (Parágrafo único) is complete by itself.
    paragraph: new RegExp(`^(?:${[...(symbols.length ? [`${alt(byLength(symbols).map(esc))}\\s*\\d+`] : []), ...(phrases.length ? [alt(byLength(phrases).map(words))] : [])].join('|') || NEVER})`, 'iu'),
    ncmHeader: new RegExp(`^${alt(byLength(f.ncm.columnHeaders).map(header))}$`, 'iu'),
    // Blockers use the header fragment too, so "NCM / SH" and "NCM/SH" are the same blocker (review of PR #249).
    ncmBlocker: new RegExp(blockerPattern(byLength(f.ncm.columnBlockers)), 'iu'),
    ncmMarker: new RegExp(`\\b${alt(byLength(f.ncm.markers).map(esc))}\\b\\s*(?:(?:c[oó]digos?|n[.º°o]s?)\\s*)?[:=-]?\\s*`, 'giu'),
    codeList: new RegExp(`^(?:[ \\t]*(?:\\d[\\d.]*|${byLength(f.lists.tokens).map((t) => `${esc(t)}${listEnd(t)}`).join('|') || NEVER}|[,:;()–—-]))+`, 'iu'),
    rangeBridge: new RegExp(`^\\s*${alt(byLength(f.ranges.operators).map(esc))}\\s*$`, 'iu'),
    exceptionMarker: new RegExp(`\\b${alt(byLength(f.exceptions.markers).map((m) => `${esc(m)}${excEnd(m)}`))}`, 'giu'),
  };
  issued.add(Object.freeze(rules));
  return rules;
}

const cache = new Map<ReaderSource, CompiledRules>();
/** Rules of the shipped DEFAULT_PROFILES for a source (used when a caller supplies none). */
export function defaultRules(source: ReaderSource): CompiledRules {
  let rules = cache.get(source);
  if (!rules) { rules = compileProfileRules(resolveEffectiveProfile([...DEFAULT_PROFILES], { source }), source); cache.set(source, rules); }
  return rules;
}
