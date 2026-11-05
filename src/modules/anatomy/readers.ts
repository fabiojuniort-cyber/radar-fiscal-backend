import { Parser } from 'htmlparser2';
import type { AnatomyPart, AnatomyResult } from './contract.js';
import { NfcQuarantineError, NFC_DIAGNOSTICS, decideRecovery, exactToShadow, type RecoveryDecision, type ShadowContext } from './nfc-recovery.js';
import { assertCompiledRules, defaultRules, type CompiledRules } from './profile-rules.js';

export interface AnatomyReaderInput {
  source: 'CONFAZ' | 'DOU' | 'DOE-SP' | 'RFB';
  representationId: string;
  html?: string | undefined;
  text?: string | undefined;
  missingResources?: string[];
  /** Compiled effective profile for this source; defaults to the shipped DEFAULT_PROFILES. */
  rules?: CompiledRules;
}
export type AnatomyReaderResult = Pick<AnatomyResult, 'canonicalText' | 'parts' | 'sourceMap' | 'coverage' | 'limitations' | 'status'>;
export const ANATOMY_READER_LIMITS = Object.freeze({ maxBytes: 2 * 1024 * 1024, maxDepth: 128, maxNodes: 50_000 });
type Pointer = AnatomyPart['sourcePointers'][number];
type Node = { tag: string; attrs: Record<string, string>; path: string; start: number; end: number;
  children: Node[]; text: string | null; span: { start: number; end: number }; blocked: boolean };
/** ANAT-STRUCT-01: grouping levels nest inside an annex (rank 2) and above articles/clauses (rank 3). */
const GROUP_RANK: Record<string, [string, number]> = {
  LIVRO: ['book', 2.1], TITULO: ['title', 2.2], CAPITULO: ['chapter', 2.3], SECAO: ['section', 2.4], SUBSECAO: ['subsection', 2.5],
};
const SOLE_PARAGRAPH = /^par[áa]grafo\s+[úu]nico(?![\p{L}\p{N}_])/iu;
const CONSIDERANDO = /^considerando(?![\p{L}\p{N}_])/iu;
const groupLevel = (word: string) => GROUP_RANK[word.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase()]!;
const GROUP = /^(LIVRO|T[ÍI]TULO|CAP[ÍI]TULO|SE[ÇC][ÃA]O|SUBSE[ÇC][ÃA]O|Livro|T[íi]tulo|Cap[íi]tulo|Se[çc][ãa]o|Subse[çc][ãa]o)\s+(?:[IVXLCDM]+|\d+|[ÚU]NIC[OA]|[ÚU]nic[oa])(?:\s*[-–—:.]|\s*$)/u;
type Descriptor = { type: AnatomyPart['type']; context: AnatomyPart['context']; reason: string; rank: number; itemNumber?: string };
const blocks = new Set(['p', 'div', 'section', 'h1', 'h2', 'h3', 'h4', 'li', 'table', 'tr', 'td', 'th', 'article']);
const excluded = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'object', 'head']);
const textOf = (node: Node): string => {
  const stack = [node]; let text = '';
  while (stack.length) {
    const next = stack.pop()!;
    if (next.blocked) continue;
    if (next.text !== null) text += next.text;
    else for (let i = next.children.length - 1; i >= 0; i--) stack.push(next.children[i]!);
  }
  return text;
};
const classesOf = (node: Node): string[] => {
  const found: string[] = []; const pending = [node];
  while (pending.length) {
    const current = pending.pop()!;
    found.push(...(current.attrs.class ?? '').split(/\s+/).filter(Boolean));
    pending.push(...current.children);
  }
  return found;
};
function describe(node: Node, rules: CompiledRules, matchText: (node: Node) => string = textOf): Descriptor {
  // Class scope is fixed per source (rules.classScope): CONFAZ looks at the block and its descendants, others at the block.
  const subtree = rules.classScope === 'subtree';
  const text = matchText(node).trim();
  const own = (node.attrs.class ?? '').split(/\s+/);
  const classes = subtree ? classesOf(node) : own;
  const c = rules.classes; const p = rules.reasonPrefix;
  const pick = (list: string[]): string | undefined => list.find((name) => classes.includes(name));
  const hist = classes.some((name) => c.historical.has(name));
  const context = hist ? 'historical' : 'operative_candidate';
  const note = classes.some((name) => c.editorialNote.has(name));
  if (subtree) {
    if (pick(c.epigraph)) return { type: 'epigraph', context: 'prohibited', reason: `${p}_epigraph`, rank: 100 };
    if (pick(c.summary)) return { type: 'summary', context: 'prohibited', reason: `${p}_summary`, rank: 100 };
    if (note) return { type: 'editorial_note', context: hist ? 'historical' : 'prohibited', reason: `${p}_editorial_note`, rank: 100 };
    if (pick(c.signature)) return { type: 'signature', context: 'prohibited', reason: `${p}_signature`, rank: 100 };
  } else {
    // Official classes on the block itself describe position, never legal status; the reason names the class.
    const epigraph = pick(c.epigraph); if (epigraph) return { type: 'epigraph', context: 'prohibited', reason: `${p}_${epigraph}`, rank: 100 };
    const summary = pick(c.summary); if (summary) return { type: 'summary', context: 'prohibited', reason: `${p}_${summary}`, rank: 100 };
    const signature = pick(c.signature); if (signature) return { type: 'signature', context: 'prohibited', reason: `${p}_${signature}`, rank: 100 };
    if (note) return { type: 'editorial_note', context: hist ? 'historical' : 'prohibited', reason: `${p}_editorial_note`, rank: 100 };
  }
  // Rectification wording quotes another act: original and corrected text both stay out of positive selection.
  if (rules.rectificationOriginal.test(text)) return { type: 'quoted_text', context: 'prohibited', reason: `${p}_rectification_original`, rank: 100 };
  if (rules.rectificationCorrected.test(text)) return { type: 'quoted_text', context: 'prohibited', reason: `${p}_rectification_corrected`, rank: 100 };
  if (rules.quoteBlockOpen.test(text)) return { type: 'quoted_text', context: hist ? 'historical' : 'prohibited', reason: 'quoted_block', rank: 100 };
  if (rules.preamble.test(text)) {
    // ANAT-STRUCT-01: a preamble block that is a considerando (the whole word, any case) is typed as such; the
    // preamble matcher itself is unchanged, so context and every non-considerando preamble stay as before.
    const consideration = CONSIDERANDO.test(text);
    return { type: consideration ? 'consideration' : 'preamble', context: hist ? 'historical' : 'prohibited', reason: consideration ? 'consideration_marker' : 'preamble_marker', rank: 100 };
  }
  // Only block-initial markers are recognized. A reference to an annex in prose is not a heading.
  if (rules.annex.test(text)) return { type: 'annex', context, reason: 'annex_heading', rank: 2 };
  // Grouping headings (Livro > Título > Capítulo > Seção > Subseção) are built-in grammar: an upper-case or
  // capitalised heading word, then a roman/arabic number or "Único/Única", alone at the start of the block.
  const g = GROUP.exec(text);
  if (g) { const [level, rank] = groupLevel(g[1]!); return { type: 'group', context, reason: `group_${level}`, rank }; }
  if (rules.clause.test(text)) return { type: 'clause', context, reason: 'clause_marker', rank: 3 };
  if (rules.article.test(text)) return { type: 'article', context, reason: 'article_marker', rank: 3 };
  // ANAT-STRUCT-02: "Parágrafo único" keeps the paragraph type with its own reason (single paragraph of the device).
  if (rules.paragraph.test(text)) return { type: 'paragraph', context, reason: SOLE_PARAGRAPH.test(text) ? 'paragraph_sole' : 'paragraph_marker', rank: 4 };
  // Inciso and alínea numbering is built-in grammar, not a profile label.
  if (/^[IVXLCDM]+\s*[-–—]/u.test(text)) return { type: 'inciso', context, reason: 'inciso_marker', rank: 5 };
  if (/^[a-z]\)\s/u.test(text)) return { type: 'alinea', context, reason: 'alinea_marker', rank: 6 };
  // Items numbered "1." / "1)" / "1.1." under an alínea or a device (ANAT-STRUCT-01).
  // R1-B: the depth (number of dot-separated levels) nests 1.1. under 1. and 1.1.1. under 1.1.; a shallower or equal
  // level closes the deeper ones.
  const item = /^(\d{1,3}(?:\.\d{1,3}){0,5})[.)]\s+\S/u.exec(text);
  if (item) { const depth = item[1]!.split('.').length - 1; return { type: 'item', context, reason: depth ? `item_level_${depth + 1}` : 'item_marker', rank: 7 + depth / 100, itemNumber: item[1]! }; }
  if (classes.some((name) => c.body.has(name))) return { type: 'body', context, reason: hist ? `${p}_historical_wording` : `${p}_text_class`, rank: 100 };
  return { type: 'unidentified', context: 'unknown', reason: 'unrecognized_block', rank: 100 };
}

