import { Parser } from 'htmlparser2';
import type { AnatomyPart, AnatomyResult } from './contract.js';

export interface AnatomyReaderInput {
  source: 'CONFAZ' | 'DOU' | 'DOE-SP' | 'RFB';
  representationId: string;
  html?: string | undefined;
  text?: string | undefined;
  missingResources?: string[];
}
export type AnatomyReaderResult = Pick<AnatomyResult, 'canonicalText' | 'parts' | 'sourceMap' | 'coverage' | 'limitations' | 'status'>;
export const ANATOMY_READER_LIMITS = Object.freeze({ maxBytes: 2 * 1024 * 1024, maxDepth: 128, maxNodes: 50_000 });
type Pointer = AnatomyPart['sourcePointers'][number];
type Node = { tag: string; attrs: Record<string, string>; path: string; start: number; end: number;
  children: Node[]; text: string | null; span: { start: number; end: number }; blocked: boolean };
type Descriptor = { type: AnatomyPart['type']; context: AnatomyPart['context']; reason: string; rank: number };
const blocks = new Set(['p', 'div', 'section', 'h1', 'h2', 'h3', 'h4', 'li', 'table', 'tr', 'td', 'th', 'article']);
const excluded = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'object', 'head']);
const historical = /^(?:RedaoAnt|RemissoAnt|A8-2RemissaoAnt|A8-3RedacaoAnt)$/;
const notes = /^(?:DataPublicao|A2DataPublicacao|Remisso|RemissoAnt|A8-1Remissao|A8-2RemissaoAnt)$/;
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
function describe(node: Node, source: AnatomyReaderInput['source']): Descriptor {
  const confaz = source === 'CONFAZ';
  const dou = source === 'DOU';
  const text = textOf(node).trim();
  const classes = classesOf(node);
  const own = (node.attrs.class ?? '').split(/\s+/);
  const hist = confaz && classes.some((name) => historical.test(name));
  const context = hist ? 'historical' : 'operative_candidate';
  if (confaz && classes.includes('TituloAcordo')) return { type: 'epigraph', context: 'prohibited', reason: 'confaz_epigraph', rank: 100 };
  if (confaz && classes.includes('Ementa')) return { type: 'summary', context: 'prohibited', reason: 'confaz_summary', rank: 100 };
  if (confaz && classes.some((name) => notes.test(name))) return { type: 'editorial_note', context: hist ? 'historical' : 'prohibited', reason: 'confaz_editorial_note', rank: 100 };
  // DOU official INLABS classes on the block itself describe position, never legal status.
  if (dou && own.includes('identifica')) return { type: 'epigraph', context: 'prohibited', reason: 'dou_identifica', rank: 100 };
  if (dou && own.includes('ementa')) return { type: 'summary', context: 'prohibited', reason: 'dou_ementa', rank: 100 };
  if (dou && own.includes('assina')) return { type: 'signature', context: 'prohibited', reason: 'dou_assina', rank: 100 };
  if (dou && own.includes('cargo')) return { type: 'signature', context: 'prohibited', reason: 'dou_cargo', rank: 100 };
  // Rectification wording quotes another act: original and corrected text both stay out of positive selection.
  if (dou && /^Onde\s+se\s+l[êe](?![\p{L}\p{N}])/iu.test(text)) return { type: 'quoted_text', context: 'prohibited', reason: 'dou_rectification_original', rank: 100 };
  if (dou && /^Leia-se(?![\p{L}\p{N}])/iu.test(text)) return { type: 'quoted_text', context: 'prohibited', reason: 'dou_rectification_corrected', rank: 100 };
  if (/^\s*["“]/u.test(text)) return { type: 'quoted_text', context: hist ? 'historical' : 'prohibited', reason: 'quoted_block', rank: 100 };
  if (/^(?:O\s+(?:Conselho|Ministro|Secret[áa]rio|Governador|Presidente)|A\s+(?:Secret[áa]ria|Receita Federal)|CONSIDERANDO\b)/iu.test(text)) return { type: 'preamble', context: hist ? 'historical' : 'prohibited', reason: 'preamble_marker', rank: 100 };
  // Only block-initial markers are recognized. A reference to an annex in prose is not a heading.
  if (/^ANEXO\s+(?:[IVXLCDM]+|[0-9]+)(?:\s*[-–—:(]|\s*$)/iu.test(text)) return { type: 'annex', context, reason: 'annex_heading', rank: 2 };
  if (/^Cl[áa]usula\s+(?:primeira|segunda|terceira|quarta|quinta|sexta|s[ée]tima|oitava|nona|d[ée]cima|\d+)/iu.test(text)) return { type: 'clause', context, reason: 'clause_marker', rank: 3 };
  if (/^(?:Art(?:igo|\.)\s*\d+[ºo°]?)/iu.test(text)) return { type: 'article', context, reason: 'article_marker', rank: 3 };
  if (/^(?:§\s*\d+|Par[áa]grafo\s+[úu]nico)/iu.test(text)) return { type: 'paragraph', context, reason: 'paragraph_marker', rank: 4 };
  if (/^[IVXLCDM]+\s*[-–—]/u.test(text)) return { type: 'inciso', context, reason: 'inciso_marker', rank: 5 };
  if (/^[a-z]\)\s/u.test(text)) return { type: 'alinea', context, reason: 'alinea_marker', rank: 6 };
  if (confaz && classes.some((name) => /^(?:TextoAcordo|A5-1TextoAcordo|RedaoAnt|A8-3RedacaoAnt)$/.test(name))) return { type: 'body', context, reason: hist ? 'confaz_historical_wording' : 'confaz_text_class', rank: 100 };
  return { type: 'unidentified', context: 'unknown', reason: 'unrecognized_block', rank: 100 };
}

/** Pure snapshot reader. It never fetches resources, infers current legal status, or grants eligibility. */
export function readAnatomyInput(input: AnatomyReaderInput): AnatomyReaderResult {
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
  const newPart = (type: AnatomyPart['type'], start: number, end: number, parentId: string | null,
    context: AnatomyPart['context'], reason: string, origin: Pointer, label = ''): AnatomyPart => {
    const part: AnatomyPart = { id: `part-${result.parts.length}`, parentId,
      order: childOrders.get(parentId) ?? 0, type, label,
      span: { start, end }, sourcePointers: [origin], recognition: type === 'unidentified' ? 'unidentified' : 'explicit',
      ruleId: `reader/v1/${reason}`, confidence: type === 'unidentified' ? 0 : 1,
      coverage: type === 'unidentified' ? 'unidentified' : 'complete', context, contextReasons: [reason], legalStatus: 'unknown', table: null };
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
  if (!result.canonicalText.trim()) limitation('missing_readable_body', 'The supplied representation contains no readable body.');
  const root = newPart('document', 0, length, null, 'operative_candidate', 'document', pointer('/'));
  const logical: { part: AnatomyPart; rank: number }[] = [{ part: root, rank: 0 }];
  let annexHistorical = false;
  const ownership: { start: number; end: number; part: AnatomyPart }[] = [];
  const addOwnership = (part: AnatomyPart): void => { if (part.span.end > part.span.start) ownership.push({ ...part.span, part }); };
  const attach = (node: Node, desc: Descriptor): AnatomyPart => {
    if (desc.rank < 100) {
      while (logical.length > 1 && logical[logical.length - 1]!.rank >= desc.rank) logical.pop()!.part.span.end = node.span.start;
    }
    const parent = logical[logical.length - 1]!.part;
    if (desc.type === 'annex') annexHistorical = desc.context === 'historical';
    let context = desc.context;
    const reasons = [desc.reason];
    if (annexHistorical || parent.context === 'historical') {
      reasons.push('historical_ancestor');
      if (context === 'operative_candidate') context = 'historical';
    }
    const part = newPart(desc.type, node.span.start, desc.rank < 100 ? length : node.span.end, parent.id,
      context, desc.reason, pointer(node.path, node.start, node.end), textOf(node).trim().slice(0, 256));
    part.contextReasons = reasons;
    if (desc.rank < 100) logical.push({ part, rank: desc.rank });
    // The marker owns only its own text, not the whole future logical container.
    if (node.span.end > node.span.start) ownership.push({ ...node.span, part });
    return part;
  };
  type DomContext = 'operative_candidate' | 'historical' | 'prohibited';
  const domContext = (node: Node, inherited: DomContext): DomContext => {
    const ownClasses = (node.attrs.class ?? '').split(/\s+/);
    if (inherited === 'prohibited' || node.tag === 'blockquote' || node.tag === 'q'
      || (input.source === 'CONFAZ' && ownClasses.some((name) => ['TituloAcordo', 'Ementa'].includes(name)))) return 'prohibited';
    if (inherited === 'historical' || (input.source === 'CONFAZ' && ownClasses.some((name) => historical.test(name)))) return 'historical';
    if (input.source === 'CONFAZ' && ownClasses.some((name) => notes.test(name))) return 'prohibited';
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
        const cellHistorical = input.source === 'CONFAZ' && classesOf(cell).some((name) => historical.test(name));
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
  const walk = (node: Node, inheritedContext: DomContext = 'operative_candidate', quotedAncestor = false): void => {
    if (node.blocked || node.text !== null) return;
    const context = domContext(node, inheritedContext);
    if (node.tag === 'table') { table(node, undefined, context); return; }
    const hasBlock = node.children.some((child) => blocks.has(child.tag));
    const quotedDom = quotedAncestor || node.tag === 'blockquote' || node.tag === 'q';
    if (blocks.has(node.tag) && !hasBlock && node.span.end > node.span.start) {
      const text = textOf(node).trim();
      const inlineQuote = hasInlineQuote(node);
      const wasQuoted = openQuotation || inlineQuote || quotedDom;
      if (/^[“"]/u.test(text)) openQuotation = true;
      const descriptor = wasQuoted || openQuotation
        ? { type: 'quoted_text' as const, context: 'prohibited' as const, reason: 'quoted_block', rank: 100 }
        : describe(node, input.source);
      if (descriptor.type !== 'unidentified' && context !== 'operative_candidate') descriptor.context = context;
      if (wasQuoted || openQuotation) descriptor.context = 'prohibited';
      const part = attach(node, descriptor);
      if (context !== 'operative_candidate') part.contextReasons.push('inherited_dom_zone');
      if (inlineQuote) { part.contextReasons.push('inline_quote_conservative_exclusion'); limitation('inline_quote_conservative_exclusion', 'Inline quoted content excludes its entire containing block; no operative selection is inferred.', node.span); }
      if (/[”"](?:\s*\(NR\)\.?)?\s*$/u.test(text) && !/^[“"]$/.test(text)) openQuotation = false;
      return;
    }
    for (const child of node.children) walk(child, context, quotedDom);
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

/** Explicit NCM header columns only. Generic CÓDIGO, NBM, SH or TIPI columns do not qualify. */
export function identifyNcmPartIds(result: Pick<AnatomyReaderResult, 'parts' | 'canonicalText'>): string[] {
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
        const text = result.canonicalText.slice(cell.span.start, cell.span.end).trim();
        if (/^(?:C[ÓO]DIGO\s+)?NCM(?:\s*\/\s*SH)?$/iu.test(text)) columns.add(cell.table.column);
        else if (/^(?:NBM|TIPI|SH|C[ÓO]DIGO)(?:\s*\/.*)?$/iu.test(text)) columns.delete(cell.table.column);
        else if (columns.has(cell.table.column)) ids.push(cell.id);
      }
    }
  }
  return ids;
}
