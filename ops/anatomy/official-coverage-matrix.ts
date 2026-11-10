/**
 * E9 / P3 — official coverage matrix "fonte × tipo de ato × variação de layout × porte" (direction approved by Fábio,
 * #116 c.6514510003; E9 criterion STATUS-MATRIX-02 §9; R2 of #303 c.6701945748).
 *
 * ONE grid (`GRID`) is the single source of the mandatory categories: pending cells, absent categories and completeness
 * are all derived from it, so a category with no proof can never let E9 be complete. A cell is covered only by a sample
 * that matches ALL FOUR axes exactly AND reached the `validated` stage. Stages are kept apart:
 *   captured   — bytes present and SHA-256 + size equal to the recorded provenance (checked before any use);
 *   identified — the act's identity was checked in the bytes (title / idAto);
 *   read       — read by the engine with the source's OWN profile (a diagnostic with another profile is not a read);
 *   validated  — conservative invariants hold and the output is locked by a regression baseline run by a CI test;
 *   accepted   — independent review recorded for that sample in docs/anatomy/e9-acceptances.json (DERIVED: the record must
 *                pin the sample's current lock digest and engine identity; any drift voids it). Collection acceptance ≠
 *                anatomy acceptance.
 *
 * Size criterion: canonical characters produced by the engine. pequeno < 10.000; médio 10.000–49.999; grande ≥ 50.000.
 * `--write` regenerates docs/anatomy/official-coverage-matrix.json, docs/anatomy/official-samples-baseline.json and
 * docs/anatomy/normas-leg-samples-baseline.json.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeAnatomy } from '../../src/modules/anatomy/engine.js';
import { ANATOMY_ENGINE_BUILD_HASH } from '../../src/modules/anatomy/build-identity.js';
import { prepareDoeSpRepresentation } from '../../src/modules/anatomy/json-preparation.js';
import { prepareSefazSpPortalPage } from '../../src/modules/anatomy/sefaz-sp-preparation.js';
import { prepareNormasLegPage } from '../../src/modules/anatomy/normas-leg-preparation.js';
import { MANUAL_DIR, decodeDeclared, type ManualMeta } from './official-manual-ingest.js';
import { HTTP_DIR, type HttpMeta } from './official-http-ingest.js';
import { APPROVED_FALLBACK, compareWithIndependent, decodeWithPolicy, PASSAGES } from './charset-policy.js';

const ROOT = fileURLToPath(new URL('./official-identification/', import.meta.url));
export const MATRIX_FILE = fileURLToPath(new URL('../../docs/anatomy/official-coverage-matrix.json', import.meta.url));
export const SAMPLES_BASELINE = fileURLToPath(new URL('../../docs/anatomy/official-samples-baseline.json', import.meta.url));
/** #305 c.6710099648: baseline specific to the two normas.leg.br "atualizada" samples read by NORMAS-LEG. */
export const NORMAS_LEG_BASELINE = fileURLToPath(new URL('../../docs/anatomy/normas-leg-samples-baseline.json', import.meta.url));
const LOT_BASELINE = fileURLToPath(new URL('../../docs/anatomy/official-lot-rfb.json', import.meta.url));
export type Size = 'pequeno' | 'médio' | 'grande';
export const sizeOf = (chars: number): Size => (chars < 10_000 ? 'pequeno' : chars < 50_000 ? 'médio' : 'grande');
const SIZES: readonly Size[] = ['pequeno', 'médio', 'grande'];
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------------------------------------------------------------
// The single grid. Layout names are exact strings; a sample must carry the same string to match.
export const LAYOUT = Object.freeze({
  RFB_JSON: 'JSON multivigente (API normasinternet2)',
  PLANALTO_HTML: 'HTML compilado do Planalto (ccivil_03)',
  NORMASLEG_HTML: 'HTML do normas.leg.br (exportado do Word)',
  CONFAZ_HTML: 'HTML da página do CONFAZ (Plone)',
  DOU_HTML: 'HTML da página do ato no in.gov.br',
  DOU_PDF_PAGE: 'PDF da página do jornal (INPDFViewer)',
  SP_PORTAL_HTML: 'HTML SharePoint, região "Conteúdo da Página"',
  DOESP_JSON: 'JSON API v2 (HTML em content)',
});
export interface GridCell {
  id: string; source: string; type: string; layout: string; size: Size | 'n/a';
  /** n/a size or a non-required cell needs a verifiable justification. */
  applicability: { required: true } | { required: false; justification: string; evidence: string };
  sizeJustification?: string; route: string; manualItems?: string[];
}
const slug = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '');
const bySize = (source: string, type: string, layout: string, route: string, manualItems: Record<string, string[]> = {}): GridCell[] =>
  SIZES.map((size) => ({ id: `${slug(source)}--${slug(type)}--${slug(size)}`, source, type, layout, size, applicability: { required: true }, route,
    ...(manualItems[size] ? { manualItems: manualItems[size] } : {}) }));
