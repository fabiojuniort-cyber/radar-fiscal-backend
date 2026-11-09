import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { analyzeAnatomy } from '../src/modules/anatomy/engine.js';
import { prepareDoeSpRepresentation } from '../src/modules/anatomy/json-preparation.js';
import { parseDoeSpDetail } from '../src/modules/collection/doe-sp.parser.js';
import { sanitizeLegalPresentationHtml } from '../src/modules/collection/legal-presentation.js';

// E9-ACERVO-01 R5.3 (tribusca-control#116): the DOE-SP closing signature block ("fecho") is not a continuation of the
// last caput. Real sample = Decreto 70.226/2025 preserved by the P2-d direct attempt (no network here).
const ID = 'fdb81d5f-3876-468a-70bc-08de3f1ee1ea';
const BYTES = readFileSync(new URL(`../ops/anatomy/official-identification/doesp-p2d/${ID}.json`, import.meta.url));
const read = (source: 'DOE-SP' | 'DOU', html: string, id = 'x') => analyzeAnatomy({ publicationVersionId: id, referenceDate: '2026-11-09', ruleSet: { id: 'r53', version: '1' },
  input: { source, representationId: id, html }, catalog: { edition: 'none', codes: [] } });
const text = (r: ReturnType<typeof read>, p: { span: { start: number; end: number } }) => r.canonicalText.slice(p.span.start, p.span.end);
const official = () => read('DOE-SP', prepareDoeSpRepresentation({ resourceId: `doesp:${ID}`, bytes: new Uint8Array(BYTES) }, ID).html, `doesp:${ID}`);
const acervo = () => read('DOE-SP', sanitizeLegalPresentationHtml(parseDoeSpDetail(JSON.parse(BYTES.toString('utf8')), ID).contentHtml)!, `acervo:${ID}`);
const touches = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;
const candidates = (r: ReturnType<typeof read>) => r.eligibility.filter((e) => e.exclusionReasons.every((x) => x === 'missing_approved_evidence'));

function checkStructure(r: ReturnType<typeof read>, label: string) {
  const arts = r.parts.filter((p) => p.type === 'article'); const sigs = r.parts.filter((p) => p.type === 'signature');
  assert.equal(arts.length, 3, label); assert.equal(r.parts.filter((p) => p.type === 'paragraph').length, 1, label);
  assert.match(text(r, arts[0]!), /^Artigo 1° - Fica a Fazenda do Estado autorizada[\s\S]*Parágrafo único - [\s\S]*estrutura administrativa da Fundação\.\s*$/u, `${label}: Art. 1 + § único complete`);
  assert.match(text(r, arts[1]!), /^Artigo 2° - A permissão de uso qualificada[\s\S]*impostas à permissionária\.\s*$/u, `${label}: Art. 2 complete`);
  assert.match(text(r, arts[2]!), /^Artigo 3° - Este decreto entra em vi­gor na data de sua publicação\.\n$/u, `${label}: Art. 3 complete and closed before the signatures`);
  const cap3 = r.parts.find((p) => p.id === `${arts[2]!.id}-caput`)!;
  assert.deepEqual(cap3.span, arts[2]!.span, `${label}: Art. 3 caput = its own block`);
  assert.ok(!cap3.contextReasons.includes('caput_continuation'), label);
  assert.deepEqual(sigs.map((s) => text(r, s).trim()), ['TARCÍSIO DE FREITAS', 'Arthur Luis Pinho de Lima'], `${label}: signatures kept in the canonical text`);
  for (const s of sigs) {
    assert.deepEqual([s.context, s.parentId, s.contextReasons], ['prohibited', 'part-0', ['doe_sp_closing_signature']], label);
    assert.ok(!r.parts.some((p) => (p.type === 'article' || p.type === 'caput') && touches(p.span, s.span)), `${label}: signature outside every article/caput`);
    assert.ok(!candidates(r).some((e) => touches(e.span, s.span)), `${label}: signature outside every candidate selection`);
    assert.ok(s.sourcePointers.length === 1 && s.sourcePointers[0]!.sourceSpan !== null, `${label}: signature traceable to its source block`);
  }
  // Ementa and "Decreta:" stay explicit unidentified limitations and are never candidate selections.
  const un = r.parts.filter((p) => p.type === 'unidentified');
  assert.deepEqual(un.map((p) => text(r, p).trim().slice(0, 20)), ['Autoriza a outorga d', 'Decreta:'], label);
  assert.ok(un.every((p) => p.context === 'unknown' && !candidates(r).some((e) => touches(e.span, p.span))), label);
  assert.ok(r.limitations.some((l) => l.code === 'unidentified_content'), label);
  for (const a of arts) assert.ok(a.sourcePointers.every((ptr) => ptr.sourceSpan !== null), `${label}: article positions traceable`);
  assert.ok(r.parts.every((p) => p.legalStatus === 'unknown')); assert.ok(!r.eligibility.some((e) => e.eligible));
}

