import { createHash } from 'node:crypto';

/**
 * PROVISIONAL offline preparations of the DOE-SP and RFB official JSON into the single HTML representation
 * consumed by `readAnatomyInput`. Built and tested ONLY against synthetic fixtures shaped after the existing
 * connectors (`doe-sp.parser.ts`, `rfb-normas.parser.ts`). They must be checked against the recovered
 * originals before any real canonical text is frozen. They never fetch, normalize or repair text.
 */
export const DOE_SP_PREPARATION_VERSION = 'doe-sp-json/0.1.0-provisional' as const;
export const RFB_PREPARATION_VERSION = 'rfb-api-original/0.1.0-provisional' as const;

/** Format hypotheses taken from the connectors, not from original captures. */
export const JSON_PREPARATION_HYPOTHESES = Object.freeze({
  'DOE-SP': [
    'GET v2/publications/{id} returns one object with id (GUID), title, slug, date (YYYY-MM-DD), journal and content (HTML string).',
    'content is the complete legal body; title is metadata and may repeat the heading present in content.',
    'attachments[] carries {id (GUID), name, position}; attachment bytes are separate resources and are not part of content.',
    'Optional fields (section names, publicationType, authCode, editionPages) do not carry legal text.',
  ],
  RFB: [
    'visao/original returns one object with idAto (positive integer) and segments in ementas[] and outrosSegmentos[].',
    'Each segment has ordemSegmentoAto (number) and textoIntegra (HTML string); segments are read in ascending order.',
    'omitir=true marks a segment whose text the source withholds; it is declared missing, never filled.',
    'arquivoBinario {idArquivoBinario, nomeArquivoBinario} references an attachment whose content (e.g. tables) is not in textoIntegra.',
    'epigrafeCompleta is metadata; whether a segment repeats it is unproven.',
  ],
});

export interface JsonResource { resourceId: string; bytes: Uint8Array }
export interface PreparedPiece { pointer: string; sha256: string; htmlSpan: { start: number; end: number } }
export interface AttachmentRef { id: string; name: string | null; position: number; status: 'missing' }
export interface ExcludedField { pointer: string; sha256: string; length: number; reason: 'metadata' }
export interface JsonPreparation {
  preparationVersion: typeof DOE_SP_PREPARATION_VERSION | typeof RFB_PREPARATION_VERSION;
  provisional: true;
  source: 'DOE-SP' | 'RFB';
  sourceId: string;
  resource: { resourceId: string; sha256: string; byteLength: number; bomPresent: boolean };
  metadata: Record<string, string | number | null>;
  pieces: PreparedPiece[];
  missingSegments: { pointer: string; order: number; reason: 'omitted_by_source' | 'no_text' }[];
  attachments: AttachmentRef[];
  excluded: ExcludedField[];
  html: string;
  htmlSha256: string;
  preparationId: string;
}

export class JsonPreparationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'JsonPreparationError'; }
}

const sha = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

function decode(input: JsonResource): { root: Record<string, unknown>; bomPresent: boolean } {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input.bytes); }
  catch { throw new JsonPreparationError('invalid_utf8', `${input.resourceId}: resource is not valid UTF-8`); }
  const bomPresent = text.charCodeAt(0) === 0xfeff; if (bomPresent) text = text.slice(1);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new JsonPreparationError('invalid_json', `${input.resourceId}: resource is not valid JSON`); }
  const root = record(parsed); if (!root) throw new JsonPreparationError('invalid_root', `${input.resourceId}: JSON root must be an object`);
  return { root, bomPresent };
}

function finish(p: Omit<JsonPreparation, 'htmlSha256' | 'preparationId'>): JsonPreparation {
  const htmlSha256 = sha(p.html);
  const preparationId = sha(JSON.stringify({ version: p.preparationVersion, sourceId: p.sourceId, resource: p.resource.sha256, htmlSha256 }));
  return { ...p, htmlSha256, preparationId };
}

/** DOE-SP publication detail → HTML. `expectedId` must match the publication id (fail closed). */
export function prepareDoeSpRepresentation(input: JsonResource, expectedId: string): JsonPreparation {
  const { root, bomPresent } = decode(input);
  const id = root.id;
  if (typeof id !== 'string' || !GUID.test(id)) throw new JsonPreparationError('invalid_id', 'DOE-SP id must be a GUID');
  if (id.toLowerCase() !== expectedId.toLowerCase()) throw new JsonPreparationError('id_mismatch', 'DOE-SP id differs from the expected publication');
  const title = str(root.title); const slug = str(root.slug); const date = str(root.date); const journal = str(root.journal);
  if (!title || !slug || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !journal) throw new JsonPreparationError('missing_fields', 'DOE-SP title, slug, date and journal are required');
  if (typeof root.content !== 'string') throw new JsonPreparationError('missing_content', 'DOE-SP content must be a string');
  if (!root.content.trim()) throw new JsonPreparationError('empty_content', 'DOE-SP content is empty');
  const attachments: AttachmentRef[] = [];
  if (root.attachments !== undefined && !Array.isArray(root.attachments)) throw new JsonPreparationError('invalid_attachments', 'DOE-SP attachments must be an array');
  for (const [index, raw] of (Array.isArray(root.attachments) ? root.attachments : []).entries()) {
    const a = record(raw); const aid = a?.id;
    if (typeof aid !== 'string' || !GUID.test(aid) || !str(a?.name)) throw new JsonPreparationError('invalid_attachment', `DOE-SP attachment ${index} needs GUID id and name`);
    attachments.push({ id: aid.toLowerCase(), name: str(a!.name), position: typeof a!.position === 'number' && Number.isSafeInteger(a!.position) ? a!.position : index, status: 'missing' });
  }
  attachments.sort((x, y) => x.position - y.position || x.id.localeCompare(y.id));
  const html = root.content;
  return finish({ preparationVersion: DOE_SP_PREPARATION_VERSION, provisional: true, source: 'DOE-SP', sourceId: id.toLowerCase(),
    resource: { resourceId: input.resourceId, sha256: sha(input.bytes), byteLength: input.bytes.byteLength, bomPresent },
    metadata: { slug, date, journal, publicationType: str(root.publicationType), section: str(root.section) },
    pieces: [{ pointer: '/content', sha256: sha(html), htmlSpan: { start: 0, end: html.length } }],
    missingSegments: [], attachments, excluded: [{ pointer: '/title', sha256: sha(title), length: title.length, reason: 'metadata' }], html });
}