/** Governance record (not a function parameter): the grid v1 was APPROVED by the COORD as the planning/demonstration
 * grid (#116 c.6708512598 §2). Approval does not accept any cell, does not change project weights and does not close E9. */
export const GRID_APPROVAL = Object.freeze({ approved: true as const, ref: 'tribusca-control#116 c.6708512598 §2', version: 'v1',
  scope: 'grade de planejamento e demonstração fonte × tipo × layout × porte; 61 células aplicáveis; N/A só com justificativa e decisão registrada' });
export const GRID_STATUS = `aprovada (${GRID_APPROVAL.ref}) — não aceita células, não fecha E9`;
export const GRID: readonly GridCell[] = Object.freeze([
  ...['Instrução Normativa', 'Portaria', 'Ato Declaratório Interpretativo', 'Ato Declaratório Executivo', 'Solução de Consulta', 'Resolução']
    .flatMap((t) => bySize('RFB', t, LAYOUT.RFB_JSON, t === 'Instrução Normativa' ? 'API RFB (coletado)' : 'API RFB — P2-c (autorizada, c.6701950134)')),
  ...bySize('Planalto', 'Lei', LAYOUT.PLANALTO_HTML, 'arquivo manual (a origem recusa este ambiente)', { grande: ['M1', 'M2'] }),
  ...bySize('normas.leg.br', 'Lei', LAYOUT.NORMASLEG_HTML, 'normas.leg.br (versão atualizada lida pela fonte NORMAS-LEG, L-LEG-01; estado por amostra: ver validatedSamples/accepted)'),
  // M3 and M4 are two Convênios ICMS; each is a SAMPLE whose measured size decides the cell it may cover — neither closes
  // a cell by being received, and one never stands for the other (no OR between items).
  ...bySize('CONFAZ', 'Convênio ICMS', LAYOUT.CONFAZ_HTML, 'arquivo manual (M3, M4)'),
  // M5 was listed as "porte pequeno"; its measured size decides (Ajuste SINIEF 07/05 is long). The list label never closes a cell.
  ...bySize('CONFAZ', 'Ajuste SINIEF', LAYOUT.CONFAZ_HTML, 'arquivo manual (M5 recebido; demais portes a selecionar)'),
  ...bySize('CONFAZ', 'Protocolo ICMS', LAYOUT.CONFAZ_HTML, 'arquivo manual (a selecionar)'),
  ...['Instrução Normativa', 'Decreto', 'Portaria', 'Resolução', 'Despacho'].flatMap((t) => bySize('DOU', t, LAYOUT.DOU_HTML, t === 'Instrução Normativa' ? 'arquivo manual (M9 em HTML)' : 'arquivo manual (a selecionar)')),
  { id: 'dou--pagina-do-jornal--na', source: 'DOU', type: 'Página do jornal (cabeçalho e rodapé)', layout: LAYOUT.DOU_PDF_PAGE, size: 'n/a', applicability: { required: true },
    sizeJustification: 'uma página do jornal não tem porte de ato; a célula prova cabeçalho/rodapé e não a completude do ato', route: 'M9: páginas 57 e 58 em PDF recebidas e identificadas; leitura da página não validada (ordem de colunas exige preparação própria)', manualItems: ['M9'] },
  ...bySize('SEFAZ-SP-PORTAL', 'Decreto consolidado (RICMS/2000), artigo', LAYOUT.SP_PORTAL_HTML, 'coletor oficial (coletado)'),
  ...['Decreto', 'Resolução', 'Portaria CAT'].flatMap((t) => bySize('DOE-SP', t, LAYOUT.DOESP_JSON, 'P2-d (autorizada só depois da validação de M9)')),
]);

// ---------------------------------------------------------------------------------------------------------------------
export interface Sample {
  id: string; source: string; type: string; layout: string; chars: number | null; size: Size | null; sha256: string; bytes: number;
  stages: { captured: boolean; identified: boolean; read: boolean; validated: boolean; accepted: boolean };
  profile: string | null; diagnostic: { profile: string; chars: number } | null; outputHash: string | null; evidence: string[]; notes: string[];
  /** Only for snapshots decoded under the approved local fallback (charset-policy.ts); never a declared charset. */
  decoding?: { encoding: string; encodingSource: string; confidence: string; declaredCharset: null; independentCheck: { passage: string; sentenceEqual: boolean }[] };
}
export class SampleIntegrityError extends Error {}

