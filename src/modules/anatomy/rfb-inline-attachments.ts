import { createHash } from 'node:crypto';
import type { AnatomyPart } from './contract.js';
import { prepareRfbRepresentation, type JsonPreparation } from './json-preparation.js';
import { readAnatomyInput, type AnatomyReaderResult } from './readers.js';

/**
 * ANAT-L2/L12 (decisão do Fábio, tribusca-control#116 c.6673604188; desenho #293 §13.2/§14.2).
 *
 * Some RFB acts carry an attachment's content INSIDE the official JSON (`arquivoBinario.arquivoBinario`, base64).
 * This module reads such an attachment as a SEPARATE resource:
 *  - the main RFB preparation (json-preparation.ts, rfb-api-original/0.2.0) is NOT touched: its HTML, pieces and
 *    hashes stay identical, so the reconciliation chain 0.1.0 →(D04)→ 0.2.0 of every captured act stays valid;
 *  - each attachment gets its own resourceId `rfb:<idAto>:anexo:<idArquivoBinario>` and its own reader pass, so a
 *    malformed attachment (unclosed tags, a stray `</section>`, an open comment) can never alter the act's tree,
 *    text or source map;
 *  - the decoded bytes are kept as they are (SHA-256), decoded with the charset the attachment itself declares
 *    (windows-1252 / iso-8859-1 / utf-8 only), never normalised or repaired; UTF-16 offsets map back to bytes;
 *  - size limits: 512 KiB decoded per attachment, 1 MiB per act. PDFs (or any non-HTML content) stay `missing`.
 * Nothing is fetched. legalStatus stays unknown (the reader never sets it).
 *
 * R2 (COORD #300): (1) a UTF-8 BOM is KEPT in `html` (decoded with ignoreBOM), so UTF-16 offsets of the reader's own
 * sourcePointers map to the original bytes including the 3 BOM bytes; (2) an offset inside a surrogate pair (non-BMP
 * character) is refused; (3) the attachment inherits the protected context of the segment that references it in the
 * act: quotation/prohibited → prohibited, tachado/historical → historical, undetermined → prohibited (conservative).
 */
export const RFB_INLINE_ATTACHMENT_VERSION = 'rfb-inline-attachment/0.2.0-provisional' as const;
export const RFB_INLINE_ATTACHMENT_LIMITS = Object.freeze({ maxBytesPerAttachment: 512 * 1024, maxBytesPerAct: 1024 * 1024 });

export type InlineAttachmentState = 'read' | 'unreadable' | 'missing_no_content' | 'invalid_base64' | 'not_html'
  | 'charset_undeclared' | 'charset_unsupported' | 'attachment_too_large' | 'act_attachments_too_large';
type Charset = 'windows-1252' | 'utf-8';

export interface InlineAttachment {
  version: typeof RFB_INLINE_ATTACHMENT_VERSION;
  idAto: number;
  idArquivoBinario: number;
  name: string | null;
  idTipoArquivo: number | null;
  /** JSON pointer of the base64 payload inside the official resource. */
  pointer: string;
  /** Segment that references the attachment (its position in the act). */
  segmentOrder: number;
  resourceId: string;
  state: InlineAttachmentState;
  reason: string | null;
  /** Decoded bytes (only when the payload was valid base64). */
  byteLength: number | null;
  sha256: string | null;
  charset: Charset | null;
  /**
   * The decoded HTML (state 'read' only), verbatim, for provenance. UNTRUSTED (R2 A-4): its attributes (on*, style,
   * javascript: URLs…) are never interpreted here; any rendering must sanitize it first.
   */
  html: string | null;
  /** The separate reader pass (state 'read' only), with the referencing segment's protected context applied. */
  reading: AnatomyReaderResult | null;
  /** Context of the segment that references the attachment in the act (R2). */
  referenceContext: AnatomyPart['context'];
  referenceContextEvidence: string;
  /**
   * E9 P2-c (COORD A, tribusca-control#116): where the decoding charset came from. 'declared' = <meta charset> of the
   * attachment; 'inferred_strict_utf8' = no declaration, accepted ONLY for a validated table fragment of idTipoArquivo 5
   * whose bytes decode as strict (fatal) UTF-8. null when nothing was decoded. `reason` stays null for state 'read'.
   */
  charsetEvidence: 'declared' | 'inferred_strict_utf8' | null;
  /** 'document' (<html>/doctype) or 'table_fragment' (validated bare <table> of idTipoArquivo 5); null if not HTML. */
  htmlForm: 'document' | 'table_fragment' | null;
}

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const B64 = /^[A-Za-z0-9+/]*={0,2}$/u;

function declaredCharset(bytes: Uint8Array): string | null {
  // The declaration is ASCII in every accepted charset; read only the head of the document.
  const head = Buffer.from(bytes.subarray(0, 4096)).toString('latin1');
  const m = /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_-]+)/iu.exec(head);
  return m ? m[1]!.toLowerCase() : null;
}
function charsetOf(label: string): Charset | null {
  if (['windows-1252', 'cp1252', 'iso-8859-1', 'latin1', 'us-ascii'].includes(label)) return 'windows-1252'; // WHATWG: latin1 → windows-1252
  if (['utf-8', 'utf8'].includes(label)) return 'utf-8';
  return null;
}

/** Byte offset (in the decoded attachment bytes) of a UTF-16 offset of `att.html`. */
export function attachmentByteOffset(att: Pick<InlineAttachment, 'charset' | 'html'>, utf16Offset: number): number {
  if (att.html === null || att.charset === null) throw new TypeError('attachment was not read');
  if (utf16Offset < 0 || utf16Offset > att.html.length) throw new RangeError('offset outside the attachment');
  // windows-1252 (WHATWG) maps every byte to exactly one BMP code point: byte offset = UTF-16 offset.
  if (att.charset === 'windows-1252') return utf16Offset;
  // R2: never split a surrogate pair (characters outside the BMP take 2 UTF-16 units and 4 UTF-8 bytes).
  const prev = att.html.charCodeAt(utf16Offset - 1);
  if (utf16Offset > 0 && utf16Offset < att.html.length && prev >= 0xd800 && prev <= 0xdbff) throw new RangeError('offset splits a surrogate pair');
  // The BOM, when present, is part of `html` (decoded with ignoreBOM), so it is counted like any other character.
  return Buffer.byteLength(att.html.slice(0, utf16Offset), 'utf8');
}

