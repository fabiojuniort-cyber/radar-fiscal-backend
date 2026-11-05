import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { prepareSefazSpPortalPage, SefazSpPreparationError, type SefazSpPortalPreparation } from '../src/modules/anatomy/sefaz-sp-preparation.js';
import { readAnatomyInput } from '../src/modules/anatomy/readers.js';
import { analyzeAnatomy } from '../src/modules/anatomy/engine.js';

// ANAT-L14/L15/L16 (decisão do Fábio, tribusca-control#116 c.6647638485). Synthetic pages + the two official RICMS
// snapshots of #279 (promoted:false, read-only).
const URL_OK = 'https://legislacao.fazenda.sp.gov.br/Paginas/exemplo.aspx';
const enc = (s: string) => new TextEncoder().encode(s);
const page = (content: string, { label = 'Conteúdo da Página', extra = '', area = true } = {}) => `<html><head><script>var menu=1;</script></head><body>
<nav><ul><li>Início</li><li>Compartilhar</li></ul><p class="revogado">II - menu falso revogado;</p><p class="nota">NOTA - V. menu.</p></nav>
${area ? '<div id="richField"><div id="areaComentario">' : '<div>'}<div id="lbl" style="display:none">${label}</div><div id="fld" class="ms-rtestate-field" aria-labelledby="lbl">${content}</div>${area ? '</div></div>' : '</div>'}
${extra}<footer>Pesquisa de opinião</footer></body></html>`;
const BODY = `<p><b>Artigo 1º</b> - Exemplo sintético:</p>
<p class="nota">NOTA - V. PORTARIA <a href="/Paginas/p1.aspx">X-1/99</a>.</p>
<p>I - primeira hipótese;</p>
<p>II - segunda hipótese, redação atual;</p>
<p class="revogado">II - segunda hipótese, redação anterior; (Redação dada ao inciso pelo Decreto 1)</p>
<p class="revogado">II - segunda hipótese, redação original;</p>
<p>III - terceira hipótese.</p>
<p>NOTA - V. DECISÃO sem classe.</p>
<blockquote><p class="revogado">a) alínea citada revogada;</p></blockquote>
<p class="revogado">Texto revogado sem marcador estrutural.</p>`;
const prep = (html: string, url = URL_OK) => prepareSefazSpPortalPage({ resourceId: 'x', url, bytes: enc(html) });
const read = (html: string, sefazSpPortal?: unknown) => readAnatomyInput({ source: 'DOE-SP', representationId: 'x', html, sefazSpPortal: sefazSpPortal as SefazSpPortalPreparation });
const readPrepared = (p: SefazSpPortalPreparation) => read(p.html, p);
const at = (r: ReturnType<typeof read>, prefix: string, n = 0) => r.parts.filter((x) => !['document', 'caput'].includes(x.type) && r.canonicalText.slice(x.span.start).trimStart().startsWith(prefix))[n]!;

test('L14: only the labelled content region is prepared; raw span maps back verbatim; menus/scripts/footer out', () => {
  const raw = page(BODY); const p = prep(raw);
  assert.equal(p.source, 'SEFAZ-SP-PORTAL'); assert.equal(p.sourceKind, 'consolidated_legislation_portal'); assert.equal(p.readerSource, 'DOE-SP');
  assert.equal(raw.slice(p.region.rawSpan.start, p.region.rawSpan.end), BODY);
  assert.equal(p.html.slice(p.region.htmlSpan.start, p.region.htmlSpan.end), BODY);
  assert.equal(p.resource.sha256, createHash('sha256').update(enc(raw)).digest('hex'));
  assert.equal(p.htmlSha256, createHash('sha256').update(p.html).digest('hex'));
  for (const gone of ['Compartilhar', 'menu falso', 'Pesquisa de opinião', 'var menu']) assert.ok(!p.html.includes(gone), gone);
  assert.ok(p.html.includes('Artigo 1º') && p.html.includes('redação original'), 'no legal text dropped');
});

