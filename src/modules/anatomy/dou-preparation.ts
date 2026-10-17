import { createHash } from 'node:crypto';
import { Parser } from 'htmlparser2';

/**
 * Versioned, offline preparation of INLABS DOU XML into the single HTML representation consumed by
 * `readAnatomyInput`. It never fetches, normalizes or repairs text: the CDATA of `<Texto>` is copied
 * verbatim and every prepared interval points back to its XML resource.
 */
export const DOU_PREPARATION_VERSION = 'dou-xml-cdata/1.0.0' as const;

export interface DouXmlResource { resourceId: string; bytes: Uint8Array }

export interface DouPreparedResource {
  resourceId: string;
  sha256: string;
  byteLength: number;
  bomPresent: boolean;
  name: string;
  partNumber: number | null;
  numberPage: string | null;
  pdfPage: string | null;
  /** UTF-16 interval of the CDATA payload inside the decoded XML (BOM removed). */
  cdataSpan: { start: number; end: number };
  /** UTF-16 interval of the same payload inside the prepared HTML. */
  htmlSpan: { start: number; end: number };
}

export interface DouExcludedField {
  resourceId: string;
  field: 'artNotes' | 'Identifica' | 'Data' | 'Ementa' | 'Titulo' | 'SubTitulo';
  /** SHA-256 of the exact value; the value itself is not duplicated. */
  sha256: string;
  length: number;
  reason: 'internal_layout_note' | 'metadata_duplicate';
}

export interface DouPreparation {
  preparationVersion: typeof DOU_PREPARATION_VERSION;
  source: 'DOU';
  idMateria: string;
  metadata: { artType: string | null; artCategory: string | null; pubName: string | null; pubDate: string | null; editionNumber: string | null };
  resources: DouPreparedResource[];
  excluded: DouExcludedField[];
  html: string;
  htmlSha256: string;
  preparationId: string;
}

export class DouPreparationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'DouPreparationError'; }
}

const sha = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const OPEN = '<Texto><![CDATA[';
const CLOSE = ']]></Texto>';
const META_FIELDS = ['Identifica', 'Data', 'Ementa', 'Titulo', 'SubTitulo'] as const;

interface Parsed { attrs: Record<string, string>; fields: Map<string, string>; cdata: { start: number; end: number } }

function parseResource(resourceId: string, xml: string): Parsed {
  const first = xml.indexOf(OPEN);
  if (first < 0 || xml.indexOf(OPEN, first + 1) >= 0) throw new DouPreparationError('texto_cdata_not_unique', `${resourceId}: expected exactly one <Texto> CDATA block`);
  const start = first + OPEN.length;
  const end = xml.indexOf(CLOSE, start);
  if (end < 0) throw new DouPreparationError('texto_cdata_unterminated', `${resourceId}: <Texto> CDATA is not terminated`);
  let attrs: Record<string, string> | null = null; let articles = 0;
  const fields = new Map<string, string>(); let current: string | null = null; let buffer = '';
  const parser = new Parser({
    onopentag(tag, a) {
      if (tag === 'article') { articles++; attrs = a; }
      if ((META_FIELDS as readonly string[]).includes(tag)) { current = tag; buffer = ''; }
    },
    ontext(text) { if (current) buffer += text; },
    onclosetag(tag) { if (tag === current) { fields.set(tag, buffer); current = null; } },
  }, { xmlMode: true, recognizeCDATA: true, decodeEntities: true });
  parser.write(xml.slice(0, first)); parser.end();
  if (articles !== 1 || !attrs) throw new DouPreparationError('article_not_unique', `${resourceId}: expected exactly one <article> element before <Texto>`);
  return { attrs, fields, cdata: { start, end } };
}

