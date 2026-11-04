import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { consultOfficial, rfbJsonIdAto, validateRfbJson, type FetchLike, type ManifestAct } from '../ops/anatomy/fetch-official-core.js';
import { locateJsonHtmlSpan, prepareRfbRepresentation } from '../src/modules/anatomy/json-preparation.js';
import { readAnatomyInput } from '../src/modules/anatomy/readers.js';
import { bindingIssues } from '../ops/anatomy/official-binding.js';
import { PDF_TEXT_TOOL, pdfText } from '../ops/anatomy/pdf-text.js';
import { buildSyntheticPdf } from './support/synthetic-pdf.js';
import { OFFICIAL_SAMPLES } from '../src/modules/anatomy/config/config.service.js';
import type { SampleInput } from '../src/modules/anatomy/config/sample-inputs.js';

// ANAT-OFFICIAL-01 R1: simulated HTTP only (no network); synthetic bodies, not official text.
const HOSTS = ['www.confaz.fazenda.gov.br'];
const act = (over: Partial<ManifestAct> = {}): ManifestAct => ({ id: 'ofc-x', source: 'CONFAZ', act: 'Convênio ICMS 142/2018', url: 'https://www.confaz.fazenda.gov.br/a', urlStatus: 'verified', reason: 'teste', ...over });
const res = (status: number, headers: Record<string, string> = {}, body = '') => ({ status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer });
const scripted = (...answers: ReturnType<typeof res>[]) => { const calls: string[] = []; const f: FetchLike = async (url) => { calls.push(url); return answers.shift()!; }; return { f, calls }; };

test('R1-2: a redirect to an external host is refused BEFORE requesting it', async () => {
  const { f, calls } = scripted(res(302, { location: 'https://evil.example/copy' }));
  const r = await consultOfficial(act(), HOSTS, f);
  assert.equal(r.ok, false); assert.equal(!r.ok && r.failure.code, 'host_not_allowed');
  assert.deepEqual(calls, ['https://www.confaz.fazenda.gov.br/a'], 'the external URL was never requested');
});

test('R1-2: http downgrade and too many redirects are refused; same-host relative redirects are followed', async () => {
  assert.equal(((await consultOfficial(act(), HOSTS, scripted(res(301, { location: 'http://www.confaz.fazenda.gov.br/a' })).f)) as any).failure.code, 'host_not_allowed');
  const loop = scripted(...Array.from({ length: 7 }, () => res(302, { location: '/a' })));
  assert.equal(((await consultOfficial(act(), HOSTS, loop.f)) as any).failure.code, 'too_many_redirects');
  const ok = await consultOfficial(act(), HOSTS, scripted(res(302, { location: '/b' }), res(200, { 'content-type': 'text/html; charset=utf-8' }, '<p>x</p>')).f);
  assert.ok(ok.ok && ok.meta.finalUrl === 'https://www.confaz.fazenda.gov.br/b' && ok.meta.hops.length === 2);
});

test('R1-3: 404/500 and non-HTML/PDF answers never become snapshots (no body kept)', async () => {
  for (const status of [404, 500]) {
    const r = await consultOfficial(act(), HOSTS, scripted(res(status, { 'content-type': 'text/html' }, '<h1>Erro</h1>')).f);
    assert.ok(!r.ok && r.failure.code === 'http_error' && !('body' in r), `HTTP ${status}`);
  }
  for (const ct of ['application/json', 'text/plain', '']) {
    const r = await consultOfficial(act(), HOSTS, scripted(res(200, ct ? { 'content-type': ct } : {}, '{}')).f);
    assert.ok(!r.ok && r.failure.code === 'content_type', ct || '(none)');
  }
});

test('R1-5: a candidate URL is fetched only as unverified evidence and can never be promoted', async () => {
  const r = await consultOfficial(act({ urlStatus: 'candidate' }), HOSTS, scripted(res(200, { 'content-type': 'text/html' }, '<p>x</p>')).f);
  assert.ok(r.ok && r.meta.verified === false && r.meta.urlStatus === 'candidate');
});

