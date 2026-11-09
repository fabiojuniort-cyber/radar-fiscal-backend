import { createHash } from 'node:crypto';
import { Parser } from 'htmlparser2';

/**
 * L-LEG-01 (#116 c.6708512598 §7; docs/anatomy/L-LEG-01-DESIGN.md §3, §11). Offline preparation of the "versão
 * atualizada" (Congress compilation) of a federal law published by normas.leg.br. The HTML is NOT changed: the
 * preparation only computes, from the bytes, a PLAN of exact note regions per block, and issues it by reference
 * (WeakSet, deep-frozen) bound to the bytes' SHA-256, the HTML, the URN, the version and the representationId.
 *
 * A note region is a run of consecutive `<a>` elements of the same leaf block such that:
 * (a) every anchor's href resolves (against the page URL) to http(s) on camara.leg.br / camara.gov.br (the host or a
 *     subdomain; a look-alike suffix such as camara.leg.br.example is not) with a `/legin/` path;
 * (b) the joined text opens "(" in the first anchor and closes the balanced parenthesis in the last one; anchors are
 *     separated only by whitespace or [,;.]; the text is one or more top-level parenthetical groups separated by spaces;
 * (c) each group starts with a word of the note grammar (NOTE_GRAMMAR); a structural noun (Caput, Parágrafo, Inciso,
 *     Alínea, Artigo) also needs a note verb inside the group;
 * (d) after the first note of the block there is only whitespace, other notes or empty anchors.
 * Anything that looks like a note but fails a rule makes the block AMBIGUOUS (no region is cut; the reader sends the
 * block to `unknown`). A block whose only text besides its notes is a device label, with a revocation/veto note, is a
 * REVOKED PLACEHOLDER. Nothing here infers validity, dates or earlier wording; legalStatus is never touched.
 *
 * The proof is LOCAL (bytes, URL, URN, version); it does not prove the official collection of the bytes.
 */
export const NORMAS_LEG_PREPARATION_VERSION = 'normas-leg-atualizada/0.1.0-provisional' as const;
export const NORMAS_LEG_HOST = 'normas.leg.br' as const;

export interface NormasLegResource {
  resourceId: string; url: string; urn: string;
  /** Only the "versão atualizada" carries the compilation notes; the original text is refused (design §7). */
  version: string; bytes: Uint8Array;
  /** Identity recorded in the snapshot meta; a different hash or size is refused (counter-case 28). */
  expected?: { sha256: string; bytes: number };
}
type Span = { start: number; end: number };
export type NormasLegNoteKind = 'editorial' | 'vide' | 'revocation';
export type NormasLegAmbiguity = 'unclosed' | 'shape' | 'grammar' | 'not_last' | 'note_like_unproven' | 'label_only_without_revocation';
export interface NormasLegNote {
  /** Raw HTML (UTF-16) and byte intervals of each `<a>` of the note, in order. */
  anchors: readonly { htmlSpan: Span; byteSpan: Span }[];
  /** [start of the first anchor, end of the last anchor) and the SHA-256 of those bytes. */
  region: { htmlSpan: Span; byteSpan: Span; sha256: string };
  kind: NormasLegNoteKind;
  /** The first grammar word of each parenthetical group. */
  groups: readonly string[];
  text: string;
}
export interface NormasLegBlock {
  tag: string;
  htmlSpan: Span;
  notes: readonly NormasLegNote[];
  placeholder: boolean;
  ambiguous: { code: NormasLegAmbiguity; detail: string } | null;
}
export interface NormasLegPreparation {
  preparationVersion: typeof NORMAS_LEG_PREPARATION_VERSION;
  provisional: true;
  source: 'NORMAS-LEG';
  readerSource: 'NORMAS-LEG';
  representation: 'atualizada';
  provenance: { level: 'local_preparation'; collectedFromOfficialSourceVerified: false };
  url: string; urn: string;
  resource: { resourceId: string; sha256: string; byteLength: number; bomPresent: boolean };
  html: string; htmlSha256: string;
  plan: { blocks: readonly NormasLegBlock[]; counts: { notes: number; anchors: number; placeholders: number; ambiguous: number }; planSha256: string };
  preparationId: string;
}