/**
 * COORD A: a bare table fragment (idTipoArquivo 5) is accepted only when it is structurally a single table: it starts
 * with <table and ends with </table>, every tag is a table/inline-text tag, and it has at least one row with a cell.
 * Returns null when valid, else why not. Bytes are never edited (validation reads a latin1 view of the bytes).
 */
const FRAGMENT_TAGS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col', 'p', 'span', 'br', 'b', 'strong', 'i', 'em', 'u', 'sub', 'sup']);
export function tableFragmentProblem(bytes: Uint8Array): string | null {
  const t = Buffer.from(bytes).toString('latin1').replace(/^\xEF\xBB\xBF/u, '').trim();
  if (!/^<table[\s>]/iu.test(t)) return 'does not start with <table>';
  if (!/<\/table>$/iu.test(t)) return 'does not end with </table>';
  const tags = [...t.matchAll(/<\/?([a-z][a-z0-9]*)\b[^>]*>/giu)].map((m) => m[1]!.toLowerCase());
  const bad = tags.filter((x) => !FRAGMENT_TAGS.has(x));
  if (bad.length) return `non-table tag(s) ${[...new Set(bad)].join(', ')}`;
  if (/<!--|<!\[CDATA\[|<\?/u.test(t)) return 'comment or processing instruction';
  const opens = (t.match(/<table[\s>]/giu) ?? []).length; const closes = (t.match(/<\/table>/giu) ?? []).length;
  if (opens !== 1 || closes !== 1) return `${opens} <table> / ${closes} </table> (exactly one table required)`;
  if (!/<tr[\s>][\s\S]*?<t[dh][\s>]/iu.test(t)) return 'no row with a cell';
  return null;
}
const RESTRICT: Record<AnatomyPart['context'], number> = { operative_candidate: 0, unknown: 1, historical: 2, prohibited: 3 };
/** Most restrictive context of the act's parts that cover the referencing segment's text (R2). */
type MainAct = { prep: Pick<JsonPreparation, 'pieces' | 'html'>; parts: readonly AnatomyPart[] };
type Piece = JsonPreparation['pieces'][number];
const coveringOf = (main: MainAct, piece: Piece) => main.parts.filter((x) => x.type !== 'document' && x.type !== 'caput'
  && x.sourcePointers.some((sp) => sp.sourceSpan && sp.sourceSpan.start < piece.htmlSpan.end && sp.sourceSpan.end > piece.htmlSpan.start));
const strictest = (parts: readonly AnatomyPart[]): AnatomyPart['context'] => {
  let ctx: AnatomyPart['context'] = 'operative_candidate';
  for (const x of parts) if (RESTRICT[x.context] > RESTRICT[ctx]) ctx = x.context;
  return ctx;
};
/**
 * Most restrictive context of the act at the referencing segment (R2/R3).
 * - Segment with text: the strictest context of the act's parts covering it (unknown → prohibited).
 * - R3: segment WITHOUT text: decided from the nearest text segments before and after it in segment order. A
 *   quotation (prohibited) on either side prevails over tachado; a missing or undetermined neighbour → prohibited;
 *   only with both neighbours determined and not prohibited does tachado give historical (else prohibited).
 */
/** Express reference at the very END of a segment's text, pointing to what follows. Returns the matched words or null. */
const EXPRESS_REF = /\b((?:descrit|constante|relacionad|especificad|indicad|discriminad|listad|apresentad)[oa]?s?\s+(?:abaixo|a\s+seguir)|(?:tabela|quadro|rela[çc][ãa]o)\s+(?:abaixo|a\s+seguir))\s*[.:]$/iu;
/**
 * R3 (review R2 A2-1/A2-2): an express reference only counts when it is LIVE normative text of a device that is not
 * negated and does not involve ANOTHER norm. In doubt about the link between the table and the device: no promotion.
 * - A2-1: the segment HTML is walked tag by tag with a DEPTH counter for <strike>/<s>/<del>; struck text is dropped.
 *   A stray close, an unclosed or self-closing struck tag, or any element styled `line-through` makes the struck scope
 *   undeterminable → null (conservative).
 * - Entities are decoded first (named Portuguese letters + numeric); an unknown entity → null.
 * - The segment must start with a normative device and END with the express reference.
 * - A2-2: negation/exclusion ANYWHERE in the device text (não, nem, exceto, salvo, ressalvad…, exclu…, vedad…), or a
 *   citation of ANY identified norm anywhere in it (kind + nº/number/year, e.g. "Instrução Normativa RFB nº 2.121"), or
 *   an annex/table/quadro of another norm → null. This also covers mixed text (another norm + device + reference).
 */
const STRUCK_TAGS = new Set(['strike', 's', 'del']);
const NAMED: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ordm: 'º', ordf: 'ª', sect: '§', deg: '°', ndash: '–', mdash: '—',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', atilde: 'ã', otilde: 'õ', Atilde: 'Ã', Otilde: 'Õ',
  acirc: 'â', ecirc: 'ê', ocirc: 'ô', Acirc: 'Â', Ecirc: 'Ê', Ocirc: 'Ô', agrave: 'à', Agrave: 'À', ccedil: 'ç', Ccedil: 'Ç', uuml: 'ü', Uuml: 'Ü' };
function decodeEntities(t: string): string | null {
  let bad = false;
  const out = t.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z][A-Za-z0-9]{0,31});/gu, (_m, e: string) => {
    if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith('#')) return String.fromCodePoint(Number(e.slice(1)));
    const v = NAMED[e]; if (v === undefined) bad = true; return v ?? '';
  });
  return bad ? null : out;
}
/** Live (non-struck) text of a segment, or null when the struck scope cannot be determined. `struck` tells whether any struck content existed. */
export function liveSegmentText(html: string): { text: string; struck: boolean } | null {
  let depth = 0; let text = ''; let struck = false;
  for (const m of html.matchAll(/<!--[\s\S]*?-->|<(\/?)([A-Za-z][A-Za-z0-9]*)\b([^>]*?)(\/?)>|<|[^<]+/gu)) {
    const tok = m[0];
    if (tok.startsWith('<!--')) continue;
    if (m[2]) {
      const name = m[2].toLowerCase(); const closing = m[1] === '/'; const selfClosing = m[4] === '/'; const attrs = m[3] ?? '';
      if (/line-through/iu.test(attrs)) return null;
      // R4 A3-1: an EXPLICIT strike class is struck text whose scope we do not model → conservative
      // R5 A4-2: quoted or unquoted class values; camelCase ("textoTachado") matches too (no leading \b)
      const cls = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/iu.exec(attrs);
      if (cls && /(?:tachad|riscad|strike|line-through)/iu.test(cls[1] ?? cls[2] ?? cls[3] ?? '')) return null;
      if (STRUCK_TAGS.has(name)) {
        if (selfClosing) return null;
        if (closing) { if (depth === 0) return null; depth--; } else { depth++; struck = true; }
      }
      text += ' '; continue;
    }
    if (tok === '<') return null; // a bare "<" that is not a tag: structure undeterminable
    if (depth === 0) text += tok;
  }
  if (depth !== 0) return null;
  const decoded = decodeEntities(text);
  return decoded === null ? null : { text: decoded.replace(/\s+/gu, ' ').trim(), struck };
}
const DEVICE = /^(?:Art\.?\s*\d+|§\s*\d+|Par[áa]grafo\s+[úu]nico|[IVXLC]+\s*[-–—]|[a-z]\))/iu;
/** R5 (COORD): negation OF APPLICABILITY still blocks anywhere in the device; a PROHIBITION is an operative command. */
const NEGATION = /\b(?:n[ãa]o|nem|exceto|salvo|ressalvad[oa]s?|exclu[íi]d[oa]s?|excluindo|exclus[ãa]o)\b/iu;
const PROHIBITION = /\b(?:vedad[oa]s?|proibid[oa]s?|impedid[oa]s?)\b/iu;
const PERMISSION = /\b(?:autorizad[oa]s?|permitid[oa]s?|poder(?:[áa]|[ãa]o)|pode(?:m)?|facultad[oa]s?)\b/iu;
const OBLIGATION = /\b(?:dever(?:[áa]|[ãa]o)|deve(?:m)?|obrigad[oa]s?|obrigat[óo]ri[oa]s?)\b/iu;
// R7/R8: abbreviated kinds (Dec., Instr., Port., Res.; composite Port. Conj., Instr. Norm., Ato Decl. Interpr., Sol. de
// Consulta, …) cite a norm exactly like the full forms
const NORM_KIND_BARE = /\b(?:(?:Ato\s+Decl\.(?:\s*(?:Interpr|Exec)\.)?|Sol\.\s*(?:de\s+Consulta|Cons\.)|(?:Dec|Decr|Instr|Inst|Port|Res|Resol|Conv|Prot|Sol|Parec)\.(?:-Lei)?(?:\s*(?:Conj|Interm|Norm|Leg)\.)?)|Leis?(?:\s+Complementar|\s+Compl\.)?|Decretos?(?:-Lei)?|Instru[çc](?:[ãa]o|[õo]es)\s+Normativas?|IN|Portarias?|Resolu[çc](?:[ãa]o|[õo]es)|Conv[êe]nio|Ajuste|Protocolo|Ato\s+Declarat[óo]rio|ADE|ADI|Medida\s+Provis[óo]ria|Parecer|Solu[çc][ãa]o\s+de\s+(?:Consulta|Diverg[êe]ncia)|Regulamento|RIR|RIPI|TIPI)(?:(?<=\.)|\b)/u;
// R9: plural kinds ("Decretos nº …", "Leis", "Portarias", "Instruções Normativas", "Resoluções") cite like the singular
// R9 R8-LOW: the abbreviated kinds whatever the case ("port. conj.", "INSTR. NORM.", "Ato decl. Interpr.")
const NORM_KIND_ABBR_ANYCASE = /(?<![\p{L}])(?:Ato\s+Decl\.(?:\s*(?:Interpr|Exec)\.)?|Sol\.\s*(?:de\s+Consulta|Cons\.)|(?:Dec|Decr|Instr|Inst|Port|Res|Resol|Conv|Prot|Sol|Parec)\.(?:-Lei)?(?:\s*(?:Conj|Interm|Norm|Leg)\.)?)/iu;
const CONNECTOR = /^\s*(?:conforme|nos\s+termos|na\s+forma|segundo|de\s+acordo\s+com|cuj[oa]s?)\b/iu;
// R8 R7-ACC: an accessory word counts only when it OPENS the clause ("dispensadas as exigências …", "observada a Lei …");
// inside a clause ("os valores observados na Portaria") the clause keeps its citation
const ACCESSORY = /^\s*(?:(?:e|ou)\s+)?(?:dispensad[oa]s?|observad[oa]s?|nos\s+termos\s+d[oa]s?\s+(?:art\.|artigo))/iu;
// R8 R7-FRONT: a FOUNDATION citation ("nos termos d…", "com base em", "com fundamento em", "por força d…") opening a clause,
// at the start or in the middle of the sentence, is judged by its FUNCTION: accessory only when the sentence's main clause
// is CONSTITUTIVE (authorizes, approves, institutes, establishes …); when the main clause applies or maintains content,
// or cannot be classified, the citation counts (ambiguity never promotes)
const FOUNDATION = /^\s*(?:(?:e|ou)\s+)?(?:nos\s+termos\s+d[oa]s?|com\s+base\s+(?:em|n[oa]s?)|com\s+fundamento\s+(?:em|n[oa]s?)|por\s+for[çc]a\s+d[oa]s?)(?![\p{L}])/iu;
// R10 R9-RES: the ORIGIN of the approved object. Under a constitutive verb, the object "resumes" another norm whenever it
// carries a provision participle ("previstas", "lá estabelecidas", "constantes") or a locative/anaphoric/possessive marker
// ("ali", "acima", "supracitado", "aludido", "em referência", "referido", "seu Anexo", "naquele") — an OPEN rule, not a
// list of phrasings. Only an express self-reference ("nesta Portaria", "deste ato", "da presente Instrução Normativa")
// keeps the content as the act's own; anything else is ambiguous → the cited norm counts (never promoted).
const SELF_KIND = String.raw`(?:Portaria(?:\s+Conjunta)?|Instru[çc][ãa]o\s+Normativa|IN|Ato\s+Declarat[óo]rio(?:\s+(?:Executivo|Interpretativo))?|ADE|ADI|Resolu[çc][ãa]o|Solu[çc][ãa]o\s+de\s+(?:Consulta|Diverg[êe]ncia)|Parecer|Decreto|Lei|norma|ato|diploma|Anexo)(?![\p{L}])`;
const SELF_REF = new RegExp(String.raw`(?<![\p{L}])(?:(?:n|d)?est[ea]s?|(?:n|d|pel)?[oa]\s+presente)\s+${SELF_KIND}`, 'giu');
const PROVISION = String.raw`(?:previst|estabelecid|fixad|definid|disciplinad|regulad|contid|relacionad|especificad|enumerad|listad|indicad|determinad|aprovad|institu[íi]d|constante)[oa]?s?`;
const SELF_PROVISION = new RegExp(String.raw`(?<![\p{L}])${PROVISION}\s+(?:(?:n|d|pel)?[oa]s?\s+)?(?:Anexo(?:\s+[IVXLC]+)?\s+)?(?:(?:n|d)?est[ea]s?|(?:n|d|pel)?[oa]\s+presente)\s+${SELF_KIND}`, 'giu');
// R12 (review R11 c.6930078953): ONE marker vocabulary shared by FOREIGN_ORIGIN (R10: the sentence cites a norm) and RESUMPTION
// (R11: it cites none), so the two rules can never diverge. Adds "sobredit[oa]" (was missing from FOREIGN_ORIGIN), "susodit[oa]",
// "em tela", "em comento" and "<act kind> anterior(es)" ("do ato anterior", "da Portaria anterior"); a bare temporal
// "anterior" ("exercício anterior", "mês anterior") is NOT a marker. "lá" only accented; "dito/a" only as a determiner
// R13 (review R12 c.6933422896): + multicitado, em epígrafe, em questão, em causa (accent-insensitive in "í"/"ã"; case-insensitive via the iu flag)
const RESUMPTION_MARKERS = String.raw`ali|lá|acima|supra\p{L}*|retro\p{L}*|precitad[oa]s?|aludid[oa]s?|sobredit[oa]s?|susodit[oa]s?|(?:(?<=(?<![\p{L}])[oa]s?\s)dit[oa]s?|dit[oa]s?(?=\s+\p{L}))|em\s+refer[êe]ncia|em\s+tela|em\s+comento|(?:ato|norma|diploma|Portaria|Instru[çc][ãa]o\s+Normativa|IN|Lei|Decreto|Resolu[çc][ãa]o|Ato\s+Declarat[óo]rio|Parecer|Solu[çc][ãa]o\s+de\s+Consulta|regulamento)\s*anterior(?:es)?|multicitad[oa]s?|em\s+ep[íi]grafe|em\s+quest[ãa]o|em\s+causa|referid[oa]s?|mencionad[oa]s?|citad[oa]s?|[nd]el[ae]s?|[nd]aquel[ae]s?|[nd]ess[ea]s?|seus?|suas?|tal|tais|mesm[oa]s?`;
// FOREIGN_ORIGIN = the shared markers + the bare provision participles ("previstas", "constantes"), which only count here
const FOREIGN_ORIGIN = new RegExp(String.raw`(?<![\p{L}])(?:${PROVISION}|${RESUMPTION_MARKERS})(?![\p{L}])`, 'iu');
// R10 R9-ANA: a sentence that OPENS by resuming something said before ("Os mesmos valores", "Tais alíquotas", "Esses
// produtos", "Os referidos itens", "Aqueles") has no origin of its own; only an express self-reference in that same sentence
// lets it promote — never inheritance across the sentence boundary
// R11 (review R10 c.6924070158): the opening set also takes "Estes/Estas" (plural demonstrative; "Esta/Este" + a SELF_KIND
// word stays a self-reference and is neutralised by stripSelf), "Os/As demais", "Ditos/As ditas", "Sobreditas". "diploma" is
// now a SELF_KIND ("neste/deste/do presente diploma" is the act itself); "naquele/no aludido/no mencionado diploma" stay foreign
const RESUMPTION_OPEN = /^\s*(?:(?:[OA]s?|N[oa]s?|D[oa]s?|Pel[oa]s?)\s+(?:mesm|referid|mencionad|citad|aludid|precitad|supracitad)[oa]s?|(?:[OA]s\s+)?[Dd]emais|(?:[OA]s?\s+)?[Dd]it[oa]s?|(?:[OA]s?\s+)?[Ss]obredit[oa]s?|(?:[OA]s?\s+)?[Ss]usodit[oa]s?|Tais|Tal|Est[ea]s|Ess[ea]s?|Aquel[ea]s?|Referid[oa]s|Mencionad[oa]s|Citad[oa]s)(?![\p{L}])/u;
// R11 (review R10 c.6924070158): a RESUMPTION marker ANYWHERE in the sentence (anaphoric/locative/possessive/explicit; bare
// provision participles are NOT markers here). When the sentence cites no norm of its own, the marker points to an
// antecedent that lives outside the sentence (previous sentence, other norm) → unresolved, never promoted. "lá" only
// accented (not the article "la"); "dito/a" only as a determiner ("ditas alíquotas", "as ditas")
const RESUMPTION = new RegExp(String.raw`(?<![\p{L}])(?:${RESUMPTION_MARKERS})(?![\p{L}])`, 'iu');
const stripSelf = (t: string) => t.replace(SELF_PROVISION, ' ').replace(SELF_REF, ' ');
const CONSTITUTIVE = /^\s*(?:fica(?:m)?|[ée]|s[ãa]o|ser[áa]|ser[ãa]o)(?![\p{L}])[^,]{0,80}?(?<![\p{L}])(?:autorizad|aprovad|institu[íi]d|estabelecid|criad|habilitad|credenciad|concedid|deferid|reconhecid|homologad)[oa]s?(?![\p{L}])/iu;
/**
 * Internal polarity of the command that governs the referenced content (R5, tests only; NOT persisted, NOT in the
 * contract): 'prohibition' | 'permission' | 'obligation' | null. operative_candidate never means "permitted".
 */
