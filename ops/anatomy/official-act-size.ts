import { DomUtils, parseDocument } from 'htmlparser2';

const IGNORED = new Set(['script', 'style', 'noscript', 'template', 'nav']);
const BLOCKS = /^(?:address|article|blockquote|br|dd|div|dl|dt|h[1-6]|hr|li|ol|p|pre|section|table|tbody|td|th|thead|tr|ul)$/u;

function hasClass(classes: string | undefined, name: string): boolean {
  return classes?.split(/\s+/u).includes(name) ?? false;
}

/** Measure the source's dedicated act container. Never use the reader's full-page or raw-HTML fallback. */
export function portalActChars(source: 'DOU' | 'CONFAZ', html: string): number | null {
  const doc = parseDocument(html, { withEndIndices: true });
  const roots = DomUtils.findAll((node) => source === 'DOU'
    ? node.name === 'article' && node.attribs.id === 'materia'
    : node.attribs.id === 'content-core', doc.children);
  if (roots.length !== 1) return null;

  const acts = DomUtils.findAll((node) => source === 'DOU'
    ? node.name === 'div' && hasClass(node.attribs.class, 'texto-dou')
    : node.attribs.id === 'parent-fieldname-text', roots[0]!.children);
  const act = acts[0];
  if (acts.length !== 1 || !act || act.endIndex === null) return null;

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
  return chunks.join('').normalize('NFC').replace(/\s+/gu, ' ').trim().length || null;
}
