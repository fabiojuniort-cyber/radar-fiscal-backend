import assert from 'node:assert/strict';
import test from 'node:test';

import { planDimensionMerge } from '../src/modules/taxonomy/curation/curation.merge-dimension.js';
import type { ConceptView, GroupView } from '../src/modules/taxonomy/curation/curation.read.js';

function concept(code: string, label: string, extra: Partial<ConceptView> = {}): ConceptView {
  return {
    releaseConceptId: code,
    conceptId: code,
    code,
    dimensionCode: code.split('.')[0]!,
    label,
    definition: label,
    positiveExample: null,
    negativeExample: null,
    governanceStatus: 'APPROVED',
    evidenceStatus: 'NOT_ASSESSED',
    notes: null,
    releaseNotes: null,
    revisionNo: 1,
    membershipStatus: 'INCLUDED',
    groupId: null,
    groupCode: null,
    profileVisible: false,
    displayOrder: null,
    helpText: null,
    classifyByLabel: true,
    officialCodes: [],
    aliases: [],
    ...extra,
  };
}

function group(dimensionCode: string, code: string): GroupView {
  return { id: code, dimensionCode, code, label: code, displayOrder: 0, helpText: null, detailSection: null, officialCodes: [], segmentCodes: [] };
}

test('planDimensionMerge merges by code or label and recreates the rest in the target', () => {
  const steps = planDimensionMerge(
    {
      groups: [group('theme', 'beneficios'), group('theme', 'cobranca_pagamento')],
      concepts: [
        concept('theme.exemption', 'Isenção', { aliases: [{ text: 'isento', aliasType: 'EXACT_LEXICAL' }] }),
        concept('theme.tax_substitution', 'Substituição tributária'),
        concept('treatment.exemption', 'Isenção', {
          officialCodes: ['200001'],
          aliases: [{ text: 'Isento', aliasType: 'EXACT_LEXICAL' }, { text: 'isenções', aliasType: 'EXACT_LEXICAL' }],
        }),
        concept('treatment.st', 'Substituição Tributária'),
        concept('theme.zero_rate', 'Alíquota zero', {
          membershipStatus: 'RETIRED',
          groupCode: 'beneficios',
        }),
        concept('treatment.zero_rate', 'Alíquota zero', { groupCode: 'beneficios' }),
        concept('treatment.monophase', 'Monofásico', { groupCode: 'cobranca_especial' }),
        concept('treatment.old', 'Retirado', { membershipStatus: 'RETIRED' }),
      ],
    },
    'treatment',
    'theme',
    { cobranca_especial: 'cobranca_pagamento' },
  );

  assert.deepEqual(
    steps.map((step) => [step.from, step.action, step.into, step.group]),
    [
      ['treatment.exemption', 'MERGE', 'theme.exemption', null],
      ['treatment.st', 'MERGE', 'theme.tax_substitution', null],
      ['treatment.zero_rate', 'RESTORE', 'theme.zero_rate', null],
      ['treatment.monophase', 'CREATE', 'theme.monophase', 'cobranca_pagamento'],
    ],
  );
  assert.deepEqual(steps[0]!.addedAliases, ['isenções'], 'aliases already on the target are not repeated');
  assert.deepEqual(steps[0]!.addedOfficialCodes, ['200001']);
  assert.deepEqual(steps[1]!.addedAliases, [], 'same label in another case is not an alias');
  assert.equal(
    steps.find((step) => step.from === 'treatment.zero_rate')?.action,
    'RESTORE',
    'retired target identity is reused instead of recreated',
  );
});