export class NormasLegPreparationError extends Error {
  constructor(readonly code: 'not_https' | 'not_normas_leg_host' | 'invalid_urn' | 'unsupported_version' | 'not_utf8' | 'identity_mismatch', message: string) {
    super(message); this.name = 'NormasLegPreparationError';
  }
}

const sha = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
/** Note grammar of design §3 (c). `Artigo` was added after measuring the real files (design §12). */
export const NOTE_GRAMMAR = Object.freeze(['Redação', 'Revogad', 'Inclu', 'Acrescid', 'Vide', 'Produção de efeito', 'Vigência', 'Vetad', 'Renumerad',
  'Caput', 'Parágrafo', 'Inciso', 'Alínea', 'Artigo']);
const STRUCTURAL = new Set(['caput', 'parágrafo', 'inciso', 'alínea', 'artigo']);
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const GROUP_START = /^\(\s*[“"]?\s*([\p{L}]+(?:\s+de\s+efeito)?)/u;
const NOTE_VERB = /(?<!\p{L})(?:reda[çc][ãa]o|revogad|acrescid|inclu[íi]d|vetad|vide|renumerad|efeito|vig[êe]ncia|vigor)/iu;
const REVOCATION = /(?<!\p{L})(?:revogad|vetad)/iu;
/** Between anchors of one note: whitespace/[,;.] and at most one connective "e" (measured, design §12). */
const SEPARATOR = /^[\s,;.]*(?:(?<!\p{L})e(?!\p{L})[\s,;.]*)?$/u;
const LEGACY_LEGIN = /^\/(?:internet\/)?legislacao\/legin\.html\/textos\/visualizarTexto\.html$/u;
/** Device label alone (the block's own marker), after removing the notes. */
const LABEL_ONLY = /^(?:Art\.?\s*\d+(?:[º°o]|\.)?(?:\s*-\s*[A-Z]+)?\.?|§\s*\d+[º°o]?(?:\s*-\s*[A-Z]+)?\.?|Par[áa]grafo\s+[úu]nico\.?|[IVXLCDM]+(?:\s*-\s*[A-Z])?\s*[-–—]?|[a-z]\)|\d{1,3}(?:\.\d{1,3})*[.)])\s*[-–—.:]?$/u;

/** The grammar word that starts a parenthetical group, or null. */
export function grammarWord(group: string): string | null {
  const m = GROUP_START.exec(group); if (!m) return null;
  const w = fold(m[1]!);
  const hit = NOTE_GRAMMAR.find((g) => { const f = fold(g); return STRUCTURAL.has(fold(g)) || f === 'vide' ? w === f : w.startsWith(f); });
  if (!hit) return null;
  if (STRUCTURAL.has(fold(hit)) && !NOTE_VERB.test(group.slice(m[0].length))) return null;
  return hit;
}
/** "Looks like a note": a parenthetical that starts with a grammar word (and, for structural nouns, has a note verb). */
export function noteLike(text: string): boolean {
  for (let i = text.indexOf('('); i >= 0; i = text.indexOf('(', i + 1)) {
    const close = text.indexOf(')', i); const group = text.slice(i, close < 0 ? undefined : close + 1);
    if (grammarWord(group)) return true;
  }
  return false;
}
export function isCamaraNoteHref(href: string | undefined, base: string): boolean {
  if (!href) return false;
  let u: URL; try { u = new URL(href, base); } catch { return false; }
  const h = u.hostname.toLowerCase();
  const camara = ['camara.leg.br', 'camara.gov.br'].some((d) => h === d || h.endsWith(`.${d}`));
  if (!camara || (u.protocol !== 'http:' && u.protocol !== 'https:')) return false;
  // `/legin/` (design §3 a), or the legacy LegIn viewer of camara.gov.br (measured in the real files, design §12).
  return u.pathname.includes('/legin/') || (h.endsWith('camara.gov.br') && LEGACY_LEGIN.test(u.pathname));
}