/** Bytes are checked against the recorded provenance BEFORE any use; a divergence refuses the whole matrix. */
export function verifiedBytes(path: string, expected: { sha256: string; bytes: number }, id: string): Uint8Array {
  const b = new Uint8Array(readFileSync(path));
  if (b.byteLength !== expected.bytes || sha(b) !== expected.sha256) throw new SampleIntegrityError(`${id}: bytes differ from the recorded provenance (${b.byteLength} bytes, ${sha(b).slice(0, 12)}…)`);
  return b;
}
interface Read { chars: number; outputHash: string; invariants: string[] }
/** Conservative invariants every validated sample must keep (protection, not interpretation). */
function readWith(source: 'DOU' | 'CONFAZ' | 'SEFAZ-SP-PORTAL' | 'NORMAS-LEG' | 'DOE-SP', id: string, html: string, extra: object = {}): Read {
  const r = analyzeAnatomy({ publicationVersionId: id, referenceDate: '2026-11-07', ruleSet: { id: 'official-coverage-matrix', version: '2' },
    input: { source, representationId: id, html, ...extra }, catalog: { edition: 'none', codes: [] } });
  const broken: string[] = [];
  if (r.parts.some((p) => p.legalStatus !== 'unknown')) broken.push('legalStatus must stay unknown');
  if (r.parts.some((p) => p.type === 'quoted_text' && p.context === 'operative_candidate')) broken.push('quoted text must never be operative');
  if (r.parts.some((p) => p.type === 'unidentified') && r.status === 'complete') broken.push('unidentified content cannot be complete');
  if (source === 'DOE-SP') {
    // E9-ACERVO-01 R5.3: DOE-SP invariants. The reader must really read (no fallback); nothing is eligible; no candidate
    // selection touches unidentified text (ementa, "Decreta:") or a signature; signatures are prohibited and lie outside
    // every operative article/caput span.
    if (r.limitations.some((l) => ['input_size_limit', 'html_parse_failure', 'html_complexity_limit'].includes(l.code))) broken.push('DOE-SP reader fallback (not read)');
    if (r.eligibility.some((e) => e.eligible)) broken.push('nothing is eligible');
    const closed = r.parts.filter((p) => p.type === 'unidentified' || p.type === 'signature' || p.context === 'prohibited');
    const touches = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;
    // A CANDIDATE selection is one excluded only for lack of approved evidence (same rule as NORMAS-LEG).
    const candidates = r.eligibility.filter((e) => e.exclusionReasons.every((x) => x === 'missing_approved_evidence'));
    if (candidates.some((e) => closed.some((p) => touches(e.span, p.span)))) broken.push('no candidate selection over unidentified, prohibited or signature text');
    const sigs = r.parts.filter((p) => p.type === 'signature');
    if (sigs.some((p) => p.context !== 'prohibited')) broken.push('signatures are prohibited');
    if (sigs.some((sg) => r.parts.some((p) => (p.type === 'article' || p.type === 'caput') && p.context === 'operative_candidate' && touches(p.span, sg.span)))) broken.push('signatures lie outside operative articles/caputs');
  }
  return { chars: r.canonicalText.length, outputHash: r.outputHash, invariants: broken };
}
type BaselineEntry = { id: string; sha256: string; profile: string; outputHash: string; chars: number };
/**
 * NORMAS-LEG lock (#305 c.6710099648): one digest per component, so a drift is attributable — bytes/identity, the
 * preparation plan, canonical text, sourceMap, parts by region, candidate selections by region, and the measured
 * counts. `validated` is DERIVED: entry equal to the committed baseline AND no invariant broken. Never hard-coded.
 */