/**
 * ANAT-UNICODE-01a (containment, issue #116). Text that is not in Unicode NFC (e.g. decomposed accents) is not read
 * reliably by NFC literals and rules: exception markers, citations and ranges can be lost. Until a mapped
 * normalisation exists (UNICODE-01b), such a document is flagged here and its entity extraction is suspended
 * (engine.ts, entities.ts). The NFC copy only serves detection: text, hashes and positions stay the supplied ones.
 */
export const NON_NFC_TEXT = 'non_nfc_text' as const;
/** True when the text is not in NFC; a failure to normalise counts as not NFC (fail closed). */
export function isNonNfcText(text: string): boolean {
  try { return text !== text.normalize('NFC'); } catch { return true; }
}

// Recovery contexts are registered only here, by readAnatomyInput after its own checks (review B2-R1-01): there is no
// exported setter, so no caller can attach a context or map to a result the reader did not accept for recovery.
const recoveryRegistry = new WeakMap<object, ShadowContext>();
/** The recovery context the reader issued for this very result object, or undefined (NFC path or quarantine). */
export function shadowContextOf(result: object): ShadowContext | undefined { return recoveryRegistry.get(result); }

/** Pure snapshot reader. It never fetches resources, infers current legal status, or grants eligibility. */
export function readAnatomyInput(input: AnatomyReaderInput): AnatomyReaderResult {
  // Decoded attributes (e.g. class="Histo&#x301;rica") drive context but are in neither the raw markup nor the text.
  const seen: ReaderSignals = { decodedAttributeNonNfc: false, recovery: undefined };
  const result = readSnapshot(input, seen);
  const raw = input.html ?? input.text ?? '';
  const textNonNfc = isNonNfcText(result.canonicalText);
  // Fallback paths (plain text, limits, parse failure) return before the HTML walk: decide recovery here.
  if (textNonNfc && !seen.recovery) seen.recovery = decideWithExactSourceMap(result, seen.decodedAttributeNonNfc);
  const span = { start: 0, end: result.canonicalText.length };
  if (textNonNfc && seen.recovery?.mode === 'recover') {
    // UNICODE-01b/B2: exact NFC recovery. The result stays partial; the engine may still quarantine extraction.
    recoveryRegistry.set(result, Object.freeze({ map: seen.recovery.context.map }));
    result.limitations.push({ code: NON_NFC_TEXT, partId: null, span,
      message: 'The canonical text is not in Unicode NFC; text, hashes and positions are unchanged.' });
    result.limitations.push({ code: NFC_DIAGNOSTICS.shadowMatching, partId: null, span,
      message: 'Recognition used an NFC shadow with exact position mapping to the original text; the result stays partial and carries no positive selection.' });
    result.status = 'partial';
  } else if (textNonNfc || isNonNfcText(raw) || seen.decodedAttributeNonNfc) {
    const where = seen.decodedAttributeNonNfc ? 'A decoded HTML attribute (e.g. a class name written with character references)'
      : textNonNfc ? 'The canonical text' : 'The supplied representation (markup or attributes)';
    result.limitations.push({ code: NON_NFC_TEXT, partId: null, span: textNonNfc ? span : null,
      message: `${where} is not in Unicode NFC. Entity and relation extraction was not performed for this document (temporary Unicode containment); text and positions are unchanged.` });
    const decision = seen.recovery;
    if (decision?.mode === 'quarantine' && decision.code !== NON_NFC_TEXT) {
      result.limitations.push({ code: decision.code, partId: null, span: textNonNfc ? span : null,
        message: `NFC recovery is not supported for this document: ${decision.detail.replace(/\.+$/u, '')}. The Unicode quarantine stays in force.` });
    }
    result.status = 'partial';
  }
  return result;
}

