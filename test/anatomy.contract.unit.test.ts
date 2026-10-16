import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ANATOMY_CONTRACT_VERSION, anatomyContractJsonSchema, anatomyIdentityHash, anatomyOutputHash,
  anatomyResultSchema, canonicalJson, sha256, validateAnatomyResult, type AnatomyResult } from '../src/modules/anatomy/contract.js';

const digest = 'a'.repeat(64);
const pointer = { resourceId: 'snapshot', representation: 'text' as const, locator: '/text', sourceSpan: null };
function fixture(text = 'NCM 0101.21.00'): AnatomyResult {
  const identity = { publicationVersionId: 'fixture-v1', representationId: 'fixture-text', inputTextHash: sha256(text),
    inputPresentationHash: null, attachmentManifestHash: sha256('[]'), engineVersion: 'fixture-engine/1',
    ruleSetId: 'fixture-rules', ruleSetVersion: '1', ruleSetHash: digest, contractVersion: ANATOMY_CONTRACT_VERSION };
  const root = { id: 'root', parentId: null, order: 0, type: 'document' as const, label: '',
    span: { start: 0, end: text.length }, sourcePointers: [pointer], recognition: 'explicit' as const,
    ruleId: 'fixture', confidence: 1, coverage: 'complete' as const, context: 'operative_candidate' as const,
    contextReasons: ['fixture_only'], legalStatus: 'unknown' as const, table: null };
  const result: AnatomyResult = {
    contractVersion: ANATOMY_CONTRACT_VERSION, analysisId: anatomyIdentityHash(identity), identity, canonicalText: text,
    referenceDate: '2026-10-16', status: 'complete', parts: [root, { ...root, id: 'body', parentId: 'root', type: 'body', legalStatus: 'current' }],
    entities: [], evidence: [], eligibility: [],
    sourceMap: text ? [{ span: root.span, pointer }] : [],
    coverage: { unit: 'UTF-16', textLength: text.length, accountedLength: text.length, recognizedLength: text.length,
      segments: text ? [{ span: root.span, partId: 'body', classification: 'recognized' }] : [], missingResources: [] },
    limitations: [], outputHash: digest,
  };
  result.outputHash = anatomyOutputHash(result);
  return result;
}
function resign(result: AnatomyResult): AnatomyResult { result.outputHash = anatomyOutputHash(result); return result; }
function positiveFixture(): AnatomyResult {
  const result = fixture();
  result.entities.push({ id: 'ncm', partId: 'body', domain: 'NCM', literal: '0101.21.00', normalized: '01012100',
    span: { start: 4, end: 14 }, ruleId: 'fixture', confidence: 1,
    validation: { status: 'valid', method: 'catalog', catalogEdition: 'controlled-2026', reason: 'fixture_catalog' }, relation: null });
  result.evidence.push({ id: 'proof', partId: 'body', scope: { start: 0, end: 14 }, origin: 'controlled_fixture', approval: 'approved',
    reviewer: 'controlled-test', reviewedAt: '2026-10-16T00:00:00Z', identityHash: result.analysisId,
    referenceDate: result.referenceDate, validFrom: '2026-01-01', validThrough: '2026-12-31', conclusion: 'current',
    basis: 'Synthetic approval, never the ANAT-03 dossier', officialUrl: 'https://example.invalid/fixture',
    dependencies: [{ reference: 'fixture-act', approvedHash: digest, observedHash: digest, effectsFrom: '2026-01-01', validThrough: '2026-12-31' }] });
  result.eligibility.push({ id: 'selection', purpose: 'ncm', partId: 'body', entityId: 'ncm', span: { start: 4, end: 14 },
    eligible: true, evidenceIds: ['proof'], exclusionReasons: [] });
  return resign(result);
}