export function referencePolarity(text: string): 'prohibition' | 'permission' | 'obligation' | null {
  const m = EXPRESS_REF.exec(text); if (!m) return null;
  const clause = referenceObject(text.slice(0, m.index)).text;
  return PROHIBITION.test(clause) ? 'prohibition' : OBLIGATION.test(clause) ? 'obligation' : PERMISSION.test(clause) ? 'permission' : null;
}
const NORM_CITATION = /\b(?:(?:Ato\s+Decl\.(?:\s*(?:Interpr|Exec)\.)?|Sol\.\s*(?:de\s+Consulta|Cons\.)|(?:Dec|Decr|Instr|Inst|Port|Res|Resol|Conv|Prot|Sol|Parec)\.(?:-Lei)?(?:\s*(?:Conj|Interm|Norm|Leg)\.)?)|Leis?(?:\s+Complementar|\s+Compl\.)?|Decretos?(?:-Lei)?|Instru[çc](?:[ãa]o|[õo]es)\s+Normativas?|IN|Portarias?|Resolu[çc](?:[ãa]o|[õo]es)|Conv[êe]nio|Ajuste|Protocolo|Ato\s+Declarat[óo]rio|ADE|ADI|Medida\s+Provis[óo]ria|Parecer|Solu[çc][ãa]o\s+de\s+(?:Consulta|Diverg[êe]ncia)|Decis[ãa]o|Regulamento|RIR|RIPI|TIPI)(?:(?<=\.)|\b)(?:[^.;:]|(?<=(?<!\p{L})\p{L}{1,8})\.){0,40}?(?:\bn\s*[º°o.]|\b\d{1,3}(?:\.\d{3})+\b|\b\d+\s*\/\s*\d{2,4}\b|,\s*de\s+\d{4})/iu;
const OTHER_NORM_ANNEX = /\b(?:anexos?|tabelas?|quadros?)\b[^;]{0,60}?\bd[ao]s?\s+(?:(?:Ato\s+Decl\.(?:\s*(?:Interpr|Exec)\.)?|Sol\.\s*(?:de\s+Consulta|Cons\.)|(?:Dec|Decr|Instr|Inst|Port|Res|Resol|Conv|Prot|Sol|Parec)\.(?:-Lei)?(?:\s*(?:Conj|Interm|Norm|Leg)\.)?)|Lei|Decreto|Instru[çc][ãa]o\s+Normativa|IN|Portaria|Resolu[çc][ãa]o|Conv[êe]nio|Ajuste|Ato\s+Declarat[óo]rio|Medida\s+Provis[óo]ria|Regulamento|Parecer|Solu[çc][ãa]o\s+de\s+Consulta|TIPI|NCM)(?:(?<=\.)|\b)/iu;
function expressReference(main: MainAct, piece: Piece): string | null {
  if (piece.pointer.startsWith('/ementas/')) return null;
  const live = liveSegmentText(main.prep.html.slice(piece.htmlSpan.start, piece.htmlSpan.end));
  // A2-1: any struck content in the referencing device mixes historical and live text → in doubt, no promotion.
  if (live === null || live.struck) return null;
  const text = live.text;
  const m = EXPRESS_REF.exec(text);
  if (!m || !DEVICE.test(text)) return null;
  if (NEGATION.test(text)) return null;
  // R5 (COORD): a prohibition links the table only when it governs the reference in the SAME (non-elliptical) clause
  if (PROHIBITION.test(text)) { const o = referenceObject(text.slice(0, m.index)); if (o.elliptical || o.viaConnector || !PROHIBITION.test(o.text)) return null; }
  // R4 A3-2 (COORD): an ACCESSORY citation (foundation, dispensation: "dispensadas as exigências … da IN 1.155,") does
  // not block. What blocks is another norm in the OBJECT of the reference: the clause that holds the reference, or —
  // when the reference is elliptical (", descritas abaixo.") — the clause it attaches to. Citation tails (", de 2011")
  // never close a clause. An elliptical reference that leans on a citation is ambiguous → conservative (no promotion).
  const object = referenceObject(text.slice(0, m.index));
  // R6 A5-2: a remission with no provable governing clause in its own sentence is ambiguous → no promotion
  if (object.unresolved) return null;
  if (NORM_CITATION.test(object.text) || OTHER_NORM_ANNEX.test(object.text)) return null;
  // R5 A4-1: through a remission connector, even a bare norm kind ("as regras da IN") in the antecedent blocks
  // R10: an express self-reference ("nesta Portaria") names the act itself, not another norm
  if (object.viaConnector && (NORM_KIND_BARE.test(stripSelf(object.antecedent)) || NORM_KIND_ABBR_ANYCASE.test(stripSelf(object.antecedent)))) return null;
  // R7 A6-1: a remission never reaches past a non-accessory norm citation anywhere earlier in the same sentence — an
  // intermediate nominal clause ("e os respectivos valores") cannot hide it
  const prior = stripSelf(object.prior);
  if (NORM_CITATION.test(object.prior) || OTHER_NORM_ANNEX.test(object.prior) || NORM_KIND_BARE.test(prior) || NORM_KIND_ABBR_ANYCASE.test(prior)) return null;
  return m[0];
}
const CITATION_TAIL = /^\s*(?:de\s+\d{4}|de\s+\d{1,2}\s+de\s+\p{L}+\s+de\s+\d{4}|(?:RFB\s+)?n\s*[º°o.]\s*[\d.]+)\s*$/iu;
// R6: the governing clause chain never crosses a sentence ("." + capital; abbreviations such as "Art.", "nº." or — R7 — "Dec." do not
// end one), a ";" or a ":" — what lies beyond belongs to another proposition or device and is never inherited (E).
const SENTENCE_END = /\.\s+(?=[\p{Lu}§“"])|[;:]/gu;
// R7: tokens whose "." is an abbreviation, never a sentence end — device/number words and abbreviated norm kinds
// (a false end would hide an earlier norm from the remission chain)
const ABBREVIATIONS = new Set(['art', 'arts', 'n', 'nº', 'n°', 'no', 'inc', 'incs', 'al', 'p', 'fl', 'fls', 'sr', 'dr',
  'dec', 'decr', 'instr', 'inst', 'port', 'res', 'resol', 'conv', 'prot', 'compl', 'normat', 'fed',
  // R9 R8-LOW: the second token of composite abbreviated kinds, in any case ("port. conj.", "instr. norm.", "ato decl. interpr.")
  'conj', 'interm', 'norm', 'leg', 'decl', 'interpr', 'exec', 'cons', 'sol', 'parec']);
function sentenceStart(before: string): number {
  let start = 0;
  for (const m of before.matchAll(SENTENCE_END)) {
    if (m[0].startsWith('.')) {
      const tok = /([\p{L}º°]+)$/u.exec(before.slice(0, m.index))?.[1];
      // R8 R7-ABBR: a known abbreviation, or any CAPITALIZED short token ("Conj.", "Norm.", "Decl.", "Interpr."), is not an
      // end — conservative: a merged sentence can only add citations to check, never hide one
      // R9 R8-MRG: …except when the next sentence OPENS with a remission connector: never merged (it stays unresolved)
      const opensRemission = CONNECTOR.test(before.slice(m.index! + m[0].length));
      if (tok && !opensRemission && (ABBREVIATIONS.has(tok.toLowerCase()) || /^\p{Lu}\p{Ll}{0,7}$/u.test(tok))) continue;
    }
    start = m.index! + m[0].length;
  }
  return start;
}
const DEVICE_LABEL = /^\s*(?:Art\.?\s*\d+[º°o]?\.?|§\s*\d+[º°o]?\.?|Par[áa]grafo\s+[úu]nico\.?|[IVXLC]+\s*[-–—]|[a-z]\))\s*/iu;
const STOPWORDS = /\b(?:e|ou|de|do|da|dos|das|com|em|no|na|nos|nas|as|os|a|o|que)\b/giu;
// a clause holds a NOMINAL nucleus when a determiner/contracted preposition introduces a word ("os valores", "da IN",
// "a exportar", "no CNPJ"); bare participles/adverbs ("atualizados mensalmente") do not
const NOMINAL = /(?:^|[^\p{L}])(?:o|a|os|as|um|uma|uns|umas|est[ea]s?|ess[ea]s?|aquel[ea]s?|tais|seus?|suas?|d[oa]s?|n[oa]s?|pel[oa]s?|aos?|à|às)\s+(?!(?:que|qual|quais)\b)\p{L}{3,}/iu;
// a MODIFIER clause (participle, gerund or adverb at its head: "atualizados mensalmente", "contados da ciência",
// "revistos") qualifies the noun before it and never governs the reference, even when it holds a noun phrase
const MODIFIER_HEAD = /^\s*(?:(?:e|ou)\s+)?(?:\p{L}+(?:ad|id|ot|it|ist|eit|ert|ost)[oa]s?|\p{L}+mente|\p{L}+ndo)(?![\p{L}-])/iu;
/**
 * The object region of an express reference (text before it), inside its own sentence only: its own clause; or — when
 * the reference is elliptical (", descritas abaixo.") or the clause opens with a REMISSION CONNECTOR (conforme, nos
 * termos, na forma, segundo, de acordo com, cujo/a/s) — the CHAIN of clauses back to the GOVERNING clause (R6 A5-1):
 * modifier clauses ("atualizados mensalmente", "contados da ciência") and intermediate remissions ("conforme o caso") are traversed and kept;
 * ACCESSORY clauses (dispensad…, com fundamento em, observad…) are skipped as foundations, not the content referenced
 * (R4/R5; ADE Cofis preserved); the first clause with a nominal nucleus ends the chain. `unresolved` (R6 A5-2): a
 * remission whose sentence offers no governing clause, or an elliptical reference whose nearest noun is in an accessory
 * clause (it would describe the other norm's content) — ambiguous, never promoted.
 */
export function referenceObject(before: string): { text: string; elliptical: boolean; viaConnector: boolean; antecedent: string; unresolved: boolean; prior: string } {
  const sentence = before.slice(sentenceStart(before)).replace(DEVICE_LABEL, '');
  // R10 R9-ANA: an opening resumption with no express self-reference in its own sentence is unresolved
  if (RESUMPTION_OPEN.test(sentence) && stripSelf(sentence) === sentence) return { text: sentence, elliptical: false, viaConnector: false, antecedent: '', unresolved: true, prior: '' };
  // R11: a resumption marker (constitutive verb phrase removed, express self-references stripped) in a sentence that cites no
  // norm of its own has its antecedent outside the sentence → unresolved. A sentence that OPENS with a resumption and got here
  // carries an express self-reference (R10 R9-ANA: "Os mesmos valores previstos nesta Portaria") and keeps that R10 outcome
  const sentenceBody = stripSelf(sentence);
  if (!RESUMPTION_OPEN.test(sentence) && RESUMPTION.test(stripSelf(sentence.replace(CONSTITUTIVE, ' '))) && !(NORM_CITATION.test(sentenceBody) || OTHER_NORM_ANNEX.test(sentenceBody)
    || NORM_KIND_BARE.test(sentenceBody) || NORM_KIND_ABBR_ANYCASE.test(sentenceBody))) return { text: sentence, elliptical: false, viaConnector: false, antecedent: '', unresolved: true, prior: '' };
  const chunks = sentence.split(',');
  let k = chunks.length - 1; let own = chunks[k] ?? '';
  while (k > 0 && CITATION_TAIL.test(own)) { k--; own = `${chunks[k]},${own}`; }
  const viaConnector = CONNECTOR.test(own);
  const elliptical = !/\p{L}{3,}/u.test(own.replace(CONNECTOR, '').replace(STOPWORDS, ''));
  if (!elliptical && !viaConnector) return { text: own, elliptical, viaConnector, antecedent: '', unresolved: false, prior: '' };
  // R7 A6-1: every earlier clause of the sentence (citation tails merged), minus accessory ones and a fronted foundation
  const clauses: string[] = [];
  for (let i = 0; i < k; i++) { const c = chunks[i] ?? ''; if (clauses.length && CITATION_TAIL.test(c)) clauses[clauses.length - 1] += `,${c}`; else clauses.push(c); }
  // R8 R7-FRONT: the main clause = the first clause that is neither accessory, foundation nor remission
  const main = [...clauses, own].find((c) => !ACCESSORY.test(c) && !FOUNDATION.test(c) && !CONNECTOR.test(c)) ?? '';
  const foundationAccessory = CONSTITUTIVE.test(main);
  // R9 R8-CST: when the rest of the sentence RESUMES a norm cited in an accessory/foundation clause ("nela previstas",
  // "dela constantes", "previstos na referida norma"), that citation governs the content → it is never skipped
  const cites = (c: string) => NORM_CITATION.test(c) || NORM_KIND_BARE.test(c) || NORM_KIND_ABBR_ANYCASE.test(c);
  // R10 R9-RES: origin of the referenced content in the non-accessory clauses, constitutive verb removed
  const resumed = FOREIGN_ORIGIN.test(stripSelf([...clauses.filter((c) => !(ACCESSORY.test(c) || FOUNDATION.test(c))), own]
    .map((c) => c.replace(CONSTITUTIVE, ' ')).join(',')));
  const skip = (c: string) => !(resumed && cites(c)) && (ACCESSORY.test(c) || (foundationAccessory && FOUNDATION.test(c)));
  const prior = clauses.filter((c) => !skip(c)).join(',');
  const chain: string[] = []; let resolved = false; let nearest = true;
  while (k > 0) {
    k--; let c = chunks[k] ?? '';
    while (k > 0 && CITATION_TAIL.test(c)) { k--; c = `${chunks[k]},${c}`; }
    if (skip(c)) { if (elliptical && nearest) break; nearest = false; continue; }
    nearest = false; chain.unshift(c);
    if (!CONNECTOR.test(c) && !FOUNDATION.test(c) && !MODIFIER_HEAD.test(c) && NOMINAL.test(c)) { resolved = true; break; }
  }
  const antecedent = chain.join(',');
  return { text: antecedent ? `${antecedent},${own}` : own, elliptical, viaConnector, antecedent, unresolved: !resolved, prior };
}

function referenceContextOf(main: MainAct, pointer: string, tachado: boolean, order: number, pieceOrder: Map<string, number>):
  { context: AnatomyPart['context']; evidence: string } {
  const piece = main.prep.pieces.find((x) => x.pointer === `${pointer}/textoIntegra`);
  if (piece) {
    const covering = coveringOf(main, piece);
    if (!covering.length) return { context: 'prohibited', evidence: 'no act part covers the referencing segment: conservative prohibited' };
    let ctx = strictest(covering); if (ctx === 'unknown') ctx = 'prohibited';
    return { context: ctx, evidence: `context of ${covering.length} act part(s) covering ${pointer}` };
  }
  const ordered = main.prep.pieces.map((x) => ({ x, o: pieceOrder.get(x.pointer) })).filter((e): e is { x: Piece; o: number } => typeof e.o === 'number');
  const before = ordered.filter((e) => e.o < order).sort((a, b) => b.o - a.o)[0];
  const after = ordered.filter((e) => e.o > order).sort((a, b) => a.o - b.o)[0];
  if (!before || !after) return { context: 'prohibited', evidence: 'segment has no text and lacks a text neighbour on one side: context undetermined, prohibited' };
  // the part at the END of the previous segment and at the START of the next one decide whether a quotation spans the gap
  const lastOf = (ps: AnatomyPart[]) => ps.sort((a, b) => b.span.start - a.span.start)[0];
  const firstOf = (ps: AnatomyPart[]) => ps.sort((a, b) => a.span.start - b.span.start)[0];
  const prevPart = lastOf(coveringOf(main, before.x)); const nextPart = firstOf(coveringOf(main, after.x));
  if (!prevPart || !nextPart) return { context: 'prohibited', evidence: 'segment has no text and a neighbour has no act part: context undetermined, prohibited' };
  if (prevPart.context === 'prohibited' || nextPart.context === 'prohibited') {
    return { context: 'prohibited', evidence: `segment has no text; neighbour segment ${prevPart.context === 'prohibited' ? before.o : after.o} is prohibited (quotation prevails over tachado)` };
  }
  if (prevPart.context === 'unknown' || nextPart.context === 'unknown') return { context: 'prohibited', evidence: 'segment has no text; a neighbour is undetermined: prohibited' };
  if (tachado) return { context: 'historical', evidence: `segment has no text; source marks it tachado; neighbours ${before.o}/${after.o} are not quoted` };
  // COORD A (E9 P2-c): association by EXPRESS normative reference. Only for a text-less, non-struck segment placed
  // IMMEDIATELY after an operative segment whose text ENDS by pointing to what follows ("… descritas abaixo.", "… na
  // tabela a seguir:"), with an operative (non-quoted, non-historical) next neighbour. Anything else keeps R3.
  const ref = expressReference(main, before.x);
  if (ref && before.o === order - 1 && prevPart.context === 'operative_candidate' && nextPart.context === 'operative_candidate') {
    return { context: 'operative_candidate', evidence: `express reference: segment ${before.o} ends ${JSON.stringify(ref)} and the attachment segment ${order} follows it immediately; neighbours operative` };
  }
  return { context: 'prohibited', evidence: 'segment has no text and is not tachado: context undetermined, prohibited' };
}

export function readRfbInlineAttachments(bytes: Uint8Array, expectedIdAto: number,
  main?: { prep: Pick<JsonPreparation, 'pieces' | 'html'>; parts: readonly AnatomyPart[] }): InlineAttachment[] {
  // R2: the referencing segment's context comes from the act itself; without a supplied reading it is computed here.
  const act = main ?? (() => { const prep = prepareRfbRepresentation({ resourceId: `rfb:${expectedIdAto}`, bytes }, expectedIdAto);
    return { prep, parts: readAnatomyInput({ source: 'RFB', representationId: `rfb:${expectedIdAto}`, html: prep.html }).parts }; })();
  const root = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/u, '')) as Record<string, unknown>;
  if (root.idAto !== expectedIdAto) throw new TypeError('RFB idAto differs from the expected act');
  const out: InlineAttachment[] = []; let actBytes = 0;
  // R3: segment order of every piece, so a text-less referencing segment can be placed between its neighbours.
  const pieceOrder = new Map<string, number>();
  for (const key of ['ementas', 'outrosSegmentos'] as const) (Array.isArray(root[key]) ? root[key] as Record<string, unknown>[] : [])
    .forEach((seg, i) => { if (typeof seg?.ordemSegmentoAto === 'number') pieceOrder.set(`/${key}/${i}/textoIntegra`, seg.ordemSegmentoAto); });
  for (const key of ['ementas', 'outrosSegmentos'] as const) {
    const list = Array.isArray(root[key]) ? root[key] as Record<string, unknown>[] : [];
    list.forEach((seg, i) => {
      const file = seg?.arquivoBinario as Record<string, unknown> | undefined;
      if (!file || typeof file !== 'object' || typeof file.idArquivoBinario !== 'number') return;
      const id = file.idArquivoBinario;
      const base: InlineAttachment = { version: RFB_INLINE_ATTACHMENT_VERSION, idAto: expectedIdAto, idArquivoBinario: id,
        name: typeof file.nomeArquivoBinario === 'string' ? file.nomeArquivoBinario : null,
        idTipoArquivo: typeof file.idTipoArquivo === 'number' ? file.idTipoArquivo : null,
        pointer: `/${key}/${i}/arquivoBinario/arquivoBinario`, segmentOrder: typeof seg.ordemSegmentoAto === 'number' ? seg.ordemSegmentoAto : -1,
        resourceId: `rfb:${expectedIdAto}:anexo:${id}`, state: 'missing_no_content', reason: 'no embedded content in the official JSON',
        byteLength: null, sha256: null, charset: null, html: null, reading: null, referenceContext: 'operative_candidate', referenceContextEvidence: '',
        charsetEvidence: null, htmlForm: null };
      const rc = referenceContextOf(act, `/${key}/${i}`, seg.tachado === true, typeof seg.ordemSegmentoAto === 'number' ? seg.ordemSegmentoAto : -1, pieceOrder);
      base.referenceContext = rc.context; base.referenceContextEvidence = rc.evidence;
      const done = (state: InlineAttachmentState, reason: string, extra: Partial<InlineAttachment> = {}) => { out.push(Object.freeze({ ...base, ...extra, state, reason })); };
      const payload = file.arquivoBinario;
      if (typeof payload !== 'string' || !payload.length) return done('missing_no_content', 'no embedded content in the official JSON');
      const compact = payload.replace(/\s+/gu, '');
      if (compact.length % 4 !== 0 || !B64.test(compact)) return done('invalid_base64', 'payload is not valid base64');
      const decoded = new Uint8Array(Buffer.from(compact, 'base64'));
      const meta = { byteLength: decoded.byteLength, sha256: sha(decoded) };
      if (decoded.byteLength > RFB_INLINE_ATTACHMENT_LIMITS.maxBytesPerAttachment) return done('attachment_too_large', `> ${RFB_INLINE_ATTACHMENT_LIMITS.maxBytesPerAttachment} bytes`, meta);
      if (actBytes + decoded.byteLength > RFB_INLINE_ATTACHMENT_LIMITS.maxBytesPerAct) return done('act_attachments_too_large', `> ${RFB_INLINE_ATTACHMENT_LIMITS.maxBytesPerAct} bytes in this act`, meta);
      const head = Buffer.from(decoded.subarray(0, 512)).toString('latin1').replace(/^﻿|^\xEF\xBB\xBF/u, '').trimStart();
      const isDocument = /^<(!doctype\s+html|html)[\s>]/iu.test(head);
      const fragment = !isDocument && base.idTipoArquivo === 5 ? tableFragmentProblem(decoded) : 'not a type-5 table fragment';
      if (!isDocument && fragment !== null) return done('not_html', `content is not an HTML document (${fragment})`, meta);
      const htmlForm = isDocument ? 'document' as const : 'table_fragment' as const;
      const label = declaredCharset(decoded);
      let charsetEvidence: InlineAttachment['charsetEvidence'] = 'declared';
      let charset: Charset | null;
      if (label) charset = charsetOf(label);
      else if (htmlForm === 'table_fragment') {
        // COORD A: delimited fallback — undeclared charset of a validated table fragment, strict UTF-8 only.
        try { new TextDecoder('utf-8', { fatal: true }).decode(decoded); charset = 'utf-8'; charsetEvidence = 'inferred_strict_utf8'; }
        catch { return done('charset_undeclared', 'table fragment declares no charset and is not strict UTF-8', { ...meta, htmlForm }); }
      } else return done('charset_undeclared', 'the attachment declares no charset', { ...meta, htmlForm });
      if (!charset) return done('charset_unsupported', `charset ${label} is not supported`, { ...meta, htmlForm });
      let html: string;
      // R2: ignoreBOM keeps a UTF-8 BOM as U+FEFF in `html`, so offsets stay aligned with the original bytes.
      try { html = new TextDecoder(charset, { fatal: charset === 'utf-8', ignoreBOM: true }).decode(decoded); }
      catch { return done('charset_unsupported', `bytes are not valid ${charset}`, { ...meta, charset, htmlForm }); }
      actBytes += decoded.byteLength;
      let reading: AnatomyReaderResult;
      try { reading = readAnatomyInput({ source: 'RFB', representationId: base.resourceId, html }); }
      catch (e) { return done('unreadable', `reader refused the attachment: ${(e as Error).message}`, { ...meta, charset, htmlForm, charsetEvidence }); }
      // R2: the attachment never becomes more permissive than the segment that references it.
      if (base.referenceContext !== 'operative_candidate') for (const x of reading.parts) {
        if (RESTRICT[x.context] < RESTRICT[base.referenceContext] && x.type !== 'unidentified') { x.context = base.referenceContext; x.contextReasons.push('rfb_inline_attachment_reference_context'); }
      }
      done('read', null as unknown as string, { ...meta, charset, html, reading, charsetEvidence, htmlForm });
    });
  }
  return out.map((a) => (a.state === 'read' ? Object.freeze({ ...a, reason: null }) : a));
}