type ReaderSignals = { decodedAttributeNonNfc: boolean; recovery: RecoveryDecision | undefined };
/** Recovery decision with every sourceMap span checked exact in the shadow (provenance boundaries are forced). */
function decideWithExactSourceMap(result: AnatomyReaderResult, decodedAttributeNonNfc: boolean): RecoveryDecision {
  const decision = decideRecovery(result.canonicalText, result.sourceMap.flatMap((entry) => [entry.span.start, entry.span.end]), decodedAttributeNonNfc);
  if (decision.mode !== 'recover') return decision;
  try {
    for (const entry of result.sourceMap) exactToShadow(decision.context, entry.span, 'sourceMap span');
  } catch (error) {
    if (error instanceof NfcQuarantineError) return { mode: 'quarantine', code: error.code, detail: error.message };
    throw error;
  }
  return decision;
}

function readSnapshot(input: AnatomyReaderInput, seen: ReaderSignals): AnatomyReaderResult {
  const rules = input.rules ?? defaultRules(input.source);
  assertCompiledRules(rules);
  if (rules.source !== input.source) throw new TypeError(`Rules compiled for ${rules.source} cannot read ${input.source}`);
  const result: AnatomyReaderResult = { canonicalText: '', parts: [], sourceMap: [],
    coverage: { unit: 'UTF-16', textLength: 0, accountedLength: 0, recognizedLength: 0, segments: [], missingResources: [...(input.missingResources ?? [])] },
    limitations: [], status: 'complete' };
  const representation = input.html !== undefined ? 'html' : 'text';
  const raw = input.html ?? input.text ?? '';
  const childOrders = new Map<string | null, number>();
  const pointer = (locator: string, start: number | null = null, end: number | null = null): Pointer => ({
    resourceId: input.representationId, representation, locator,
    sourceSpan: start !== null && end !== null ? { start, end } : null,
  });
  const limitation = (code: string, message: string, span: { start: number; end: number } | null = null): void => {
    result.limitations.push({ code, message, partId: null, span }); result.status = 'partial';
  };
  // Sequential ids exclude derived caput parts (ANAT-STRUCT-02), so adding a caput never renumbers other parts.
  let partSeq = 0;
  // ANAT-D02 (decided by Fábio: fix now): unmarked continuation blocks right after the caput block belong to the caput,
  // until the article/clause receives any other child (§, inciso, table, note...); R2-08: any
  // new child created through newPart (tables included) closes it, so the rule does not depend on the attach path. Keyed by the article/clause id.
  const openCaput = new Map<string, AnatomyPart>();
  const newPart = (type: AnatomyPart['type'], start: number, end: number, parentId: string | null,
    context: AnatomyPart['context'], reason: string, origin: Pointer, label = ''): AnatomyPart => {
    const part: AnatomyPart = { id: `part-${partSeq++}`, parentId,
      order: childOrders.get(parentId) ?? 0, type, label,
      span: { start, end }, sourcePointers: [origin], recognition: type === 'unidentified' ? 'unidentified' : 'explicit',
      ruleId: `reader/v1/${reason}`, confidence: type === 'unidentified' ? 0 : 1,
      coverage: type === 'unidentified' ? 'unidentified' : 'complete', context, contextReasons: [reason], legalStatus: 'unknown', table: null };
    if (parentId !== null) openCaput.delete(parentId);
    childOrders.set(parentId, part.order + 1); result.parts.push(part); return part;
  };
  const fallback = (code: string, message: string): AnatomyReaderResult => {
    // Preserve every original unit as unknown rather than silently truncate hostile/unsupported input.
    result.canonicalText = raw;
    const root = newPart('document', 0, raw.length, null, 'unknown', 'document', pointer('/'));
    const child = newPart('unidentified', 0, raw.length, root.id, 'unknown', 'raw_fallback', pointer('/', 0, raw.length));
    if (raw.length) {
      result.sourceMap.push({ span: { ...child.span }, pointer: pointer('/', 0, raw.length) });
      result.coverage.segments.push({ span: { ...child.span }, partId: child.id, classification: 'unidentified' });
    }
    result.coverage.textLength = raw.length; result.coverage.accountedLength = raw.length;
    limitation(code, message); return result;
  };
  if (Buffer.byteLength(raw, 'utf8') > ANATOMY_READER_LIMITS.maxBytes) return fallback('input_size_limit', 'Input exceeds the reader size limit; original representation retained as unidentified raw text.');
  if (!raw) return fallback('missing_body', 'No readable body supplied.');
  if (representation === 'text') return fallback('plain_text_unidentified', 'Plain text is accounted for without inventing structural markup.');

  const dom: Node = { tag: 'root', attrs: {}, path: '', start: 0, end: raw.length, children: [], text: null, span: { start: 0, end: 0 }, blocked: false };
  const stack = [dom]; let nodeCount = 0; let exceeded = false;
  const childCounts = new Map<Node, Map<string, number>>();
  const childIndex = (parent: Node, name: string): number => {
    const counts = childCounts.get(parent) ?? new Map<string, number>();
    const index = (counts.get(name) ?? 0) + 1;
    counts.set(name, index); childCounts.set(parent, counts); return index;
  };
  const parser = new Parser({
    onopentag(tag, attrs) {
      if (++nodeCount > ANATOMY_READER_LIMITS.maxNodes || stack.length > ANATOMY_READER_LIMITS.maxDepth) { exceeded = true; parser.pause(); return; }
      const parent = stack[stack.length - 1]!;
      // Every decoded attribute name/value is checked (a superset of the class attributes the reader consumes).
      if (!seen.decodedAttributeNonNfc && Object.entries(attrs).some(([k, v]) => isNonNfcText(k) || isNonNfcText(v))) seen.decodedAttributeNonNfc = true;
      const index = childIndex(parent, tag);
      if (parent.path.length + tag.length + 16 > 4096) { exceeded = true; parser.pause(); return; }
      const node: Node = { tag, attrs, path: `${parent.path}/${tag}[${index}]`, start: parser.startIndex,
        end: parser.endIndex + 1, children: [], text: null, span: { start: 0, end: 0 }, blocked: parent.blocked || excluded.has(tag) };
      parent.children.push(node); stack.push(node);
    },
    ontext(text) {
      if (++nodeCount > ANATOMY_READER_LIMITS.maxNodes) { exceeded = true; parser.pause(); return; }
      const parent = stack[stack.length - 1]!;
      parent.children.push({ tag: '#text', attrs: {}, path: `${parent.path}/text()[${childIndex(parent, '#text')}]`,
        start: parser.startIndex, end: parser.endIndex + 1, children: [], text, span: { start: 0, end: 0 }, blocked: parent.blocked });
    },
    onclosetag() { if (stack.length > 1) stack.pop()!.end = parser.endIndex + 1; },
  }, { decodeEntities: true, lowerCaseTags: true });
  try { parser.end(raw); } catch { return fallback('html_parse_failure', 'HTML parse failed; original representation retained as unidentified.'); }
  if (exceeded) return fallback('html_complexity_limit', 'HTML exceeds the depth/node limit; original representation retained as unidentified.');

  const append = (text: string, origin: Pointer): void => {
    if (!text) return;
    const start = result.canonicalText.length; result.canonicalText += text;
    result.sourceMap.push({ span: { start, end: result.canonicalText.length }, pointer: origin });
  };
  const render = (node: Node): void => {
    node.span.start = result.canonicalText.length;
    if (node.blocked) {
      if (!excluded.has(node.tag) || node.tag === 'head') return;
      limitation('excluded_executable_content', `Excluded non-readable HTML element ${node.tag}; original representation remains the source.`);
    } else if (node.text !== null) append(node.text, pointer(node.path, node.start, node.end));
    else {
      if (node.tag === 'img') limitation('image_without_ocr', 'Image content was not read; OCR is outside this reader.');
      for (const child of node.children) render(child);
      if (node.tag === 'br' || blocks.has(node.tag)) append('\n', pointer(`${node.path}/separator`));
    }
    node.span.end = result.canonicalText.length;
  };
  render(dom);
  const length = result.canonicalText.length;
  // UNICODE-01b/B2: for a non-NFC canonical text, decide recovery before any matcher runs. Matchers then read each
  // block through the shadow (text nodes mapped exactly); structure, spans, labels and attributes stay original.
  let matchText: (node: Node) => string = textOf;
  if (isNonNfcText(result.canonicalText)) {
    seen.recovery = decideWithExactSourceMap(result, seen.decodedAttributeNonNfc);
    if (seen.recovery.mode === 'recover') {
      const context = seen.recovery.context;
      matchText = (node: Node): string => {
        const stack = [node]; let text = '';
        while (stack.length) {
          const next = stack.pop()!;
          if (next.blocked) continue;
          if (next.text !== null) { const s = exactToShadow(context, next.span, 'text node'); text += context.map.shadow.slice(s.start, s.end); }
          else for (let i = next.children.length - 1; i >= 0; i--) stack.push(next.children[i]!);
        }
        return text;
      };
    }
  }
  if (!result.canonicalText.trim()) limitation('missing_readable_body', 'The supplied representation contains no readable body.');
  const root = newPart('document', 0, length, null, 'operative_candidate', 'document', pointer('/'));
  const logical: { part: AnatomyPart; rank: number }[] = [{ part: root, rank: 0 }];
  let annexHistorical = false;
  const ownership: { start: number; end: number; part: AnatomyPart }[] = [];
  const addOwnership = (part: AnatomyPart): void => { if (part.span.end > part.span.start) ownership.push({ ...part.span, part }); };
  // ANAT-STRUCT-01 R1-A / R2-01: the highest grouping level used in the body (outside any annex). A grouping heading of
  // that level or above, met while an annex is open, is a CANDIDATE return to the body. The level alone is not proof:
  // the annex closes only on structural evidence — (a) the annex heading sits inside its own DOM container and the new
  // heading is outside it, or (b) the annex is a historical zone (by class) and the new heading is not. Without evidence
  // the heading stays inside the annex and the ambiguity is recorded (`annex_return_ambiguous`), never resolved silently.
  let bodyTopGroupRank: number | null = null;
  const itemNumbers = new Map<string, string>();
  let annexContainer: string | null = null;
  const containerOf = (path: string): string | null => {
    const parentPath = path.slice(0, path.lastIndexOf('/'));
    // The annex container is its DOM parent unless that parent is the document root, <html> or <body> (no own container).
    return parentPath === '' || /\/(?:body|html)\[\d+\]$/u.test(parentPath) ? null : parentPath;
  };
  const insideAnnex = () => logical.some((entry) => entry.part.type === 'annex');
  const attach = (node: Node, desc: Descriptor): AnatomyPart => {
    if (desc.type === 'group' && insideAnnex() && bodyTopGroupRank !== null && desc.rank <= bodyTopGroupRank) {
      const leftContainer = annexContainer !== null && !node.path.startsWith(`${annexContainer}/`);
      const leftHistorical = annexHistorical && desc.context !== 'historical';
      if (leftContainer || leftHistorical) {
        while (logical.length > 1) logical.pop()!.part.span.end = node.span.start;
        annexHistorical = false; annexContainer = null;
      } else {
        limitation('annex_return_ambiguous', 'A grouping heading at the body top level appears inside an open annex with no structural evidence of a return to the body; it was kept inside the annex.', { ...node.span });
      }
    }
    if (desc.type === 'group' && !insideAnnex()) bodyTopGroupRank = Math.min(bodyTopGroupRank ?? desc.rank, desc.rank);
    if (desc.rank < 100) {
      while (logical.length > 1 && logical[logical.length - 1]!.rank >= desc.rank) logical.pop()!.part.span.end = node.span.start;
    }
    // R2-02: a sub-item (1.1., 2.1.1.) nests only under the item whose number is its exact prefix. Depth alone is not
    // proof: with no matching parent the open items are closed, the sub-item attaches to the enclosing device and the
    // missing parent is recorded (`item_parent_missing`); the text is never lost or given an incompatible parent.
    let itemParentMissing = false;
    if (desc.type === 'item' && desc.itemNumber?.includes('.')) {
      const expected = desc.itemNumber.slice(0, desc.itemNumber.lastIndexOf('.'));
      const top = logical[logical.length - 1]!.part;
      if (top.type !== 'item' || itemNumbers.get(top.id) !== expected) {
        while (logical.length > 1 && logical[logical.length - 1]!.part.type === 'item') logical.pop()!.part.span.end = node.span.start;
        itemParentMissing = true;
        limitation('item_parent_missing', `Item ${desc.itemNumber} has no open parent item ${expected}; attached to the enclosing device.`, { ...node.span });
      }
    }
    const parent = logical[logical.length - 1]!.part;
    if (desc.type === 'annex') { annexHistorical = desc.context === 'historical'; annexContainer = containerOf(node.path); }
    let context = desc.context;
    const reasons = [desc.reason];
    if (annexHistorical || parent.context === 'historical') {
      reasons.push('historical_ancestor');
      if (context === 'operative_candidate') context = 'historical';
    }
    const caputOpen = openCaput.get(parent.id);
    const continuesCaput = caputOpen !== undefined && desc.rank >= 100 && (desc.type === 'unidentified' || desc.type === 'body')
      && desc.context !== 'prohibited' && node.span.end > node.span.start;
    if (continuesCaput) {
      caputOpen.span.end = node.span.end;
      caputOpen.sourcePointers.push(pointer(node.path, node.start, node.end));
      if (!caputOpen.contextReasons.includes('caput_continuation')) caputOpen.contextReasons.push('caput_continuation');
    }
    const part = newPart(desc.type, node.span.start, desc.rank < 100 ? length : node.span.end, continuesCaput ? caputOpen.id : parent.id,
      context, desc.reason, pointer(node.path, node.start, node.end), textOf(node).trim().slice(0, 256));
    if (itemParentMissing) reasons.push('item_parent_missing');
    part.contextReasons = reasons;
    if (desc.itemNumber) itemNumbers.set(part.id, desc.itemNumber);
    if (desc.rank < 100) logical.push({ part, rank: desc.rank });
    // ANAT-STRUCT-02: the opening block of an article or clause is its caput, a structural child over exactly that
    // block. Ownership (entities, selections) stays with the article/clause, so their partIds do not change.
    if ((desc.type === 'article' || desc.type === 'clause') && node.span.end > node.span.start) {
      const caput: AnatomyPart = { ...part, id: `${part.id}-caput`, parentId: part.id, order: childOrders.get(part.id) ?? 0, type: 'caput',
        span: { ...node.span }, sourcePointers: [pointer(node.path, node.start, node.end)], ruleId: 'reader/v1/caput_block',
        contextReasons: [...reasons.filter((r) => r !== desc.reason), 'caput_block'], table: null };
      childOrders.set(part.id, caput.order + 1); result.parts.push(caput); openCaput.set(part.id, caput);
    }
    // The marker owns only its own text, not the whole future logical container.
    if (node.span.end > node.span.start) ownership.push({ ...node.span, part });
    return part;
  };
  type DomContext = 'operative_candidate' | 'historical' | 'prohibited';
  // DOM zones inherited from editorial classes are a fixed CONFAZ behaviour (subtree class scope).
  const zones = rules.classScope === 'subtree';
  const domContext = (node: Node, inherited: DomContext): DomContext => {
    const ownClasses = (node.attrs.class ?? '').split(/\s+/);
    if (inherited === 'prohibited' || node.tag === 'blockquote' || node.tag === 'q'
      || (zones && ownClasses.some((name) => rules.classes.epigraph.includes(name) || rules.classes.summary.includes(name)))) return 'prohibited';
    if (inherited === 'historical' || (zones && ownClasses.some((name) => rules.classes.historical.has(name)))) return 'historical';
    if (zones && ownClasses.some((name) => rules.classes.editorialNote.has(name))) return 'prohibited';
    return 'operative_candidate';
  };
  const hasInlineQuote = (node: Node): boolean => {
    const pending = [...node.children];
    while (pending.length) {
      const current = pending.pop()!;
      if (current.tag === 'q' || current.tag === 'blockquote') return true;
      // Nested tables are handled independently; do not taint an outer cell for a distinct inner table.
      if (current.tag !== 'table') pending.push(...current.children);
    }
    return false;
  };
  const table = (node: Node, suppliedParent?: AnatomyPart, inheritedContext: DomContext = 'operative_candidate'): void => {
    const parent = suppliedParent ?? logical[logical.length - 1]!.part;
    const structuralContext = domContext(node, inheritedContext);
    const tableContext = structuralContext === 'prohibited' || parent.context === 'prohibited' || openQuotation ? 'prohibited'
      : structuralContext === 'historical' || annexHistorical || parent.context === 'historical' ? 'historical' : 'operative_candidate';
    const tablePart = newPart('table', node.span.start, node.span.end, parent.id,
      tableContext, 'table', pointer(node.path, node.start, node.end));
    if (tableContext !== 'operative_candidate') tablePart.contextReasons.push('inherited_dom_zone');
    addOwnership(tablePart);
    const rowNodes: { node: Node; context: DomContext }[] = [];
    const visitRows = (current: Node, inherited: DomContext): void => {
      for (const child of current.children) {
        const context = domContext(child, inherited);
        if (child.tag === 'tr') rowNodes.push({ node: child, context });
        else if (child.tag !== 'table') visitRows(child, context);
      }
    };
    visitRows(node, tableContext);
    const occupied = new Map<number, number>();
    rowNodes.forEach(({ node: row, context: rowContext }, rowIndex) => {
      const rp = newPart('row', row.span.start, row.span.end, tablePart.id, rowContext, 'table_row', pointer(row.path, row.start, row.end));
      if (rowContext !== 'operative_candidate') rp.contextReasons.push('inherited_dom_zone');
      addOwnership(rp); let column = 0;
      for (const cell of row.children.filter((child) => child.tag === 'td' || child.tag === 'th')) {
        while ((occupied.get(column) ?? 0) > rowIndex) column++;
        const parseSpan = (value: string | undefined): number | null => value === undefined ? 1 : /^[1-9]\d{0,3}$/.test(value) ? Number(value) : null;
        const rowSpan = parseSpan(cell.attrs.rowspan); const columnSpan = parseSpan(cell.attrs.colspan);
        const inlineQuote = hasInlineQuote(cell);
        const ownCellContext = domContext(cell, rowContext);
        const cellHistorical = zones && classesOf(cell).some((name) => rules.classes.historical.has(name));
        const cellContext = inlineQuote || ownCellContext === 'prohibited' ? 'prohibited' : cellHistorical ? 'historical' : ownCellContext;
        const cp = newPart('cell', cell.span.start, cell.span.end, rp.id, cellContext, 'table_cell', pointer(cell.path, cell.start, cell.end));
        if (cellContext !== 'operative_candidate') cp.contextReasons.push('inherited_dom_zone');
        if (inlineQuote) { cp.contextReasons.push('inline_quote_conservative_exclusion'); limitation('inline_quote_conservative_exclusion', 'Inline quoted content excludes its entire containing cell; no operative selection is inferred.', cp.span); }
        const collision = Array.from({ length: columnSpan ?? 1 }, (_, i) => column + i).some((c) => (occupied.get(c) ?? 0) > rowIndex);
        const unknown = rowSpan === null || columnSpan === null || collision;
        cp.table = { row: rowIndex, column, rowSpan: rowSpan ?? 1, columnSpan: columnSpan ?? 1, geometry: unknown ? 'unknown' : 'original' };
        if (unknown) { cp.coverage = 'partial'; limitation('table_geometry_unknown', 'Invalid or conflicting table geometry preserved without guessing.', cp.span); }
        for (let c = column; c < column + (columnSpan ?? 1); c++) occupied.set(c, rowIndex + (rowSpan ?? 1));
        column += columnSpan ?? 1; addOwnership(cp);
        const nestedTables: { node: Node; context: DomContext }[] = [];
        const findNested = (current: Node, inherited: DomContext): void => {
          for (const child of current.children) {
            const context = domContext(child, inherited);
            if (child.tag === 'table') nestedTables.push({ node: child, context });
            else findNested(child, context);
          }
        };
        findNested(cell, cellContext);
        for (const nested of nestedTables) table(nested.node, cp, nested.context);
      }
    });
  };
  let openQuotation = false;
  // ANAT-D04: RFB segment types declared by the source document (`data-rfb-*` written by prepareRfbRepresentation from
  // its own tiposSegmento table). The text grammar stays first; a declared type only fills a block the grammar left
  // unidentified. A declared type that contradicts the grammar, a missing/unknown/conflicting type, or the source's own
  // "não identificado" type is recorded as a limitation, never guessed. tachado → context historical
  // (rfb_tachado_source); legalStatus is never touched.
  type RfbSeg = { type: string | null; issue: string | null; tachado: boolean; pointer: string | null };
  const RFB_TYPE: Record<string, Descriptor['type']> = { artigo: 'article', paragrafo: 'paragraph', inciso: 'inciso', alinea: 'alinea',
    item: 'item', ementa: 'summary', fecho: 'signature', capitulo: 'group', secao: 'group', subsecao: 'group', titulo: 'group', livro: 'group' };
  const RFB_GROUP_WORD: Record<string, string> = { capitulo: 'CAPITULO', secao: 'SECAO', subsecao: 'SUBSECAO', titulo: 'TITULO', livro: 'LIVRO' };
  const RFB_RANK: Partial<Record<Descriptor['type'], number>> = { article: 3, paragraph: 4, inciso: 5, alinea: 6, item: 7, summary: 100, signature: 100 };
  const rfbDeclared = (seg: RfbSeg, current: Descriptor, span: { start: number; end: number }): Descriptor => {
    if (seg.issue) { limitation(`rfb_segment_${seg.issue}`, `RFB segment ${seg.pointer ?? '?'}: declared type ${seg.issue.replace(/_/gu, ' ')}; no type was guessed.`, span); return current; }
    const sig = (seg.type ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
    if (!sig) return current;
    if (sig.startsWith('nao identific')) { if (current.type === 'unidentified') limitation('rfb_segment_type_unidentified_by_source', `RFB segment ${seg.pointer ?? '?'}: the source itself declares the type as not identified.`, span); return current; }
    const mapped = RFB_TYPE[sig];
    if (!mapped) { if (current.type === 'unidentified') limitation('rfb_segment_type_unmapped', `RFB segment ${seg.pointer ?? '?'}: declared type "${seg.type}" has no structural mapping.`, span); return current; }
    if (current.type === 'unidentified') {
      if (mapped === 'group') { const [level, rank] = groupLevel(RFB_GROUP_WORD[sig]!); return { type: 'group', context: current.context === 'unknown' ? 'operative_candidate' : current.context, reason: `rfb_declared_group_${level}`, rank }; }
      const ctx = mapped === 'summary' || mapped === 'signature' ? 'prohibited' as const : 'operative_candidate' as const;
      return { type: mapped, context: ctx, reason: `rfb_declared_${sig}`, rank: RFB_RANK[mapped]! };
    }
    if (current.type !== mapped && !(current.type === 'preamble' && mapped === 'summary')) limitation('rfb_segment_type_conflict', `RFB segment ${seg.pointer ?? '?'}: text grammar found ${current.type}, source declares "${seg.type}"; the text grammar result is kept.`, span);
    return current;
  };
  const walk = (node: Node, inheritedContext: DomContext = 'operative_candidate', quotedAncestor = false, rfbSeg: RfbSeg | null = null): void => {
    if (node.blocked || node.text !== null) return;
    const context = domContext(node, inheritedContext);
    if (node.tag === 'table') { table(node, undefined, context); return; }
    const hasBlock = node.children.some((child) => blocks.has(child.tag));
    if (input.source === 'RFB' && node.attrs['data-rfb-segment'] !== undefined) rfbSeg = { type: node.attrs['data-rfb-type'] ?? null, issue: node.attrs['data-rfb-type-issue'] ?? null,
      tachado: node.attrs['data-rfb-tachado'] === 'true', pointer: `ordemSegmentoAto ${node.attrs['data-rfb-segment']}` };
    const quotedDom = quotedAncestor || node.tag === 'blockquote' || node.tag === 'q';
    if (blocks.has(node.tag) && !hasBlock && node.span.end > node.span.start) {
      const text = matchText(node).trim();
      const inlineQuote = hasInlineQuote(node);
      const wasQuoted = openQuotation || inlineQuote || quotedDom;
      if (rules.quoteOpen.test(text)) openQuotation = true;
      let descriptor: Descriptor = wasQuoted || openQuotation
        ? { type: 'quoted_text' as const, context: 'prohibited' as const, reason: 'quoted_block', rank: 100 }
        : describe(node, rules, matchText);
      if (rfbSeg && !wasQuoted && !openQuotation) descriptor = rfbDeclared(rfbSeg, descriptor, node.span);
      const rfbStruck = rfbSeg?.tachado === true;
      if (rfbStruck && descriptor.context === 'operative_candidate') descriptor = { ...descriptor, context: 'historical' };
      if (descriptor.type !== 'unidentified' && context !== 'operative_candidate') descriptor.context = context;
      if (wasQuoted || openQuotation) descriptor.context = 'prohibited';
      const part = attach(node, descriptor);
      if (context !== 'operative_candidate') part.contextReasons.push('inherited_dom_zone');
      if (rfbStruck) part.contextReasons.push('rfb_tachado_source');
      if (inlineQuote) { part.contextReasons.push('inline_quote_conservative_exclusion'); limitation('inline_quote_conservative_exclusion', 'Inline quoted content excludes its entire containing block; no operative selection is inferred.', node.span); }
      if (rules.quoteClose.test(text) && !rules.quoteOnly.test(text)) openQuotation = false;
      return;
    }
    for (const child of node.children) walk(child, context, quotedDom, rfbSeg);
  };
  walk(dom);
  // Logical containers extend until their next sibling marker; all open containers end with the document.
  for (const open of logical) open.part.span.end = length;
  // Exclusive ownership uses the smallest structural span; uncovered raw text stays explicitly unknown.
  const boundaries = [...new Set([0, length, ...ownership.flatMap((item) => [item.start, item.end])])].sort((a, b) => a - b);
  const starts = new Map<number, typeof ownership>(); const ends = new Map<number, typeof ownership>();
  for (const item of ownership) {
    starts.set(item.start, [...(starts.get(item.start) ?? []), item]);
    ends.set(item.end, [...(ends.get(item.end) ?? []), item]);
  }
  const active = new Map<string, (typeof ownership)[number]>();
  let unidentified: AnatomyPart | null = null;
  for (let i = 1; i < boundaries.length; i++) {
    const start = boundaries[i - 1]!; const end = boundaries[i]!;
    if (end === start) continue;
    for (const item of ends.get(start) ?? []) active.delete(item.part.id);
    for (const item of starts.get(start) ?? []) active.set(item.part.id, item);
    const owners = [...active.values()];
    const owner = owners.sort((a, b) => (a.end - a.start) - (b.end - b.start) || Number(b.part.id.slice(5)) - Number(a.part.id.slice(5)))[0]?.part;
    if (!owner) {
      // Avoid overlapping siblings: uncovered pieces belong to the root, whose recognition is only structural.
      result.coverage.segments.push({ span: { start, end }, partId: root.id, classification: 'unidentified' });
    } else {
      if (owner.type === 'unidentified') unidentified = owner;
      const classification = owner.type === 'unidentified' ? 'unidentified' : 'recognized';
      result.coverage.segments.push({ span: { start, end }, partId: owner.id, classification });
      if (classification === 'recognized') result.coverage.recognizedLength += end - start;
    }
  }
  result.coverage.textLength = length; result.coverage.accountedLength = length;
  if (unidentified || result.coverage.segments.some((segment) => segment.classification === 'unidentified')) limitation('unidentified_content', 'Unrecognized text is fully accounted for and is not a successful identification.');
  if (result.coverage.missingResources.length) limitation('missing_resources', 'Referenced resources were not supplied; no fetch was attempted.');
  return result;
}

/** Explicit NCM header columns only (profile `ncm.columnHeaders`); blockers (`ncm.columnBlockers`) close a column. */
export function identifyNcmPartIds(result: Pick<AnatomyReaderResult, 'parts' | 'canonicalText'>, rules: CompiledRules = defaultRules('DOE-SP')): string[] {
  assertCompiledRules(rules);
  // UNICODE-01b/B2: for a recovered result, header cells are read through the reader's own NFC shadow (exact spans).
  const context = shadowContextOf(result);
  const headerText = (span: { start: number; end: number }): string => {
    if (!context) return result.canonicalText.slice(span.start, span.end);
    const s = exactToShadow(context, span, 'header cell');
    return context.map.shadow.slice(s.start, s.end);
  };
  const ids: string[] = [];
  const children = new Map<string, AnatomyPart[]>();
  for (const part of result.parts) if (part.parentId !== null) {
    const group = children.get(part.parentId) ?? []; group.push(part); children.set(part.parentId, group);
  }
  for (const table of result.parts.filter((part) => part.type === 'table')) {
    const columns = new Set<number>();
    for (const row of (children.get(table.id) ?? []).filter((part) => part.type === 'row')) {
      for (const cell of (children.get(row.id) ?? []).filter((part) => part.type === 'cell')) {
        if (!cell.table || cell.table.geometry === 'unknown' || cell.table.columnSpan !== 1) continue;
        const text = headerText(cell.span).trim();
        if (rules.ncmHeader.test(text)) columns.add(cell.table.column);
        else if (rules.ncmBlocker.test(text)) columns.delete(cell.table.column);
        else if (columns.has(cell.table.column)) ids.push(cell.id);
      }
    }
  }
  return ids;
}