/** Prepare one DOU matter from one or more INLABS XML files. Fails closed on any ambiguity. */
export function prepareDouRepresentation(inputs: DouXmlResource[]): DouPreparation {
  if (!inputs.length) throw new DouPreparationError('no_resources', 'At least one DOU XML resource is required');
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const parsed = inputs.map((input) => {
    let xml: string;
    try { xml = decoder.decode(input.bytes); } catch { throw new DouPreparationError('invalid_utf8', `${input.resourceId}: resource is not valid UTF-8`); }
    const bomPresent = xml.charCodeAt(0) === 0xfeff;
    if (bomPresent) xml = xml.slice(1);
    const p = parseResource(input.resourceId, xml);
    const name = p.attrs.name ?? '';
    const suffix = /_(\d{3})$/.exec(name);
    return { input, xml, bomPresent, ...p, name, partNumber: suffix ? Number(suffix[1]) : null };
  });
  const ids = new Set(parsed.map((p) => p.attrs.idMateria ?? ''));
  if (ids.size !== 1 || ids.has('')) throw new DouPreparationError('id_materia_mismatch', 'All resources must share one non-empty idMateria');
  if (parsed.length > 1) {
    if (parsed.some((p) => p.partNumber === null)) throw new DouPreparationError('part_number_missing', 'Multi-file matter requires _NNN suffix on every article name');
    parsed.sort((a, b) => a.partNumber! - b.partNumber!);
    parsed.forEach((p, index) => { if (p.partNumber !== index + 1) throw new DouPreparationError('part_sequence_gap', `Expected contiguous parts starting at _001; found _${String(p.partNumber).padStart(3, '0')}`); });
  }
  const resources: DouPreparedResource[] = []; const excluded: DouExcludedField[] = []; let html = '';
  for (const p of parsed) {
    const payload = p.xml.slice(p.cdata.start, p.cdata.end);
    // A neutral block wrapper keeps parts from fusing text across files; it adds no characters.
    const open = `<div data-dou-part="${resources.length + 1}">`;
    html += open; const htmlStart = html.length; html += payload; const htmlEnd = html.length; html += '</div>';
    resources.push({ resourceId: p.input.resourceId, sha256: sha(p.input.bytes), byteLength: p.input.bytes.byteLength, bomPresent: p.bomPresent,
      name: p.name, partNumber: p.partNumber, numberPage: p.attrs.numberPage ?? null, pdfPage: p.attrs.pdfPage ?? null,
      cdataSpan: { ...p.cdata }, htmlSpan: { start: htmlStart, end: htmlEnd } });
    if (p.attrs.artNotes) excluded.push({ resourceId: p.input.resourceId, field: 'artNotes', sha256: sha(p.attrs.artNotes), length: p.attrs.artNotes.length, reason: 'internal_layout_note' });
    for (const field of META_FIELDS) {
      const value = p.fields.get(field);
      if (value && value.trim()) excluded.push({ resourceId: p.input.resourceId, field, sha256: sha(value), length: value.length, reason: 'metadata_duplicate' });
    }
  }
  const head = parsed[0]!.attrs;
  const metadata = { artType: head.artType ?? null, artCategory: head.artCategory ?? null, pubName: head.pubName ?? null,
    pubDate: head.pubDate ?? null, editionNumber: head.editionNumber ?? null };
  const htmlSha256 = sha(html);
  const preparationId = sha(JSON.stringify({ version: DOU_PREPARATION_VERSION, idMateria: [...ids][0], resources: resources.map((r) => [r.resourceId, r.sha256]), htmlSha256 }));
  return { preparationVersion: DOU_PREPARATION_VERSION, source: 'DOU', idMateria: [...ids][0]!, metadata, resources, excluded, html, htmlSha256, preparationId };
}

/** Map a UTF-16 interval of the prepared HTML back to its XML resource, or null for wrapper markup. */
export function locateDouHtmlSpan(preparation: Pick<DouPreparation, 'resources'>, span: { start: number; end: number }):
  { resourceId: string; xmlSpan: { start: number; end: number } } | null {
  const r = preparation.resources.find((x) => span.start >= x.htmlSpan.start && span.end <= x.htmlSpan.end);
  if (!r) return null;
  const delta = r.cdataSpan.start - r.htmlSpan.start;
  return { resourceId: r.resourceId, xmlSpan: { start: span.start + delta, end: span.end + delta } };
}