test('R5.3 real sample, official JSON: three articles and the § único complete; signatures out of Art. 3 and its caput', () => checkStructure(official(), 'official'));
test('R5.3 real sample, Acervo equivalent: same structure; positions = official − 8 (edge whitespace only)', () => {
  const a = official(); const b = acervo(); checkStructure(b, 'acervo');
  assert.equal(a.canonicalText.indexOf(b.canonicalText), 8);
  const nd = (r: ReturnType<typeof read>, off: number) => r.parts.filter((p) => p.type !== 'document').map((p) => [p.type, p.context, p.span.start + off, p.span.end + off]);
  assert.deepEqual(nd(b, 8), nd(a, 0));
});

// Counter-cases (synthetic DOE-SP-shaped HTML written for this test; not official text).
const H = (...ps: string[]) => ps.map((p) => `<p>${p}</p>`).join('');
const sigIds = (r: ReturnType<typeof read>) => r.parts.filter((p) => p.type === 'signature').map((p) => text(r, p).trim());
test('R5.3 counter-case: a proper name / uppercase line INSIDE an article (more text or a device follows) never closes it', () => {
  const r = read('DOE-SP', H('Artigo 1º - Fica nomeado:', 'JOÃO DA SILVA', 'para exercer o cargo de Diretor.', 'Artigo 2º - Este decreto entra em vigor na data de sua publicação.', 'FULANO DE TAL'));
  assert.deepEqual(sigIds(r), ['FULANO DE TAL']);
  const a1 = r.parts.find((p) => p.type === 'article')!; assert.match(text(r, a1), /JOÃO DA SILVA[\s\S]*para exercer o cargo de Diretor\./u, 'the name stays inside Art. 1');
  const r2 = read('DOE-SP', H('Artigo 1º - Fica designada a COMISSÃO ESPECIAL DE LICITAÇÃO.', 'MARIA DE SOUZA', 'Artigo 2º - Este decreto entra em vigor na data de sua publicação.'));
  assert.deepEqual(sigIds(r2), [], 'a name line followed by a device is not a closing block');
});
test('R5.3 counter-case: no closing when the last device ends with ":" or a tail line is not a name, or the tail is too long', () => {
  assert.deepEqual(sigIds(read('DOE-SP', H('Artigo 1º - Ficam designados os seguintes servidores:', 'JOÃO DA SILVA', 'MARIA DE SOUZA'))), [], "':' introduces content");
  assert.deepEqual(sigIds(read('DOE-SP', H('Artigo 1º - Este decreto entra em vigor.', 'COMISSÃO DE 2025, COMPOSTA POR'))), [], 'digits/punctuation are not a name');
  assert.deepEqual(sigIds(read('DOE-SP', H('Artigo 1º - Este decreto entra em vigor.', 'Ana Lima', 'Bia Lima', 'Caio Lima', 'Davi Lima', 'Eva Lima'))), [], 'more than 4 tail lines');
  assert.deepEqual(sigIds(read('DOE-SP', H('Artigo 1º - Este decreto entra em vigor.', 'SILVA'))), [], 'a single word is not a signature');
});
test('R5.3 scope: the rule is DOE-SP only — the same HTML read as DOU keeps the previous reading', () => {
  const html = H('Artigo 1º - Este decreto entra em vigor na data de sua publicação.', 'TARCÍSIO DE FREITAS', 'Arthur Luis Pinho de Lima');
  assert.deepEqual(sigIds(read('DOE-SP', html)), ['TARCÍSIO DE FREITAS', 'Arthur Luis Pinho de Lima']);
  assert.deepEqual(sigIds(read('DOU', html)), []);
});
