import { createHash } from 'node:crypto';
import type { AnatomyResult } from '../contract.js';
import type { Annotation, Nature } from './sample-annotations.js';

/**
 * ANAT-CONFIG-01: pure translation of an engine result into what the configuration screen shows, in Portuguese.
 * Structure, nature and validity are separate fields. Nature is DERIVED from the engine's part type and context only;
 * validity is the engine's legalStatus (the engine never asserts "current" from a note, colour or style).
 */
export type Part = AnatomyResult['parts'][number];
const STRUCTURE_PT: Record<string, string> = {
  document: 'Documento', internal_act: 'Ato interno', publication_header: 'Cabeçalho da publicação', epigraph: 'Epígrafe', summary: 'Ementa',
  preamble: 'Preâmbulo', consideration: 'Considerando', group: 'Agrupamento', article: 'Artigo', clause: 'Cláusula', caput: 'Caput',
  paragraph: 'Parágrafo', inciso: 'Inciso', alinea: 'Alínea', item: 'Item', annex: 'Anexo', table: 'Tabela', row: 'Linha', cell: 'Célula',
  signature: 'Assinatura', footer: 'Rodapé', editorial_note: 'Nota editorial', quoted_text: 'Texto citado', body: 'Corpo de texto', unidentified: 'Não identificado',
};
export const NATURE_PT: Record<Nature, string> = {
  operative: 'Dispositivo do ato', historical: 'Redação anterior (histórico)', editorial_note: 'Nota editorial',
  amendment: 'Texto que altera outro ato', structure: 'Elemento estrutural', ambiguous: 'A conferir (não reconhecido)',
};
export const VALIDITY_PT: Record<string, string> = {
  unknown: 'Não determinada', not_determined: 'Não determinada', current: 'Vigente', repealed: 'Revogada', replaced: 'Substituída', future: 'Futura', suspended: 'Suspensa',
};
const STRUCTURAL = new Set(['epigraph', 'summary', 'preamble', 'consideration', 'signature', 'footer', 'publication_header']);
/** Parts that are containers or table internals: shown through their parent, not as passages. */
const HIDDEN = new Set(['document', 'row', 'cell']);

export function natureOf(part: Part): Nature {
  if (part.type === 'editorial_note') return 'editorial_note';
  if (part.type === 'quoted_text') return 'amendment';
  if (part.type === 'unidentified' || part.context === 'unknown') return 'ambiguous';
  if (part.context === 'historical') return 'historical';
  if (STRUCTURAL.has(part.type)) return 'structure';
  return 'operative';
}
const REASONS_PT: Record<string, string> = {
  clause_marker: 'começa com o rótulo de cláusula', article_marker: 'começa com o rótulo de artigo', paragraph_marker: 'começa com o rótulo de parágrafo',
  preamble_marker: 'começa com uma fórmula de preâmbulo', quoted_block: 'está entre aspas de texto citado', inherited_dom_zone: 'herda a marcação do bloco',
  historical_ancestor: 'está dentro de um trecho histórico', unrecognized_block: 'nenhuma regra reconheceu este bloco', raw_fallback: 'o texto não foi dividido em partes',
  confaz_editorial_note: 'tem estilo de nota editorial', confaz_epigraph: 'tem estilo de epígrafe', confaz_summary: 'tem estilo de ementa', confaz_text_class: 'tem estilo de corpo de texto',
  dou_identifica: 'tem estilo de identificação do DOU', dou_ementa: 'tem estilo de ementa do DOU', dou_assina: 'tem estilo de assinatura do DOU', dou_cargo: 'tem estilo de cargo do DOU',
  dou_rectification_original: 'começa com "Onde se lê"', dou_rectification_corrected: 'começa com "Leia-se"', table: 'é uma tabela', table_row: 'linha de tabela', table_cell: 'célula de tabela',
};
export const reasonPt = (r: string) => REASONS_PT[r] ?? (r.endsWith('_class') || r.includes('historical') ? `estilo do bloco (${r})` : r);

/** Text of the part without the text of its own child parts (a clause span may contain the blocks under it). */
function ownText(result: AnatomyResult, part: Part): string {
  const kids = result.parts.filter((p) => p.parentId === part.id && !HIDDEN.has(p.type)).map((p) => p.span).sort((a, b) => a.start - b.start);
  if (part.type === 'table') return result.canonicalText.slice(part.span.start, part.span.end).replace(/\n+/gu, ' | ').replace(/( \| )+$/u, '').trim();
  let out = ''; let at = part.span.start;
  for (const k of kids) { if (k.start > at) out += result.canonicalText.slice(at, k.start); at = Math.max(at, k.end); }
  if (part.span.end > at) out += result.canonicalText.slice(at, part.span.end);
  return out.trim();
}
export const passageKey = (sampleId: string, text: string) => createHash('sha256').update(`${sampleId}|${text}`, 'utf8').digest('hex').slice(0, 16);

export interface Passage {
  key: string; partId: string; parentKey: string | null; depth: number; type: string; structure: string; label: string; text: string;
  nature: Nature; natureLabel: string; validity: string; validityLabel: string; reasons: string[]; references: string[]; ncm: string[];
  ai: (Annotation & { natureLabel: string; validityLabel: string }) | null;
}
export interface Correction { sampleId: string; partKey: string; expected: Nature; note?: string | undefined }
export interface ReviewItem { sampleId: string; partKey: string | null; kind: 'not_recognized' | 'ai_differs' | 'ai_ambiguous' | 'correction_unmet' | 'limitation'; title: string; detail: string }