export interface NormasLegEntry {
  id: string; sha256: string; bytes: number; urn: string; version: 'atualizada'; representationId: string; profile: 'NORMAS-LEG';
  preparationVersion: string; htmlSha256: string; planSha256: string; textSha256: string; sourceMapSha256: string; partsSha256: string; selectionsSha256: string;
  counts: { notes: number; anchors: number; placeholders: number; ambiguous: number; editorialNoteParts: number; candidateSelections: number }; chars: number;
}
const canonJson = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));
export function readNormasLeg(m: { id: string; url: string; urn: string; sha256: string; bytes: number }, bytes: Uint8Array): { entry: NormasLegEntry; invariants: string[]; outputHash: string } {
  const prep = prepareNormasLegPage({ resourceId: m.id, url: m.url, urn: m.urn, version: 'atualizada', bytes, expected: { sha256: m.sha256, bytes: m.bytes } });
  const r = analyzeAnatomy({ publicationVersionId: m.id, referenceDate: '2026-11-07', ruleSet: { id: 'official-coverage-matrix', version: '2' },
    input: { source: 'NORMAS-LEG', representationId: m.id, html: prep.html, normasLeg: prep }, catalog: { edition: 'none', codes: [] } });
  const candidates = r.eligibility.filter((e) => e.exclusionReasons.every((x) => x === 'missing_approved_evidence')).map((e) => `${e.purpose}@${e.span.start}-${e.span.end}`).sort();
  const notes = r.parts.filter((x) => x.type === 'editorial_note' && x.contextReasons.some((c) => c.startsWith('normas_leg_')));
  const broken: string[] = [];
  if (r.parts.some((x) => x.legalStatus !== 'unknown')) broken.push('legalStatus must stay unknown');
  if (r.parts.some((x) => x.context === 'historical')) broken.push('NORMAS-LEG never produces historical');
  if (notes.some((x) => x.context !== 'prohibited')) broken.push('every compilation note is prohibited');
  if (r.parts.some((x) => (x.contextReasons.includes('normas_leg_revoked_placeholder') || x.contextReasons.includes('normas_leg_note_ambiguous')) && x.context === 'operative_candidate')) broken.push('placeholders/ambiguous blocks are never operative');
  if (r.eligibility.some((e) => e.eligible)) broken.push('nothing is eligible');
  if (candidates.some((c) => { const [a, b] = c.split('@')[1]!.split('-').map(Number); return notes.some((n) => n.span.start < b! && a! < n.span.end && a! >= n.span.start && b! <= n.span.end); })) broken.push('no candidate selection inside a note region');
  if (!r.limitations.some((l) => l.code === 'normas_leg_local_preparation_only')) broken.push('the local-preparation limitation must be recorded');
  if (r.parts.some((x) => x.type === 'quoted_text' && x.context === 'operative_candidate')) broken.push('quoted text must never be operative');
  const regions = r.parts.map((x) => ({ type: x.type, span: x.span, context: x.context, reasons: x.contextReasons })).sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end || a.type.localeCompare(b.type));
  const entry: NormasLegEntry = { id: m.id, sha256: m.sha256, bytes: m.bytes, urn: m.urn, version: 'atualizada', representationId: m.id, profile: 'NORMAS-LEG',
    preparationVersion: prep.preparationVersion, htmlSha256: prep.htmlSha256, planSha256: prep.plan.planSha256, textSha256: sha(r.canonicalText),
    sourceMapSha256: sha(canonJson(r.sourceMap)), partsSha256: sha(canonJson(regions)), selectionsSha256: sha(canonJson(candidates)),
    counts: { ...prep.plan.counts, editorialNoteParts: notes.length, candidateSelections: candidates.length }, chars: r.canonicalText.length };
  return { entry, invariants: broken, outputHash: r.outputHash };
}
/**
 * E9-ACERVO-01 R3 (tribusca-control#116): formal acceptances are DATA, never a hard-coded `accepted: true`. A record
 * counts only while it pins the sample's current lock digest (sha256 of the canonical baseline entry) and the engine
 * identity it was reviewed on; a drift of either voids the acceptance (the sample stays validated or not on its own).
 */
export const ACCEPTANCES_FILE = fileURLToPath(new URL('../../docs/anatomy/e9-acceptances.json', import.meta.url));
export interface Acceptance { sampleId: string; cellId: string; scope: 'offline'; entrySha256: string; engineBuildHash: string; decidedBy: string; decidedOn: string; ref: string; limits: string[] }
const loadAcceptances = (): Acceptance[] => (existsSync(ACCEPTANCES_FILE) ? (JSON.parse(readFileSync(ACCEPTANCES_FILE, 'utf8')) as { acceptances: Acceptance[] }).acceptances : []);
export const normasLegEntrySha256 = (e: NormasLegEntry) => sha(canonJson(e));
const loadNormasLegBaseline = (): NormasLegEntry[] => (existsSync(NORMAS_LEG_BASELINE) ? (JSON.parse(readFileSync(NORMAS_LEG_BASELINE, 'utf8')) as { samples: NormasLegEntry[] }).samples : []);
const loadBaseline = (): BaselineEntry[] => (existsSync(SAMPLES_BASELINE) ? (JSON.parse(readFileSync(SAMPLES_BASELINE, 'utf8')) as { samples: BaselineEntry[] }).samples : []);

