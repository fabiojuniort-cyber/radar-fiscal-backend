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
