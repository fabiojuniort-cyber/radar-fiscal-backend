import { createHash } from 'node:crypto';
import { Parser } from 'htmlparser2';

/**
 * ANAT-L14 (decisão do Fábio, tribusca-control#116 c.6647638485). Offline preparation of a page of the Sefaz-SP
 * CONSOLIDATED LEGISLATION PORTAL (legislacao.fazenda.sp.gov.br, SharePoint). This is NOT the DOE-SP official
 * gazette (Diário Oficial): the preparation records its own source kind and never reuses DOE-SP identifiers.
 *
 * It extracts only the page's legal content region — the single `.ms-rtestate-field` labelled "Conteúdo da Página"
 * inside `#areaComentario` — copying its inner HTML verbatim (no normalization, no repair) inside a neutral wrapper
 * `<div data-sefaz-sp-portal="legislacao-consolidada">`. Menus, scripts and portal controls outside the region are
 * left out of the prepared representation; the raw page (bytes, SHA-256, URL) is preserved by the caller's snapshot
 * and the prepared interval maps back to the raw HTML. Missing, duplicated or ambiguous regions fail closed.
 *
 * The reader still reads the prepared HTML with the DOE-SP rules (the engine contract has no separate source yet);
 * only blocks inside the wrapper get the portal classes `nota` (editorial note, L15) and `revogado` (earlier
 * wording, L16). Plain DOE-SP gazette HTML has no wrapper and is unaffected.
 */
export const SEFAZ_SP_PORTAL_PREPARATION_VERSION = 'sefaz-sp-portal/0.1.0-provisional' as const;
export const SEFAZ_SP_PORTAL_HOST = 'legislacao.fazenda.sp.gov.br' as const;
export const SEFAZ_SP_PORTAL_WRAPPER = 'legislacao-consolidada' as const;

export interface SefazSpPortalResource { resourceId: string; url: string; bytes: Uint8Array }

export interface SefazSpPortalPreparation {
  preparationVersion: typeof SEFAZ_SP_PORTAL_PREPARATION_VERSION;
  provisional: true;
  /** The consolidated-legislation portal of Sefaz-SP; distinct from the DOE-SP gazette. */
  source: 'SEFAZ-SP-PORTAL';
  sourceKind: 'consolidated_legislation_portal';
  /** Reader rules used for the prepared HTML (the engine contract has no own source for the portal yet). */
  readerSource: 'DOE-SP';
  url: string;
  resource: { resourceId: string; sha256: string; byteLength: number; bomPresent: boolean };
  /** The selected region, as proof of the selection. */
  region: { selector: string; labelText: string; rawSpan: { start: number; end: number }; htmlSpan: { start: number; end: number }; sha256: string };
  /** Raw page text intervals left out of the prepared representation (navigation, scripts, controls). */
  excludedRawLength: number;
  html: string;
  htmlSha256: string;
  preparationId: string;
}

export class SefazSpPreparationError extends Error {
  constructor(readonly code: 'not_https' | 'not_portal_host' | 'not_utf8' | 'region_missing' | 'region_duplicated' | 'region_ambiguous' | 'region_empty', message: string) {
    super(message); this.name = 'SefazSpPreparationError';
  }
}

const sha = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const LABEL = 'Conteúdo da Página';

interface El { name: string; attrs: Record<string, string>; start: number; openEnd: number; closeStart: number; end: number; parent: El | null; text: string }

function parse(html: string): El[] {
  const all: El[] = []; const stack: El[] = [];
  const parser = new Parser({
    onopentag(name, attrs) {
      const el: El = { name, attrs, start: parser.startIndex, openEnd: parser.endIndex + 1, closeStart: -1, end: -1, parent: stack[stack.length - 1] ?? null, text: '' };
      all.push(el); stack.push(el);
    },
    ontext(t) { for (const el of stack) el.text += t; },
    onclosetag(name) {
      // htmlparser2 closes implied tags too; pop until the matching element.
      for (let i = stack.length - 1; i >= 0; i--) if (stack[i]!.name === name) {
        while (stack.length > i) { const el = stack.pop()!; el.closeStart = parser.startIndex; el.end = parser.endIndex + 1; if (el.name !== name) el.closeStart = el.end = -1; }
        break;
      }
    },
  }, { decodeEntities: true, lowerCaseTags: true, recognizeSelfClosing: false });
  parser.write(html); parser.end();
  return all;
}

const hasClass = (el: El, name: string) => (el.attrs.class ?? '').split(/\s+/u).includes(name);
const within = (el: El, ancestor: El) => { for (let p = el.parent; p; p = p.parent) if (p === ancestor) return true; return false; };