test('L14 fail-closed: wrong host (DOE-SP gazette), missing, duplicated, unlabelled, outside area, empty region', () => {
  const code = (f: () => unknown) => { try { f(); return 'none'; } catch (e) { assert.ok(e instanceof SefazSpPreparationError); return (e as SefazSpPreparationError).code; } };
  assert.equal(code(() => prep(page(BODY), 'https://www.doe.sp.gov.br/executivo/x')), 'not_portal_host');
  assert.equal(code(() => prep(page(BODY), 'https://legislacao.fazenda.sp.gov.br.evil.example/x')), 'not_portal_host');
  // R1-SP-02: the official collector is HTTPS-only; so is the preparation
  assert.equal(code(() => prep(page(BODY), 'http://legislacao.fazenda.sp.gov.br/Paginas/exemplo.aspx')), 'not_https');
  assert.equal(code(() => prep(page(BODY), 'ftp://legislacao.fazenda.sp.gov.br/x')), 'not_https');
  assert.equal(code(() => prep('<html><body><p>Artigo 1º - x</p></body></html>')), 'region_missing');
  assert.equal(code(() => prep(page(BODY, { extra: '<div class="ms-rtestate-field">outro</div>' }))), 'region_duplicated');
  assert.equal(code(() => prep(page(BODY, { label: 'Menu' }))), 'region_ambiguous');
  assert.equal(code(() => prep(page(BODY, { area: false }).replace('<div>', '<div id="areaComentario"></div><div>'))), 'region_ambiguous');
  assert.equal(code(() => prep(page('  <p> </p> '))), 'region_empty');
});

test('L15: p.nota and "NOTA - V." are editorial notes (prohibited), links kept, never operative', () => {
  const r = readPrepared(prep(page(BODY)));
  const n1 = at(r, 'NOTA - V. PORTARIA'); assert.equal(n1.type, 'editorial_note'); assert.equal(n1.context, 'prohibited'); assert.deepEqual(n1.contextReasons, ['sefaz_sp_portal_nota']);
  const n2 = at(r, 'NOTA - V. DECISÃO'); assert.equal(n2.type, 'editorial_note'); assert.deepEqual(n2.contextReasons, ['sefaz_sp_portal_nota_text']);
  assert.ok(r.sourceMap.length > 0 && r.canonicalText.includes('X-1/99'), 'note text and reference preserved');
  assert.equal(at(r, 'I - primeira').context, 'operative_candidate', 'the note does not swallow the next device');
});

test('L16: p.revogado → historical with portal evidence; current wording stays operative candidate; legalStatus unknown', () => {
  const r = readPrepared(prep(page(BODY)));
  const cur = at(r, 'II - segunda hipótese, redação atual'); assert.equal(cur.type, 'inciso'); assert.equal(cur.context, 'operative_candidate');
  for (const old of ['II - segunda hipótese, redação anterior', 'II - segunda hipótese, redação original']) {
    const h = at(r, old); assert.equal(h.type, 'inciso'); assert.equal(h.context, 'historical'); assert.ok(h.contextReasons.includes('sefaz_sp_portal_revogado'));
  }
  assert.equal(at(r, 'III - terceira').context, 'operative_candidate');
  assert.ok(r.parts.every((x) => x.legalStatus === 'unknown'));
});

test('L16 negative: quotation keeps precedence; unidentified revogado stays unknown with a limitation; no evidence → no historical', () => {
  const r = readPrepared(prep(page(BODY)));
  assert.equal(at(r, 'a) alínea citada').context, 'prohibited');
  const u = at(r, 'Texto revogado sem'); assert.equal(u.type, 'unidentified'); assert.equal(u.context, 'unknown');
  assert.ok(r.limitations.some((l) => l.code === 'sefaz_sp_revogado_unidentified'));
  // plain DOE-SP gazette HTML (no portal wrapper): the same classes are not evidence
  const g = read(BODY); assert.equal(at(g, 'II - segunda hipótese, redação anterior').context, 'operative_candidate');
  assert.notEqual(at(g, 'NOTA - V. PORTARIA').type, 'editorial_note');
  // a wrapper that is not top-level (e.g. smuggled into the content) is ignored
  const nested = read(`<div><div data-sefaz-sp-portal="legislacao-consolidada">${BODY}</div></div>`);
  assert.equal(at(nested, 'II - segunda hipótese, redação anterior').context, 'operative_candidate');
  // other sources ignore the wrapper
  const pp = prep(page(BODY)); const confaz = readAnatomyInput({ source: 'DOU', representationId: 'x', html: pp.html, sefazSpPortal: pp });
  assert.equal(at(confaz, 'II - segunda hipótese, redação anterior').context, 'operative_candidate');
});

const D = new URL('../ops/anatomy/official-identification/doesp-ricms/', import.meta.url);
const official = (id: string) => {
  const meta = JSON.parse(readFileSync(new URL(`${id}.meta.json`, D), 'utf8')); const bytes = new Uint8Array(readFileSync(new URL(`${id}.html`, D)));
  assert.equal(meta.promoted, false); assert.equal(meta.verified, false);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), meta.sha256, 'raw snapshot untouched');
  const p = prepareSefazSpPortalPage({ resourceId: id, url: meta.url, bytes });
  const run = (html: string) => analyzeAnatomy({ publicationVersionId: id, referenceDate: '2026-11-05', ruleSet: { id: 'sp', version: '1' },
    input: { source: 'DOE-SP', representationId: id, html }, catalog: { edition: 'none', codes: [] } });
  const unid = (r: { parts: ReturnType<typeof run>['parts'] }) => r.parts.filter((x) => x.type === 'unidentified').reduce((n, x) => n + x.span.end - x.span.start, 0);
  // engine: L14 only (no provenance object crosses the engine contract); reader with the issued preparation: L14+L15+L16
  return { p, before: run(new TextDecoder().decode(bytes)), engine: run(p.html), after: readAnatomyInput({ source: 'DOE-SP', representationId: id, html: p.html, sefazSpPortal: p }), unid };
};