test('R1-4: promotion requires a verified manifest URL, matching snapshot metadata, intact bytes and an exact excerpt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ofc-'));
  const body = '<html><body><p class="TextoAcordo">Cláusula primeira Texto de forma.</p></body></html>';
  const sha = createHash('sha256').update(body).digest('hex');
  writeFileSync(join(dir, 'ofc-x.html'), body);
  writeFileSync(join(dir, 'ofc-x.meta.json'), JSON.stringify({ url: 'https://www.confaz.fazenda.gov.br/a', sha256: sha, verified: true, contentType: 'text/html' }));
  const sample = (over: Partial<SampleInput> = {}, prov: Record<string, unknown> = {}): SampleInput => ({ id: 'ofc-x', documentId: 'ofc-x', version: 'v1', title: 't', source: 'CONFAZ', family: null,
    format: 'html', content: '<p class="TextoAcordo">Cláusula primeira Texto de forma.</p>', covers: ['x'],
    provenance: { kind: 'official', act: 'Convênio ICMS 142/2018', url: 'https://www.confaz.fazenda.gov.br/a', consultedAt: '2026-10-31', version: 'v', reason: 'motivo suficiente', snapshotSha256: sha, ...prov } as SampleInput['provenance'], ...over });
  assert.deepEqual(await bindingIssues([sample()], dir, [act()]), []);
  assert.match((await bindingIssues([sample({ content: '<p class="TextoAcordo">Cláusula primeira Texto ALTERADO.</p>' })], dir, [act()])).join(), /recorte exato/u, 'edited excerpt');
  assert.match((await bindingIssues([sample({}, { snapshotSha256: 'b'.repeat(64) })], dir, [act()])).join(), /SHA-256 difere/u);
  assert.match((await bindingIssues([sample()], dir, [act({ urlStatus: 'candidate' })])).join(), /não verificada/u);
  writeFileSync(join(dir, 'ofc-x.html'), body.replace('forma', 'FORMA'));
  assert.match((await bindingIssues([sample({ content: '<p' })], dir, [act()])).join(), /adulterado/u, 'tampered snapshot file');
});

test('R1-4: the shipped OFFICIAL_SAMPLES pass the binding check against the committed snapshots', async () => {
  const manifest = (JSON.parse(readFileSync(new URL('../ops/anatomy/official-manifest.json', import.meta.url), 'utf8')) as { acts: ManifestAct[] }).acts;
  assert.deepEqual(await bindingIssues(OFFICIAL_SAMPLES, new URL('../ops/anatomy/official-snapshots', import.meta.url).pathname, manifest), []);
});

const bin = (status: number, headers: Record<string, string>, body: Uint8Array) => ({ status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  arrayBuffer: async () => body.slice().buffer as ArrayBuffer });

test('R2-03: a verified URL answering 200 with an invalid body never becomes a verifiable snapshot', async () => {
  const fake = await consultOfficial(act(), HOSTS, scripted(res(200, { 'content-type': 'application/pdf' }, '<html>Página de erro</html>')).f);
  assert.ok(!fake.ok && fake.failure.code === 'invalid_representation' && !('body' in fake), 'HTML error page served as PDF');
  for (const ct of ['application/pdf', 'text/html']) {
    const empty = await consultOfficial(act(), HOSTS, scripted(res(200, { 'content-type': ct }, '')).f);
    assert.ok(!empty.ok && empty.failure.code === 'invalid_representation', `empty ${ct}`);
  }
  const noMarkup = await consultOfficial(act(), HOSTS, scripted(res(200, { 'content-type': 'text/html' }, 'apenas texto')).f);
  assert.ok(!noMarkup.ok && noMarkup.failure.code === 'invalid_representation');
  const pdf = buildSyntheticPdf([[{ text: 'Art. 1º Ação exemplo.', y: 700 }]]);
  const pdfAsHtml = await consultOfficial(act(), HOSTS, scripted(bin(200, { 'content-type': 'text/html' }, pdf)).f);
  assert.ok(!pdfAsHtml.ok && pdfAsHtml.failure.code === 'invalid_representation', 'PDF served as HTML');
  const good = await consultOfficial(act(), HOSTS, scripted(bin(200, { 'content-type': 'application/pdf' }, pdf)).f);
  assert.ok(good.ok && good.meta.verified && good.meta.urlVerified && good.meta.representation === 'pdf');
  const html = await consultOfficial(act(), HOSTS, scripted(res(200, { 'content-type': 'text/html' }, '<p>x</p>')).f);
  assert.ok(html.ok && html.meta.representation === 'html');
  const { f, calls } = scripted(res(302, { location: 'https://evil.example/x' }));
  assert.ok(!(await consultOfficial(act(), HOSTS, f)).ok && calls.length === 1, 'redirect protection preserved');
});