export function collectSamples(baseline: BaselineEntry[] = loadBaseline(), normasLegBaseline: NormasLegEntry[] = loadNormasLegBaseline(), acceptances: Acceptance[] = loadAcceptances()): Sample[] {
  const out: Sample[] = [];
  const locked = (id: string, s: string, profile: string, rd: Read) => {
    const b = baseline.find((x) => x.id === id);
    return rd.invariants.length === 0 && !!b && b.sha256 === s && b.profile === profile && b.outputHash === rd.outputHash;
  };
  // RFB — the reproducible lot: bytes checked against the snapshot meta AND the lot baseline; the lot test re-runs it.
  const lot = JSON.parse(readFileSync(LOT_BASELINE, 'utf8')) as { acts: { idAto: number; epigrafe: string; canonicalChars: number; sha256: string; bytes: number; promoted: boolean; outputHash: string }[] };
  for (const dir of ['rfb-normasinternet2', 'rfb-normasinternet2-coleta02', 'rfb-p2c']) {
    const d = join(ROOT, dir); if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((x) => /^\d+\.meta\.json$/u.test(x)).sort()) {
      const m = JSON.parse(readFileSync(join(d, f), 'utf8')) as { id: string; sha256: string; bytes: number; identification?: { epigrafe?: string }; p2c?: { type: string } };
      m.id = f.slice(0, -'.meta.json'.length); // the file name is the identity (older metas carry no id field)
      verifiedBytes(join(d, `${m.id}.json`), m, `rfb:${m.id}`);
      const a = lot.acts.find((x) => String(x.idAto) === m.id);
      const epi = m.identification?.epigrafe ?? a?.epigrafe ?? '';
      const type = m.p2c?.type ?? (/^Instru[çc][ãa]o Normativa/iu.test(epi) ? 'Instrução Normativa' : epi);
      const inLot = !!a && a.sha256 === m.sha256;
      out.push({ id: `rfb:${m.id}`, source: 'RFB', type, layout: LAYOUT.RFB_JSON, chars: a?.canonicalChars ?? null, size: a ? sizeOf(a.canonicalChars) : null, sha256: m.sha256, bytes: m.bytes,
        stages: { captured: true, identified: !!epi, read: inLot, validated: inLot, accepted: false }, profile: inLot ? 'RFB' : null, diagnostic: null, outputHash: a?.outputHash ?? null,
        evidence: inLot ? ['docs/anatomy/official-lot-rfb.json', 'test/anatomy.official-lot-rfb.unit.test.ts (re-runs the lot; fails on drift)'] : [], notes: inLot ? [] : ['not yet in the reproducible lot'] });
    }
  }
  // Sefaz-SP consolidated legislation portal: read only through its proven preparation (typed source).
  const sp = join(ROOT, 'doesp-ricms');
  for (const f of readdirSync(sp).filter((x) => x.endsWith('.meta.json')).sort()) {
    const m = JSON.parse(readFileSync(join(sp, f), 'utf8')) as { id: string; url: string; sha256: string; bytes: number };
    const bytes = verifiedBytes(join(sp, `${m.id}.html`), m, m.id);
    const prep = prepareSefazSpPortalPage({ resourceId: m.id, url: m.url, bytes });
    const rd = readWith('SEFAZ-SP-PORTAL', m.id, prep.html, { sefazSpPortal: prep });
    const ok = locked(m.id, m.sha256, 'SEFAZ-SP-PORTAL', rd);
    out.push({ id: m.id, source: 'SEFAZ-SP-PORTAL', type: 'Decreto consolidado (RICMS/2000), artigo', layout: LAYOUT.SP_PORTAL_HTML, chars: rd.chars, size: sizeOf(rd.chars), sha256: m.sha256, bytes: m.bytes,
      stages: { captured: true, identified: true, read: true, validated: ok, accepted: false }, profile: 'SEFAZ-SP-PORTAL', diagnostic: null, outputHash: rd.outputHash,
      evidence: ok ? ['docs/anatomy/official-samples-baseline.json', 'test/anatomy.official-coverage.unit.test.ts'] : [], notes: rd.invariants });
  }
  // normas.leg.br. The two "versão atualizada" files are READ by the typed source NORMAS-LEG through
  // prepareNormasLegPage (#305 c.6709334910: hash, URN, version and representationId preserved); validated by the
  // NORMAS-LEG lock (#305 c.6710099648) and accepted only through a pinned record (E9-ACERVO-01 R3). The original texts have no plan:
  // captured and identified only; the DOU-profile reading stays a diagnostic (never a read, never closes a cell).
  const lg = join(ROOT, 'leg-normas');
  for (const f of readdirSync(lg).filter((x) => /-(original|atualizada)\.meta\.json$/u.test(x)).sort()) {
    const m = JSON.parse(readFileSync(join(lg, f), 'utf8')) as { id: string; url: string; urn: string; sha256: string; bytes: number; titleCheck: { found: boolean } };
    const bytes = verifiedBytes(join(lg, `${m.id}.html`), m, m.id);
    if (m.id.endsWith('-atualizada')) {
      const rd = readNormasLeg(m, bytes);
      const b = normasLegBaseline.find((x) => x.id === m.id);
      const ok = rd.invariants.length === 0 && !!b && canonJson(b) === canonJson(rd.entry);
      // R5.6: records are an append-only history (one per engine the COORD accepted on); the sample is accepted when
      // ANY record pins its current lock digest AND the current engine. Older records stay as history, never rewritten.
      const digest = normasLegEntrySha256(rd.entry);
      const accepted = ok && acceptances.some((a) => a.sampleId === m.id && a.scope === 'offline' && a.entrySha256 === digest && a.engineBuildHash === ANATOMY_ENGINE_BUILD_HASH);
      out.push({ id: m.id, source: 'normas.leg.br', type: 'Lei', layout: LAYOUT.NORMASLEG_HTML, chars: rd.entry.chars, size: sizeOf(rd.entry.chars), sha256: m.sha256, bytes: m.bytes,
        stages: { captured: true, identified: m.titleCheck.found, read: true, validated: ok, accepted }, profile: 'NORMAS-LEG', diagnostic: null, outputHash: rd.outputHash,
        evidence: ok ? ['docs/anatomy/normas-leg-samples-baseline.json', 'test/anatomy.official-coverage.unit.test.ts', 'test/anatomy.normas-leg.unit.test.ts', ...(accepted ? ['docs/anatomy/e9-acceptances.json'] : [])] : ['test/anatomy.normas-leg.unit.test.ts'],
        notes: ['lida pela fonte NORMAS-LEG (prova local de preparação, não prova de coleta oficial)', ...(ok ? [] : ['não validada: linha de base NORMAS-LEG ausente ou divergente']), ...rd.invariants] });
      continue;
    }
    const diag = readWith('DOU', m.id, new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    out.push({ id: m.id, source: 'normas.leg.br', type: 'Lei', layout: LAYOUT.NORMASLEG_HTML, chars: null, size: null, sha256: m.sha256, bytes: m.bytes,
      stages: { captured: true, identified: m.titleCheck.found, read: false, validated: false, accepted: false }, profile: null,
      diagnostic: { profile: 'DOU (diagnóstico)', chars: diag.chars }, outputHash: null, evidence: [], notes: ['texto original: sem plano NORMAS-LEG (só a versão atualizada); porte não atribuído sem leitura própria'] });
  }
  // Files saved by hand and ingested (official-manual-ingest.ts): bytes and declared encoding are checked first.
  if (existsSync(MANUAL_DIR)) for (const f of readdirSync(MANUAL_DIR).filter((x) => /^M\d+\.meta\.json$/u.test(x)).sort()) {
    const m = JSON.parse(readFileSync(join(MANUAL_DIR, f), 'utf8')) as ManualMeta;
    const bytes = verifiedBytes(join(MANUAL_DIR, m.fileName), m, m.item);
    const html = decodeDeclared(bytes, m.declaredCharset);
    const profile = m.source === 'CONFAZ' ? 'CONFAZ' : m.source === 'DOU' ? 'DOU' : null;
    const layout = m.source === 'CONFAZ' ? LAYOUT.CONFAZ_HTML : m.source === 'DOU' ? LAYOUT.DOU_HTML : LAYOUT.PLANALTO_HTML;
    if (!profile) { out.push({ id: m.item, source: m.source, type: m.type, layout, chars: null, size: null, sha256: m.sha256, bytes: m.bytes,
      stages: { captured: true, identified: true, read: false, validated: false, accepted: false }, profile: null, diagnostic: null, outputHash: null, evidence: [], notes: ['sem perfil de leitura próprio'] }); continue; }
    const rd = readWith(profile, m.item, html);
    const ok = locked(m.item, m.sha256, profile, rd);
    out.push({ id: m.item, source: m.source, type: m.type, layout, chars: rd.chars, size: sizeOf(rd.chars), sha256: m.sha256, bytes: m.bytes,
      stages: { captured: true, identified: true, read: true, validated: ok, accepted: false }, profile, diagnostic: null, outputHash: rd.outputHash,
      evidence: ok ? ['docs/anatomy/official-samples-baseline.json', 'test/anatomy.official-coverage.unit.test.ts'] : [], notes: rd.invariants });
  }
  // HTTP response bytes captured by another session and delivered by git (official-http-ingest.ts): provenance of their
  // own; encoding never inferred; the DOU PDF page is header/footer evidence, not a validated act anatomy.
  if (existsSync(HTTP_DIR)) for (const f of readdirSync(HTTP_DIR).filter((x) => /^M\d+(-p\d+)?\.meta\.json$/u.test(x)).sort()) {
    const m = JSON.parse(readFileSync(join(HTTP_DIR, f), 'utf8')) as HttpMeta;
    const bytes = verifiedBytes(join(HTTP_DIR, m.fileName), m, `http:${m.item}`);
    const id = `http:${m.item}`;
    const base = { id, source: m.source, type: m.type, sha256: m.sha256, bytes: m.bytes, diagnostic: null, evidence: [] as string[] };
    if (m.representation === 'pdf') { out.push({ ...base, layout: LAYOUT.DOU_PDF_PAGE, chars: null, size: null, stages: { captured: true, identified: true, read: false, validated: false, accepted: false },
      profile: null, outputHash: null, notes: [m.reach] }); continue; }
    const layout = m.source === 'CONFAZ' ? LAYOUT.CONFAZ_HTML : LAYOUT.PLANALTO_HTML;
    if (!m.readable || m.source !== 'CONFAZ') {
      let decoding: Sample['decoding'];
      if (m.source === 'Planalto' && APPROVED_FALLBACK[m.sha256]) {
        const d = decodeWithPolicy(bytes, { httpCharset: null });
        const leg = m.item === 'M1' ? 'lei-10637-2002-atualizada' : 'lei-10833-2003-atualizada';
        const indep = readFileSync(join(ROOT, 'leg-normas', `${leg}.html`), 'utf8');
        decoding = { encoding: d.encoding, encodingSource: d.encodingSource, confidence: d.confidence, declaredCharset: null,
          independentCheck: compareWithIndependent(d.text, indep, PASSAGES[m.item] ?? []).map((c) => ({ passage: c.passage, sentenceEqual: c.sentenceEqual })) };
      }
      out.push({ ...base, layout, chars: null, size: null, stages: { captured: true, identified: true, read: false, validated: false, accepted: false },
        profile: null, outputHash: null, notes: [decoding ? 'charset: fallback local aprovado (tentative); leitura habilitada para preparação, sem perfil Planalto — não lido nem validado' : (m.readableNote ?? 'sem perfil de leitura próprio')],
        ...(decoding ? { decoding } : {}) }); continue; }
    const rd = readWith('CONFAZ', id, decodeDeclared(bytes, m.declaredCharset));
    const ok = locked(id, m.sha256, 'CONFAZ', rd);
    out.push({ ...base, layout, chars: rd.chars, size: sizeOf(rd.chars), stages: { captured: true, identified: true, read: true, validated: ok, accepted: false }, profile: 'CONFAZ',
      outputHash: rd.outputHash, evidence: ok ? ['docs/anatomy/official-samples-baseline.json', 'test/anatomy.official-coverage.unit.test.ts'] : [], notes: rd.invariants });
  }
  // E9-ACERVO-01 R5.3: DOE-SP API v2 captures (P2-d), read by the DOE-SP profile through prepareDoeSpRepresentation
  // (PROVISIONAL preparation — its scope is under independent recheck). A reader fallback (e.g. input_size_limit) is
  // not a read. validated = DOE-SP invariants hold AND the output equals the committed samples baseline.
  const dp = join(ROOT, 'doesp-p2d');
  if (existsSync(dp)) for (const f of readdirSync(dp).filter((x) => /^[0-9a-f-]{36}\.meta\.json$/u.test(x)).sort()) {
    const id = f.slice(0, -'.meta.json'.length);
    const m = JSON.parse(readFileSync(join(dp, f), 'utf8')) as { sha256: string; bytes: number; act: string; p2d?: { type?: string } };
    const bytes = verifiedBytes(join(dp, `${id}.json`), m, `doesp:${id}`);
    const prep = prepareDoeSpRepresentation({ resourceId: `doesp:${id}`, bytes }, id);
    const rd = readWith('DOE-SP', `doesp:${id}`, prep.html);
    const base = { id: `doesp:${id}`, source: 'DOE-SP', type: m.p2d?.type ?? 'Decreto', layout: LAYOUT.DOESP_JSON, sha256: m.sha256, bytes: m.bytes, diagnostic: null };
    if (rd.invariants.includes('DOE-SP reader fallback (not read)')) {
      out.push({ ...base, chars: rd.chars, size: sizeOf(rd.chars), stages: { captured: true, identified: true, read: false, validated: false, accepted: false }, profile: null,
        outputHash: null, evidence: [], notes: ['reader fallback (input_size_limit): the act was not read'] });
      continue;
    }
    const ok = locked(`doesp:${id}`, m.sha256, 'DOE-SP', rd);
    out.push({ ...base, chars: rd.chars, size: sizeOf(rd.chars), stages: { captured: true, identified: true, read: true, validated: ok, accepted: false }, profile: 'DOE-SP',
      outputHash: rd.outputHash, evidence: ok ? ['docs/anatomy/official-samples-baseline.json', 'test/anatomy.official-coverage.unit.test.ts', 'test/anatomy.doesp-closing-signature.unit.test.ts', `preparation ${prep.preparationVersion} (provisional)`] : [],
      notes: rd.invariants });
  }
  return out;
}

