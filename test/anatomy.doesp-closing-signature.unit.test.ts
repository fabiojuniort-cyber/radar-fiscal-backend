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
const BOX = (...ps: string[]) => `<div>${H(...ps)}</div>`;
const sigIds = (r: ReturnType<typeof read>) => r.parts.filter((p) => p.type === 'signature').map((p) => text(r, p).trim());
const lastArticleText = (r: ReturnType<typeof read>) => { const arts = r.parts.filter((p) => p.type === 'article'); return text(r, arts[arts.length - 1]!); };
const stillOperative = (r: ReturnType<typeof read>, line: string) => {
  const p = r.parts.find((x) => x.type !== "document" && x.type !== "article" && x.type !== "caput" && r.canonicalText.slice(x.span.start, x.span.end).trim() === line)!;
  assert.ok(p, line); assert.notEqual(p.type, 'signature', line);
  const art = r.parts.filter((x) => x.type === 'article').at(-1)!;
  assert.ok(art.span.start <= p.span.start && p.span.end <= art.span.end, `${line} stays inside the last article`);
  assert.ok(candidates(r).some((e) => e.span.start <= p.span.start && p.span.end <= e.span.end), `${line} stays inside the article's candidate selection`);
};

test('R5.4 COORD case A: "…a servidora identificada abaixo." + "MARIA DE SOUZA" keeps the name in the article (plain or in its own div)', () => {
  const art = 'Artigo 1º - Fica designada para a função a servidora identificada abaixo.';
  for (const html of [H(art, 'MARIA DE SOUZA'), H(art) + BOX('MARIA DE SOUZA')]) {
    const r = read('DOE-SP', html); assert.deepEqual(sigIds(r), [], html);
    assert.match(lastArticleText(r), /MARIA DE SOUZA/u, html);
    if (!html.includes('<div>')) stillOperative(r, 'MARIA DE SOUZA');
  }
});
test('R5.4 COORD case B: "…com a denominação indicada abaixo." + "PROGRAMA ESTADUAL DE SAÚDE" keeps the line in the article (plain or in its own div)', () => {
  const art = 'Artigo 1º - Fica instituído o programa com a denominação indicada abaixo.';
  for (const html of [H(art, 'PROGRAMA ESTADUAL DE SAÚDE'), H(art) + BOX('PROGRAMA ESTADUAL DE SAÚDE')]) {
    const r = read('DOE-SP', html); assert.deepEqual(sigIds(r), [], html);
    assert.match(lastArticleText(r), /PROGRAMA ESTADUAL DE SAÚDE/u, html);
    if (!html.includes('<div>')) stillOperative(r, 'PROGRAMA ESTADUAL DE SAÚDE');
  }
});
test('R5.4: position + period + name look are NOT enough — without a dedicated container nothing is closed', () => {
  assert.deepEqual(sigIds(read('DOE-SP', H('Artigo 1º - Este decreto entra em vigor na data de sua publicação.', 'TARCÍSIO DE FREITAS', 'Arthur Luis Pinho de Lima'))), []);
});
test('R5.3/R5.4 counter-cases: name/uppercase line inside an article; container holding a device; ":"; digits; >4 lines; single word', () => {
  const r = read('DOE-SP', H('Artigo 1º - Fica nomeado:', 'JOÃO DA SILVA', 'para exercer o cargo de Diretor.', 'Artigo 2º - Este decreto entra em vigor na data de sua publicação.') + BOX('FULANO DE TAL'));
  assert.deepEqual(sigIds(r), ['FULANO DE TAL']);
  assert.match(text(r, r.parts.find((p) => p.type === 'article')!), /JOÃO DA SILVA[\s\S]*para exercer o cargo de Diretor\./u, 'the name stays inside Art. 1');
  assert.deepEqual(sigIds(read('DOE-SP', H('Artigo 1º - Fica designada a COMISSÃO ESPECIAL.', 'MARIA DE SOUZA', 'Artigo 2º - Este decreto entra em vigor.'))), []);
  assert.deepEqual(sigIds(read('DOE-SP', H('Artigo 1º - Fica criada a comissão.') + `<div>${H('Artigo 2º - Este decreto entra em vigor.', 'ANA LIMA')}</div>`)), [], 'container holding a device');
  assert.deepEqual(sigIds(read('DOE-SP', H('Artigo 1º - Ficam designados os seguintes servidores:') + BOX('JOÃO DA SILVA', 'MARIA DE SOUZA'))), [], "':'");
  assert.deepEqual(sigIds(read('DOE-SP', H('Artigo 1º - Este decreto entra em vigor.') + BOX('COMISSÃO DE 2025, COMPOSTA POR'))), [], 'digits/punctuation');
  assert.deepEqual(sigIds(read('DOE-SP', H('Artigo 1º - Este decreto entra em vigor.') + BOX('Ana Lima', 'Bia Lima', 'Caio Lima', 'Davi Lima', 'Eva Lima'))), [], '>4 lines');
  assert.deepEqual(sigIds(read('DOE-SP', H('Artigo 1º - Este decreto entra em vigor.') + BOX('SILVA'))), [], 'single word');
});
test('R5.4 positive case and scope: own container after a closed last device => signatures (DOE-SP only; DOU unchanged)', () => {
  const html = H('Artigo 1º - Este decreto entra em vigor na data de sua publicação.') + BOX('TARCÍSIO DE FREITAS', 'Arthur Luis Pinho de Lima');
  assert.deepEqual(sigIds(read('DOE-SP', html)), ['TARCÍSIO DE FREITAS', 'Arthur Luis Pinho de Lima']);
  assert.deepEqual(sigIds(read('DOU', html)), []);
});
