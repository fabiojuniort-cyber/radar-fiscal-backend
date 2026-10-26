import assert from 'node:assert/strict';
import test from 'node:test';
import { ANATOMY_CONTRACT_VERSION, anatomyIdentityHash, anatomyOutputHash, sha256,
  type AnatomyResult } from '../src/modules/anatomy/contract.js';
import { simulateTaxonomyConsumer } from '../src/modules/anatomy/consumer.js';

function fixture(): AnatomyResult {
  const text = 'inseticidas exceto 0101.21.00';
  const identity = { publicationVersionId: 'controlled-fixture', representationId: 'controlled-text',
    inputTextHash: sha256(text), inputPresentationHash: null, attachmentManifestHash: sha256('[]'),
    engineVersion: 'controlled/1', engineHash: sha256('controlled-engine-build'), ruleSetId: 'controlled', ruleSetVersion: '1', ruleSetHash: sha256('{}'),
    contractVersion: ANATOMY_CONTRACT_VERSION };
  const span = { start: 0, end: text.length };
  const pointer = { resourceId: 'controlled-text', representation: 'text' as const, locator: '/', sourceSpan: span };
  const root = { id: 'root', parentId: null, order: 0, type: 'document' as const, label: '', span,
    sourcePointers: [pointer], recognition: 'explicit' as const, ruleId: 'controlled', confidence: 1,
    coverage: 'complete' as const, context: 'operative_candidate' as const, contextReasons: ['controlled'],
    legalStatus: 'unknown' as const, table: null };
  const result: AnatomyResult = { contractVersion: ANATOMY_CONTRACT_VERSION,
    analysisId: anatomyIdentityHash(identity), identity, canonicalText: text, referenceDate: '2026-10-16',
    status: 'complete', parts: [root, { ...root, id: 'body', parentId: 'root', type: 'body', legalStatus: 'current' }],
    entities: [{ id: 'excluded-code', partId: 'body', domain: 'NCM', literal: '0101.21.00', normalized: '01012100',
      span: { start: text.length - 10, end: text.length }, ruleId: 'controlled', confidence: 1,
      validation: { status: 'valid', method: 'catalog', catalogEdition: 'controlled-2026', reason: 'fixture' },
      relation: { kind: 'exception', groupId: 'exception', targetEntityIds: [], operator: 'exceto',
        scopePartId: 'body', condition: null, expansion: [] } }],
    evidence: [], eligibility: [], sourceMap: [{ span, pointer }],
    coverage: { unit: 'UTF-16', textLength: text.length, accountedLength: text.length, recognizedLength: text.length,
      segments: [{ span, partId: 'body', classification: 'recognized' }], missingResources: [] },
    limitations: [], outputHash: '' };
  result.evidence.push({ id: 'controlled-proof', partId: 'body', scope: span, origin: 'controlled_fixture', approval: 'approved',
    reviewer: 'controlled-reviewer', reviewedAt: '2026-10-16T00:00:00Z', identityHash: result.analysisId,
    referenceDate: result.referenceDate, validFrom: '2026-10-16', validThrough: '2026-10-16', conclusion: 'current',
    basis: 'Synthetic fixture; no ANAT-03 dossier', officialUrl: 'https://example.invalid/controlled', dependencies: [] });
  result.eligibility.push({ id: 'topic', purpose: 'thematic_text', partId: 'body', entityId: null,
    span, eligible: true, evidenceIds: ['controlled-proof'], exclusionReasons: [] });
  result.outputHash = anatomyOutputHash(result);
  return result;
}

test('exception remains thematic text, never a positive NCM inferred from it', () => {
  const result = fixture();
  const before = JSON.stringify(result);
  const consumed = simulateTaxonomyConsumer(result);
  assert.equal(consumed.thematicBlocks[0]?.text, result.canonicalText);
  assert.deepEqual(consumed.ncmOccurrences, []);
  assert.equal(JSON.stringify(result), before);
});

test('consumer rejects unapproved selection and forged output', () => {
  const result = fixture(); result.evidence = []; result.outputHash = anatomyOutputHash(result);
  assert.throws(() => simulateTaxonomyConsumer(result));
  const forged = fixture(); forged.outputHash = 'a'.repeat(64);
  assert.throws(() => simulateTaxonomyConsumer(forged));
});

test('thematic blocks retain separate boundaries without concatenation', () => {
  const result = fixture();
  result.eligibility = [0, 1].map(index => ({ ...result.eligibility[0]!, id: `block-${index}`,
    span: index === 0 ? { start: 0, end: 5 } : { start: 5, end: 11 } }));
  result.outputHash = anatomyOutputHash(result);
  const consumed = simulateTaxonomyConsumer(result);
  assert.deepEqual(consumed.thematicBlocks.map(block => block.text), ['inset', 'icidas']);
  assert.equal(consumed.thematicBlocks.length, 2);
});

test('missing resources produce an explicitly partial empty selection, not no-topic certainty', () => {
  const result = fixture(); result.status = 'partial'; result.eligibility = [];
  result.coverage.missingResources = ['controlled-missing-attachment']; result.outputHash = anatomyOutputHash(result);
  const consumed = simulateTaxonomyConsumer(result);
  assert.equal(consumed.status, 'partial');
  assert.deepEqual(consumed.thematicBlocks, []);
  assert.deepEqual(consumed.missingResources, ['controlled-missing-attachment']);
});
