import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeAnatomy, type AnatomyRequest } from '../src/modules/anatomy/engine.js';
import { simulateTaxonomyConsumer } from '../src/modules/anatomy/consumer.js';
import { sha256 } from '../src/modules/anatomy/contract.js';

function request(html = '<p class="TextoAcordo">Cláusula primeira NCM 0101.21.00</p>'): AnatomyRequest {
  return { publicationVersionId: 'controlled-version', referenceDate: '2026-10-16', ruleSet: { id: 'controlled', version: '1' },
    input: { source: 'CONFAZ', representationId: 'controlled-html', html },
    catalog: { edition: 'controlled-2026', codes: ['01012100', '84501100', '73071920'] } };
}

test('same supplied snapshot and rules reproduce the complete output and hash', () => {
  const first = analyzeAnatomy(request());
  const second = analyzeAnatomy(request());
  assert.deepEqual(second, first);
  assert.equal(first.coverage.accountedLength, first.canonicalText.length);
  assert.equal(first.identity.inputPresentationHash, sha256(request().input.html!));
  assert.equal(first.entities.find(entity => entity.domain === 'NCM')?.normalized, '01012100');
  assert.ok(first.parts.every(part => part.legalStatus === 'unknown'));
  assert.ok(first.eligibility.every(selection => !selection.eligible));
  assert.deepEqual(simulateTaxonomyConsumer(first).ncmOccurrences, []);
});

test('presentation-only, catalog, attachments and rule versions change identity without pretending approval', () => {
  const original = analyzeAnatomy(request());
  const presentation = request(); presentation.input.html += '<!-- representation changed -->';
  const catalog = request(); catalog.catalog!.edition = 'controlled-2027';
  const rules = request(); rules.ruleSet.version = '2';
  const attachments = request(); attachments.attachments = [{ resourceId: 'missing-table', sha256: null, state: 'missing' }];
  for (const changed of [presentation, catalog, rules, attachments]) {
    const result = analyzeAnatomy(changed);
    assert.notEqual(result.analysisId, original.analysisId);
    assert.ok(result.eligibility.every(selection => !selection.eligible));
  }
  assert.equal(analyzeAnatomy(attachments).status, 'partial');
});

test('two synthetic historical 8450.11.00 occurrences remain separate and outside selection', () => {
  const result = analyzeAnatomy(request('<p class="RedaoAnt">Cláusula primeira NCM 8450.11.00</p>'
    + '<p class="RedaoAnt">Cláusula segunda NCM 8450.11.00</p>'));
  const occurrences = result.entities.filter(entity => entity.domain === 'NCM' && entity.normalized === '84501100');
  assert.equal(occurrences.length, 2);
  assert.notEqual(occurrences[0]!.id, occurrences[1]!.id);
  assert.ok(occurrences.every(entity => result.parts.find(part => part.id === entity.partId)?.context === 'historical'));
  assert.deepEqual(simulateTaxonomyConsumer(result).ncmOccurrences, []);
});

test('NCM column gives domain context, generic code or NBM columns do not', () => {
  for (const [header, expected] of [['NCM', true], ['CÓDIGO', false], ['NBM', false]] as const) {
    const result = analyzeAnatomy(request(`<p>ANEXO I</p><table><tr><th>PRODUTO</th><th>${header}</th></tr>`
      + '<tr><td>Mercadoria sintética</td><td>7307.19.20</td></tr></table>'));
    assert.equal(result.entities.some(entity => entity.domain === 'NCM' && entity.normalized === '73071920'), expected);
  }
});

test('unknown source profile and missing content stay explicit, never a complete negative finding', () => {
  const unknown = request(); unknown.input.source = 'RFB'; unknown.input.html = '<p>Corpo desconhecido 😀 &amp; fim.</p>';
  const result = analyzeAnatomy(unknown);
  assert.equal(result.status, 'partial');
  assert.equal(result.coverage.accountedLength, result.canonicalText.length);
  const missing = request(); delete missing.input.html;
  assert.notEqual(analyzeAnatomy(missing).status, 'complete');
});

test('ambiguous representations and untrusted evidence fields are rejected before analysis', () => {
  const both = request(); both.input.text = 'another representation';
  assert.throws(() => analyzeAnatomy(both));
  assert.throws(() => analyzeAnatomy({ ...request(), evidence: [] } as AnatomyRequest));
});
test('single-block ownership prefers the deepest part over an equally sized document root', () => {
  for (const html of ['<p class="Ementa">NCM 0101.21.00</p>',
    '<p class="TextoAcordo">Art. 1º Texto <q>NCM 0101.21.00</q></p>']) {
    const result = analyzeAnatomy(request(html));
    assert.equal(result.entities.filter(entity => entity.domain === 'NCM').length, 0);
  }
  const historical = analyzeAnatomy(request('<div class="RedaoAnt"><p>Art. 1º NCM 0101.21.00</p></div>'));
  const occurrence = historical.entities.find(entity => entity.domain === 'NCM');
  assert.ok(occurrence);
  const owner = historical.parts.find(part => part.id === occurrence.partId)!;
  assert.notEqual(owner.type, 'document');
  assert.equal(owner.context, 'historical');
});
