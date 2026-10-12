import assert from 'node:assert/strict';
import {partitionL17AutomaticRules,selectL17AutomaticRules} from '../src/modules/collection/l17-daily-always.js';
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


test('L17 scheduler selects only normalized DOU EXCLUDE_ALWAYS, never conditional or CONFAZ',()=>{
  const policy=compileCollectionFilterPolicy({
    version:1,contextWindowWords:12,weakScoreThreshold:3,
    locationWeights:{title:3,summary:2,body:1},
    rules:[
      {sourceCode:'dou',section:'DO1E',canonicalType:'RESOLUCAO CIT SNC MINC',mode:'EXCLUDE_ALWAYS'},
      {sourceCode:'dou',section:'DO1',canonicalType:'PORTARIA',mode:'EXCLUDE_UNLESS_STRONG'},
      {sourceCode:'confaz',section:'DO1',canonicalType:'PORTARIA',mode:'EXCLUDE_ALWAYS'},
      {sourceCode:'dou',section:'DO3',canonicalType:'AVISO DE LICITACAO',mode:'KEEP_IF_TAX_TERM'},
    ],
    aliases:[],terms:[],
  });
  assert.deepEqual(selectL17AutomaticRules(policy).map(r=>r.canonicalType),
    ['RESOLUCAO CIT SNC MINC']);
});

test('L17 hotfix: 3200 active EXCLUDE_ALWAYS rules are all partitioned without silent drops',()=>{
  const compiled=compileCollectionFilterPolicy({
    version:1,contextWindowWords:12,weakScoreThreshold:3,
    locationWeights:{title:3,summary:2,body:1},
    rules:Array.from({length:3200},(_,i)=>({
      sourceCode:'dou',section:'DO1E',canonicalType:'PERF TYPE '+i,
      mode:'EXCLUDE_ALWAYS' as const,
    })),
    aliases:[],terms:[],
  });
  const groups=partitionL17AutomaticRules(compiled);
  assert.equal(groups.rules.length,3200);
  assert.ok(groups.partitions.length>1);
  assert.ok(groups.partitions.every(x=>x.types.length<=160));
  const distinct=new Set(groups.partitions.flatMap(g=>g.types));
  assert.equal(distinct.size,3200);
});


test('L-20 f57e0b03 fixture: DOU/DO3 mismatch between Aviso de Dispensa and Aviso de Adjudicação',()=>{
  const bothExcluded:ApprovedCollectionFilterRuntime={
    ...runtime,
    policy:compileCollectionFilterPolicy({
      version:1,contextWindowWords:12,weakScoreThreshold:3,
      locationWeights:{title:3,summary:2,body:1},
      rules:[
        {sourceCode:'dou',section:'DO3',canonicalType:'AVISO DE DISPENSA DE LICITACAO',mode:'EXCLUDE_ALWAYS'},
        {sourceCode:'dou',section:'DO3',canonicalType:'AVISO DE ADJUDICACAO',mode:'EXCLUDE_ALWAYS'},
      ],terms:[],
    }),
  };
  const fixture=publication({
    sourceItemKey:'f57e0b03',title:'AVISO DE DISPENSA DE LICITAÇÃO 7/2026',
    agency:'Prefeitura de Douradoquara/MG',publishedOn:'2026-10-09',
    actType:'AVISO DE DISPENSA DE LICITACAO',
    originMetadata:{dou:{section:'DO3',sourceActType:'Aviso de Adjudicação'}},
  });
  const result=evaluateRuntimeCollectionFilter(bothExcluded,fixture);
  assert.deepEqual([result.decision.decision,result.decision.reasonCode],
    ['DISCARD','TYPE_CONFLICT_BOTH_EXCLUDED']);
  const keepRuntime:ApprovedCollectionFilterRuntime={
    ...bothExcluded,
    policy:compileCollectionFilterPolicy({
      version:1,contextWindowWords:12,weakScoreThreshold:3,
      locationWeights:{title:3,summary:2,body:1},
      rules:[
        {sourceCode:'dou',section:'DO3',canonicalType:'AVISO DE DISPENSA DE LICITACAO',mode:'EXCLUDE_ALWAYS'},
        {sourceCode:'dou',section:'DO3',canonicalType:'AVISO DE ADJUDICACAO',mode:'KEEP_ALWAYS'},
      ],terms:[],
    }),
  };
  const keep=evaluateRuntimeCollectionFilter(keepRuntime,fixture);
  assert.deepEqual([keep.decision.decision,keep.decision.reasonCode],['KEEP','TYPE_CONFLICT']);
});
