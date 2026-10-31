import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { consultOfficial, type FetchLike, type ManifestAct } from '../ops/anatomy/fetch-official-core.js';
import { bindingIssues } from '../ops/anatomy/official-binding.js';
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

test('R1-4: promotion requires a verified manifest URL, matching snapshot metadata, intact bytes and an exact excerpt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ofc-'));
  const body = '<html><body><p class="TextoAcordo">Cláusula primeira Texto de forma.</p></body></html>';
  const sha = createHash('sha256').update(body).digest('hex');
  writeFileSync(join(dir, 'ofc-x.html'), body);
  writeFileSync(join(dir, 'ofc-x.meta.json'), JSON.stringify({ url: 'https://www.confaz.fazenda.gov.br/a', sha256: sha, verified: true, contentType: 'text/html' }));
  const sample = (over: Partial<SampleInput> = {}, prov: Record<string, unknown> = {}): SampleInput => ({ id: 'ofc-x', documentId: 'ofc-x', version: 'v1', title: 't', source: 'CONFAZ', family: null,
    format: 'html', content: '<p class="TextoAcordo">Cláusula primeira Texto de forma.</p>', covers: ['x'],
    provenance: { kind: 'official', act: 'Convênio ICMS 142/2018', url: 'https://www.confaz.fazenda.gov.br/a', consultedAt: '2026-10-31', version: 'v', reason: 'motivo suficiente', snapshotSha256: sha, ...prov } as SampleInput['provenance'], ...over });
  assert.deepEqual(bindingIssues([sample()], dir, [act()]), []);
  assert.match(bindingIssues([sample({ content: '<p class="TextoAcordo">Cláusula primeira Texto ALTERADO.</p>' })], dir, [act()]).join(), /recorte exato/u, 'edited excerpt');
  assert.match(bindingIssues([sample({}, { snapshotSha256: 'b'.repeat(64) })], dir, [act()]).join(), /SHA-256 difere/u);
  assert.match(bindingIssues([sample()], dir, [act({ urlStatus: 'candidate' })]).join(), /não verificada/u);
  writeFileSync(join(dir, 'ofc-x.html'), body.replace('forma', 'FORMA'));
  assert.match(bindingIssues([sample({ content: '<p' })], dir, [act()]).join(), /adulterado/u, 'tampered snapshot file');
});

test('R1-4: the shipped OFFICIAL_SAMPLES pass the binding check against the committed snapshots', () => {
  const manifest = (JSON.parse(readFileSync(new URL('../ops/anatomy/official-manifest.json', import.meta.url), 'utf8')) as { acts: ManifestAct[] }).acts;
  assert.deepEqual(bindingIssues(OFFICIAL_SAMPLES, new URL('../ops/anatomy/official-snapshots', import.meta.url).pathname, manifest), []);
});