test('R2-04: a PDF sample binds through traceable extraction, never through UTF-8 decoding of the PDF bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ofc-pdf-'));
  const pdf = buildSyntheticPdf([[{ text: 'CONVÊNIO EXEMPLO', y: 760 }, { text: 'Art. 1º Ação exemplo.', y: 700 }]]);
  const sha = createHash('sha256').update(pdf).digest('hex');
  const text = await pdfText(pdf);
  const textSha = createHash('sha256').update(text, 'utf8').digest('hex');
  writeFileSync(join(dir, 'ofc-x.pdf'), pdf);
  const meta = (over: Record<string, unknown> = {}) => writeFileSync(join(dir, 'ofc-x.meta.json'), JSON.stringify({ url: 'https://www.confaz.fazenda.gov.br/a', sha256: sha, verified: true, contentType: 'application/pdf', extraction: { tool: PDF_TEXT_TOOL, textSha256: textSha }, ...over }));
  const sample = (content: string, prov: Record<string, unknown> = {}): SampleInput => ({ id: 'ofc-x', documentId: 'ofc-x', version: 'v1', title: 't', source: 'CONFAZ', family: null, format: 'text', content, covers: ['x'],
    provenance: { kind: 'official', act: 'Convênio ICMS 142/2018', url: 'https://www.confaz.fazenda.gov.br/a', consultedAt: '2026-11-04', version: 'v', reason: 'motivo suficiente', snapshotSha256: sha, ...prov } as SampleInput['provenance'] });
  meta();
  assert.ok(!pdf.toString().includes('Ação') && !Buffer.from(pdf).toString('utf8').includes('Art. 1º Ação exemplo.'), 'the PDF bytes are not the text in UTF-8');
  assert.deepEqual(await bindingIssues([sample('Art. 1º Ação exemplo.')], dir, [act()]), [], 'accented excerpt accepted via extraction');
  assert.match((await bindingIssues([sample('Art. 1º Ação ALTERADA.')], dir, [act()])).join(), /texto extraído do PDF/u, 'edited text refused');
  assert.match((await bindingIssues([sample('Art. 1º Ação exemplo.', { snapshotSha256: 'c'.repeat(64) })], dir, [act()])).join(), /SHA-256 difere/u, 'binary hash still binds');
  meta({ extraction: { tool: PDF_TEXT_TOOL, textSha256: 'd'.repeat(64) } });
  assert.match((await bindingIssues([sample('Art. 1º Ação exemplo.')], dir, [act()])).join(), /não confere com textSha256/u, 'tampered text hash refused');
  meta({ extraction: undefined });
  assert.match((await bindingIssues([sample('Art. 1º Ação exemplo.')], dir, [act()])).join(), /sem extração rastreável/u);
  meta();
  writeFileSync(join(dir, 'ofc-x.pdf'), buildSyntheticPdf([[{ text: 'Art. 1º Outra ação.', y: 700 }]]));
  assert.match((await bindingIssues([sample('Art. 1º Ação exemplo.')], dir, [act()])).join(), /adulterado/u, 'tampered PDF refused');
});

// ANAT-D03 — RFB structured JSON. Synthetic payloads shaped like the portal; never official text.
const RFB_HOSTS = ['normasinternet2.receita.fazenda.gov.br'];
const RFB_URL = 'https://normasinternet2.receita.fazenda.gov.br/api/consulta-externa/ato/900001/visao/multivigente';
const rfbAct = (over: Partial<ManifestAct> = {}): ManifestAct => act({ id: 'ofc-rfb-x', source: 'RFB', act: 'Instrução Normativa RFB 9.999/2099', url: RFB_URL, ...over });
const rfbJson = (over: Record<string, unknown> = {}) => JSON.stringify({ idAto: 900001, epigrafeCompleta: 'Instrução Normativa RFB nº 9999, de 1 de janeiro de 2099',
  epigrafe: { numeroAto: '9999', dataAto: '2099-01-01' }, dataPublicacao: '2099-01-02', dadosPublicacao: 'Publicado(a) no DOU de 02/01/2099, seção 1, página 1',
  visao: 'multivigente', vigente: true,
  ementas: [{ ordemSegmentoAto: 1, textoIntegra: '<p>Dispõe sobre o exemplo sintético.</p>' }],
  outrosSegmentos: [{ ordemSegmentoAto: 2, textoIntegra: '<p>Art. 1º Fica instituída a ação exemplo.</p>' }, { ordemSegmentoAto: 3, textoIntegra: '<p>Art. 2º Vigência na publicação.</p>' }], ...over });
