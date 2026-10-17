import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Parser } from 'htmlparser2';
import { prepareDouRepresentation } from '../../src/modules/anatomy/dou-preparation.js';
import { ANATOMY_GOLD_VERSION, validateAnatomyGold, type AnatomyGold } from '../../src/modules/anatomy/gold.js';
import { developmentCanonicalText } from './annotation-pack.js';

/**
 * Builds structural gold from a human-written spec (ops/anatomy/gold-specs/<id>.json).
 * Anchors are resolved against the frozen canonical text only; engine parts/entities are never consulted.
 * Table geometry is derived from the ORIGINAL markup by this independent walker (rowspan/colspan occupancy),
 * then located in the canonical text in reading order. Usage: tsx ops/anatomy/gold-build.ts <id> [...]
 */
type Span = { start: number; end: number };
type Anchor = { line: number } | { lines: [number, number] } | { text: string; nth?: number; from?: number };
type Part = AnatomyGold['parts'][number];
interface BlockSpec { id: string; type: Part['type']; at: Anchor; parent?: string; context: Part['context']; reason: string }
interface TableSpec { id: string; parent?: string; tableIndex: number; startLine: number; context: Part['context']; reason: string;
  classContext?: { historical: string[]; note: string[]; previousWordingNote?: string[] };
  headerRows?: number; headerDomains?: Record<string, string | null> }
interface EntitySpec { part: string; literal: string; nth?: number; domain: AnatomyGold['entities'][number]['domain']; note?: string; id?: string }
interface ColumnEntitySpec { table: string; column: number; pattern: string; domain: AnatomyGold['entities'][number]['domain']; note?: string; skipHeader?: boolean }
export interface Spec { id: string; annotator: string; annotatedAt: string; blocks: BlockSpec[]; tables?: TableSpec[]; entities?: EntitySpec[];
  columnEntities?: ColumnEntitySpec[]; textEntities?: { pattern: string; domain: AnatomyGold['entities'][number]['domain']; note?: string }[]; relations?: AnatomyGold['relations']; ranges?: boolean; exceptions?: boolean; headerDomainOverride?: boolean; review?: AnatomyGold['review']; gaps?: AnatomyGold['gaps']; notes?: string }

const root = new URL('../../', import.meta.url);
const frozen = JSON.parse(readFileSync(new URL('test/fixtures/anatomy/canonical/development.json', root), 'utf8')) as
  { entries: { id: string; source: 'CONFAZ' | 'DOU'; preparation: string; inputs: { path: string }[]; canonicalTextSha256: string; canonicalTextUtf16Length: number }[] };

interface Cell { row: number; column: number; rowSpan: number; columnSpan: number; chunks: string[]; classes: string[] }
interface Table { rows: Cell[][]; nested: boolean }

/** Independent walker over the original markup: top-level tables in document order, with grid occupancy. */
export function tablesOf(html: string): Table[] {
  const tables: Table[] = []; const stack: { table: Table; occupied: Set<string>; row: number; cell: Cell | null; rowClass: string }[] = [];
  let depth = 0;
  const parser = new Parser({
    onopentag(tag, attrs) {
      if (tag === 'table') {
        depth++;
        if (depth === 1) { const t: Table = { rows: [], nested: false }; tables.push(t); stack.push({ table: t, occupied: new Set(), row: -1, cell: null, rowClass: '' }); }
        else stack[0]!.table.nested = true;
        return;
      }
      if (depth !== 1) return;
      const s = stack[0]!;
      if (s.cell && attrs.class) s.cell.classes.push(...attrs.class.split(/\s+/));
      if (tag === 'tr') { s.row++; s.table.rows.push([]); s.rowClass = attrs.class ?? ''; }
      if ((tag === 'td' || tag === 'th') && s.row >= 0) {
        let column = 0; while (s.occupied.has(`${s.row}:${column}`)) column++;
        const rowSpan = Math.max(1, Number.parseInt(attrs.rowspan ?? '1', 10) || 1);
        const columnSpan = Math.max(1, Number.parseInt(attrs.colspan ?? '1', 10) || 1);
        for (let r = 0; r < rowSpan; r++) for (let c = 0; c < columnSpan; c++) s.occupied.add(`${s.row + r}:${column + c}`);
        s.cell = { row: s.row, column, rowSpan, columnSpan, chunks: [], classes: [...(attrs.class ?? '').split(/\s+/), ...s.rowClass.split(/\s+/)].filter(Boolean) }; s.table.rows[s.row]!.push(s.cell);
      }
    },
    ontext(text) { if (depth >= 1 && stack[0]?.cell && text.trim()) stack[0].cell.chunks.push(text.trim()); },
    onclosetag(tag) {
      if (tag === 'table') { depth--; if (depth === 0) stack.pop(); return; }
      if (depth === 1 && (tag === 'td' || tag === 'th')) stack[0]!.cell = null;
    },
  }, { decodeEntities: true });
  parser.write(html); parser.end();
  return tables;
}

