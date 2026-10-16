import assert from 'node:assert/strict';
import test from 'node:test';
import { entitySchema, type AnatomyPart } from '../src/modules/anatomy/contract.js';
import { extractAnatomyEntities } from '../src/modules/anatomy/entities.js';

function part(text: string, extra: Partial<AnatomyPart> = {}): AnatomyPart {
  return { id: 'body', parentId: null, order: 0, type: 'body', label: '', span: { start: 0, end: text.length },
    sourcePointers: [{ resourceId: 'fixture', representation: 'text', locator: '/', sourceSpan: null }],
    recognition: 'explicit', ruleId: 'fixture', confidence: 1, coverage: 'complete', context: 'operative_candidate',
    contextReasons: [], legalStatus: 'unknown', table: null, ...extra };
}
const run = (text: string, inCell = false) => extractAnatomyEntities({ canonicalText: text, parts: [part(text)], ...(inCell ? { ncmPartIds: ['body'] } : {}) });

test('range relations never cross part boundaries or a later line in a chained expression', () => {
  const text = '0101 a 0102';
  const entries = extractAnatomyEntities({ canonicalText: text,
    parts: [part(text), part(text, { id: 'first', parentId: 'body', span: { start: 0, end: 4 } }),
      part(text, { id: 'second', parentId: 'body', span: { start: 7, end: 11 } })], ncmPartIds: ['first', 'second'] });
  assert.equal(entries.filter(entity => entity.domain === 'NCM_RANGE').length, 0);
  const chained = run('0101 a 0102 a\n0103', true);
  const range = chained.find(entity => entity.domain === 'NCM_RANGE');
  assert.equal(range?.relation?.targetEntityIds.length, 2);
  assert.equal(chained.find(entity => entity.normalized === '0103')?.relation, null);
});
test('explicit citations need no href and remain unresolved, preserving literals', () => {
  const text = 'Lei nº 8.433; Convênio ICMS 52/91; IN RFB 1234/2026; Portaria RFB nº 345.';
  const entities = run(text, true);
  assert.equal(entities.filter((entity) => entity.domain === 'CITATION').length, 4);
  assert.equal(entities.filter((entity) => entity.domain === 'NCM').length, 0);
  assert.ok(entities.every((entity) => entity.validation.status === 'unknown' && entity.literal === text.slice(entity.span.start, entity.span.end)));
});
test('formal citation abbreviations and act families preserve their complete literal without links', () => {
  const literals = ['LC 214/2025', 'Conv. ICMS 89/09', 'Conv. 52/91', 'Res. Senado 48/2007',
    'SC Cosit 252/2025', 'AD 1/24', 'Ato COTEPE 17/97', 'IN 2.058/2021'];
  const entities = run(literals.join('; '), true);
  assert.deepEqual(entities.map((entity) => entity.literal), literals);
  assert.ok(entities.every((entity) => entity.domain === 'CITATION' && entity.validation.status === 'unknown'));
});
test('citation number prefixes n.º, n°, nº and optional agency do not expose numeric false NCMs', () => {
  const literals = ['Lei n.º 8.433', 'LC n° 214/2025', 'IN RFB nº 2.058/2021',
    'Conv. ICMS n.º 89/09', 'SC Cosit n° 252/2025', 'AD nº 1/24', 'Ato COTEPE/ICMS n.º 17/97'];
  const entities = run(literals.join('; '), true);
  assert.deepEqual(entities.map((entity) => entity.literal), literals);
  assert.equal(entities.filter((entity) => entity.domain === 'NCM').length, 0);
});
test('device identifiers remain protected and ordinary dotted numbers are not inferred as citations', () => {
  const entities = run('art. 8433; artigo 1234; § 2345; cláusula 3456; inciso 4567; NCM 0101.21.00', true);
  assert.equal(entities.filter((entity) => entity.domain === 'NCM').length, 1);
  assert.equal(entities.filter((entity) => entity.domain === 'CITATION').length, 0);
  assert.equal(entities.filter((entity) => entity.validation.reason === 'legal_device_identifier_not_ncm').length, 5);
});
test('protected domains take precedence over an NCM column or nearby NCM marker', () => {
  const text = 'NCM: Lei 8433; CNPJ 12.345.678/0001-90; CEP 12345678; processo SEI 12345.678901/2026-10; '
    + '16/10/2026; 2026-10-16; 16 de outubro de 2026; CNAE 0111-3/01; CFOP 5102; CST 0101; '
    + 'cClassTrib 123456; CEST 12.345.67; NBM 8417.8020; SH 0101.21; TIPI 0101.21.00; DARF 1234; SUS 12345678.';
  const entities = run(text, true);
  assert.equal(entities.filter((entity) => entity.domain === 'NCM').length, 0);
  for (const domain of ['CITATION', 'CNPJ', 'CEP', 'PROCESS', 'DATE', 'CNAE', 'CFOP', 'CST', 'CCLASSTRIB', 'CEST', 'NBM', 'SH', 'TIPI', 'REVENUE_CODE', 'OTHER']) {
    assert.ok(entities.some((entity) => entity.domain === domain), domain);
  }
});
test('NCM accepts 2 informative and 4–8 exact digits, legacy punctuation, without padding', () => {
  const entities = run('NCM: 01, 0101, 01012, 010121, 0101210, 01012100, 8417.8020, 0101.21.00.');
  assert.deepEqual(entities.map((entity) => entity.normalized), ['01', '0101', '01012', '010121', '0101210', '01012100', '84178020', '01012100']);
  assert.equal(entities[0]!.validation.status, 'informative');
  assert.ok(entities.every((entity) => entitySchema.safeParse(entity).success));
  assert.equal(run('123 123456789 0.1.0.1', true).length, 0);
});
test('numeric NCM context stops before unrelated prose and never infers unmarked codes', () => {
  assert.deepEqual(run('NCM 0101.21.00 e 0202.30.00. Ano 2026.').map((entity) => entity.normalized), ['01012100', '02023000']);
  assert.equal(run('Motor 84178020 custa 1234; ano 2026.').length, 0);
  assert.deepEqual(run('NCM/SH: 0101.21.00').map((entity) => entity.normalized), ['01012100']);
});
test('exact controlled catalog validates occurrences without prefix equivalence', () => {
  const text = 'NCM 0101 e 0101.21.00';
  const entities = extractAnatomyEntities({ canonicalText: text, parts: [part(text)], catalog: { edition: 'fixture-2026', codes: ['01012100'] } });
  assert.deepEqual(entities.map((entity) => entity.validation.status), ['invalid', 'valid']);
  assert.ok(entities.every((entity) => entity.validation.catalogEdition === 'fixture-2026'));
});
test('M01 range is compound, endpoints linked, never expanded from a shared prefix', () => {
  const entities = run('NCM 0101.21.00 a 0101.29.00');
  const range = entities.find((entity) => entity.domain === 'NCM_RANGE')!;
  assert.equal(range.normalized, '01012100..01012900');
  assert.deepEqual(range.relation!.expansion, []);
  assert.deepEqual(entities.filter((entity) => entity.domain === 'NCM').map((entity) => entity.relation!.kind), ['range_start', 'range_end']);
  assert.equal(run('NCM 01012100 a 0101').find((entity) => entity.domain === 'NCM_RANGE')!.validation.status, 'invalid');
  assert.equal(run('NCM 99999999 até 00000000').find((entity) => entity.domain === 'NCM_RANGE')!.validation.status, 'invalid');
});
test('M02 exception scopes every explicit list member and preserves thematic literal', () => {
  const text = 'NCM 0101, exceto 0101.21.00 e 0101.29.00; benefício temático.';
  const entities = run(text);
  const exception = entities.find((entity) => entity.domain === 'NCM_EXCEPTION')!;
  assert.equal(exception.literal, 'exceto 0101.21.00 e 0101.29.00');
  assert.equal(exception.relation!.targetEntityIds.length, 3);
  assert.equal(entities.find((entity) => entity.normalized === '0101')!.relation!.kind, 'exception_target');
  assert.ok(entities.filter((entity) => entity.domain === 'NCM' && entity.normalized.length === 8).every((entity) => entity.relation?.kind === 'exception_target'));
  assert.equal(run('NCM 0101; exceto as mercadorias destinadas ao uso pessoal.').find((entity) => entity.domain === 'NCM')!.relation!.kind, 'exception_target');
});
test('an exception around a range preserves both restrictions', () => {
  const entities = run('NCM 0101, exceto 0101.21.00 a 0101.29.00');
  assert.equal(entities.filter((entity) => entity.domain === 'NCM_RANGE').length, 1);
  assert.equal(entities.find((entity) => entity.domain === 'NCM_EXCEPTION')!.relation!.targetEntityIds.length, 3);
  assert.ok(entities.filter((entity) => entity.domain === 'NCM' && entity.normalized.length === 8).every((entity) => entity.relation !== null));
});
test('ambiguous chained ranges and prose exception scopes cannot release standalone endpoints', () => {
  const chain = run('NCM 0101 a 0202 a 0303');
  assert.equal(chain.find((entity) => entity.domain === 'NCM_RANGE')!.validation.status, 'invalid');
  assert.ok(chain.filter((entity) => entity.domain === 'NCM').every((entity) => entity.relation !== null));
  const prose = run('exceto produtos destinados ao uso 01012100', true);
  assert.equal(prose.find((entity) => entity.domain === 'NCM_EXCEPTION')!.validation.reason, 'M02_unknown_scope_conservative_mask');
  assert.ok(prose.filter((entity) => entity.domain === 'NCM').every((entity) => entity.relation !== null));
});
test('all excluded inflections mask both the base prefix and excluded targets', () => {
  for (const operator of ['excluído', 'excluídos', 'excluída', 'excluídas']) {
    const entities = run(`NCM 0101, ${operator} 0101.21.00 e 0101.29.00`);
    assert.equal(entities.find((entity) => entity.domain === 'NCM_EXCEPTION')!.relation!.operator, operator);
    assert.ok(entities.filter((entity) => entity.domain === 'NCM').every((entity) => entity.relation !== null));
  }
  const prose = run('NCM 0101 exceto produtos destinados ao uso pessoal.');
  assert.equal(prose.find((entity) => entity.domain === 'NCM')!.relation!.kind, 'exception_target');
  assert.equal(prose.find((entity) => entity.domain === 'NCM_EXCEPTION')!.validation.reason, 'M02_unknown_scope_conservative_mask');
});
test('sentence punctuation closes lexical NCM context without confusing internal code dots', () => {
  assert.deepEqual(run('NCM 0101.21.00. 2026').filter((entity) => entity.domain === 'NCM').map((entity) => entity.normalized), ['01012100']);
  assert.deepEqual(run('NCM 8417.8020. 2026').filter((entity) => entity.domain === 'NCM').map((entity) => entity.normalized), ['84178020']);
  assert.equal(run('NCM 0101.21.00.2026').filter((entity) => entity.domain === 'NCM').length, 0);
});
test('forbidden structural zones emit zero NCM entities, including misleading NCM column input', () => {
  const text = 'NCM 8450.11.00; Lei 8433';
  for (const type of ['epigraph', 'summary', 'preamble', 'signature', 'footer', 'publication_header', 'consideration', 'editorial_note', 'unidentified'] as const) {
    const entities = extractAnatomyEntities({ canonicalText: text, parts: [part(text, { type })], ncmPartIds: ['body'] });
    assert.equal(entities.filter((entity) => entity.domain === 'NCM').length, 0, type);
    assert.equal(entities.filter((entity) => entity.domain === 'CITATION').length, 1, type);
  }
  for (const context of ['unknown', 'prohibited'] as const) {
    assert.equal(extractAnatomyEntities({ canonicalText: text, parts: [part(text, { context })], ncmPartIds: ['body'] }).filter((entity) => entity.domain === 'NCM').length, 0);
  }
});
test('forbidden ancestors suppress NCM while historical body occurrences remain distinct', () => {
  const text = 'NCM 8450.11.00 e 8450.11.00';
  const ancestor = part(text, { id: 'parent', type: 'summary' });
  const child = part(text, { parentId: 'parent' });
  assert.equal(extractAnatomyEntities({ canonicalText: text, parts: [ancestor, child] }).filter((entity) => entity.domain === 'NCM').length, 0);
  const history = extractAnatomyEntities({ canonicalText: text, parts: [part(text, { context: 'historical', legalStatus: 'repealed' })] });
  assert.equal(history.filter((entity) => entity.domain === 'NCM').length, 2);
  assert.notEqual(history[0]!.id, history[1]!.id);
});
test('UTF-16 spans preserve combining accents and emoji, and historical occurrence is only recognized', () => {
  const text = 'e\u0301 😀 NCM 8450.11.00';
  const p = part(text, { context: 'historical', legalStatus: 'repealed' });
  const entities = extractAnatomyEntities({ canonicalText: text, parts: [p] });
  assert.equal(entities[0]!.span.start, text.indexOf('8450'));
  assert.equal(entities[0]!.literal, text.slice(entities[0]!.span.start, entities[0]!.span.end));
  assert.equal(entities[0]!.validation.status, 'unknown');
  assert.equal('eligible' in entities[0]!, false);
});
test('same input is reproducible, malformed catalog/unknown cells fail explicitly', () => {
  assert.deepEqual(run('NCM 0101.21.00 a 0101.29.00'), run('NCM 0101.21.00 a 0101.29.00'));
  assert.throws(() => extractAnatomyEntities({ canonicalText: 'x', parts: [part('x')], ncmPartIds: ['missing'] }));
  assert.throws(() => extractAnatomyEntities({ canonicalText: 'x', parts: [part('x')], catalog: { edition: '', codes: ['0101'] } }));
});