/** The NORMAS-LEG lock, computed from the files (regenerated only with --write; written only when invariants hold). */
export function normasLegBaseline(): { samples: NormasLegEntry[] } {
  const lg = join(ROOT, 'leg-normas');
  const samples = readdirSync(lg).filter((x) => /-atualizada\.meta\.json$/u.test(x)).sort().map((f) => {
    const m = JSON.parse(readFileSync(join(lg, f), 'utf8')) as { id: string; url: string; urn: string; sha256: string; bytes: number };
    const rd = readNormasLeg(m, verifiedBytes(join(lg, `${m.id}.html`), m, m.id));
    if (rd.invariants.length) throw new Error(`${m.id}: invariants broken, baseline not written: ${rd.invariants.join('; ')}`);
    return rd.entry;
  });
  return { samples };
}

/** The regression lock for non-RFB samples read with their own profile (regenerated only with --write). */
export function samplesBaseline(samples: Sample[]): { samples: BaselineEntry[] } {
  return { samples: samples.filter((s) => s.profile && s.outputHash && s.source !== 'RFB' && s.notes.length === 0)
    .map((s) => ({ id: s.id, sha256: s.sha256, profile: s.profile!, outputHash: s.outputHash!, chars: s.chars! })) };
}

export const matches = (c: GridCell, s: Sample) => s.source === c.source && s.type === c.type && s.layout === c.layout && (c.size === 'n/a' || s.size === c.size);
export function buildMatrix(samples = collectSamples(), grid: readonly GridCell[] = GRID, gridApproved: boolean = GRID_APPROVAL.approved) {
  const cells = grid.map((c) => {
    const hits = samples.filter((s) => matches(c, s));
    const validated = hits.filter((s) => s.stages.validated).map((s) => s.id);
    return { ...c, status: validated.length ? 'covered' as const : 'pending' as const, validatedSamples: validated, accepted: hits.some((s) => s.stages.accepted),
      unvalidatedSamples: hits.filter((s) => !s.stages.validated).map((s) => ({ id: s.id, stages: s.stages })) };
  });
  const required = cells.filter((c) => c.applicability.required);
  const pending = required.filter((c) => c.status === 'pending').map((c) => c.id);
  const unmatched = samples.filter((s) => !grid.some((c) => matches(c, s)) && s.size !== null).map((s) => s.id);
  return { criterion: { approval: 'tribusca-control#116 c.6514510003; E9: STATUS-MATRIX-02 §9 (sem fração); R2 #303 c.6701945748',
    size: 'pequeno < 10.000; médio 10.000–49.999; grande ≥ 50.000 caracteres do texto canônico do motor', stages: 'captured → identified → read (perfil próprio) → validated (invariantes + baseline em teste de CI) → accepted (revisão)' },
    grid: { status: GRID_STATUS, approved: gridApproved, approval: GRID_APPROVAL, cells: grid.length, required: required.length },
    samples, cells, requiredPending: pending, coveredRequired: required.length - pending.length, samplesOutsideGrid: unmatched,
    e9MatrixComplete: gridApproved && pending.length === 0 };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--write')) {
    const first = collectSamples([]);
    writeFileSync(SAMPLES_BASELINE, `${JSON.stringify(samplesBaseline(first), null, 2)}\n`);
    writeFileSync(NORMAS_LEG_BASELINE, `${JSON.stringify(normasLegBaseline(), null, 2)}\n`);
  }
  const m = buildMatrix();
  if (process.argv.includes('--write')) writeFileSync(MATRIX_FILE, `${JSON.stringify(m, null, 2)}\n`);
  for (const c of m.cells.filter((x) => x.status === 'covered' || x.unvalidatedSamples.length)) console.log(`${c.status === 'covered' ? '✅' : '…'} ${c.id} | validated: ${c.validatedSamples.join(', ') || '—'} | not validated: ${c.unvalidatedSamples.map((u) => u.id).join(', ') || '—'}`);
  console.log(`grid ${m.grid.cells} cells (${m.grid.required} required); covered ${m.coveredRequired}; pending ${m.requiredPending.length}; complete: ${m.e9MatrixComplete}`);
}
