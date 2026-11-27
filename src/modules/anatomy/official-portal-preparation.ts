import { DomUtils, parseDocument } from 'htmlparser2';
type PortalElement = ReturnType<typeof DomUtils.findAll>[number];

type PortalSource = 'DOU' | 'CONFAZ' | 'PLANALTO';
export interface OfficialActPreparation {
  readonly source: PortalSource;
  readonly resourceId: string;
  readonly start: number;
  readonly end: number;
  readonly chars: number;
}
const issued = new WeakMap<OfficialActPreparation, string>();
export const PORTAL_MAX_NODES = 180_000;
const IGNORED = new Set(['script', 'style', 'noscript', 'template', 'nav']);
const BLOCKS = /^(?:address|article|blockquote|br|dd|div|dl|dt|h[1-6]|hr|li|ol|p|pre|section|table|tbody|td|th|thead|tr|ul)$/u;

function hasClass(classes: string | undefined, name: string): boolean {
  return classes?.split(/\s+/u).includes(name) ?? false;
}

/** Measure the source's dedicated act container. Never use the reader's full-page or raw-HTML fallback. */
export function prepareOfficialAct(source: PortalSource, resourceId: string, html: string, epigraph?: string): OfficialActPreparation | null {
  if (Buffer.byteLength(html, 'utf8') > 2 * 1024 * 1024) return null;
  const doc = parseDocument(html, { withStartIndices: true, withEndIndices: true });
  if (source === 'PLANALTO') {
    const bodies = DomUtils.findAll((node) => node.name === 'body', doc.children);
    if (bodies.length !== 1 || !epigraph) return null;
    const body = bodies[0]!;
    const paragraphs = DomUtils.findAll((node) => node.name === 'p', body.children);
    const headers = paragraphs.filter((p) => /^LEI\s+N/iu.test(normalizeText(DomUtils.textContent(p)))
      && normalizeText(DomUtils.textContent(p)).replace(/\s+/gu, '').toUpperCase().includes(normalizeText(epigraph).toUpperCase().replace(/\s+/gu, '')));
    if (headers.length !== 1 || headers[0]!.startIndex === null || body.endIndex === null) return null;
    const start = headers[0]!.startIndex!;
    const end = html.lastIndexOf('<', body.endIndex);
    if (!/^<\/body\s*>$/iu.test(html.slice(end, body.endIndex + 1))
      || !/Casa\s+Civil/iu.test(html.slice(body.startIndex ?? 0, start))) return null;
    const visible = measure(parseDocument(html.slice(start, end)).children);
    const hasFirstArticle = paragraphs.some((p) => p.startIndex !== null && p.startIndex > start
      && /^Art\.\s*1(?:[º°o])?(?![\p{L}\p{N}])/iu.test(normalizeText(DomUtils.textContent(p))));
    if (!visible || !hasFirstArticle) return null;
    const result = Object.freeze({ source, resourceId, start, end, chars: visible.length });
    issued.set(result, html);
    return result;
  }
  const roots = DomUtils.findAll((node) => source === 'DOU'
    ? node.name === 'article' && node.attribs.id === 'materia'
    : node.attribs.id === 'content-core', doc.children);
  if (roots.length !== 1) return null;

  const acts = DomUtils.findAll((node) => source === 'DOU'
    ? node.name === 'div' && hasClass(node.attribs.class, 'texto-dou')
    : node.attribs.id === 'parent-fieldname-text', roots[0]!.children);
  const act = acts[0];
  if (acts.length !== 1 || !act || act.endIndex === null || act.startIndex === null) return null;

  const closingTag = html.slice(html.lastIndexOf('<', act.endIndex), act.endIndex + 1);
  if (!new RegExp(`^</${act.name}\\s*>$`, 'iu').test(closingTag)) return null;

  const visible = measure(act.children);
  if (!visible || (epigraph && !matchesEpigraph(source, visible.slice(0, 1600), epigraph)
    && !(source === 'DOU' && matchesDouCgsnEpigraph(act, epigraph))
    && !(source === 'CONFAZ' && matchesConfazLegacyTitle(act, epigraph)))) return null;
  const result = Object.freeze({ source, resourceId, start: act.startIndex, end: act.endIndex + 1, chars: visible.length });
  if (epigraph) issued.set(result, html);
  return result;
}