test('contract exports strict JSON Schema and accepts a deterministic positive fixture', () => {
  assert.equal(anatomyContractJsonSchema().additionalProperties, false);
  assert.deepEqual(JSON.parse(readFileSync(new URL('../docs/anatomy/contract-v1.schema.json', import.meta.url), 'utf8')),
    anatomyContractJsonSchema(), 'Published JSON Schema must match the executable shape');
  const result = positiveFixture();
  assert.deepEqual(validateAnatomyResult(result), result);
  assert.equal(anatomyOutputHash(result), result.outputHash);
  assert.equal(canonicalJson({ z: 1, a: ['á', '😀'] }), canonicalJson({ a: ['á', '😀'], z: 1 }));
  assert.throws(() => canonicalJson({ value: undefined }));
});
test('UTF-16 preserves combining marks, emoji and literal without normalization', () => {
  const result = fixture('á e\u0301 😀 &');
  assert.equal(result.canonicalText.length, 9);
  assert.ok(anatomyResultSchema.safeParse(result).success);
  result.parts[1]!.span.end = 6; // Splits the emoji surrogate pair.
  assert.equal(anatomyResultSchema.safeParse(resign(result)).success, false);
});
test('approval of an NCM prefix cannot authorize the entire occurrence', () => {
  const result = positiveFixture();
  result.eligibility[0]!.span = { start: 4, end: 8 };
  result.evidence[0]!.scope = { start: 4, end: 8 };
  assert.equal(anatomyResultSchema.safeParse(resign(result)).success, false);
  result.eligibility[0]!.span = { start: 4, end: 14 };
  assert.equal(anatomyResultSchema.safeParse(resign(result)).success, false);
  result.evidence[0]!.scope = { start: 4, end: 14 };
  assert.equal(anatomyResultSchema.safeParse(resign(result)).success, true);
});
test('coverage is a partition, container spans are not counted twice', () => {
  const result = fixture();
  result.coverage.segments.push({ span: { start: 0, end: 14 }, partId: 'root', classification: 'recognized' });
  assert.equal(anatomyResultSchema.safeParse(resign(result)).success, false);
});
test('invalid parent, cycles and sibling overlap are rejected', () => {
  for (const parentId of ['missing', 'body']) {
    const result = fixture(); result.parts[1]!.parentId = parentId;
    assert.equal(anatomyResultSchema.safeParse(resign(result)).success, false);
  }
  const result = fixture(); result.parts.push({ ...result.parts[1]!, id: 'overlap', order: 1 });
  assert.equal(anatomyResultSchema.safeParse(resign(result)).success, false);
});
test('input, presentation, attachment and rule identities invalidate snapshot evidence', () => {
  for (const field of ['inputPresentationHash', 'attachmentManifestHash', 'ruleSetHash'] as const) {
    const result = positiveFixture(); result.identity[field] = 'b'.repeat(64);
    result.analysisId = anatomyIdentityHash(result.identity);
    assert.equal(anatomyResultSchema.safeParse(resign(result)).success, false);
  }
  const result = fixture(); result.canonicalText += '!';
  assert.equal(anatomyResultSchema.safeParse(resign(result)).success, false);
});
test('positive selection requires approved evidence, current context and dependencies', () => {
  const mutations: Array<(result: AnatomyResult) => void> = [
    (r) => { r.evidence = []; }, (r) => { r.evidence[0]!.validThrough = '2026-10-15'; },
    (r) => { r.evidence[0]!.dependencies[0]!.observedHash = 'b'.repeat(64); },
    (r) => { r.parts[1]!.context = 'historical'; }, (r) => { r.parts[0]!.context = 'unknown'; },
    (r) => { r.parts[1]!.legalStatus = 'unknown'; }, (r) => { r.parts[1]!.type = 'summary'; },
    (r) => { r.entities[0]!.validation.method = 'format'; },
    (r) => { r.evidence[0]!.scope = { start: 0, end: 5 }; },
    (r) => { r.evidence[0]!.referenceDate = '2026-10-15'; },
  ];
  for (const mutate of mutations) { const result = positiveFixture(); mutate(result); assert.equal(anatomyResultSchema.safeParse(resign(result)).success, false); }
});
test('unknown retains full coverage, never counts as recognized, and is partial', () => {
  const result = fixture('unknown'); result.status = 'partial';
  result.parts[1]!.type = 'unidentified'; result.parts[1]!.recognition = 'unidentified';
  result.parts[1]!.coverage = 'unidentified'; result.parts[1]!.context = 'unknown'; result.parts[1]!.legalStatus = 'unknown';
  result.coverage.recognizedLength = 0; result.coverage.segments[0]!.classification = 'unidentified';
  assert.ok(anatomyResultSchema.safeParse(resign(result)).success);
  result.coverage.segments[0]!.classification = 'recognized'; result.coverage.recognizedLength = 7;
  assert.equal(anatomyResultSchema.safeParse(resign(result)).success, false);
});
test('NCM allows 4–8 digits including 5/7 and keeps leading zeros; two is informative only', () => {
  for (const literal of ['01', '0101', '01012', '010121', '0101210', '01012100']) {
    const result = fixture(literal);
    result.entities.push({ id: 'ncm', partId: 'body', domain: 'NCM', literal, normalized: literal,
      span: { start: 0, end: literal.length }, ruleId: 'fixture', confidence: 1,
      validation: { status: literal.length === 2 ? 'informative' : 'unknown', method: 'format', catalogEdition: null, reason: 'fixture' }, relation: null });
    assert.ok(anatomyResultSchema.safeParse(resign(result)).success);
  }
  const result = positiveFixture(); result.entities[0]!.normalized = '1012100';
  assert.equal(anatomyResultSchema.safeParse(resign(result)).success, false);
});
test('range and exception members cannot become independent positive selections', () => {
  for (const kind of ['range_start', 'exception'] as const) {
    const result = positiveFixture(); result.entities[0]!.relation = { kind, groupId: 'range-1', targetEntityIds: [],
      operator: kind, scopePartId: 'body', condition: null, expansion: [] };
    assert.equal(anatomyResultSchema.safeParse(resign(result)).success, false);
  }
});
test('a container cannot include a forbidden, historical or unknown descendant', () => {
  for (const context of ['historical', 'unknown', 'prohibited'] as const) {
    const result = positiveFixture();
    result.parts.push({ ...result.parts[1]!, id: 'quoted', parentId: 'body', type: 'quoted_text', context,
      legalStatus: 'repealed', span: { start: 4, end: 14 } });
    result.eligibility[0]!.entityId = null;
    result.eligibility[0]!.purpose = 'thematic_text';
    assert.equal(anatomyResultSchema.safeParse(resign(result)).success, false);
  }
});
test('NCM selections cannot bypass range, exception or protected-domain exclusions through a null target', () => {
  for (const kind of ['range_start', 'exception'] as const) {
    const result = positiveFixture(); result.eligibility[0]!.entityId = null;
    result.entities[0]!.relation = { kind, groupId: 'range-1', targetEntityIds: [], operator: kind,
      scopePartId: 'body', condition: null, expansion: [] };
    assert.equal(anatomyResultSchema.safeParse(resign(result)).success, false);
  }
  const result = positiveFixture(); result.eligibility[0]!.entityId = null; result.entities[0]!.domain = 'PROCESS';
  assert.equal(anatomyResultSchema.safeParse(resign(result)).success, false);
});
test('thematic text with exceptions remains usable without exporting an NCM selection', () => {
  const result = positiveFixture();
  result.eligibility[0]!.purpose = 'thematic_text'; result.eligibility[0]!.entityId = null;
  result.entities[0]!.relation = { kind: 'exception', groupId: 'exception-1', targetEntityIds: [], operator: 'except',
    scopePartId: 'body', condition: 'controlled fixture condition', expansion: [] };
  assert.ok(anatomyResultSchema.safeParse(resign(result)).success);
  result.eligibility[0]!.purpose = 'ncm'; result.eligibility[0]!.entityId = 'ncm';
  assert.equal(anatomyResultSchema.safeParse(resign(result)).success, false);
});
test('a separate overlapping citation or compound cannot be bypassed using a clean NCM entity', () => {
  for (const domain of ['CITATION', 'NCM_RANGE', 'NCM_EXCEPTION'] as const) {
    const result = positiveFixture(); result.entities.push({ ...result.entities[0]!, id: 'protected', domain });
    assert.equal(anatomyResultSchema.safeParse(resign(result)).success, false);
    result.eligibility[0]!.purpose = 'thematic_text'; result.eligibility[0]!.entityId = null;
    assert.ok(anatomyResultSchema.safeParse(resign(result)).success);
  }
});
test('conflicting approved evidence blocks positive selection even when it was not cited', () => {
  const result = positiveFixture(); result.evidence.push({ ...result.evidence[0]!, id: 'conflict', conclusion: 'repealed' });
  assert.equal(anatomyResultSchema.safeParse(resign(result)).success, false);
});
test('source pointers reject inverted offsets and NCM rejects arbitrary dots but preserves legacy 4.4', () => {
  const result = fixture(); result.parts[1]!.sourcePointers = [{ ...pointer, sourceSpan: { start: 9, end: 1 } }];
  assert.equal(anatomyResultSchema.safeParse(resign(result)).success, false);
  for (const [literal, accepted] of [['0.1.0.1', false], ['8417.8020', true], ['0101.2', true], ['0101.21.0', true]] as const) {
    const r = fixture(literal); r.entities.push({ id: 'ncm', partId: 'body', domain: 'NCM', literal,
      normalized: literal.replace(/\./g, ''), span: { start: 0, end: literal.length }, ruleId: 'fixture', confidence: 1,
      validation: { status: 'unknown', method: 'format', catalogEdition: null, reason: 'fixture' }, relation: null });
    assert.equal(anatomyResultSchema.safeParse(resign(r)).success, accepted);
  }
});
test('unidentified type or coverage segment can never claim complete, regardless of other flags', () => {
  const result = fixture(); result.parts[1]!.type = 'unidentified'; result.parts[1]!.context = 'unknown';
  result.coverage.recognizedLength = 0; result.coverage.segments[0]!.classification = 'unidentified';
  assert.equal(anatomyResultSchema.safeParse(resign(result)).success, false);
  const r = fixture(); r.coverage.recognizedLength = 0; r.coverage.segments[0]!.classification = 'unidentified';
  assert.equal(anatomyResultSchema.safeParse(resign(r)).success, false);
});
test('unknown fields, false calendar dates, partial/failed positives and missing resources fail closed', () => {
  assert.equal(anatomyResultSchema.safeParse({ ...fixture(), inventedApproval: true }).success, false);
  const invalidDate = fixture(); invalidDate.referenceDate = '2026-02-30';
  assert.equal(anatomyResultSchema.safeParse(resign(invalidDate)).success, false);
  for (const status of ['partial', 'failed'] as const) { const r = positiveFixture(); r.status = status; assert.equal(anatomyResultSchema.safeParse(resign(r)).success, false); }
  const r = fixture(); r.coverage.missingResources = ['attachment-1'];
  assert.equal(anatomyResultSchema.safeParse(resign(r)).success, false);
});
