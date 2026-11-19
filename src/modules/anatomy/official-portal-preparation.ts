import { DomUtils, parseDocument } from 'htmlparser2';

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

  const chunks: string[] = [];
  const stack = [...act.children].reverse().map((node) => ({ node, close: false }));
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
  const visible = normalizeText(chunks.join(''));
  if (!visible || (epigraph && !matchesEpigraph(source, visible.slice(0, 1600), epigraph))) return null;
  const result = Object.freeze({ source, resourceId, start: act.startIndex, end: act.endIndex + 1, chars: visible.length });
  if (epigraph) issued.set(result, html);
  return result;
}

const normalizeText = (text: string) => text.normalize('NFC').replace(/\s+/gu, ' ').trim();

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
