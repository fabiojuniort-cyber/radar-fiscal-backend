/**
 * Local decoding policy authorized by the COORD (#116 c.6708512598 §6), following WHATWG "determining the character
 * encoding": BOM first, then a charset the bytes declare; only when both are absent AND the HTTP response carried no
 * charset, an explicit windows-1252 fallback is admitted — for only the SHA-256-pinned Planalto snapshots below. It is a reader
 * decision (encodingSource=approved_local_fallback, confidence=tentative), never a charset declared by the origin:
 * declaredCharset stays null and the bytes/hashes stay untouched. Anything else without a charset is refused.
 * This enables reading preparation only; it creates no Planalto profile and closes no cell.
 */
import { createHash } from 'node:crypto';
const SUPPORTED: Record<string, string> = { 'utf-8': 'utf-8', utf8: 'utf-8', 'windows-1252': 'windows-1252', 'iso-8859-1': 'windows-1252', latin1: 'windows-1252' };
export class UnsupportedEncodingError extends Error {}
/** Decode with the encoding the file declares (fatal for UTF-8); anything else is refused, never guessed. */
export function decodeDeclared(bytes: Uint8Array, declared: string | null): string {
  const label = SUPPORTED[(declared ?? '').toLowerCase()];
  if (!label) throw new UnsupportedEncodingError(`declared encoding ${declared ?? '(none)'} is not supported`);
  return new TextDecoder(label, { fatal: label === 'utf-8' }).decode(bytes);
}

export const APPROVED_FALLBACK: Readonly<Record<string, { encoding: 'windows-1252'; item: string; ref: string; manualItem?: 'M10' | 'M12' }>> = Object.freeze({
  '1bfb6dabc79c5523fd697f4d598e7171be9a0ab694d92423018c71f91bf654bf': { encoding: 'windows-1252', item: 'M10 (Lei 10.168/2000, Planalto)', manualItem: 'M10', ref: 'tribusca-control#116 c.7007752683 (E9-M1b)' },
  '5776d1bbd28af7567b3a1d29c385142cd5b37bce8551ae8119a1c120392c6a7f': { encoding: 'windows-1252', item: 'M12 (Lei 9.718/1998, Planalto)', manualItem: 'M12', ref: 'tribusca-control#116 c.7007752683 (E9-M1b)' },
  fcab62384ebd6846157afefe13e82dbf313b435c26cc2605b284d98aaa613f36: { encoding: 'windows-1252', item: 'M1 (Lei 10.637/2002, Planalto)', ref: 'tribusca-control#116 c.6708512598 §6' },
  '25b7fc2de4c59dde7e2bd1fe88ac56d8285276c1f5b856e5ea3533d88315b7e9': { encoding: 'windows-1252', item: 'M2 (Lei 10.833/2003, Planalto)', ref: 'tribusca-control#116 c.6708512598 §6' },
});
export interface Decoded { text: string; encoding: string; encodingSource: 'bom' | 'declared' | 'approved_local_fallback'; confidence: 'declared' | 'tentative'; declaredCharset: string | null }
export class CharsetRefused extends Error {}

export function decodeWithPolicy(bytes: Uint8Array, opts: { httpCharset: string | null }): Decoded {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8', encodingSource: 'bom', confidence: 'declared', declaredCharset: null };
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 4096));
  const declared = /charset\s*=\s*["']?([\w-]+)/iu.exec(head)?.[1] ?? null;
  if (declared) return { text: decodeDeclared(bytes, declared), encoding: declared.toLowerCase(), encodingSource: 'declared', confidence: 'declared', declaredCharset: declared };
  if (opts.httpCharset) throw new CharsetRefused('HTTP charset present: use it as declared (not handled by the fallback)');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const approved = APPROVED_FALLBACK[sha];
  if (!approved) throw new CharsetRefused('no BOM, no declared charset and not an approved snapshot: refused (never inferred)');
  const text = new TextDecoder('windows-1252').decode(bytes);
  if (/[\u0080-\u009f]/u.test(text)) throw new CharsetRefused('windows-1252 fallback produced C1 control characters: ambiguous → pending');
  return { text, encoding: approved.encoding, encodingSource: 'approved_local_fallback', confidence: 'tentative', declaredCharset: null };
}

const visible = (s: string) => s.replace(/<(script|style)[\s\S]*?<\/\1>/giu, ' ').replace(/<[^>]+>/gu, ' ').replace(/&nbsp;|&#160;| /gu, ' ')
  .replace(/&#(\d+);/gu, (_, n) => String.fromCodePoint(Number(n))).replace(/&quot;/gu, '"').replace(/&amp;/gu, '&').replace(/\s+/gu, ' ');
/** Accented passages checked against an INDEPENDENT official representation (normas.leg.br, version "atualizada"). */
export const PASSAGES: Readonly<Record<string, string[]>> = Object.freeze({
  M1: ['A Contribuição para o PIS/Pasep, com a incidência não cumulativa, incide sobre o total das receitas auferidas no mês pela pessoa jurídica'],
  M2: ['A Contribuição para o Financiamento da Seguridade Social - Cofins, com a incidência não cumulativa, incide sobre o total das receitas auferidas no mês pela pessoa jurídica'],
});
export function compareWithIndependent(decoded: string, independentHtml: string, passages: string[]): { passage: string; inDecoded: boolean; inIndependent: boolean; sentenceEqual: boolean }[] {
  const a = visible(decoded); const b = visible(independentHtml);
  const sentence = (t: string, p: string) => { const i = t.indexOf(p); if (i < 0) return null; const j = t.indexOf('.', i + p.length); return t.slice(i, j < 0 ? undefined : j + 1); };
  return passages.map((p) => { const sa = sentence(a, p); const sb = sentence(b, p); return { passage: p, inDecoded: sa !== null, inIndependent: sb !== null, sentenceEqual: sa !== null && sa === sb }; });
}
