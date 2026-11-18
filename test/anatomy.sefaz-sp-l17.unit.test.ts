import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareSefazSpPortalPage, SefazSpPreparationError } from '../src/modules/anatomy/sefaz-sp-preparation.js';
import { SefazSpProvenanceError } from '../src/modules/anatomy/readers.js';
import { analyzeAnatomy } from '../src/modules/anatomy/engine.js';
import { DEFAULT_PROFILES, PROFILE_FORMAT_VERSION, resolveEffectiveProfile } from '../src/modules/anatomy/profile.js';

// ANAT-L17 (decisão do Fábio, tribusca-control#116 c.6649410567): SEFAZ-SP-PORTAL as a typed engine source, with the
// out-of-band preparation proof (R1-SP-03 included). Synthetic pages only. No database, no migration.
const URL_OK = 'https://legislacao.fazenda.sp.gov.br/Paginas/exemplo.aspx';
const page = (content: string) => `<html><body><nav><p class="revogado">II - menu;</p></nav><div id="areaComentario"><div id="lbl">Conteúdo da Página</div><div class="ms-rtestate-field" aria-labelledby="lbl">${content}</div></div></body></html>`;
const BODY = `<p>Artigo 1º - Exemplo:</p><p class="nota">NOTA - V. PORTARIA X.</p><p>I - atual;</p><p class="revogado">I - anterior;</p>
<blockquote><p class="revogado">a) citada revogada;</p></blockquote><p>II - segundo.</p>`;
const prep = (resourceId = 'doc-1', content = BODY) => prepareSefazSpPortalPage({ resourceId, url: URL_OK, bytes: new TextEncoder().encode(page(content)) });
const run = (input: Record<string, unknown>, extra: Record<string, unknown> = {}) => analyzeAnatomy({ publicationVersionId: 'v1', referenceDate: '2026-11-05',
  ruleSet: { id: 'l17', version: '1' }, input: input as never, catalog: { edition: 'none', codes: [] }, ...extra });
const at = (r: ReturnType<typeof run>, prefix: string) => r.parts.find((x) => !['document', 'caput'].includes(x.type) && r.canonicalText.slice(x.span.start).trimStart().startsWith(prefix))!;

test('L17 full engine path: preparation → proof → read → analysis; notes and earlier wordings with proof; nothing eligible', () => {
  const p = prep();
  const r = run({ source: 'SEFAZ-SP-PORTAL', representationId: 'doc-1', html: p.html, sefazSpPortal: p });
  assert.equal(at(r, 'NOTA - V.').type, 'editorial_note'); assert.equal(at(r, 'NOTA - V.').context, 'prohibited');
  assert.equal(at(r, 'I - atual').context, 'operative_candidate');
  const old = at(r, 'I - anterior'); assert.equal(old.context, 'historical'); assert.ok(old.contextReasons.includes('sefaz_sp_portal_revogado'));
  assert.equal(at(r, 'a) citada').context, 'prohibited', 'L18 deferred: blockquote stays prohibited');
  assert.ok(r.parts.every((x) => x.legalStatus === 'unknown'));
  assert.ok(r.eligibility.every((e) => !e.eligible), 'no new legal eligibility');
  assert.ok(r.limitations.some((l) => l.code === 'sefaz_sp_portal_local_preparation_only'), 'local proof ≠ official collection');
  assert.equal(r.status, 'partial');
  // R1-SP-03: document identity = prepared resource = source pointers
  for (const x of r.parts) for (const ptr of x.sourcePointers) assert.equal(ptr.resourceId, p.resource.resourceId);
  assert.ok(!r.canonicalText.includes('II - menu'));
});

test('L17 fail-closed: declared source without proof, serialized/copied proof, other HTML, altered HTML', () => {
  const p = prep(); const other = prep('doc-1', '<p>Artigo 9º - Outro.</p>');
  const bad: [string, unknown][] = [[p.html, undefined], [p.html, JSON.parse(JSON.stringify(p))], [p.html, { ...p }], [p.html, other], [`${p.html} `, p],
    ['<div data-sefaz-sp-portal="legislacao-consolidada"><p class="revogado">I - forjado;</p></div>', undefined]];
  for (const [html, proof] of bad) assert.throws(() => run({ source: 'SEFAZ-SP-PORTAL', representationId: 'doc-1', html, ...(proof === undefined ? {} : { sefazSpPortal: proof }) }), SefazSpProvenanceError);
  assert.throws(() => run({ source: 'SEFAZ-SP-PORTAL', representationId: 'doc-1', text: 'Artigo 1º - x', sefazSpPortal: p }), SefazSpProvenanceError);
});