interface El { tag: string; attrs: Record<string, string>; start: number; end: number; children: (El | Txt)[]; blocked: boolean }
interface Txt { tag: '#text'; text: string; start: number; end: number }
const BLOCKS = new Set(['p', 'div', 'section', 'h1', 'h2', 'h3', 'h4', 'li', 'table', 'tr', 'td', 'th', 'article']);
const EXCLUDED = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'object', 'head']);

/** Same parser and options as the reader, so element offsets coincide (node.start / node.end). */
function parse(html: string): El {
  const root: El = { tag: 'root', attrs: {}, start: 0, end: html.length, children: [], blocked: false };
  const stack = [root];
  const parser = new Parser({
    onopentag(tag, attrs) { const parent = stack[stack.length - 1]!; const el: El = { tag, attrs, start: parser.startIndex, end: -1, children: [], blocked: parent.blocked || EXCLUDED.has(tag) }; parent.children.push(el); stack.push(el); },
    ontext(text) { stack[stack.length - 1]!.children.push({ tag: '#text', text, start: parser.startIndex, end: parser.endIndex + 1 }); },
    onclosetag() { if (stack.length > 1) stack.pop()!.end = parser.endIndex + 1; },
  }, { decodeEntities: true, lowerCaseTags: true });
  parser.end(html);
  return root;
}
const textOf = (n: El | Txt): string => n.tag === '#text' ? (n as Txt).text : (n as El).blocked ? '' : (n as El).children.map(textOf).join('') + ((n as El).tag === 'br' ? '\n' : '');

type Token = { kind: 'text'; text: string } | { kind: 'anchor'; text: string; camara: boolean; span: Span };
function tokens(block: El, base: string): Token[] {
  const out: Token[] = [];
  const visit = (n: El | Txt): void => {
    if (n.tag === '#text') { out.push({ kind: 'text', text: (n as Txt).text }); return; }
    const el = n as El; if (el.blocked) return;
    if (el.tag === 'a') { const text = textOf(el); if (text.trim()) out.push({ kind: 'anchor', text, camara: isCamaraNoteHref(el.attrs.href, base), span: { start: el.start, end: el.end } }); return; }
    if (el.tag === 'br') { out.push({ kind: 'text', text: '\n' }); return; }
    el.children.forEach(visit);
  };
  block.children.forEach(visit);
  return out;
}

/** Splits a note text into top-level groups; null when it is not a sequence of balanced groups separated by spaces. */
function groupsOf(text: string): string[] | null {
  const groups: string[] = []; let depth = 0; let start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '(') { if (depth === 0) start = i; depth++; }
    else if (c === ')') { depth--; if (depth < 0) return null; if (depth === 0) groups.push(text.slice(start, i + 1)); }
    else if (depth === 0 && !/\s/u.test(c)) return null;
  }
  return depth === 0 && groups.length ? groups : null;
}
const depthOf = (text: string): number => { let d = 0; for (const c of text) { if (c === '(') d++; else if (c === ')') d--; } return d; };

