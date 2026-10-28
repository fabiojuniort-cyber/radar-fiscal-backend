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
/**
 * Stable identity of a passage (CONFIG-R2-01): the document identity, the passage's own text and its OCCURRENCE number
 * among passages with that same text in document order (1 for the first). Two identical passages ("Assinatura" twice)
 * get different keys; the key does not depend on screen position or on rules. Corrections are also bound to the exact
 * document version (documentHash), so a key is only ever resolved against the version it was made on.
 */
export const passageKey = (documentId: string, text: string, occurrence = 1) =>
  createHash('sha256').update(`${documentId}|${occurrence}|${text}`, 'utf8').digest('hex').slice(0, 16);
/** Identity of one exact version of a document: SHA-256 of its content. */
export const documentHash = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');

export interface Passage {
  key: string; partId: string; parentKey: string | null; depth: number; type: string; structure: string; label: string; text: string;
  /** Engine result (never modified). */
  nature: Nature; natureLabel: string; validity: string; validityLabel: string; reasons: string[]; references: string[]; ncm: string[];
  ai: (Annotation & { natureLabel: string; validityLabel: string }) | null;
  /** Administrative correction applied on top of the engine result (null = none), and the resulting nature. */
  correction: AppliedCorrection | null; effectiveNature: Nature; effectiveNatureLabel: string;
}
/**
 * A passage correction (document scope). Bound to the exact document version (documentHash) and to the passage identity
 * (partKey). author/createdAt/version are set by the server, never trusted from the client.
 */
export interface Correction { documentId: string; documentHash: string; partKey: string; expected: Nature; reason: string;
  author?: string | undefined; createdAt?: string | undefined; sinceVersion?: number | undefined }
export interface AppliedCorrection { expected: Nature; expectedLabel: string; reason: string; author: string | null; createdAt: string | null; sinceVersion: number | null }
export interface StaleCorrection { correction: Correction; why: 'document_changed' | 'passage_not_found' | 'ambiguous_passage' }
export interface ReviewItem { sampleId: string; partKey: string | null; kind: 'not_recognized' | 'ai_differs' | 'ai_ambiguous' | 'stale_correction' | 'limitation'; title: string; detail: string }
export interface DocumentRef { id: string; documentId: string; content: string }

