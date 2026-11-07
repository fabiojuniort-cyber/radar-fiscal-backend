import { createHash } from 'node:crypto';
import { Parser } from 'htmlparser2';
import { prepareRfbRepresentation, type JsonResource } from './json-preparation.js';
import { defaultRules } from './profile-rules.js';

/**
 * ANAT-L20 (desenho final, #293 §17). For an RFB act whose quotation opens and never closes, the preparation computes
 * — from the official JSON only — whether the evidence E0–E7 (#293 §14.1, §15, §16) says the quotation is the act's own
 * new wording of an article. The result is ONLY a candidate for human review: the reader then emits the limitation
 * `rfb_quote_unclosed_resume_candidate` and changes no part, context, type, eligibility or sourceMap. Nothing is
 * resumed automatically.
 *
 * Provenance (E4): the plan is issued here, deep-frozen and registered in a private WeakSet, and bound to the prepared
 * HTML hash and to the representation id. HTML attributes are never read for it; a missing, forged, copied or
 * mismatched plan yields no signal.
 */
export const RFB_QUOTE_RESUME_PLAN_VERSION = 'rfb-quote-resume/0.1.0-provisional' as const;

export interface RfbQuoteResumeSegmentRef { order: number; pointer: string; htmlSpan: { start: number; end: number } }
export interface RfbQuoteResumeCandidate {
  /** Segment whose first block opens the quotation with `"Art. N`, and N. */
  opening: RfbQuoteResumeSegmentRef & { article: string };
  /** First article after the opening, declared, not struck, without quotes, numbered as the successor of N. */
  successor: RfbQuoteResumeSegmentRef & { article: string };
  evidence: {
    /** E0: the quotation is never closed in the act and the successor exists (also re-checked by the reader). */
    E0: { unclosed: true; successorOrder: number };
    /** E1: the segment right before the opening is article N struck (earlier wording of the act's own article). */
    E1: { struckArticleOrder: number };
    /** E2: no amending formula in the last operative article nor between it and the opening (orders checked). */
    E2: { checkedOrders: number[] };
    /** E6: struck + current pairs of the same label between the opening and the successor. */
    E6: { pairs: { struckOrder: number; currentOrder: number; type: string; label: string }[] };
    /** E7: a declared grouping right before the successor, or the successor's own struck pair. */
    E7: { kind: 'declared_grouping'; order: number; type: string } | { kind: 'struck_successor_pair'; order: number };
  };
}
export interface RfbQuoteResumePlan {
  planVersion: typeof RFB_QUOTE_RESUME_PLAN_VERSION;
  representationId: string;
  htmlSha256: string;
  preparationId: string;
  candidate: RfbQuoteResumeCandidate | null;
  /** Why there is no candidate (audit only; the reader emits nothing for it). */
  notCandidate: { condition: 'no_unclosed_quotation' | 'E0' | 'E1' | 'E2' | 'E6' | 'E7'; detail: string } | null;
}

const sha = (v: string | Uint8Array): string => createHash('sha256').update(v).digest('hex');
const ISSUED = new WeakSet<object>();
const deepFreeze = <T>(v: T): T => { if (v && typeof v === 'object') { for (const x of Object.values(v)) deepFreeze(x); Object.freeze(v); } return v; };
const deepFrozen = (v: unknown): boolean => v === null || typeof v !== 'object' || (Object.isFrozen(v) && Object.values(v).every(deepFrozen));