function planBlock(block: El, base: string, bytesAt: (i: number) => number, html: string): NormasLegBlock | null {
  const toks = tokens(block, base);
  const notes: NormasLegNote[] = []; const inNote = new Set<number>();
  const blockOf = (ambiguous: NormasLegBlock['ambiguous']): NormasLegBlock => ({ tag: block.tag, htmlSpan: { start: block.start, end: block.end }, notes: ambiguous ? [] : notes, placeholder: false, ambiguous });
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.kind !== 'anchor' || !t.camara || !t.text.trimStart().startsWith('(')) continue;
    const members = [i]; let joined = t.text; let j = i;
    while (depthOf(joined) > 0) {
      let k = j + 1; let sep = '';
      while (k < toks.length && toks[k]!.kind === 'text' && SEPARATOR.test(toks[k]!.text)) { sep += toks[k]!.text; k++; }
      const next = toks[k];
      if (!next || next.kind !== 'anchor' || !next.camara) break;
      joined += sep + next.text; members.push(k); j = k;
    }
    if (depthOf(joined) !== 0) return blockOf({ code: 'unclosed', detail: `a note opened at ${t.span.start} is not closed by a consecutive Câmara anchor` });
    const groups = groupsOf(joined.trim());
    if (!groups) return blockOf({ code: 'shape', detail: `note at ${t.span.start} is not a sequence of whole parenthetical groups` });
    const words = groups.map(grammarWord);
    if (words.some((w) => w === null)) return blockOf({ code: 'grammar', detail: `note at ${t.span.start} starts with a word outside the note grammar` });
    const anchors = members.map((m) => { const s = (toks[m] as Extract<Token, { kind: 'anchor' }>).span; return { htmlSpan: s, byteSpan: { start: bytesAt(s.start), end: bytesAt(s.end) } }; });
    const region = { start: anchors[0]!.htmlSpan.start, end: anchors[anchors.length - 1]!.htmlSpan.end };
    const kind: NormasLegNoteKind = groups.some((g) => REVOCATION.test(g)) ? 'revocation' : words.every((w) => w === 'Vide') ? 'vide' : 'editorial';
    notes.push({ anchors, region: { htmlSpan: region, byteSpan: { start: bytesAt(region.start), end: bytesAt(region.end) }, sha256: sha(html.slice(region.start, region.end)) },
      kind, groups: words as string[], text: joined.trim() });
    for (let m = i; m <= j; m++) inNote.add(m);
    i = j;
  }
  const first = toks.findIndex((_, i) => inNote.has(i));
  const residual = toks.filter((_, i) => !inNote.has(i));
  // (d) only whitespace after the first note (separators between consecutive notes included).
  if (first >= 0 && toks.some((t, i) => i > first && !inNote.has(i) && t.text.trim() !== '')) return blockOf({ code: 'not_last', detail: 'text follows a note inside the block' });
  if (residual.some((t) => noteLike(t.text))) return blockOf({ code: 'note_like_unproven', detail: 'a parenthetical looks like a compilation note but is not a proven Câmara note region' });
  if (!notes.length) return null;
  const rest = residual.map((t) => t.text).join('').replace(/\s+/gu, ' ').trim();
  const labelOnly = rest !== '' && LABEL_ONLY.test(rest);
  if (labelOnly && !notes.some((n) => n.kind === 'revocation')) return blockOf({ code: 'label_only_without_revocation', detail: 'the block holds only a label and notes, none of them a revocation or veto' });
  return { ...blockOf(null), placeholder: labelOnly };
}

const deepFreeze = <T>(v: T): T => { if (v && typeof v === 'object') { Object.values(v).forEach(deepFreeze); Object.freeze(v); } return v; };