export function describeResult(sampleId: string, result: AnatomyResult, annotations: readonly Annotation[], corrections: readonly Correction[] = []) {
  const visible = result.parts.filter((p) => !HIDDEN.has(p.type));
  const keyOf = new Map<string, string>();
  const used = new Set<Annotation>();
  const passages: Passage[] = visible.map((p) => {
    const text = ownText(result, p); const key = passageKey(sampleId, text); keyOf.set(p.id, key);
    let depth = 0; for (let q = p; q.parentId; ) { const parent = result.parts.find((x) => x.id === q.parentId)!; if (!HIDDEN.has(parent.type)) depth++; q = parent; }
    const nature = natureOf(p);
    const ann = annotations.find((a) => !used.has(a) && text.startsWith(a.anchor)) ?? null;
    if (ann) used.add(ann);
    const inPart = result.entities.filter((e) => e.partId === p.id);
    return { key, partId: p.id, parentKey: null, depth, type: p.type, structure: STRUCTURE_PT[p.type] ?? p.type, label: p.label, text, nature, natureLabel: NATURE_PT[nature],
      validity: p.legalStatus, validityLabel: VALIDITY_PT[p.legalStatus] ?? p.legalStatus, reasons: p.contextReasons.map(reasonPt),
      references: inPart.filter((e) => e.domain === 'CITATION' || e.domain === 'LAW_NUMBER').map((e) => e.literal),
      ncm: inPart.filter((e) => e.domain === 'NCM').map((e) => e.literal),
      ai: ann && { ...ann, natureLabel: NATURE_PT[ann.nature], validityLabel: VALIDITY_PT[ann.validity] ?? ann.validity } };
  });
  for (const p of passages) {
    let q = result.parts.find((x) => x.id === p.partId)!;
    while (q.parentId) { q = result.parts.find((x) => x.id === q.parentId)!; if (!HIDDEN.has(q.type)) { p.parentKey = keyOf.get(q.id) ?? null; break; } }
  }
  const review: ReviewItem[] = [];
  for (const p of passages) {
    const corr = corrections.find((c) => c.sampleId === sampleId && c.partKey === p.key);
    if (corr && corr.expected !== p.nature) review.push({ sampleId, partKey: p.key, kind: 'correction_unmet', title: `Sua correção ainda não é atendida: ${p.structure}`,
      detail: `Você marcou "${NATURE_PT[corr.expected]}", e a configuração produz "${p.natureLabel}". Crie ou ajuste uma regra para casos semelhantes, se for o caso.` });
    else if (p.nature === 'ambiguous') review.push({ sampleId, partKey: p.key, kind: 'not_recognized', title: `Trecho não reconhecido: "${p.text.slice(0, 60)}"`,
      detail: p.ai ? `Leitura da IA: ${p.ai.natureLabel} — ${p.ai.explanation}${p.ai.ambiguity ? ` Por que continua a conferir: ${p.ai.ambiguity}` : ''}` : 'Nenhuma regra reconheceu este trecho e a IA não tem leitura para ele.' });
    else if (p.ai && p.ai.nature !== 'ambiguous' && p.ai.nature !== p.nature && !corr) review.push({ sampleId, partKey: p.key, kind: 'ai_differs', title: `A IA lê diferente: ${p.structure}`,
      detail: `Configuração: ${p.natureLabel}. IA: ${p.ai.natureLabel} (evidência: ${p.ai.evidence}). ${p.ai.ambiguity ?? ''}`.trim() });
    else if (p.ai?.ambiguity && !corr) review.push({ sampleId, partKey: p.key, kind: 'ai_ambiguous', title: `Caso ambíguo: ${p.structure}`, detail: p.ai.ambiguity });
  }
  for (const l of result.limitations) {
    if (l.code === 'unidentified_content') continue; // already listed passage by passage
    review.push({ sampleId, partKey: l.partId ? keyOf.get(l.partId) ?? null : null, kind: 'limitation', title: limitationTitle(l.code), detail: l.message });
  }
  const counts = Object.fromEntries((Object.keys(NATURE_PT) as Nature[]).map((n) => [n, passages.filter((p) => p.nature === n).length])) as Record<Nature, number>;
  return { status: result.status, statusLabel: result.status === 'complete' ? 'Completo' : result.status === 'partial' ? 'Parcial' : 'Falhou', passages, review, counts };
}
function limitationTitle(code: string): string {
  if (code === 'plain_text_unidentified') return 'Texto corrido: o motor não divide este ato em partes (limitação do motor, não da configuração)';
  return `Limitação do motor: ${code}`;
}
export type Described = ReturnType<typeof describeResult>;

/** Before/after of the same sample: which passages changed nature, with real counts. */
export function diffDescribed(before: Described, after: Described) {
  const b = new Map(before.passages.map((p) => [p.key, p]));
  const a = new Map(after.passages.map((p) => [p.key, p]));
  const changed = after.passages.filter((p) => b.has(p.key) && b.get(p.key)!.nature !== p.nature)
    .map((p) => ({ key: p.key, structure: p.structure, text: p.text.slice(0, 120), from: b.get(p.key)!.nature, fromLabel: b.get(p.key)!.natureLabel, to: p.nature, toLabel: p.natureLabel }));
  const appeared = after.passages.filter((p) => !b.has(p.key)).length;
  const disappeared = before.passages.filter((p) => !a.has(p.key)).length;
  return { changed, appeared, disappeared, reviewBefore: before.review.length, reviewAfter: after.review.length };
}
