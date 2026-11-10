import assert from 'node:assert/strict';
import test from 'node:test';
import { OFFICIAL_API_ENDPOINTS, OFFICIAL_HOSTS, officialApiEndpoint } from '../src/modules/anatomy/config/official-provenance.js';
import { consultOfficial, type FetchLike } from '../ops/anatomy/fetch-official-core.js';

// P2-d gate (#116 c.6708512598 §5): the DOE-SP search API is admitted EXACTLY. Simulated transport only — no request.
const HOST = 'do-api-web-search.doe.sp.gov.br';
const ID = '0b9b4578-91be-4da4-aaa8-803f9651765c';
const pub = (id = ID) => JSON.stringify({ id, title: 'DECRETO Nº 1, DE 1º DE JANEIRO DE 2025', slug: 'decreto-1', date: '2025-01-01', journal: 'Executivo', content: '<p>Artigo 1º Texto.</p>' });
const json = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
const act = (url: string) => ({ id: 'x', source: 'DOE-SP', act: 'teste', url, urlStatus: 'candidate' as const, reason: 'gate test' });
const transport = (...responses: Response[]) => { const urls: string[] = []; const f: FetchLike = async (url) => { urls.push(url); return responses.shift() as never; }; return { f, urls }; };

test('DOE-SP gate: exact host only; OFFICIAL_HOSTS (HTML/PDF hosts) unchanged; no PDF API', () => {
  assert.equal(OFFICIAL_API_ENDPOINTS['DOE-SP'].host, HOST);
  assert.deepEqual(OFFICIAL_HOSTS['DOE-SP'], ['legislacao.fazenda.sp.gov.br', 'www.doe.sp.gov.br'], 'the API host is not an HTML/PDF host');
  assert.ok(officialApiEndpoint(new URL(`https://${HOST}/v2/publications/${ID}`)));
  for (const u of [`https://${HOST}.evil.example/v2/publications/${ID}`, `https://evil-${HOST}/v2/publications/${ID}`, `https://x.${HOST}/v2/publications/${ID}`,
    `https://do-api-publication-pdf.doe.sp.gov.br/v2/publications/${ID}`, `https://doe.sp.gov.br/v2/publications/${ID}`, `http://${HOST}/v2/publications/${ID}`,
    `https://${HOST}:8443/v2/publications/${ID}`, `https://user:pw@${HOST}/v2/publications/${ID}`,
    `https://${HOST}/v2/publications/attachment/downloadattachment/${ID}`, `https://${HOST}/v2/authentication/download/abc`, `https://${HOST}/v2/publications/not-a-guid`, `https://${HOST}/v3/journals`])
    assert.equal(officialApiEndpoint(new URL(u)), null, u);
});

test('DOE-SP gate: a publication with the URL identity is accepted as JSON; misleading hosts and schemes are refused BEFORE any request', async () => {
  const ok = transport(json(pub()));
  const r = await consultOfficial(act(`https://${HOST}/v2/publications/${ID}`), OFFICIAL_HOSTS['DOE-SP'], ok.f, undefined, ['DOE-SP']);
  assert.equal(r.ok, true); if (r.ok) assert.equal(r.meta.representation, 'json');
  for (const u of [`https://${HOST}.evil.example/v2/publications/${ID}`, `http://${HOST}/v2/publications/${ID}`, `https://do-api-publication-pdf.doe.sp.gov.br/v2/publications/${ID}`]) {
    const t = transport(json(pub()));
    const x = await consultOfficial(act(u), OFFICIAL_HOSTS['DOE-SP'], t.f, undefined, ['DOE-SP']);
    assert.equal(x.ok, false, u); if (!x.ok) assert.equal(x.failure.code, 'host_not_allowed'); assert.equal(t.urls.length, 0, `${u}: no request sent`);
  }
});

test('DOE-SP gate: redirects are validated hop by hop (other host refused before the request; disallowed path refused)', async () => {
  const away = transport(new Response(null, { status: 302, headers: { location: 'https://evil.example/v2/publications/x' } }));
  const a = await consultOfficial(act(`https://${HOST}/v2/publications/${ID}`), OFFICIAL_HOSTS['DOE-SP'], away.f, undefined, ['DOE-SP']);
  assert.equal(a.ok, false); if (!a.ok) assert.equal(a.failure.code, 'host_not_allowed'); assert.equal(away.urls.length, 1, 'the redirect target was never requested');
  const path = transport(new Response(null, { status: 301, headers: { location: `https://${HOST}/v2/authentication/download/abc` } }));
  const b = await consultOfficial(act(`https://${HOST}/v2/publications/${ID}`), OFFICIAL_HOSTS['DOE-SP'], path.f, undefined, ['DOE-SP']);
  assert.equal(b.ok, false); assert.equal(path.urls.length, 1);
  const same = transport(new Response(null, { status: 301, headers: { location: `https://${HOST}/v2/publications/${ID}` } }), json(pub()));
  const c = await consultOfficial(act(`https://${HOST}/v2/publications/${ID.toUpperCase()}`), OFFICIAL_HOSTS['DOE-SP'], same.f, undefined, ['DOE-SP']);
  assert.equal(c.ok, true); assert.equal(same.urls.length, 2);
});