export function prepareNormasLegPage(input: NormasLegResource): NormasLegPreparation {
  let url: URL; try { url = new URL(input.url); } catch { throw new NormasLegPreparationError('not_normas_leg_host', 'invalid URL'); }
  if (url.protocol !== 'https:') throw new NormasLegPreparationError('not_https', `protocol ${url.protocol} is not HTTPS`);
  if (url.hostname.toLowerCase() !== NORMAS_LEG_HOST || url.port || url.username || url.password) throw new NormasLegPreparationError('not_normas_leg_host', `host ${url.host} is not ${NORMAS_LEG_HOST}`);
  if (!/^urn:lex:br:[a-z0-9.:;_-]+$/u.test(input.urn)) throw new NormasLegPreparationError('invalid_urn', 'URN is not a urn:lex:br identifier');
  if (input.version !== 'atualizada') throw new NormasLegPreparationError('unsupported_version', `representation "${input.version}" has no compilation-note plan (only "atualizada")`);
  const resourceSha = sha(input.bytes);
  if (input.expected && (input.expected.sha256 !== resourceSha || input.expected.bytes !== input.bytes.byteLength)) throw new NormasLegPreparationError('identity_mismatch', 'bytes differ from the recorded SHA-256/size');
  let raw: string;
  try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input.bytes); } catch { throw new NormasLegPreparationError('not_utf8', 'page is not valid UTF-8'); }
  const bomPresent = raw.charCodeAt(0) === 0xfeff; const html = bomPresent ? raw.slice(1) : raw;
  // UTF-16 index → byte offset in the original bytes (BOM included), surrogate pairs counted once.
  const offsets = new Uint32Array(html.length + 1); offsets[0] = bomPresent ? 3 : 0;
  for (let i = 0; i < html.length; i++) {
    const c = html.charCodeAt(i);
    offsets[i + 1] = offsets[i]! + (c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? 4 : c >= 0xdc00 && c <= 0xdfff ? 0 : 3);
  }
  const bytesAt = (i: number) => offsets[i]!;
  const blocks: NormasLegBlock[] = [];
  const visit = (el: El, inTable: boolean): void => {
    if (el.blocked) return;
    const isLeaf = BLOCKS.has(el.tag) && !el.children.some((c) => BLOCKS.has(c.tag));
    // Table cells are read by the reader's table path, not as leaf blocks: no plan there (nothing changes).
    if (isLeaf && !inTable && el.tag !== 'table') { const b = planBlock(el, input.url, bytesAt, html); if (b) blocks.push(b); return; }
    for (const c of el.children) if (c.tag !== '#text') visit(c as El, inTable || el.tag === 'table');
  };
  visit(parse(html), false);
  const counts = { notes: blocks.reduce((a, b) => a + b.notes.length, 0), anchors: blocks.reduce((a, b) => a + b.notes.reduce((x, n) => x + n.anchors.length, 0), 0),
    placeholders: blocks.filter((b) => b.placeholder).length, ambiguous: blocks.filter((b) => b.ambiguous).length };
  const planSha256 = sha(JSON.stringify({ blocks, counts }));
  const htmlSha256 = sha(html);
  const resource = { resourceId: input.resourceId, sha256: resourceSha, byteLength: input.bytes.byteLength, bomPresent };
  const preparationId = sha(JSON.stringify({ version: NORMAS_LEG_PREPARATION_VERSION, url: input.url, urn: input.urn, representation: 'atualizada', resourceId: input.resourceId, resource: resourceSha, htmlSha256, planSha256 }));
  const prepared = deepFreeze({ preparationVersion: NORMAS_LEG_PREPARATION_VERSION, provisional: true as const, source: 'NORMAS-LEG' as const, readerSource: 'NORMAS-LEG' as const,
    representation: 'atualizada' as const, provenance: { level: 'local_preparation' as const, collectedFromOfficialSourceVerified: false as const },
    url: input.url, urn: input.urn, resource, html, htmlSha256, plan: { blocks, counts, planSha256 }, preparationId });
  ISSUED.add(prepared);
  return prepared;
}

/** Only an object issued by prepareNormasLegPage in this process, unchanged and bound to this exact HTML and id. */
const ISSUED = new WeakSet<object>();
const deepFrozen = (v: unknown): boolean => v === null || typeof v !== 'object' || (Object.isFrozen(v) && Object.values(v).every(deepFrozen));
export function verifyNormasLegPreparation(prep: unknown, html: string, representationId: string): prep is NormasLegPreparation {
  if (!prep || typeof prep !== 'object' || !ISSUED.has(prep) || !deepFrozen(prep)) return false;
  const p = prep as NormasLegPreparation;
  let url: URL; try { url = new URL(p.url); } catch { return false; }
  return p.preparationVersion === NORMAS_LEG_PREPARATION_VERSION && p.source === 'NORMAS-LEG' && p.readerSource === 'NORMAS-LEG' && p.representation === 'atualizada'
    && p.provenance.level === 'local_preparation' && url.protocol === 'https:' && url.hostname.toLowerCase() === NORMAS_LEG_HOST
    && p.resource.resourceId === representationId && p.html === html && sha(html) === p.htmlSha256
    && p.plan.planSha256 === sha(JSON.stringify({ blocks: p.plan.blocks, counts: p.plan.counts }))
    && p.preparationId === sha(JSON.stringify({ version: NORMAS_LEG_PREPARATION_VERSION, url: p.url, urn: p.urn, representation: 'atualizada', resourceId: p.resource.resourceId, resource: p.resource.sha256, htmlSha256: p.htmlSha256, planSha256: p.plan.planSha256 }));
}
