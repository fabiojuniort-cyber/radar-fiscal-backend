import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Parser } from 'htmlparser2';
import { developmentCanonicalText } from '../annotation-pack.js';

/**
 * Annotator procedure for CONFAZ development entries (01, 02). Produces the spec consumed by gold-build.
 * Evidence used: the official CONFAZ editorial classes of each block (TextoAcordo / RedaoAnt / Remisso /
 * RemissoAnt / DataPublicao …) and the block-initial dispositive markers, read from the ORIGINAL HTML.
 * Engine output is never read. Table blocks are skipped here and come from <id>.tables.json (hand-written).
 * Usage: tsx ops/anatomy/gold-specs/confaz-draft.ts <id>
 */
const id = process.argv[2]!;
const root = new URL('../../../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('test/fixtures/anatomy/corpus-manifest.json', root), 'utf8'));
const entry = manifest.entries.find((e: { id: string }) => e.id === id);
if (!entry || entry.partition !== 'development' || entry.source !== 'CONFAZ') throw new Error(`${id} is not a CONFAZ development entry`);
const html = readFileSync(new URL(entry.inputs[0].path, root), 'utf8');
const lines = developmentCanonicalText(id).split('\n');

const BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'li', 'td', 'th']);
const blocks: { cls: string; text: string; inTable: boolean }[] = [];
const stack: { cls: string; text: string; block: boolean }[] = []; let tdepth = 0;
new Parser({
  onopentag(t, a) { if (t === 'table') tdepth++; stack.push({ cls: a.class ?? '', text: '', block: BLOCK.has(t) }); },
  ontext(x) { for (let i = stack.length - 1; i >= 0; i--) if (stack[i]!.block) { stack[i]!.text += x; break; } },
  onclosetag(t) {
    const n = stack.pop()!; if (t === 'table') tdepth--;
    if (n.block && n.text.trim()) blocks.push({ cls: [n.cls, ...stack.map((s) => s.cls)].filter(Boolean).join(' '), text: n.text.replace(/\s+/g, ' ').trim(), inTable: tdepth > 0 });
  },
}, { decodeEntities: true }).end(html);

type Item = { line: number; kind: 'disp' | 'note' | 'other'; level: number; type: string; context: string; reason: string };
const items: Item[] = []; let li = 0;
const has = (cls: string, ...names: string[]) => cls.split(/\s+/).some((c) => names.includes(c));
for (const b of blocks) {
  const probe = b.text.slice(0, 25);
  let j = li; while (j < lines.length && !lines[j]!.replace(/\s+/g, ' ').trim().startsWith(probe)) j++;
  if (b.inTable) { if (j < lines.length) li = j + 1; continue; } // table cells come from <id>.tables.json
  if (j >= lines.length) throw new Error(`${id}: block not located: ${probe}`);
  li = j + 1; const line = j + 1;
  const t = b.text; const own = b.cls.split(/\s+/)[0] ?? '';
  const historical = has(b.cls, 'RedaoAnt', 'A8-3RedacaoAnt', 'RemissoAnt', 'A8-2RemissaoAnt');
  if (has(own, 'TituloAcordo')) { items.push({ line, kind: 'other', level: 0, type: 'epigraph', context: 'prohibited', reason: 'confaz_title' }); continue; }
  if (has(own, 'Ementa')) { items.push({ line, kind: 'other', level: 0, type: 'summary', context: 'prohibited', reason: 'confaz_ementa' }); continue; }
  if (has(own, 'AcordoTipo')) { items.push({ line, kind: 'other', level: 0, type: 'body', context: 'prohibited', reason: 'act_type_heading' }); continue; }
  if (has(own, 'DataPublicao', 'A2DataPublicacao', 'Remisso', 'A8-1Remissao', 'RemissoAnt', 'A8-2RemissaoAnt')) {
    items.push({ line, kind: 'note', level: 9, type: 'editorial_note', context: historical ? 'historical' : 'prohibited', reason: historical ? 'historical_editorial_note' : 'editorial_note' }); continue;
  }
  const context = historical ? 'historical' : 'operative_candidate'; const reason = historical ? 'previous_wording' : 'current_wording_candidate';
  if (/^Bras[íi]lia,\s/u.test(t)) { items.push({ line, kind: 'other', level: 0, type: 'footer', context: 'prohibited', reason: 'place_and_date' }); continue; }
  if (/^[·•]/u.test(t)) { items.push({ line, kind: 'other', level: 0, type: 'editorial_note', context: 'prohibited', reason: 'editorial_footnote' }); continue; }
  if (/^(?:O\s+Ministro|O\s+Conselho|Os\s+Secret[áa]rios)/u.test(t)) { items.push({ line, kind: 'other', level: 0, type: 'preamble', context: 'prohibited', reason: 'preamble' }); continue; }
  if (/^ANEXO\b/u.test(t)) { items.push({ line, kind: 'disp', level: 1, type: 'annex', context, reason }); continue; }
  if (/^Cl[áa]usula\s/u.test(t)) { items.push({ line, kind: 'disp', level: 1, type: 'clause', context, reason }); continue; }
  if (/^(?:§\s*\d+|Par[áa]grafo\s+[úu]nico)/u.test(t)) { items.push({ line, kind: 'disp', level: 2, type: 'paragraph', context, reason }); continue; }
  if (/^[IVXLC]+\s*[-–]/u.test(t)) { items.push({ line, kind: 'disp', level: 3, type: 'inciso', context, reason }); continue; }
  if (/^[a-z]\)\s/u.test(t)) { items.push({ line, kind: 'disp', level: 4, type: 'alinea', context, reason }); continue; }
  items.push({ line, kind: 'disp', level: 5, type: 'body', context, reason: historical ? 'previous_wording_unmarked' : 'unmarked_act_text' });
}