const jres = (body: string, ct = 'application/json') => res(200, { 'content-type': ct }, body);

test('D03: a valid RFB JSON becomes a json snapshot with identification and preparation (traceable)', async () => {
  const r = await consultOfficial(rfbAct(), RFB_HOSTS, scripted(jres(rfbJson())).f);
  assert.ok(r.ok, JSON.stringify(!r.ok && r.failure));
  assert.equal(r.meta.representation, 'json');
  assert.equal(r.meta.sha256, createHash('sha256').update(r.body).digest('hex'));
  assert.deepEqual({ ...r.meta.identification }, { idAto: 900001, epigrafe: 'Instrução Normativa RFB nº 9999, de 1 de janeiro de 2099', numeroAto: '9999', dataAto: '2099-01-01',
    dataPublicacao: '2099-01-02', dadosPublicacao: 'Publicado(a) no DOU de 02/01/2099, seção 1, página 1', visao: 'multivigente', portalDeclaresVigente: true });
  assert.equal(r.meta.preparation!.pieces, 3);
  assert.deepEqual(r.meta.preparation!.excluded, ['/epigrafeCompleta'], 'metadata exclusion declared');
  // JSON pointer ↔ prepared text ↔ anatomy
  const prep = prepareRfbRepresentation({ resourceId: 'x', bytes: new Uint8Array(r.body) }, 900001);
  assert.equal(prep.htmlSha256, r.meta.preparation!.htmlSha256);
  const an = readAnatomyInput({ source: 'RFB', representationId: 'x', html: prep.html });
  const art1 = an.parts.find((p) => p.type === 'article' && an.canonicalText.slice(p.span.start).startsWith('Art. 1º'))!;
  const ptr = art1.sourcePointers[0]!; assert.ok(ptr.sourceSpan, 'html source span');
  assert.equal(locateJsonHtmlSpan(prep, ptr.sourceSpan!)!.pointer, '/outrosSegmentos/0/textoIntegra');
});

test('D03 (R2-03 equivalents): error payloads, empty, non-JSON, wrong act and incompatible structure never become snapshots', async () => {
  const cases: [string, string][] = [
    ['erro', JSON.stringify({ status: 500, mensagem: 'Erro interno' })],
    ['vazio', ''],
    ['html com MIME json', '<html>Página de erro</html>'],
    ['array', '[]'],
    ['ato errado', rfbJson({ idAto: 900002 })],
    ['sem segmentos', rfbJson({ ementas: [], outrosSegmentos: [] })],
    ['segmentos sem texto', rfbJson({ ementas: [{ ordemSegmentoAto: 1, textoIntegra: ' ' }], outrosSegmentos: [] })],
    ['ordem duplicada', rfbJson({ ementas: [{ ordemSegmentoAto: 1, textoIntegra: '<p>a</p>' }], outrosSegmentos: [{ ordemSegmentoAto: 1, textoIntegra: '<p>b</p>' }] })],
  ];
  for (const [label, body] of cases) {
    const r = await consultOfficial(rfbAct(), RFB_HOSTS, scripted(jres(body)).f);
    assert.ok(!r.ok && r.failure.code === 'invalid_representation' && !('body' in r), label);
  }
  // application/json outside the RFB JSON endpoint is still refused by type.
  const other = await consultOfficial(act({ url: 'https://www.confaz.fazenda.gov.br/a.json' }), HOSTS, scripted(jres(rfbJson())).f);
  assert.ok(!other.ok && other.failure.code === 'content_type');
  const wrongPath = await consultOfficial(rfbAct({ url: 'https://normasinternet2.receita.fazenda.gov.br/api/ato/900001' }), RFB_HOSTS, scripted(jres(rfbJson())).f);
  assert.ok(!wrongPath.ok && wrongPath.failure.code === 'content_type');
  const { f, calls } = scripted(res(302, { location: 'https://evil.example/x' }));
  assert.ok(!(await consultOfficial(rfbAct(), RFB_HOSTS, f)).ok && calls.length === 1, 'redirect protection preserved');
});

