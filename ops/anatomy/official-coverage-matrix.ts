/**
 * E9 / P3 — the official coverage matrix "fonte × tipo de ato × variação de layout × porte" (direction approved by Fábio,
 * #116 c.6514510003; E9 criterion, STATUS-MATRIX-02 §9). It is COMPUTED from the official samples present in the
 * repository (never typed by hand): each sample is read by the engine to measure its size, then matched to the cells.
 * `--write` regenerates docs/anatomy/official-coverage-matrix.json; the unit test re-runs it and fails on drift.
 *
 * Size criterion (documented, from the canonical text the engine produces): pequeno < 10.000 caracteres; médio 10.000 a
 * 49.999; grande ≥ 50.000. It reproduces the sizes assigned when the RFB samples were chosen (OFFICIAL-COLETA-01).
 * Promotion is recorded per sample and is not a condition of the offline milestones.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeAnatomy } from '../../src/modules/anatomy/engine.js';
import { prepareSefazSpPortalPage } from '../../src/modules/anatomy/sefaz-sp-preparation.js';
import { MANUAL_DIR, type ManualMeta } from './official-manual-ingest.js';

const ROOT = fileURLToPath(new URL('./official-identification/', import.meta.url));
export const MATRIX_FILE = fileURLToPath(new URL('../../docs/anatomy/official-coverage-matrix.json', import.meta.url));
export type Size = 'pequeno' | 'médio' | 'grande';
export const sizeOf = (chars: number): Size => (chars < 10_000 ? 'pequeno' : chars < 50_000 ? 'médio' : 'grande');

export interface Sample { id: string; source: string; type: string; layout: string; chars: number; size: Size; sha256: string; promoted: boolean; origin: string; manualItem: string | null }
export interface Cell {
  id: string; source: string; type: string; layout: string; size: Size | 'n/a'; required: boolean; manualItems: string[];
  status: 'covered' | 'pending'; samples: string[]; route: string; gap: string | null;
}

const read = (source: 'DOU' | 'CONFAZ' | 'SEFAZ-SP-PORTAL', id: string, html: string, extra: object = {}) => analyzeAnatomy({ publicationVersionId: id, referenceDate: '2026-11-07',
  ruleSet: { id: 'official-coverage-matrix', version: '1' }, input: { source, representationId: id, html, ...extra }, catalog: { edition: 'none', codes: [] } }).canonicalText.length;

export function collectSamples(): Sample[] {
  const out: Sample[] = [];
  // RFB: the reproducible lot (JSON multivigente of the official API), canonical size from its own baseline.
  const lot = JSON.parse(readFileSync(fileURLToPath(new URL('../../docs/anatomy/official-lot-rfb.json', import.meta.url)), 'utf8')) as { acts: { idAto: number; epigrafe: string; canonicalChars: number; sha256: string; promoted: boolean }[] };
  for (const a of lot.acts) out.push({ id: `rfb:${a.idAto}`, source: 'RFB', type: /Instru[çc][ãa]o Normativa/iu.test(a.epigrafe) ? 'Instrução Normativa' : a.epigrafe, layout: 'JSON multivigente (API normasinternet2)',
    chars: a.canonicalChars, size: sizeOf(a.canonicalChars), sha256: a.sha256, promoted: a.promoted, origin: 'coletor oficial (API RFB)', manualItem: null });
  // Sefaz-SP consolidated legislation portal (RICMS pages), read through its proven preparation.
  const sp = join(ROOT, 'doesp-ricms');
  for (const f of readdirSync(sp).filter((x) => x.endsWith('.meta.json')).sort()) {
    const m = JSON.parse(readFileSync(join(sp, f), 'utf8')) as { id: string; url: string; sha256: string; promoted: boolean };
    const prep = prepareSefazSpPortalPage({ resourceId: m.id, url: m.url, bytes: new Uint8Array(readFileSync(join(sp, `${m.id}.html`))) });
    const chars = read('SEFAZ-SP-PORTAL', m.id, prep.html, { sefazSpPortal: prep });
    out.push({ id: m.id, source: 'SEFAZ-SP-PORTAL', type: 'Decreto consolidado (RICMS/2000), artigo', layout: 'HTML SharePoint (região "Conteúdo da Página")', chars, size: sizeOf(chars), sha256: m.sha256, promoted: m.promoted, origin: 'coletor oficial (gate OFFICIAL-01)', manualItem: null });
  }
  // Federal laws from the Congresso Nacional (normas.leg.br): official alternative to Planalto. No reader profile exists
  // for this layout; the size is measured with the DOU profile (diagnostic, not a baseline).
  const lg = join(ROOT, 'leg-normas');
  for (const f of readdirSync(lg).filter((x) => /-(original|atualizada)\.meta\.json$/u.test(x)).sort()) {
    const m = JSON.parse(readFileSync(join(lg, f), 'utf8')) as { id: string; sha256: string; promoted: boolean; manualListItem: string; titleCheck: { found: boolean } };
    if (!m.titleCheck.found) continue;
    const chars = read('DOU', m.id, readFileSync(join(lg, `${m.id}.html`), 'utf8'));
    out.push({ id: m.id, source: 'Legislação federal (normas.leg.br)', type: 'Lei', layout: `HTML exportado do Word (${m.id.endsWith('atualizada') ? 'versão atualizada' : 'texto original'})`,
      chars, size: sizeOf(chars), sha256: m.sha256, promoted: m.promoted, origin: 'fonte oficial alternativa (Congresso Nacional)', manualItem: m.manualListItem });
  }
  // Files saved by hand (P1) once ingested by official-manual-ingest.ts.
  if (existsSync(MANUAL_DIR)) for (const f of readdirSync(MANUAL_DIR).filter((x) => /^M\d+\.meta\.json$/u.test(x)).sort()) {
    const m = JSON.parse(readFileSync(join(MANUAL_DIR, f), 'utf8')) as ManualMeta;
    const html = readFileSync(join(MANUAL_DIR, m.fileName), 'utf8');
    const chars = read(m.source === 'CONFAZ' ? 'CONFAZ' : 'DOU', m.item, html);
    out.push({ id: m.item, source: m.source, type: m.type, layout: 'HTML salvo pelo navegador', chars, size: sizeOf(chars), sha256: m.sha256, promoted: false, origin: m.origin, manualItem: m.item });
  }
  return out;
}

interface CellSpec extends Omit<Cell, 'status' | 'samples' | 'gap'> { match: (s: Sample) => boolean; pendingGap: string }
const ofItem = (...items: string[]) => (s: Sample) => s.manualItem !== null && items.includes(s.manualItem);
const CELLS: CellSpec[] = [
  ...(['pequeno', 'médio', 'grande'] as const).map((size): CellSpec => ({ id: `rfb-in-${size === 'médio' ? 'medio' : size}`, source: 'RFB', type: 'Instrução Normativa', layout: 'JSON multivigente', size,
    required: true, manualItems: [], route: 'API RFB (acessível)', match: (s) => s.source === 'RFB' && s.type === 'Instrução Normativa' && s.size === size, pendingGap: 'sem amostra' })),
  { id: 'lei-federal-grande', source: 'Legislação federal (Planalto ou normas.leg.br)', type: 'Lei', layout: 'HTML', size: 'grande', required: true, manualItems: ['M1', 'M2'],
    route: 'normas.leg.br (acessível); Planalto recusa este ambiente', match: (s) => s.type === 'Lei' && s.size === 'grande', pendingGap: 'M1/M2' },
  { id: 'confaz-convenio', source: 'CONFAZ', type: 'Convênio ICMS', layout: 'HTML', size: 'n/a', required: true, manualItems: ['M3', 'M4'],
    route: 'arquivo manual (a origem recusa este ambiente)', match: ofItem('M3', 'M4'), pendingGap: 'M3 e M4 não recebidos' },
  { id: 'confaz-ajuste-pequeno', source: 'CONFAZ', type: 'Ajuste SINIEF', layout: 'HTML', size: 'pequeno', required: true, manualItems: ['M5'],
    route: 'arquivo manual (a origem recusa este ambiente)', match: ofItem('M5'), pendingGap: 'M5 não recebido' },
  { id: 'dou-pagina-ato', source: 'DOU', type: 'Página de ato (cabeçalho e rodapé)', layout: 'HTML', size: 'n/a', required: true, manualItems: ['M9'],
    route: 'arquivo manual (a origem recusa este ambiente)', match: ofItem('M9'), pendingGap: 'M9 não recebido' },
  { id: 'sefazsp-ricms-medio', source: 'SEFAZ-SP-PORTAL', type: 'Decreto consolidado (RICMS/2000), artigo', layout: 'HTML SharePoint', size: 'médio', required: true, manualItems: [],
    route: 'coletor oficial (acessível)', match: (s) => s.source === 'SEFAZ-SP-PORTAL' && s.size === 'médio', pendingGap: 'sem amostra' },
  { id: 'doesp-diario', source: 'DOE-SP', type: 'Publicação do diário (decretos, resoluções, portarias)', layout: 'JSON API v2 (HTML em content)', size: 'n/a', required: true, manualItems: ['M10'],
    route: 'doe.sp.gov.br responde; coleta depende de decisão (lote 2, depois de M9)', match: (s) => s.source === 'DOE-SP', pendingGap: 'pendente até reconciliação do M10 (fonte do projeto no escopo aprovado)' },
];

/** Act types present in the project sources with no sample yet ("categorias ainda ausentes"), with the route. */
export const ABSENT_CATEGORIES = Object.freeze([
  { source: 'RFB', types: ['Portaria', 'Ato Declaratório (ADI/ADE)', 'Solução de Consulta', 'Resolução'], route: 'API RFB (acessível; nova coleta finita depende de decisão)' },
  { source: 'DOU', types: ['Decreto', 'Portaria', 'Resolução', 'Despacho'], route: 'arquivo manual (a origem recusa este ambiente)' },
  { source: 'CONFAZ', types: ['Protocolo ICMS'], route: 'arquivo manual (a origem recusa este ambiente)' },
  { source: 'DOE-SP', types: ['Decreto', 'Resolução', 'Portaria CAT'], route: 'doe.sp.gov.br (acessível; depende de decisão)' },
]);