test('R1-SP-03 negative: a representationId different from the prepared resource is refused', () => {
  const p = prep('doc-1');
  assert.throws(() => run({ source: 'SEFAZ-SP-PORTAL', representationId: 'doc-2', html: p.html, sefazSpPortal: p }), SefazSpProvenanceError);
  // the same HTML prepared under another resource id is a different proof
  const q = prep('doc-2');
  assert.equal(q.htmlSha256, p.htmlSha256); assert.notEqual(q.preparationId, p.preparationId);
  assert.throws(() => run({ source: 'SEFAZ-SP-PORTAL', representationId: 'doc-1', html: p.html, sefazSpPortal: q }), SefazSpProvenanceError);
});

test('R1-SP-03: nested preparation metadata is frozen (region, spans, resource, provenance)', () => {
  const p = prep() as unknown as Record<string, any>;
  assert.throws(() => { p.region.htmlSpan.start = 0; }, TypeError);
  assert.throws(() => { p.region.rawSpan.end = 1; }, TypeError);
  assert.throws(() => { p.region.sha256 = 'x'; }, TypeError);
  assert.throws(() => { p.resource.resourceId = 'doc-2'; }, TypeError);
  assert.throws(() => { p.provenance.collectedFromOfficialSourceVerified = true; }, TypeError);
  assert.throws(() => { p.url = 'http://legislacao.fazenda.sp.gov.br/x'; }, TypeError);
});

test('L17: proof only for its typed source; DOE-SP keeps its previous behaviour; invalid URLs never yield a proof', () => {
  const p = prep();
  assert.throws(() => run({ source: 'DOE-SP', representationId: 'doc-1', html: p.html, sefazSpPortal: p }), /only valid for source SEFAZ-SP-PORTAL/u);
  const doe = run({ source: 'DOE-SP', representationId: 'doc-1', html: p.html });
  assert.equal(at(doe, 'I - anterior').context, 'operative_candidate'); assert.ok(!doe.parts.some((x) => x.type === 'editorial_note'));
  assert.ok(!doe.limitations.some((l) => l.code.startsWith('sefaz_sp_portal')));
  for (const url of ['http://legislacao.fazenda.sp.gov.br/x', 'https://www.doe.sp.gov.br/x', 'https://legislacao.fazenda.sp.gov.br.evil.example/x', 'nota url']) {
    assert.throws(() => prepareSefazSpPortalPage({ resourceId: 'doc-1', url, bytes: new TextEncoder().encode(page(BODY)) }), SefazSpPreparationError);
  }
});

test('L17 profiles: the portal uses the default-level profile only; DOE-SP overrides and family scopes never apply', () => {
  const base = resolveEffectiveProfile([...DEFAULT_PROFILES], { source: 'SEFAZ-SP-PORTAL' });
  assert.equal(base.target.source, 'SEFAZ-SP-PORTAL'); assert.equal(base.chain.length, 1);
  const withDoe = [...DEFAULT_PROFILES, { profileVersion: PROFILE_FORMAT_VERSION, scope: { level: 'source', source: 'DOE-SP' }, fields: { classes: { historical: ['revogado'] } } }];
  assert.equal(resolveEffectiveProfile(withDoe, { source: 'SEFAZ-SP-PORTAL' }).effectiveHash, base.effectiveHash);
  assert.throws(() => resolveEffectiveProfile([...DEFAULT_PROFILES], { source: 'SEFAZ-SP-PORTAL', family: 'Decreto' }));
  assert.throws(() => resolveEffectiveProfile([...DEFAULT_PROFILES, { profileVersion: PROFILE_FORMAT_VERSION, scope: { level: 'source', source: 'SEFAZ-SP-PORTAL' }, fields: {} }], { source: 'SEFAZ-SP-PORTAL' }),
    'no configurable scope exists for the portal yet');
});