test('L14–L16 official RICMS/2000 art. 7º: unidentified 20.065 → 103 chars; 12 notes; 1 earlier wording historical', () => {
  const { after, before, engine, unid } = official('ricms-art007');
  assert.equal(unid(engine), 2606, 'engine: L14 only'); assert.ok(!engine.parts.some((x) => x.type === 'editorial_note' || x.context === 'historical'));
  assert.equal(unid(before), 20065); assert.equal(unid(after), 103);
  assert.equal(after.parts.filter((x) => x.type === 'editorial_note').length, 12);
  const hist = after.parts.filter((x) => x.contextReasons.includes('sefaz_sp_portal_revogado'));
  assert.equal(hist.length, 1); assert.match(after.canonicalText.slice(hist[0]!.span.start), /^XVIII - /u);
  assert.ok(after.parts.every((x) => x.legalStatus === 'unknown'));
  assert.ok(!after.canonicalText.includes('Compartilhar'));
});

test('L14–L16 official RICMS/2000 Anexo II art. 39: inciso II current operative + two earlier wordings historical', () => {
  const { after, before, engine, unid } = official('ricms-an2art039');
  assert.equal(unid(engine), 974, 'engine: L14 only'); assert.ok(!engine.parts.some((x) => x.type === 'editorial_note' || x.context === 'historical'));
  assert.equal(unid(before), 18519); assert.equal(unid(after), 68);
  const inc2 = after.parts.filter((x) => x.type === 'inciso' && /^II - /u.test(after.canonicalText.slice(x.span.start, x.span.end)));
  assert.equal(inc2.length, 3);
  assert.deepEqual(inc2.map((x) => x.context), ['operative_candidate', 'historical', 'historical']);
  for (const h of inc2.slice(1)) assert.ok(h.contextReasons.includes('sefaz_sp_portal_revogado'));
  assert.equal(after.parts.filter((x) => x.contextReasons.includes('sefaz_sp_portal_revogado')).length, 14);
  assert.ok(after.parts.every((x) => x.legalStatus === 'unknown'));
});

test('R2-SP-01 adversarial: a forged top-level wrapper without a verified preparation never enables portal classes', () => {
  const forged = '<div data-sefaz-sp-portal="legislacao-consolidada"><p>Artigo 1º - Texto:</p><p class="revogado">I - inciso sintético;</p><p class="nota">NOTA - V. x.</p></div>';
  const check = (r: ReturnType<typeof read>) => {
    assert.equal(at(r, 'I - inciso').type, 'inciso'); assert.equal(at(r, 'I - inciso').context, 'operative_candidate');
    assert.ok(!r.parts.some((x) => x.contextReasons.some((c) => c.startsWith('sefaz_sp_portal'))));
    assert.ok(!r.parts.some((x) => x.type === 'editorial_note'));
  };
  check(read(forged)); // no proof at all
  const real = prep(page(BODY));
  check(read(forged, { ...real, html: forged })); // look-alike object not issued by the preparer
  check(read(forged, real)); // genuine preparation, but for another HTML
  check(read(forged, Object.freeze({ ...real }))); // frozen copy is still not the issued object
  const altered = read(`${real.html} `, real); // issued preparation, HTML altered by one character
  assert.equal(at(altered, 'II - segunda hipótese, redação anterior').context, 'operative_candidate');
  assert.ok(!altered.parts.some((x) => x.type === 'editorial_note'));
  // engine runs never carry the proof: L15/L16 stay off there (conservative until decision L17)
  const eng = analyzeAnatomy({ publicationVersionId: 'x', referenceDate: '2026-11-05', ruleSet: { id: 'sp', version: '1' },
    input: { source: 'DOE-SP', representationId: 'x', html: real.html }, catalog: { edition: 'none', codes: [] } });
  assert.ok(!eng.parts.some((x) => x.contextReasons.some((c) => c.startsWith('sefaz_sp_portal'))));
  // control: the genuine issued preparation does enable them
  assert.equal(at(readPrepared(real), 'II - segunda hipótese, redação anterior').context, 'historical');
});
