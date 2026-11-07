import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { prepareSefazSpPortalPage } from '../src/modules/anatomy/sefaz-sp-preparation.js';
import { readAnatomyInput } from '../src/modules/anatomy/readers.js';

// ANAT-L21 (decisão do Fábio, tribusca-control#116 c.6671833324): leading U+200B tolerated ONLY to recognise the
// marker, in the proven Sefaz-SP portal. Text, spans and hashes stay literal.
const URL_OK = 'https://legislacao.fazenda.sp.gov.br/Paginas/exemplo.aspx';
const page = (c: string) => `<html><body><div id="areaComentario"><div id="lbl">Conteúdo da Página</div><div class="ms-rtestate-field" aria-labelledby="lbl">${c}</div></div></body></html>`;
const portal = (c: string) => { const p = prepareSefazSpPortalPage({ resourceId: 'x', url: URL_OK, bytes: new TextEncoder().encode(page(c)) });
  return readAnatomyInput({ source: 'SEFAZ-SP-PORTAL', representationId: 'x', html: p.html, sefazSpPortal: p }); };
// the smallest part whose text contains the needle (containers such as the article span everything after them)
const blockAt = (r: ReturnType<typeof portal>, needle: string) => r.parts.filter((x) => !['document', 'caput'].includes(x.type) && r.canonicalText.slice(x.span.start, x.span.end).includes(needle))
  .sort((a, b) => (a.span.end - a.span.start) - (b.span.end - b.span.start))[0]!;
const ZW = '​';

test('L21: leading U+200B no longer hides the marker; text, span and hash keep the character', () => {
  const html = `<p>Artigo 1º - Texto:</p><p>I - primeiro;</p><p>${ZW}II - segundo;</p><p>${ZW}${ZW} III - terceiro.</p><p>${ZW}§ 1º - Parágrafo.</p><p>${ZW}NOTA - V. Portaria X.</p>`;
  const r = portal(html);
  const ii = blockAt(r, 'II - segundo'); assert.equal(ii.type, 'inciso'); assert.ok(ii.contextReasons.includes('sefaz_sp_portal_leading_zwsp_tolerated'));
  assert.equal(r.canonicalText.slice(ii.span.start, ii.span.start + 1), ZW, 'the span still starts at the U+200B');
  assert.equal(blockAt(r, 'III - terceiro').type, 'inciso');
  assert.equal(blockAt(r, '§ 1º').type, 'paragraph');
  assert.equal(blockAt(r, 'NOTA - V.').type, 'editorial_note');
  assert.equal((r.canonicalText.match(/​/gu) ?? []).length, 5, 'no character removed from the canonical text');
  assert.ok(r.parts.every((x) => x.legalStatus === 'unknown'));
});

test('L21 negative: U+200B in the middle, other invisible characters and other sources are unchanged', () => {
  const mid = portal(`<p>Artigo 1º - Texto:</p><p>I${ZW} - primeiro;</p>`);
  assert.equal(blockAt(mid, 'primeiro').type, 'unidentified', 'U+200B inside the marker is not tolerated');
  // U+FEFF is not listed: JavaScript trim() and \s already treat it as whitespace (pre-existing behaviour, not L21).
  for (const inv of ['\u200C', '\u200D', '\u2060']) {
    const r = portal(`<p>Artigo 1º - Texto:</p><p>${inv}II - segundo;</p>`);
    assert.equal(blockAt(r, 'segundo').type, 'unidentified', `U+${inv.codePointAt(0)!.toString(16).toUpperCase()} is not tolerated`);
  }
  for (const source of ['DOE-SP', 'DOU', 'CONFAZ'] as const) {
    const r = readAnatomyInput({ source, representationId: 'x', html: `<p>Artigo 1º - Texto:</p><p>${ZW}II - segundo;</p>` });
    assert.equal(blockAt(r, 'segundo').type, 'unidentified', `${source} unchanged`);
  }
  // quotation detection is unchanged: a leading U+200B before a quote does not open a quotation
  const q = portal(`<p>Artigo 1º - Texto:</p><p>${ZW}“citação aberta</p><p>II - segundo;</p>`);
  assert.equal(blockAt(q, 'II - segundo').context, 'operative_candidate');
});

test('L21 official RICMS art. 7º (#279, promoted:false): inciso XV recognized; canonical text byte-identical', () => {
  const D = new URL('../ops/anatomy/official-identification/doesp-ricms/', import.meta.url);
  const meta = JSON.parse(readFileSync(new URL('ricms-art007.meta.json', D), 'utf8')); assert.equal(meta.promoted, false);
  const p = prepareSefazSpPortalPage({ resourceId: 'ricms-art007', url: meta.url, bytes: new Uint8Array(readFileSync(new URL('ricms-art007.html', D))) });
  const r = readAnatomyInput({ source: 'SEFAZ-SP-PORTAL', representationId: 'ricms-art007', html: p.html, sefazSpPortal: p });
  const xv = blockAt(r, 'XV - a saída, com destino a outro estabelecimento');
  assert.equal(xv.type, 'inciso'); assert.ok(xv.contextReasons.includes('sefaz_sp_portal_leading_zwsp_tolerated'));
  assert.equal(r.parts.filter((x) => x.type === 'unidentified').length, 0);
  // canonical text and source map are byte-identical to the pre-L21 candidate (#294 871ed557)
  assert.equal(createHash('sha256').update(r.canonicalText).digest('hex'), '454171706fc242c869606de4284125a4d8e70282e9965b6398e0a01831f5d5c1');
  assert.equal(createHash('sha256').update(JSON.stringify(r.sourceMap)).digest('hex').slice(0, 16), 'dbd2645b8f271483');
});