const BLOCKS = new Set(['p', 'div', 'section', 'h1', 'h2', 'h3', 'h4', 'li', 'table', 'tr', 'td', 'th', 'article']);
const PAIRABLE = new Set(['paragrafo', 'inciso', 'alinea', 'item']);
const GROUPING = new Set(['secao', 'subsecao', 'capitulo', 'titulo', 'livro', 'parte']);
const AMENDING = /passa(?:m)?\s+a\s+vigorar|com\s+as\s+seguintes\s+altera[cç][oõ]es|fica(?:m)?\s+acrescid|nova\s+reda[cç][aã]o|com\s+a\s+seguinte\s+reda[cç][aã]o/iu;
const ARTICLE = /^\s*Art\.?\s*(\d+)\s*(?:[º°o]\s*)?(?:-\s*([A-Z])\b)?/u;
const LABEL = /^\s*(§\s*\d+\s*[º°o]?|Par[aá]grafo\s+[uú]nico|[IVXLCDM]+\s*[-–—]|[a-z]\s*\)|\d+\s*[.)–—-])/u;
const norm = (s: string | null): string => (s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

/** Leaf block texts of one segment's HTML, in order (the same block notion as the reader). */
function blockTexts(html: string): string[] {
  const out: string[] = []; const stack: { block: boolean; text: string; hasBlockChild: boolean }[] = [{ block: true, text: '', hasBlockChild: false }];
  const parser = new Parser({
    onopentag(name) { const block = BLOCKS.has(name); if (block) for (const s of stack) s.hasBlockChild = true; stack.push({ block, text: '', hasBlockChild: false }); },
    ontext(t) { for (const s of stack) s.text += t; },
    onclosetag() { const s = stack.pop(); if (s?.block && !s.hasBlockChild && s.text.trim()) out.push(s.text.trim()); },
  }, { decodeEntities: true, lowerCaseTags: true });
  parser.write(html); parser.end();
  const root = stack[0]!; if (!root.hasBlockChild && root.text.trim()) out.push(root.text.trim());
  return out;
}

interface Seg { order: number; pointer: string; sigla: string; tachado: boolean; htmlSpan: { start: number; end: number }; blocks: string[] }
const articleOf = (text: string | undefined): { num: number; suffix: string | null; label: string } | null => {
  const m = ARTICLE.exec(text ?? ''); if (!m) return null;
  return { num: Number(m[1]), suffix: m[2] ?? null, label: `${m[1]}${m[2] ? `-${m[2]}` : ''}` };
};
const nextLetter = (s: string | null): string => (s === null ? 'A' : String.fromCharCode(s.charCodeAt(0) + 1));
const labelOf = (text: string | undefined): string | null => { const m = LABEL.exec(text ?? ''); return m ? m[1]!.replace(/\s+/gu, ' ').trim().toLowerCase() : null; };

/**
 * Compute the L20 plan from the official RFB JSON. The RFB preparation is re-executed here, so the plan is bound to
 * exactly the HTML `prepareRfbRepresentation` produces for these bytes.
 */
export function planRfbQuoteResume(input: JsonResource, expectedIdAto: number): RfbQuoteResumePlan {
  const prep = prepareRfbRepresentation(input, expectedIdAto);
  const rules = defaultRules('RFB');
  const byPointer = new Map(prep.pieces.map((p) => [p.pointer, p.htmlSpan]));
  const segs: Seg[] = [];
  for (const t of prep.segmentTypes ?? []) {
    const htmlSpan = byPointer.get(`${t.pointer}/textoIntegra`); if (!htmlSpan) continue;
    segs.push({ order: t.order, pointer: t.pointer, sigla: norm(t.sigla), tachado: t.tachado, htmlSpan, blocks: blockTexts(prep.html.slice(htmlSpan.start, htmlSpan.end)) });
  }
  const issue = (plan: Pick<RfbQuoteResumePlan, 'candidate' | 'notCandidate'>): RfbQuoteResumePlan => {
    const issued = deepFreeze({ planVersion: RFB_QUOTE_RESUME_PLAN_VERSION, representationId: input.resourceId, htmlSha256: prep.htmlSha256,
      preparationId: prep.preparationId, ...plan });
    ISSUED.add(issued); return issued;
  };
  const fail = (condition: NonNullable<RfbQuoteResumePlan['notCandidate']>['condition'], detail: string) => issue({ candidate: null, notCandidate: { condition, detail } });

  // E0(a): mirror the reader's quotation state over every block of the act; the opening is where it last opened.
  let open = false; let opening: { seg: number; block: number } | null = null;
  segs.forEach((s, si) => s.blocks.forEach((text, bi) => {
    if (rules.quoteOpen.test(text) && !open) { open = true; opening = { seg: si, block: bi }; } else if (rules.quoteOpen.test(text)) open = true;
    if (rules.quoteClose.test(text) && !rules.quoteOnly.test(text)) open = false;
  }));
  if (!open || !opening) return fail('no_unclosed_quotation', 'every quotation of the act is closed (or there is none)');
  const { seg: oi, block: ob } = opening as { seg: number; block: number };
  const openSeg = segs[oi]!;
  if (ob !== 0) return fail('E0', `the quotation opens inside segment ${openSeg.order}, not at its first block`);
  const n = articleOf(openSeg.blocks[0]!.replace(rules.quoteOpen, ''));
  if (!n) return fail('E0', `the opening block of segment ${openSeg.order} does not start with an article label`);

  // E0(b'): the first declared, not struck article after the opening must be the successor of N, without quotes.
  let si = -1;
  for (let i = oi + 1; i < segs.length; i++) if (segs[i]!.sigla === 'artigo' && !segs[i]!.tachado) { si = i; break; }
  if (si < 0) return fail('E0', `no declared, not struck article after the opening (N=${n.label})`);
  const succ = segs[si]!; const sa = articleOf(succ.blocks[0]);
  if (!sa || rules.quoteOpen.test(succ.blocks[0] ?? '')) return fail('E0', `segment ${succ.order} is not an unquoted article label`);
  const isSuccessor = (sa.num === n.num + 1 && sa.suffix === null) || (sa.num === n.num && sa.suffix === nextLetter(n.suffix));
  if (!isSuccessor) return fail('E0', `article ${sa.label} (segment ${succ.order}) is not the successor of ${n.label}`);

  // E1: the segment right before the opening is article N struck.
  const before = segs[oi - 1]; const ba = articleOf(before?.blocks[0]);
  if (!before || before.sigla !== 'artigo' || !before.tachado || !ba || ba.label !== n.label) return fail('E1', `segment before the opening is not article ${n.label} struck`);

  // E2: no amending formula in the last operative article or between it and the opening (conservative: the formula
  // usually sits in that article's own caput, e.g. "Art. 1º A IN ... passa a vigorar com as seguintes alterações:").
  let lo = -1; for (let i = oi - 1; i >= 0; i--) if (segs[i]!.sigla === 'artigo' && !segs[i]!.tachado) { lo = i; break; }
  const checked = segs.slice(Math.max(lo, 0), oi);
  const amending = checked.find((s) => s.blocks.some((b) => AMENDING.test(b)));
  if (amending) return fail('E2', `segment ${amending.order} introduces an amendment of another act`);

  // E7: a declared grouping right before the successor, or the successor's own struck pair.
  const between = segs.slice(oi + 1, si); const last = between[between.length - 1];
  let e7: RfbQuoteResumeCandidate['evidence']['E7'];
  if (last && GROUPING.has(last.sigla) && !last.tachado && !rules.quoteOpen.test(last.blocks[0] ?? '')) e7 = { kind: 'declared_grouping', order: last.order, type: last.sigla };
  else if (last && last.sigla === 'artigo' && last.tachado && articleOf(last.blocks[0])?.label === sa.label) { e7 = { kind: 'struck_successor_pair', order: last.order }; }
  else return fail('E7', `segment before the successor ${succ.order} is neither a declared grouping nor its struck pair`);

  // E6: everything else between the opening and the successor is struck + current pairs of the same label (at least one).
  const core = between.slice(0, -1); const pairs: RfbQuoteResumeCandidate['evidence']['E6']['pairs'] = [];
  if (!core.length || core.length % 2) return fail('E6', `${core.length} segment(s) between the opening and the E7 segment; struck + current pairs are required`);
  for (let i = 0; i < core.length; i += 2) {
    const a = core[i]!; const c = core[i + 1]!; const la = labelOf(a.blocks[0]); const lc = labelOf(c.blocks[0]);
    if (!PAIRABLE.has(a.sigla) || a.sigla !== c.sigla || !a.tachado || c.tachado || !la || la !== lc
      || rules.quoteOpen.test(a.blocks[0] ?? '') || rules.quoteOpen.test(c.blocks[0] ?? '')) return fail('E6', `segments ${a.order}/${c.order} are not a struck + current pair of the same label`);
    pairs.push({ struckOrder: a.order, currentOrder: c.order, type: a.sigla, label: la });
  }

  const ref = (s: Seg): RfbQuoteResumeSegmentRef => ({ order: s.order, pointer: s.pointer, htmlSpan: { ...s.htmlSpan } });
  return issue({ notCandidate: null, candidate: {
    opening: { ...ref(openSeg), article: n.label }, successor: { ...ref(succ), article: sa.label },
    evidence: { E0: { unclosed: true, successorOrder: succ.order }, E1: { struckArticleOrder: before.order },
      E2: { checkedOrders: checked.map((s) => s.order) }, E6: { pairs }, E7: e7 } } });
}

/** E4: only a plan issued by planRfbQuoteResume in this process, for this exact HTML and representation id, counts. */
export function verifyRfbQuoteResumePlan(plan: unknown, html: string, representationId: string): plan is RfbQuoteResumePlan {
  if (!plan || typeof plan !== 'object' || !ISSUED.has(plan) || !deepFrozen(plan)) return false;
  const p = plan as RfbQuoteResumePlan;
  return p.planVersion === RFB_QUOTE_RESUME_PLAN_VERSION && p.representationId === representationId && p.htmlSha256 === sha(html);
}