test('DOE-SP gate: response of another identity, error payload, non-JSON or incomplete publication is refused', async () => {
  const cases: [string, Response][] = [
    ['other identity', json(pub('11111111-2222-3333-4444-555555555555'))],
    ['error payload', json(JSON.stringify({ status: 404, error: 'Not Found' }))],
    ['html on the API', new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['not JSON', json('{oops')],
    ['incomplete', json(JSON.stringify({ id: ID, title: 'x' }))],
  ];
  for (const [name, res] of cases) {
    const t = transport(res);
    const r = await consultOfficial(act(`https://${HOST}/v2/publications/${ID}`), OFFICIAL_HOSTS['DOE-SP'], t.f, undefined, ['DOE-SP']);
    assert.equal(r.ok, false, name); if (!r.ok) assert.ok(['invalid_representation', 'content_type'].includes(r.failure.code), `${name}: ${r.failure.code}`);
  }
});

// R3 of #304 (c.6709334482): API admission bound to the manifest source and the caller's authorization; identity pinned on redirects.
const RFB = { id: 'r', source: 'RFB', act: 'teste', urlStatus: 'candidate' as const, reason: 'gate test' };
test('R3: the API is admitted only for a DOE-SP act AND with the caller authorization; discovery endpoints are never an act capture', async () => {
  for (const [name, a, auth] of [
    ['RFB manifest + RFB hosts on DOE-SP /v2/journals (reviewer case)', { ...RFB, url: `https://${HOST}/v2/journals` }, ['DOE-SP']],
    ['RFB manifest on a DOE-SP publication', { ...RFB, url: `https://${HOST}/v2/publications/${ID}` }, ['DOE-SP']],
    ['DOE-SP act without caller authorization', act(`https://${HOST}/v2/publications/${ID}`), []],
    ['DOE-SP listing as act capture', act(`https://${HOST}/v2/journals`), ['DOE-SP']],
    ['DOE-SP summary as act capture', act(`https://${HOST}/v2/summary/list`), ['DOE-SP']],
  ] as const) {
    const t = transport(json('[]'), json(pub()));
    const r = await consultOfficial(a as never, a.source === 'RFB' ? OFFICIAL_HOSTS.RFB : OFFICIAL_HOSTS['DOE-SP'], t.f, undefined, auth as never);
    assert.equal(r.ok, false, name); if (!r.ok) assert.equal(r.failure.code, 'host_not_allowed', name); assert.equal(t.urls.length, 0, `${name}: no request sent`);
  }
});

test('R3: a redirect cannot turn a publication into a listing, another id or a page host; the same canonical identity is accepted', async () => {
  const OTHER = '11111111-2222-3333-4444-555555555555';
  for (const [name, location] of [['publication → /v2/journals (reviewer case)', `https://${HOST}/v2/journals`], ['publication → summary', `https://${HOST}/v2/summary/list`],
    ['publication → other UUID', `https://${HOST}/v2/publications/${OTHER}`], ['publication → page host', 'https://www.doe.sp.gov.br/x']] as const) {
    const t = transport(new Response(null, { status: 302, headers: { location } }), json('[]'), json(pub(OTHER)));
    const r = await consultOfficial(act(`https://${HOST}/v2/publications/${ID}`), OFFICIAL_HOSTS['DOE-SP'], t.f, undefined, ['DOE-SP']);
    assert.equal(r.ok, false, name); if (!r.ok) assert.equal(r.failure.code, 'host_not_allowed', name); assert.equal(t.urls.length, 1, `${name}: the target was never requested`);
  }
  const page = transport(new Response(null, { status: 302, headers: { location: `https://${HOST}/v2/publications/${ID}` } }), json(pub()));
  const p = await consultOfficial(act('https://www.doe.sp.gov.br/x'), OFFICIAL_HOSTS['DOE-SP'], page.f, undefined, ['DOE-SP']);
  assert.equal(p.ok, false, 'a page cannot redirect into the API'); assert.equal(page.urls.length, 1);
  const canon = transport(new Response(null, { status: 301, headers: { location: `https://${HOST}/v2/publications/${ID}` } }), json(pub()));
  const c = await consultOfficial(act(`https://${HOST}/v2/publications/${ID.toUpperCase()}`), OFFICIAL_HOSTS['DOE-SP'], canon.f, undefined, ['DOE-SP']);
  assert.equal(c.ok, true, 'same identity, canonical URL'); assert.equal(canon.urls.length, 2);
});
