import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compileCollectionFilterPolicy,
} from '../src/modules/collection/collection-filter.engine.js';
import {
  evaluateRuntimeCollectionFilter,
  type ApprovedCollectionFilterRuntime,
} from '../src/modules/collection/collection-filter.runtime.js';
import type { NormalizedPublication } from '../src/modules/collection/publication.normalizer.js';

const runtime: ApprovedCollectionFilterRuntime = {
  policyId: '00000000-0000-4000-8000-000000000001',
  policyVersion: 1,
  policyRevision: 5,
  sourceId: '00000000-0000-4000-8000-000000000002',
  sourceCode: 'dou',
  connectorKey: 'dou',
  policy: compileCollectionFilterPolicy({
    version: 1,
    contextWindowWords: 12,
    weakScoreThreshold: 3,
    locationWeights: { title: 3, summary: 2, body: 1 },
    rules: [
      {
        sourceCode: 'dou',
        section: 'DO1',
        canonicalType: 'PORTARIA',
        mode: 'KEEP_IF_TAX_TERM',
      },
    ],
    aliases: [],
    terms: [
      { text: 'ICMS', strength: 'STRONG' },
      { text: 'CORAT', strength: 'STRONG' },
    ],
  }),
};

function publication(overrides: Partial<NormalizedPublication> = {}): NormalizedPublication {
  return {
    title: 'PORTARIA Nº 10, DE 7 DE OUTUBRO DE 2026',
    jurisdictionLevel: 'FEDERAL',
    actType: 'PORTARIA',
    actNumber: '10/2026',
    publishedOn: '2026-10-07',
    contentText: 'Dispõe sobre organização administrativa interna.',
    officialUrl: 'https://example.invalid/ato/10',
    sourceItemKey: 'ato-10',
    metadata: {},
    originMetadata: {
      dou: {
        section: 'DO1',
      },
    },
    files: [],
    contentHashPolicy: 'LEGACY_ALL_FILES',
    contentHashVersion: 1,
    identityStrength: 'SOURCE_SCOPED',
    identityBasis: {
      version: 1,
      scope: 'FEDERAL',
      sourceId: 'source',
      sourceKeyType: 'EXTERNAL_ID',
      sourceKey: 'ato-10',
    },
    identityHash: 'a'.repeat(64),
    contentHash: 'b'.repeat(64),
    ...overrides,
  };
}

test('runtime DOU adapter discards configured generic type without tax signal', () => {
  const result = evaluateRuntimeCollectionFilter(runtime, publication());
  assert.equal(result.section, 'DO1');
  assert.equal(result.decision.decision, 'DISCARD');
  assert.equal(result.decision.reasonCode, 'NO_TAX_TERM');
});

test('runtime DOU adapter keeps strong tax signal', () => {
  const result = evaluateRuntimeCollectionFilter(
    runtime,
    publication({
      contentText: 'Esta portaria disciplina operações sujeitas ao ICMS.',
    }),
  );
  assert.equal(result.decision.decision, 'KEEP');
  assert.equal(result.decision.reasonCode, 'STRONG_TERM');
  assert.equal(result.decisiveTerm, 'ICMS');
});

test('runtime DOU adapter keeps unknown type for New Types review', () => {
  const result = evaluateRuntimeCollectionFilter(
    runtime,
    publication({ actType: 'TIPO AINDA NAO MAPEADO' }),
  );
  assert.equal(result.decision.decision, 'KEEP');
  assert.equal(result.decision.reasonCode, 'UNKNOWN_TYPE');
  assert.equal(result.decision.requiresNewTypeReview, true);
});

test('runtime DOU adapter fails open when evidence is incomplete', () => {
  const result = evaluateRuntimeCollectionFilter(
    runtime,
    publication({
      originMetadata: {
        dou: {
          section: 'DO1',
          scopeStructureIncomplete: true,
        },
      },
    }),
  );
  assert.equal(result.decision.decision, 'KEEP');
  assert.equal(result.decision.reasonCode, 'INCOMPLETE_EVIDENCE');
});

test('L17: generic DOU sourceActType Resolução is compatible with specific CIT-SNC/MINC', () => {
  const runtimeWithSpecificRule: ApprovedCollectionFilterRuntime = {
    ...runtime,
    policy: compileCollectionFilterPolicy({
      version: 1,
      contextWindowWords: 12,
      weakScoreThreshold: 3,
      locationWeights: { title: 3, summary: 2, body: 1 },
      rules: [{ sourceCode: 'dou', section: 'DO1E',
        canonicalType: 'RESOLUCAO CIT SNC MINC', mode: 'EXCLUDE_ALWAYS' }],
      terms: [],
    }),
  };
  const realShape = publication({
    actType: 'RESOLUÇÃO CIT-SNC/MINC',
    title: 'Resolução CIT-SNC/MINC nº 1, de 9 de outubro de 2026',
    publishedOn: '2026-10-09',
    contentText: 'Aprova deliberação da comissão intergestores.',
    originMetadata: { dou: { section: 'DO1E', sourceActType: 'Resolução' } },
  });
  const result = evaluateRuntimeCollectionFilter(runtimeWithSpecificRule, realShape);
  assert.equal(result.decision.canonicalType, 'RESOLUCAO CIT SNC MINC');
  assert.equal(result.decision.decision, 'DISCARD');
  assert.equal(result.decision.reasonCode, 'EXCLUDE_ALWAYS');

  const unrelated = evaluateRuntimeCollectionFilter(runtimeWithSpecificRule, publication({
    ...realShape,
    originMetadata: { dou: { section: 'DO1E', sourceActType: 'Portaria' } },
  }));
  assert.equal(unrelated.decision.decision, 'KEEP');
  assert.equal(unrelated.decision.reasonCode, 'TYPE_CONFLICT');
});