export function prepareSefazSpPortalPage(input: SefazSpPortalResource): SefazSpPortalPreparation {
  let parsed: URL;
  try { parsed = new URL(input.url); } catch { throw new SefazSpPreparationError('not_portal_host', 'invalid URL'); }
  // R1-SP-02: the official collector only accepts HTTPS; the preparation refuses anything else too.
  if (parsed.protocol !== 'https:') throw new SefazSpPreparationError('not_https', `protocol ${parsed.protocol} is not HTTPS`);
  const host = parsed.hostname.toLowerCase();
  if (host !== SEFAZ_SP_PORTAL_HOST) throw new SefazSpPreparationError('not_portal_host', `host ${host} is not the Sefaz-SP legislation portal (DOE-SP gazette and others are not prepared here)`);
  let raw: string;
  try { raw = new TextDecoder('utf-8', { fatal: true }).decode(input.bytes); } catch { throw new SefazSpPreparationError('not_utf8', 'page is not valid UTF-8'); }
  const bomPresent = raw.charCodeAt(0) === 0xfeff; if (bomPresent) raw = raw.slice(1);
  const els = parse(raw);
  const areas = els.filter((e) => e.attrs.id === 'areaComentario');
  const fields = els.filter((e) => hasClass(e, 'ms-rtestate-field'));
  if (!areas.length || !fields.length) throw new SefazSpPreparationError('region_missing', 'no #areaComentario / .ms-rtestate-field content region');
  if (areas.length > 1 || fields.length > 1) throw new SefazSpPreparationError('region_duplicated', `${areas.length} #areaComentario, ${fields.length} .ms-rtestate-field`);
  const area = areas[0]!; const field = fields[0]!;
  if (!within(field, area)) throw new SefazSpPreparationError('region_ambiguous', '.ms-rtestate-field is outside #areaComentario');
  const labelId = field.attrs['aria-labelledby'];
  const label = labelId ? els.filter((e) => e.attrs.id === labelId) : [];
  if (label.length !== 1 || label[0]!.text.trim() !== LABEL) throw new SefazSpPreparationError('region_ambiguous', `content field is not labelled "${LABEL}"`);
  if (field.closeStart < 0) throw new SefazSpPreparationError('region_ambiguous', 'content field is not explicitly closed');
  const rawSpan = { start: field.openEnd, end: field.closeStart };
  const inner = raw.slice(rawSpan.start, rawSpan.end);
  if (!field.text.trim()) throw new SefazSpPreparationError('region_empty', 'content region has no text');
  const open = `<div data-sefaz-sp-portal="${SEFAZ_SP_PORTAL_WRAPPER}">`;
  const html = `${open}${inner}</div>`;
  const htmlSpan = { start: open.length, end: open.length + inner.length };
  const htmlSha256 = sha(html);
  const resource = { resourceId: input.resourceId, sha256: sha(input.bytes), byteLength: input.bytes.byteLength, bomPresent };
  const preparationId = sha(JSON.stringify({ version: SEFAZ_SP_PORTAL_PREPARATION_VERSION, url: input.url, resource: resource.sha256, htmlSha256 }));
  const prepared: SefazSpPortalPreparation = Object.freeze({ preparationVersion: SEFAZ_SP_PORTAL_PREPARATION_VERSION, provisional: true, source: 'SEFAZ-SP-PORTAL', sourceKind: 'consolidated_legislation_portal',
    readerSource: 'DOE-SP', url: input.url, resource,
    region: { selector: '#areaComentario .ms-rtestate-field[aria-labelledby → "Conteúdo da Página"]', labelText: LABEL, rawSpan, htmlSpan, sha256: sha(inner) },
    excludedRawLength: raw.length - inner.length, html, htmlSha256, preparationId }) as SefazSpPortalPreparation;
  ISSUED.add(prepared);
  return prepared;
}

/**
 * R2-SP-01: provenance of the portal classification is never read from the HTML (a `data-sefaz-sp-portal` attribute
 * is forgeable). Only a frozen preparation object issued by THIS module in this process, whose fields are consistent
 * and whose hash matches the exact HTML being read, enables the portal classes. A look-alike object built elsewhere,
 * a modified HTML or a non-HTTPS / non-portal URL is refused.
 */
const ISSUED = new WeakSet<object>();
export function verifySefazSpPortalProvenance(prep: unknown, html: string): prep is SefazSpPortalPreparation {
  if (!prep || typeof prep !== 'object' || !ISSUED.has(prep) || !Object.isFrozen(prep)) return false;
  const p = prep as SefazSpPortalPreparation;
  let url: URL; try { url = new URL(p.url); } catch { return false; }
  const open = `<div data-sefaz-sp-portal="${SEFAZ_SP_PORTAL_WRAPPER}">`;
  return p.preparationVersion === SEFAZ_SP_PORTAL_PREPARATION_VERSION && p.source === 'SEFAZ-SP-PORTAL' && p.sourceKind === 'consolidated_legislation_portal'
    && url.protocol === 'https:' && url.hostname.toLowerCase() === SEFAZ_SP_PORTAL_HOST
    && p.html === html && sha(html) === p.htmlSha256 && html.startsWith(open) && html.endsWith('</div>')
    && p.preparationId === sha(JSON.stringify({ version: SEFAZ_SP_PORTAL_PREPARATION_VERSION, url: p.url, resource: p.resource.sha256, htmlSha256: p.htmlSha256 }));
}