test('D03: binding of an RFB JSON sample goes through the prepared text, never the raw bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ofc-json-'));
  const r = await consultOfficial(rfbAct(), RFB_HOSTS, scripted(jres(rfbJson())).f);
  assert.ok(r.ok);
  writeFileSync(join(dir, 'ofc-rfb-x.json'), r.body);
  const writeMeta = (over: Record<string, unknown> = {}) => writeFileSync(join(dir, 'ofc-rfb-x.meta.json'), JSON.stringify({ ...r.meta, ...over }));
  writeMeta();
  const sample = (content: string): SampleInput => ({ id: 'ofc-rfb-x', documentId: 'ofc-rfb-x', version: 'v1', title: 't', source: 'RFB', family: null, format: 'html', content, covers: ['x'],
    provenance: { kind: 'official', act: 'Instrução Normativa RFB 9.999/2099', url: RFB_URL, consultedAt: '2026-11-04', version: 'multivigente', reason: 'motivo suficiente', snapshotSha256: r.meta.sha256 } as SampleInput['provenance'] });
  const ok = '<p>Art. 1º Fica instituída a ação exemplo.</p>';
  assert.deepEqual(await bindingIssues([sample(ok)], dir, [rfbAct()]), []);
  assert.match((await bindingIssues([sample('<p>Art. 1º Texto ALTERADO.</p>')], dir, [rfbAct()])).join(), /texto preparado do JSON/u);
  writeMeta({ preparation: { ...r.meta.preparation, htmlSha256: 'e'.repeat(64) } });
  assert.match((await bindingIssues([sample(ok)], dir, [rfbAct()])).join(), /não confere com preparation\.htmlSha256/u);
  writeMeta({ preparation: undefined });
  assert.match((await bindingIssues([sample(ok)], dir, [rfbAct()])).join(), /sem identificação\/preparação/u);
  writeMeta();
  writeFileSync(join(dir, 'ofc-rfb-x.json'), rfbJson({ visao: 'outra' }));
  assert.match((await bindingIssues([sample(ok)], dir, [rfbAct()])).join(), /adulterado/u);
});

test('D03: the four collected RFB JSON snapshots validate, match their recorded hashes and stay not promoted', () => {
  const dir = new URL('../ops/anatomy/official-identification/rfb-normasinternet2/', import.meta.url).pathname;
  for (const id of [115131, 141910, 108391, 133898]) {
    const body = readFileSync(join(dir, `${id}.json`));
    const meta = JSON.parse(readFileSync(join(dir, `${id}.meta.json`), 'utf8')) as { sha256: string; bytes: number; promoted: boolean; url: string };
    assert.equal(createHash('sha256').update(body).digest('hex'), meta.sha256, `${id} hash`);
    assert.equal(body.length, meta.bytes);
    assert.equal(meta.promoted, false);
    assert.equal(rfbJsonIdAto(new URL(meta.url), ['normasinternet2.receita.fazenda.gov.br']), id);
    const v = validateRfbJson(body, id);
    assert.ok(!('problem' in v), `${id}: ${'problem' in v ? v.problem : ''}`);
  }
});

test('D03: struck-through (tachado) segments are recorded and a sample drawing on them is refused', async () => {
  const body = rfbJson({ outrosSegmentos: [{ ordemSegmentoAto: 2, textoIntegra: '<p>Art. 1º Redação vigente.</p>' }, { ordemSegmentoAto: 3, tachado: true, textoIntegra: '<p>Art. 2º Redação superada.</p>' }] });
  const r = await consultOfficial(rfbAct(), RFB_HOSTS, scripted(jres(body)).f);
  assert.ok(r.ok);
  assert.deepEqual(r.meta.preparation!.struckSegments, [{ pointer: '/outrosSegmentos/1', order: 3, chars: '<p>Art. 2º Redação superada.</p>'.length }]);
  const dir = mkdtempSync(join(tmpdir(), 'ofc-tach-'));
  writeFileSync(join(dir, 'ofc-rfb-x.json'), r.body); writeFileSync(join(dir, 'ofc-rfb-x.meta.json'), JSON.stringify(r.meta));
  const sample = (content: string): SampleInput => ({ id: 'ofc-rfb-x', documentId: 'ofc-rfb-x', version: 'v1', title: 't', source: 'RFB', family: null, format: 'html', content, covers: ['x'],
    provenance: { kind: 'official', act: 'Instrução Normativa RFB 9.999/2099', url: RFB_URL, consultedAt: '2026-11-04', version: 'multivigente', reason: 'motivo suficiente', snapshotSha256: r.meta.sha256 } as SampleInput['provenance'] });
  assert.deepEqual(await bindingIssues([sample('<p>Art. 1º Redação vigente.</p>')], dir, [rfbAct()]), []);
  assert.match((await bindingIssues([sample('<p>Art. 2º Redação superada.</p>')], dir, [rfbAct()])).join(), /segmento tachado/u);
});