export function buildMatrix(samples = collectSamples()) {
  const cells: Cell[] = CELLS.map(({ match, pendingGap, ...c }) => {
    const hit = samples.filter(match).map((s) => s.id);
    return { ...c, status: hit.length ? 'covered' : 'pending', samples: hit, gap: hit.length ? null : pendingGap };
  });
  const pending = cells.filter((c) => c.required && c.status === 'pending').map((c) => c.id);
  return { criterion: { approval: 'tribusca-control#116 c.6514510003 (fonte × tipo × layout × porte); E9: STATUS-MATRIX-02 §9 (sem fração)',
    size: 'pequeno < 10.000; médio 10.000–49.999; grande ≥ 50.000 caracteres do texto canônico do motor' },
    samples, cells, absentCategories: ABSENT_CATEGORIES, requiredPending: pending, e9MatrixComplete: pending.length === 0 };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const m = buildMatrix();
  if (process.argv.includes('--write')) writeFileSync(MATRIX_FILE, `${JSON.stringify(m, null, 2)}\n`);
  for (const c of m.cells) console.log(`${c.status === 'covered' ? '✅' : '❌'} ${c.id} | ${c.source} × ${c.type} × ${c.layout} × ${c.size} | ${c.samples.join(', ') || c.gap}`);
  console.log(`pending: ${m.requiredPending.join(', ') || 'none'}; complete: ${m.e9MatrixComplete}`);
}
