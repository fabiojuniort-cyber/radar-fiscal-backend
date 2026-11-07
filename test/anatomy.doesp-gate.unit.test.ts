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
  const r = await consultOfficial(act(`https://${HOST}/v2/publications/${ID}`), OFFICIAL_HOSTS['DOE-SP'], ok.f);
  assert.equal(r.ok, true); if (r.ok) assert.equal(r.meta.representation, 'json');
  for (const u of [`https://${HOST}.evil.example/v2/publications/${ID}`, `http://${HOST}/v2/publications/${ID}`, `https://do-api-publication-pdf.doe.sp.gov.br/v2/publications/${ID}`]) {
    const t = transport(json(pub()));
    const x = await consultOfficial(act(u), OFFICIAL_HOSTS['DOE-SP'], t.f);
    assert.equal(x.ok, false, u); if (!x.ok) assert.equal(x.failure.code, 'host_not_allowed'); assert.equal(t.urls.length, 0, `${u}: no request sent`);
  }
});

test('DOE-SP gate: redirects are validated hop by hop (other host refused before the request; disallowed path refused)', async () => {
  const away = transport(new Response(null, { status: 302, headers: { location: 'https://evil.example/v2/publications/x' } }));
  const a = await consultOfficial(act(`https://${HOST}/v2/publications/${ID}`), OFFICIAL_HOSTS['DOE-SP'], away.f);
  assert.equal(a.ok, false); if (!a.ok) assert.equal(a.failure.code, 'host_not_allowed'); assert.equal(away.urls.length, 1, 'the redirect target was never requested');
  const path = transport(new Response(null, { status: 301, headers: { location: `https://${HOST}/v2/authentication/download/abc` } }));
  const b = await consultOfficial(act(`https://${HOST}/v2/publications/${ID}`), OFFICIAL_HOSTS['DOE-SP'], path.f);
  assert.equal(b.ok, false); assert.equal(path.urls.length, 1);
  const same = transport(new Response(null, { status: 301, headers: { location: `https://${HOST}/v2/publications/${ID}` } }), json(pub()));
  const c = await consultOfficial(act(`https://${HOST}/v2/publications/${ID.toUpperCase()}`), OFFICIAL_HOSTS['DOE-SP'], same.f);
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
    const r = await consultOfficial(act(`https://${HOST}/v2/publications/${ID}`), OFFICIAL_HOSTS['DOE-SP'], t.f);
    assert.equal(r.ok, false, name); if (!r.ok) assert.ok(['invalid_representation', 'content_type'].includes(r.failure.code), `${name}: ${r.failure.code}`);
  }
});