// Span of a dispositive: up to the line before the next dispositive of the same or higher level,
// excluding the editorial notes that immediately precede it (they annotate the next dispositive).
const blocksOut: unknown[] = []; const lastLine = lines.length - (lines[lines.length - 1] === '' ? 1 : 0);
// Previous wordings nest inside the current dispositive of the same level they are versions of, so an
// operative span skips historical items, and a historical span never swallows operative items.
const isHist = (it: Item) => it.context === 'historical';
const endOf = (i: number): number => {
  const L = items[i]!.level; const hist = isHist(items[i]!); let j = i + 1;
  const stops = (x: Item) => x.kind !== 'note' && (hist ? (!isHist(x) || x.level <= L) : (isHist(x) ? x.level < L : x.level <= L));
  while (j < items.length && !stops(items[j]!)) j++;
  if (j >= items.length) return L <= 1 ? lastLine : items[items.length - 1]!.line;
  let k = j; while (k - 1 > i && items[k - 1]!.kind === 'note') k--;
  return items[k - 1]!.line;
};
const spans = items.map((it, i) => ({ start: it.line, end: it.kind === 'disp' ? endOf(i) : it.line }));
const ids = items.map((it, i) => `${it.type}-${i}`);
items.forEach((it, i) => {
  let parent: string | undefined;
  for (let p = i - 1; p >= 0; p--) {
    const q = items[p]!;
    const levelOk = it.kind === 'note' || q.level < it.level || (q.level === it.level && !isHist(q) && isHist(it));
    if (q.kind === 'disp' && levelOk && spans[p]!.start <= spans[i]!.start && spans[i]!.end <= spans[p]!.end) { parent = ids[p]; break; }
  }
  blocksOut.push({ id: ids[i], type: it.type, at: spans[i]!.start === spans[i]!.end ? { line: it.line } : { lines: [spans[i]!.start, spans[i]!.end] },
    ...(parent ? { parent } : {}), context: it.context, reason: it.reason });
});

const tablesPath = new URL(`ops/anatomy/gold-specs/${id}.tables.json`, root);
const extra = existsSync(tablesPath) ? JSON.parse(readFileSync(tablesPath, 'utf8')) : {};
// Hand-written corrections (e.g. annex extents around skipped tables) override the procedural draft.
for (const [bid, o] of Object.entries((extra.overrides ?? {}) as Record<string, { at?: unknown; parent?: string | null }>)) {
  const b = blocksOut.find((x) => (x as { id: string }).id === bid) as Record<string, unknown> | undefined;
  if (!b) throw new Error(`override for unknown block ${bid}`);
  if (o.at) b.at = o.at; if (o.parent === null) delete b.parent; else if (o.parent) b.parent = o.parent;
}
const spec = { id, annotator: 'CLAUDE-EXEC', annotatedAt: '2026-10-17',
  notes: `CONFAZ: contexto histórico segue a marcação editorial oficial (RedaoAnt/RemissoAnt); notas de remissão/publicação proibidas; hierarquia por marcadores de cláusula/§/inciso/alínea; redações anteriores são irmãs da vigente candidata. Citações de convênios/atos enumeradas por padrão; cada número de lista (", 97/99 e 08/00") anotado como citação própria. ${extra.notes ?? ''}`.trim(),
  blocks: [...blocksOut, ...(extra.blocks ?? [])], tables: extra.tables ?? [], entities: extra.entities ?? [], columnEntities: extra.columnEntities ?? [],
  textEntities: [
    { pattern: String.raw`(?:Convs?\.|Conv[êe]nios?)\s*(?:ICMS\s*)?(?:n[ºo]\s*)?\d{1,3}/\d{2,4}`, domain: 'CITATION', note: 'convênio citado' },
    // Each further number of a list ("Convs. ICMS 40/98, 97/99 e 08/00") is its own citation.
    { pattern: String.raw`(?<=(?:Convs?\.|Conv[êe]nios?)\s*(?:ICMS\s*)?(?:n[ºo]\s*)?\d{1,3}/\d{2,4}(?:(?:,\s*|\s+e\s+)\d{1,3}/\d{2,4})*(?:,\s*|\s+e\s+))\d{1,3}/\d{2,4}`, domain: 'CITATION', note: 'convênio citado (item de lista)' },
    { pattern: String.raw`Ato\s+COTEPE(?:[-/]ICMS)?\s*(?:n[ºo]\s*)?\d{1,3}/\d{2,4}`, domain: 'CITATION', note: 'ato COTEPE citado' },
    { pattern: String.raw`Ajuste\s+SINIEF\s*\d{1,3}/\d{2,4}`, domain: 'CITATION', note: 'ajuste citado' },
    { pattern: String.raw`(?:Lei(?:\s+Complementar)?|Decreto(?:-Lei)?|Resolução(?:\s+do\s+Senado\s+Federal)?)\s+n[ºo°]\s*[\d.]+(?:/\d{2,4})?(?:,\s+de\s+\d{1,2}º?\s+de\s+\p{L}+\s+de\s+\d{4})?`, domain: 'CITATION', note: 'lei/decreto/resolução citada' },
    ...(extra.textEntities ?? []) ],
  relations: extra.relations ?? [], ranges: extra.ranges ?? false, exceptions: extra.exceptions ?? false, headerDomainOverride: extra.headerDomainOverride ?? false, gaps: extra.gaps ?? [] };
writeFileSync(new URL(`ops/anatomy/gold-specs/${id}.json`, root), JSON.stringify(spec, null, 1) + '\n');
console.log(`${id}: ${items.length} blocks (${items.filter((x) => x.context === 'historical').length} historical)`);
