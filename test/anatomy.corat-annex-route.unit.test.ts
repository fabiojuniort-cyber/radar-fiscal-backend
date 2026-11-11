import assert from 'node:assert/strict';
import test from 'node:test';
import { CORAT_INDEX, coratRoute } from '../ops/anatomy/corat-annex-route.js';

// E9 P2-c, COORD decision D: route guard for the ADE Corat 33/2025 Anexo Único discovery. Offline; nothing is fetched.
test('D1: the initial URL and the allowed prefix agree — index with or without the trailing slash is the same canonical resource', () => {
  assert.deepEqual(coratRoute(CORAT_INDEX), { kind: 'index', href: CORAT_INDEX });
  assert.deepEqual(coratRoute(`${CORAT_INDEX}/`), { kind: 'index', href: CORAT_INDEX });
  assert.deepEqual(coratRoute('https://WWW.GOV.BR/receitafederal/pt-br/assuntos/agenda-tributaria'), { kind: 'index', href: CORAT_INDEX }, 'host case is normalized');
  assert.deepEqual(coratRoute(`${CORAT_INDEX}/2026/janeiro`), { kind: 'child', href: `${CORAT_INDEX}/2026/janeiro` });
  assert.deepEqual(coratRoute(`${CORAT_INDEX}/2026/janeiro/`), { kind: 'child', href: `${CORAT_INDEX}/2026/janeiro` });
});

test('D2: unexpected routes are refused before any request (no generic gov.br access)', () => {
  const bad = [
    'http://www.gov.br/receitafederal/pt-br/assuntos/agenda-tributaria', 'https://gov.br/receitafederal/pt-br/assuntos/agenda-tributaria',
    'https://www.gov.br.evil.example/receitafederal/pt-br/assuntos/agenda-tributaria', 'https://www.gov.br:8443/receitafederal/pt-br/assuntos/agenda-tributaria',
    'https://u:p@www.gov.br/receitafederal/pt-br/assuntos/agenda-tributaria', `${CORAT_INDEX}?ano=2026`, `${CORAT_INDEX}#janeiro`, `${CORAT_INDEX}?`,
    'https://www.gov.br/receitafederal', 'https://www.gov.br/receitafederal/pt-br', 'https://www.gov.br/', 'https://www.gov.br/economia/pt-br/assuntos/agenda-tributaria',
    'https://www.gov.br/receitafederal/pt-br/assuntos/agenda-tributaria-2025', 'https://www.gov.br/receitafederal/pt-br/assuntos/agenda-tributariax/2026',
    `${CORAT_INDEX}/../../../`, `${CORAT_INDEX}/./2026`, `${CORAT_INDEX}/%2e%2e/x`, `${CORAT_INDEX}%2f..%2fx`, `${CORAT_INDEX}/2026%2Fjaneiro`,
    `${CORAT_INDEX}//2026`, `${CORAT_INDEX}/2026\\janeiro`, `${CORAT_INDEX}/2026/Janeiro`, `${CORAT_INDEX}/2026/janeiro/a/b`, `${CORAT_INDEX}/2026/jan eiro`,
    `${CORAT_INDEX}/2026/janeiro.pdf`, 'not a url',
  ];
  for (const u of bad) assert.ok('refused' in coratRoute(u), u);
});

// ---- R2 (independent review c.6784793278, D-1/D-2) + the reviewer's adversarial categories (45 URLs) ----
test('R2 D-1: C0 controls / NUL / DEL in the raw input are refused before URL normalization', () => {
  for (const u of [`${CORAT_INDEX}/a\u0000`, `${CORAT_INDEX}/\u0000a`, `${CORAT_INDEX}/2026\u0009/janeiro`, `${CORAT_INDEX}\u000d\u000a/2026`, `${CORAT_INDEX}/2026\u007f`, `\u0001${CORAT_INDEX}`])
    assert.match((coratRoute(u) as { refused: string }).refused ?? '', /control/u, JSON.stringify(u));
});

test('R2 D-2: non-canonical scheme forms are refused (https:www…, https:/www…, HTTPS://…, https:///…)', () => {
  for (const u of ['https:www.gov.br/receitafederal/pt-br/assuntos/agenda-tributaria', 'https:/www.gov.br/receitafederal/pt-br/assuntos/agenda-tributaria',
    'HTTPS://www.gov.br/receitafederal/pt-br/assuntos/agenda-tributaria', 'https:///www.gov.br/receitafederal/pt-br/assuntos/agenda-tributaria',
    ' https://www.gov.br/receitafederal/pt-br/assuntos/agenda-tributaria'])
    assert.ok('refused' in coratRoute(u), u);
});

test('R2 D: the reviewer\'s 45 adversarial categories stay refused; the two normalizations stay accepted', () => {
  const I = CORAT_INDEX; const P = 'https://www.gov.br/receitafederal/pt-br/assuntos';
  const bad = [
    'https://www.gov.br.evil.com/receitafederal/pt-br/assuntos/agenda-tributaria', 'https://evil.www.gov.br/receitafederal/pt-br/assuntos/agenda-tributaria',
    'https://sub.gov.br/receitafederal/pt-br/assuntos/agenda-tributaria', 'https://gov.br/receitafederal/pt-br/assuntos/agenda-tributaria',
    'https://www.gov.br./receitafederal/pt-br/assuntos/agenda-tributaria', 'https://www.gov.br@evil.com/receitafederal/pt-br/assuntos/agenda-tributaria',
    'https://evil.com@www.gov.br/receitafederal/pt-br/assuntos/agenda-tributaria', 'https://u:p@www.gov.br/receitafederal/pt-br/assuntos/agenda-tributaria',
    'http://www.gov.br/receitafederal/pt-br/assuntos/agenda-tributaria', 'ftp://www.gov.br/receitafederal/pt-br/assuntos/agenda-tributaria',
    `${I}?`, `${I}?a=1`, `${I}/2026?x`, `${I}#`, `${I}#j`, `${I}/2026#j`,
    `${I}/%2e%2e/x`, `${I}/%2E`, `${I}/2026%2fjaneiro`, `${I}%2F2026`, `${I}/2026%5cjaneiro`, `${I}/%252e%252e`, `${I}/.%2e/x`,
    `${I}/../x`, `${I}/./2026`, `${I}/2026/..`, `${I}//2026`, `${I}/2026//janeiro`, `${I}/2026\\janeiro`,
    `${I}/2026/Janeiro`, `${I}/2026/jan_eiro`, `${I}/2026/janeiro.pdf`, `${I}/2026;x`, `${I}/2026/janеiro`, `${I}/%61`,
    `${I}/a/b/c/d`, `${P}/agenda-tributaria-2025`, `${P}/agenda-tributariax`, `${P}/agenda-tributaria.html`, `${P}`,
    'https://www.gov.br/receitafederal', 'https://www.gov.br/', 'https://www.gov.br/economia/pt-br/assuntos/agenda-tributaria',
    `${I}/2026/ janeiro`, 'not a url',
  ];
  assert.equal(bad.length, 45);
  for (const u of bad) assert.ok('refused' in coratRoute(u), u);
  assert.deepEqual(coratRoute('https://WWW.GOV.BR/receitafederal/pt-br/assuntos/agenda-tributaria'), { kind: 'index', href: I });
  assert.deepEqual(coratRoute('https://www.gov.br:443/receitafederal/pt-br/assuntos/agenda-tributaria/2026'), { kind: 'child', href: `${I}/2026` });
});