function measure(nodes: ReturnType<typeof parseDocument>['children']): string {
  const chunks: string[] = [];
  const stack = [...nodes].reverse().map((node) => ({ node, close: false }));
  while (stack.length) {
    const { node, close } = stack.pop()!;
    if (node.type === 'text') {
      chunks.push(node.data);
      continue;
    }
    if (node.type !== 'tag' || IGNORED.has(node.name) || 'hidden' in node.attribs) continue;
    if (BLOCKS.test(node.name)) chunks.push(' ');
    if (close) continue;
    if (BLOCKS.test(node.name)) stack.push({ node, close: true });
    for (let index = node.children.length - 1; index >= 0; index--) {
      stack.push({ node: node.children[index]!, close: false });
    }
  }
  return normalizeText(chunks.join(''));
}

const normalizeText = (text: string) => text.normalize('NFC').replace(/\s+/gu, ' ').trim();

// Legacy Plone titles may pad the agreement number or print the date with an ordinal day.
// Require the first visible child to be the sole explicit title, so a citation cannot prove the act.
function matchesConfazLegacyTitle(act: PortalElement, expected: string): boolean {
  const key = /^(AJUSTE SINIEF|PROTOCOLO ICMS)\s+0*(\d+)\s*\/\s*(\d{2})$/iu.exec(normalizeText(expected));
  if (!key) return false;
  const titles = DomUtils.findAll((node) => node.name === 'p' && hasClass(node.attribs.class, 'TituloAcordo') && measure([node]) !== '', act.children);
  const first = act.children.find((node) => measure([node]));
  if (titles.length !== 1 || first !== titles[0]) return false;
  const title = /^(AJUSTE SINIEF|PROTOCOLO ICMS)\s+0*(\d+)(?:\s*\/\s*(\d{2}))?,\s+DE\s+(?:0?[1-9]|[12]\d|3[01])[º°]?\s+DE\s+\p{L}+\s+DE\s+20(\d{2})$/iu.exec(measure([titles[0]!]));
  return !!title && key[1]!.toUpperCase() === title[1]!.toUpperCase()
    && key[2] === title[2] && key[3] === title[4] && (title[3] === undefined || title[3] === title[4]);
}

// The metadata can put CGSN in the resolution title while the portal prints the issuer separately.
function matchesDouCgsnEpigraph(act: PortalElement, expected: string): boolean {
  const key = /^RESOLUÇÃO CGSN N[º°o]\s+(\d+)(?=,|$)/iu.exec(normalizeText(expected));
  if (!key) return false;
  const headings = act.children.filter((n): n is PortalElement => n.type === 'tag' && n.name === 'p' && hasClass(n.attribs.class, 'identifica'));
  if (headings.length !== 1) return false;
  const [issuer, title] = act.children.filter((n) => normalizeText(DomUtils.textContent(n)));
  if (!title || !issuer || issuer.type !== 'tag' || issuer.name !== 'p' || !hasClass(issuer.attribs.class, 'titulo')
    || !/^COMITÊ GESTOR DO SIMPLES NACIONAL$/iu.test(normalizeText(DomUtils.textContent(issuer))) || title !== headings[0]) return false;
  const literal = normalizeText(DomUtils.textContent(title));
  const number = /^RESOLUÇÃO N[º°o]\s+(\d+), DE \d{1,2} DE \p{L}+ DE \d{4}$/iu.exec(literal);
  if (number?.[1] !== key[1]) return false;
  return normalizeText(expected).length === key[0].length
    || literal.toUpperCase() === normalizeText(expected).replace(/ CGSN /iu, ' ').toUpperCase();
}

function matchesEpigraph(source: PortalSource, visible: string, expected: string): boolean {
  const wanted = normalizeText(expected);
  if (visible.toUpperCase().includes(wanted.toUpperCase())) return true;
  if (source !== 'CONFAZ') return false;
  const key = /^(.+?)\s+(?:N[º°o.]\s*)?0*(\d+)\s*\/\s*(?:20)?(\d{2})\b/iu.exec(wanted);
  const title = /^(.+?)\s+(?:N[º°o.]\s*)?0*(\d+),\s+DE\s+\d+\s+DE\s+\p{L}+\s+DE\s+20(\d{2})\b/iu.exec(visible);
  return !!key && !!title && key.slice(1).every((part, n) => part.toUpperCase() === title[n + 1]?.toUpperCase());
}

export function verifyOfficialAct(prep: OfficialActPreparation, source: string, resourceId: string, html: string): boolean {
  return prep.source === source && prep.resourceId === resourceId && issued.get(prep) === html;
}

export function portalActChars(source: 'DOU' | 'CONFAZ', html: string): number | null {
  return prepareOfficialAct(source, '', html)?.chars ?? null;
}