/** `transform` lets tests derive a variant of the committed spec in memory; the CLI never uses it. */
export function buildGold(id: string, transform?: (spec: Spec) => Spec): AnatomyGold {
  const loaded = JSON.parse(readFileSync(new URL(`ops/anatomy/gold-specs/${id}.json`, root), 'utf8')) as Spec;
  const spec = transform ? transform(structuredClone(loaded)) : loaded;
  const entry = frozen.entries.find((e) => e.id === id);
  if (!entry) throw new Error(`${id} is not a frozen development entry`);
  const text = developmentCanonicalText(id);
  const lineStarts = [0]; for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const lineSpan = (n: number): Span => {
    const start = lineStarts[n - 1]; if (start === undefined) throw new Error(`${id}: line ${n} out of range`);
    const next = lineStarts[n]; return { start, end: next === undefined ? text.length : next - 1 };
  };
  const find = (needle: string, nth = 0, from = 0): Span => {
    let at = from - 1; for (let k = 0; k <= nth; k++) { at = text.indexOf(needle, at + 1); if (at < 0) throw new Error(`${id}: anchor not found: ${needle} (#${nth})`); }
    return { start: at, end: at + needle.length };
  };
  const resolve = (a: Anchor): Span => 'line' in a ? lineSpan(a.line) : 'lines' in a ? { start: lineSpan(a.lines[0]).start, end: lineSpan(a.lines[1]).end }
    : find(a.text, a.nth ?? 0, a.from === undefined ? 0 : lineSpan(a.from).start);

  const raw: (Omit<Part, 'order'> & { order?: number })[] = [{ id: 'doc', parentId: null, type: 'document', span: { start: 0, end: text.length }, context: 'unknown', contextReason: 'document', table: null }];
  for (const b of spec.blocks) raw.push({ id: b.id, parentId: b.parent ?? 'doc', type: b.type, span: resolve(b.at), context: b.context, contextReason: b.reason, table: null });

  const cellSpans = new Map<string, { cells: { id: string; cell: Cell; span: Span }[] }>();
  if (spec.tables?.length) {
    const html = entry.source === 'DOU'
      ? prepareDouRepresentation(entry.inputs.map((i) => ({ resourceId: i.path, bytes: new Uint8Array(readFileSync(new URL(i.path, root))) }))).html
      : readFileSync(new URL(entry.inputs[0]!.path, root), 'utf8');
    const tables = tablesOf(html); let lastTableEnd = 0;
    for (const t of spec.tables) {
      const table = tables[t.tableIndex]; if (!table) throw new Error(`${id}: table ${t.tableIndex} not found`);
      // Tables appear in reading order: never search before the end of the previous table.
      let cursor = Math.max(lineSpan(t.startLine).start, lastTableEnd); const rows: { id: string; span: Span }[] = []; const cells: { id: string; cell: Cell; span: Span }[] = [];
      table.rows.forEach((row, r) => {
        const rowCells: Span[] = [];
        row.forEach((cell, c) => {
          let span: Span;
          if (!cell.chunks.length) span = { start: cursor, end: cursor };
          else {
            const first = text.indexOf(cell.chunks[0]!, cursor); if (first < 0) throw new Error(`${id}: cell text not found r${r}c${c}: ${cell.chunks[0]}`);
            let end = first + cell.chunks[0]!.length;
            for (const chunk of cell.chunks.slice(1)) { const at = text.indexOf(chunk, end); if (at < 0) throw new Error(`${id}: cell chunk not found r${r}c${c}`); end = at + chunk.length; }
            span = { start: first, end };
          }
          cursor = span.end; rowCells.push(span); cells.push({ id: `${t.id}-r${r}c${c}`, cell, span });
        });
        const nonEmpty = rowCells.filter((s) => s.end > s.start);
        const span = nonEmpty.length ? { start: nonEmpty[0]!.start, end: nonEmpty[nonEmpty.length - 1]!.end } : { start: cursor, end: cursor };
        rows.push({ id: `${t.id}-r${r}`, span });
      });
      // Empty cells anchor inside their row so children stay within parents.
      for (const c of cells) if (c.span.start === c.span.end) { const row = rows[c.cell.row]!; if (c.span.start < row.span.start || c.span.start > row.span.end) c.span = { start: row.span.end, end: row.span.end }; }
      const tableSpan = { start: Math.min(...rows.map((r) => r.span.start)), end: Math.max(...rows.map((r) => r.span.end)) };
      lastTableEnd = tableSpan.end;
      raw.push({ id: t.id, parentId: t.parent ?? 'doc', type: 'table', span: tableSpan, context: t.context, contextReason: t.reason, table: null });
      for (const r of rows) raw.push({ id: r.id, parentId: t.id, type: 'row', span: r.span, context: t.context, contextReason: t.reason, table: null });
      const headerRows = t.headerRows ?? 1;
      // Official editorial classes inside the table mark note rows and previous wordings (never colour).
      // Rows right after a "previous wording" note row repeat the same item in its former wording.
      const afterNote = new Set<number>();
      if (t.classContext?.previousWordingNote) {
        const isNote = (r: number) => (table.rows[r] ?? []).some((c) => c.classes.some((x) => t.classContext!.note.includes(x)));
        const item = (r: number) => (table.rows[r]?.find((c) => c.column === 0)?.chunks.join(' ') ?? '').split(/\s/)[0];
        table.rows.forEach((row, r) => {
          if (!row.some((c) => c.classes.some((x) => t.classContext!.previousWordingNote!.includes(x)))) return;
          const first = r + 1; for (let k = first; k < table.rows.length && !isNote(k) && item(k) === item(first); k++) afterNote.add(k);
        });
      }
      const cellContext = (c: Cell): { context: Part['context']; reason: string } => {
        if (c.row < headerRows) return { context: t.context, reason: 'table_header' };
        const cc = t.classContext; if (!cc) return { context: t.context, reason: t.reason };
        if (t.context !== 'historical' && afterNote.has(c.row) && !c.classes.some((x) => cc.note.includes(x))) return { context: 'historical', reason: 'previous_wording_after_note' };
        const hist = t.context === 'historical' || c.classes.some((x) => cc.historical.includes(x));
        if (c.classes.some((x) => cc.note.includes(x))) return { context: hist ? 'historical' : 'prohibited', reason: 'editorial_note_row' };
        return hist ? { context: 'historical', reason: t.context === 'historical' ? t.reason : 'previous_wording_row' } : { context: t.context, reason: t.reason };
      };
      const rowContext = new Map<number, { context: Part['context']; reason: string }>();
      for (const c of cells) { const x = cellContext(c.cell); const prev = rowContext.get(c.cell.row);
        rowContext.set(c.cell.row, !prev ? x : prev.context === x.context && prev.reason === x.reason ? prev : { context: t.context, reason: 'mixed_row' }); }
      for (const r of raw.filter((x) => x.parentId === t.id && x.type === 'row')) { const x = rowContext.get(Number(r.id.slice(r.id.lastIndexOf('-r') + 2))); if (x) { r.context = x.context; r.contextReason = x.reason; } }
      for (const c of cells) raw.push({ id: c.id, parentId: `${t.id}-r${c.cell.row}`, type: 'cell', span: c.span, ...(() => { const x = cellContext(c.cell); return { context: x.context, contextReason: x.reason }; })(),
        table: { row: c.cell.row, column: c.cell.column, rowSpan: c.cell.rowSpan, columnSpan: c.cell.columnSpan, geometry: 'original',
          headerDomain: t.headerDomains?.[String(c.cell.column)] ?? null } });
      if (table.nested) (spec.gaps ??= []).push({ kind: 'uncertain_geometry', span: tableSpan, resource: null, note: `${t.id}: nested table content kept inside parent cells; not annotated as separate grid` });
      cellSpans.set(t.id, { cells });
    }
  }
  // Parents precede children; siblings ordered by position.
  const byId = new Map(raw.map((p) => [p.id, p]));
  const depthOf = (p: (typeof raw)[number]): number => { let d = 0; let cur = p; while (cur.parentId) { cur = byId.get(cur.parentId)!; d++; } return d; };
  raw.sort((a, b) => depthOf(a) - depthOf(b) || a.span.start - b.span.start || b.span.end - a.span.end);
  const counters = new Map<string | null, number>();
  const parts: Part[] = raw.map((p) => { const order = counters.get(p.parentId) ?? 0; counters.set(p.parentId, order + 1); return { ...p, order } as Part; });

  const entities: AnatomyGold['entities'] = [];
  for (const e of spec.entities ?? []) {
    const part = byId.get(e.part); if (!part) throw new Error(`${id}: entity part ${e.part} unknown`);
    let at = part.span.start - 1; for (let k = 0; k <= (e.nth ?? 0); k++) { at = text.indexOf(e.literal, at + 1); if (at < 0 || at + e.literal.length > part.span.end) throw new Error(`${id}: entity ${e.literal} not in ${e.part}`); }
    entities.push({ id: e.id ?? `e${entities.length + 1}`, partId: e.part, span: { start: at, end: at + e.literal.length }, literal: e.literal, domain: e.domain, note: e.note ?? '' });
  }
  for (const ce of spec.columnEntities ?? []) {
    const table = cellSpans.get(ce.table); if (!table) throw new Error(`${id}: column table ${ce.table} unknown`);
    const re = new RegExp(ce.pattern, 'gu');
    for (const c of table.cells) {
      if (c.cell.column !== ce.column || (ce.skipHeader !== false && c.cell.row === 0)) continue;
      const slice = text.slice(c.span.start, c.span.end);
      for (const m of slice.matchAll(re)) entities.push({ id: `e${entities.length + 1}`, partId: c.id, span: { start: c.span.start + m.index!, end: c.span.start + m.index! + m[0].length },
        literal: m[0], domain: ce.domain, note: ce.note ?? `column ${ce.column} enumeration` });
    }
  }
  // Whole-text enumeration: each match belongs to the innermost part that contains it.
  for (const te of spec.textEntities ?? []) {
    for (const m of text.matchAll(new RegExp(te.pattern, 'gu'))) {
      const span = { start: m.index!, end: m.index! + m[0].length };
      const owner = parts.filter((p) => p.span.start <= span.start && span.end <= p.span.end && p.type !== 'document')
        .sort((a, b) => (a.span.end - a.span.start) - (b.span.end - b.span.start))[0];
      entities.push({ id: `e${entities.length + 1}`, partId: owner?.id ?? 'doc', span, literal: m[0], domain: te.domain, note: te.note ?? '' });
    }
  }
  entities.sort((a, b) => a.span.start - b.span.start);
  // A code inside a column whose header names its nomenclature takes that nomenclature (no conversion).
  if (spec.headerDomainOverride) for (const e of entities) {
    const header = parts.find((p) => p.id === e.partId)?.table?.headerDomain;
    if ((header === 'NCM' || header === 'NBM') && (e.domain === 'NCM' || e.domain === 'NBM') && e.domain !== header) {
      e.domain = header; e.note = `${e.note}; domínio pelo cabeçalho da coluna (${header})`;
    }
  }
  // Ranges: two consecutive codes in the same part joined only by "a" (M01 operator), never expanded.
  const relations = [...(spec.relations ?? [])];
  if (spec.ranges) for (let i = 1; i < entities.length; i++) {
    const a = entities[i - 1]!; const b = entities[i]!;
    if (a.partId !== b.partId || !/^(?:NCM|NBM)$/.test(a.domain) || a.domain !== b.domain) continue;
    const between = text.slice(a.span.end, b.span.start); const op = /^(\s*)[aA](\s*)$/u.exec(between);
    if (!op) continue;
    const start = a.span.end + op[1]!.length;
    relations.push({ id: `range-${relations.length + 1}`, kind: 'range', operatorSpan: { start, end: start + 1 }, memberEntityIds: [a.id, b.id], targetEntityIds: [], scopeSpan: { start: a.span.start, end: b.span.end }, condition: null });
  }
  // Exceptions (M02): a code preceded, within the same part and clause, by "exceto/exclusive/salvo".
  if (spec.exceptions) for (const e of entities) {
    if (!/^(?:NCM|NBM)$/.test(e.domain)) continue;
    const part = parts.find((p) => p.id === e.partId)!;
    const from = Math.max(part.span.start, e.span.start - 80); const before = text.slice(from, e.span.start);
    const m = /(exceto|exclusive|salvo)(?![\p{L}])[^.;:\n]*$/iu.exec(before);
    if (!m) continue;
    const start = from + m.index!;
    relations.push({ id: `exception-${relations.length + 1}`, kind: 'exception', operatorSpan: { start, end: start + m[1]!.length }, memberEntityIds: [], targetEntityIds: [e.id], scopeSpan: { start, end: e.span.end }, condition: null });
  }
  const gold: AnatomyGold = { goldVersion: ANATOMY_GOLD_VERSION, id, partition: 'development', preparation: entry.preparation,
    canonicalTextSha256: entry.canonicalTextSha256, canonicalTextUtf16Length: entry.canonicalTextUtf16Length, status: 'prepared',
    annotator: spec.annotator, annotatedAt: spec.annotatedAt, parts, entities, relations, gaps: spec.gaps ?? [],
    // A reviewer's approval lives in the spec and binds the content hash it was given for.
    review: spec.review ? { ...spec.review, notes: [spec.notes ?? '', spec.review.notes].filter(Boolean).join('\n\n') }
      : { reviewer: null, status: 'requested', reviewedAt: null, approvedContentSha256: null, notes: spec.notes ?? '' } };
  if (gold.review.status === 'approved') gold.status = 'reviewed';
  return validateAnatomyGold(gold, text);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const id of process.argv.slice(2)) {
    const gold = buildGold(id);
    writeFileSync(new URL(`test/fixtures/anatomy/gold/${id}.json`, root), JSON.stringify(gold, null, 1) + '\n');
    console.log(`${id}: ${gold.parts.length} parts, ${gold.entities.length} entities, ${gold.relations.length} relations, ${gold.gaps.length} gaps`);
  }
}