export function describeResult(doc: DocumentRef, result: AnatomyResult, annotations: readonly Annotation[], corrections: readonly Correction[] = []) {
  const sampleId = doc.id; const hash = documentHash(doc.content);
  const mine = corrections.filter((c) => c.documentId === doc.documentId);
  const visible = result.parts.filter((p) => !HIDDEN.has(p.type));
  const keyOf = new Map<string, string>(); const seenText = new Map<string, number>();
  const used = new Set<Annotation>();
  const passages: Passage[] = visible.map((p) => {
    const text = ownText(result, p); const occurrence = (seenText.get(text) ?? 0) + 1; seenText.set(text, occurrence)
    const key = passageKey(doc.documentId, text, occurrence); keyOf.set(p.id, key);
    let depth = 0; for (let q = p; q.parentId; ) { const parent = result.parts.find((x) => x.id === q.parentId)!; if (!HIDDEN.has(parent.type)) depth++; q = parent; }
    const nature = natureOf(p);
    const ann = annotations.find((a) => !used.has(a) && text.startsWith(a.anchor)) ?? null;
    if (ann) used.add(ann);
    const inPart = result.entities.filter((e) => e.partId === p.id);
    return { key, partId: p.id, parentKey: null, depth, type: p.type, structure: STRUCTURE_PT[p.type] ?? p.type, label: p.label, text, nature, natureLabel: NATURE_PT[nature],
      validity: p.legalStatus, validityLabel: VALIDITY_PT[p.legalStatus] ?? p.legalStatus, reasons: p.contextReasons.map(reasonPt),
      references: inPart.filter((e) => e.domain === 'CITATION' || e.domain === 'LAW_NUMBER').map((e) => e.literal),
      ncm: inPart.filter((e) => e.domain === 'NCM').map((e) => e.literal),
      ai: ann && { ...ann, natureLabel: NATURE_PT[ann.nature], validityLabel: VALIDITY_PT[ann.validity] ?? ann.validity },
      correction: null, effectiveNature: nature, effectiveNatureLabel: NATURE_PT[nature] } as Passage;
  });
  // Corrections apply only to the exact version they were made on and to a passage that still exists; otherwise they
  // are reported as stale and NOT applied. A correction never reaches another document.
  const applied: { partKey: string; correction: Correction }[] = []; const stale: StaleCorrection[] = [];
  for (const c of mine) {
    if (c.documentHash !== hash) { stale.push({ correction: c, why: 'document_changed' }); continue; }
    const matches = passages.filter((x) => x.key === c.partKey);
    if (matches.length === 0) { stale.push({ correction: c, why: 'passage_not_found' }); continue; }
    // Defensive: keys include the occurrence number, so this cannot happen; an ambiguous identity is refused, never guessed.
    if (matches.length > 1) { stale.push({ correction: c, why: 'ambiguous_passage' }); continue; }
    const p = matches[0]!;
    p.correction = { expected: c.expected, expectedLabel: NATURE_PT[c.expected], reason: c.reason, author: c.author ?? null, createdAt: c.createdAt ?? null, sinceVersion: c.sinceVersion ?? null };
    p.effectiveNature = c.expected; p.effectiveNatureLabel = NATURE_PT[c.expected];
    applied.push({ partKey: c.partKey, correction: c });
  }
  for (const p of passages) {
    let q = result.parts.find((x) => x.id === p.partId)!;
    while (q.parentId) { q = result.parts.find((x) => x.id === q.parentId)!; if (!HIDDEN.has(q.type)) { p.parentKey = keyOf.get(q.id) ?? null; break; } }
  }
  const review: ReviewItem[] = [];
  for (const s of stale) review.push({ sampleId, partKey: s.correction.partKey, kind: 'stale_correction', title: 'Correção desatualizada (não aplicada)',
    detail: s.why === 'document_changed' ? `O documento mudou desde a correção ("${NATURE_PT[s.correction.expected]}", motivo: ${s.correction.reason}). Ela não foi aplicada a esta versão; confira o trecho e corrija de novo se ainda valer.`
      : s.why === 'ambiguous_passage' ? `Mais de um trecho corresponde à correção ("${NATURE_PT[s.correction.expected]}"). Ela não foi aplicada para não atingir o trecho errado.`
      : `O trecho corrigido ("${NATURE_PT[s.correction.expected]}", motivo: ${s.correction.reason}) não existe mais nesta análise. A correção não foi aplicada.` });
  for (const p of passages) {
    const corr = p.correction;
    if (corr) continue; // corrected by an administrator: not pending review
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
  const counts = Object.fromEntries((Object.keys(NATURE_PT) as Nature[]).map((n) => [n, passages.filter((p) => p.effectiveNature === n).length])) as Record<Nature, number>;
  return { status: result.status, statusLabel: result.status === 'complete' ? 'Completo' : result.status === 'partial' ? 'Parcial' : 'Falhou', documentHash: hash, passages, review, counts,
    corrections: { applied, stale } };
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
  const changed = after.passages.filter((p) => b.has(p.key) && b.get(p.key)!.effectiveNature !== p.effectiveNature)
    .map((p) => ({ key: p.key, structure: p.structure, text: p.text.slice(0, 120), from: b.get(p.key)!.effectiveNature, fromLabel: b.get(p.key)!.effectiveNatureLabel,
      to: p.effectiveNature, toLabel: p.effectiveNatureLabel, byCorrection: !!p.correction && !b.get(p.key)!.correction }));
  const appeared = after.passages.filter((p) => !b.has(p.key)).length;
  const disappeared = before.passages.filter((p) => !a.has(p.key)).length;
  return { changed, appeared, disappeared, reviewBefore: before.review.length, reviewAfter: after.review.length };
}