/** RFB visao/original → HTML of the readable segments in ascending order, with omitted ones declared. */
export function prepareRfbRepresentation(input: JsonResource, expectedIdAto: number): JsonPreparation {
  const { root, bomPresent } = decode(input);
  const idAto = root.idAto;
  if (typeof idAto !== 'number' || !Number.isSafeInteger(idAto) || idAto < 1) throw new JsonPreparationError('invalid_id', 'RFB idAto must be a positive integer');
  if (idAto !== expectedIdAto) throw new JsonPreparationError('id_mismatch', 'RFB idAto differs from the expected act');
  const raw: { pointer: string; item: Record<string, unknown> }[] = [];
  for (const key of ['ementas', 'outrosSegmentos'] as const) {
    const list = root[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new JsonPreparationError('invalid_segments', `RFB ${key} must be an array`);
    list.forEach((v, i) => { const item = record(v); if (!item) throw new JsonPreparationError('invalid_segment', `RFB ${key}/${i} must be an object`); raw.push({ pointer: `/${key}/${i}`, item }); });
  }
  if (!raw.length) throw new JsonPreparationError('no_segments', 'RFB payload has no segments');
  const orders = new Set<number>();
  for (const r of raw) {
    const o = r.item.ordemSegmentoAto;
    if (typeof o !== 'number' || !Number.isFinite(o)) throw new JsonPreparationError('segment_order_missing', `RFB ${r.pointer} lacks ordemSegmentoAto`);
    if (orders.has(o)) throw new JsonPreparationError('segment_order_duplicate', `RFB ordemSegmentoAto ${o} is duplicated`);
    orders.add(o);
  }
  raw.sort((a, b) => (a.item.ordemSegmentoAto as number) - (b.item.ordemSegmentoAto as number));
  let html = ''; const pieces: PreparedPiece[] = []; const missingSegments: JsonPreparation['missingSegments'] = []; const attachments: AttachmentRef[] = [];
  for (const { pointer, item } of raw) {
    const order = item.ordemSegmentoAto as number;
    const file = record(item.arquivoBinario);
    if (file) {
      const fid = file.idArquivoBinario;
      if (typeof fid !== 'number' || !Number.isSafeInteger(fid)) throw new JsonPreparationError('invalid_attachment', `RFB ${pointer}/arquivoBinario needs idArquivoBinario`);
      if (!attachments.some((a) => a.id === String(fid))) attachments.push({ id: String(fid), name: str(file.nomeArquivoBinario), position: order, status: 'missing' });
    }
    if (item.omitir === true) { missingSegments.push({ pointer, order, reason: 'omitted_by_source' }); continue; }
    if (item.textoIntegra !== undefined && typeof item.textoIntegra !== 'string') throw new JsonPreparationError('invalid_segment_text', `RFB ${pointer}/textoIntegra must be a string`);
    const body = typeof item.textoIntegra === 'string' ? item.textoIntegra : '';
    if (!body.trim()) { if (!file) missingSegments.push({ pointer, order, reason: 'no_text' }); continue; }
    // A neutral wrapper keeps segments from fusing; it adds no characters.
    html += `<section data-rfb-segment="${order}">`; const start = html.length; html += body; const end = html.length; html += '</section>';
    pieces.push({ pointer: `${pointer}/textoIntegra`, sha256: sha(body), htmlSpan: { start, end } });
  }
  if (!pieces.length) throw new JsonPreparationError('no_readable_segment', 'RFB payload has no readable segment');
  const title = str(root.epigrafeCompleta);
  return finish({ preparationVersion: RFB_PREPARATION_VERSION, provisional: true, source: 'RFB', sourceId: String(idAto),
    resource: { resourceId: input.resourceId, sha256: sha(input.bytes), byteLength: input.bytes.byteLength, bomPresent },
    metadata: { idAto }, pieces, missingSegments, attachments,
    excluded: title ? [{ pointer: '/epigrafeCompleta', sha256: sha(title), length: title.length, reason: 'metadata' }] : [], html });
}

/** Map a UTF-16 interval of the prepared HTML back to its JSON pointer, or null for wrapper markup. */
export function locateJsonHtmlSpan(p: Pick<JsonPreparation, 'pieces'>, span: { start: number; end: number }): { pointer: string; offset: { start: number; end: number } } | null {
  const piece = p.pieces.find((x) => span.start >= x.htmlSpan.start && span.end <= x.htmlSpan.end);
  return piece ? { pointer: piece.pointer, offset: { start: span.start - piece.htmlSpan.start, end: span.end - piece.htmlSpan.start } } : null;
}
