import assert from 'node:assert/strict';
import test from 'node:test';

import {
  planDetachedHistoricalMergeCompatibility,
  planDimensionMerge,
  planDimensionMergeCompatibility,
} from '../src/modules/taxonomy/curation/curation.merge-dimension.js';
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

  const compatibility = planDimensionMergeCompatibility(
    {
      concepts: [
        concept('theme.exemption', 'Isenção'),
        concept('theme.tax_substitution', 'Substituição tributária'),
        concept('theme.zero_rate', 'Alíquota zero', { membershipStatus: 'RETIRED' }),
        concept('treatment.exemption', 'Isenção'),
        concept('treatment.st', 'Substituição Tributária'),
        concept('treatment.zero_rate', 'Alíquota zero'),
        concept('treatment.monophase', 'Monofásico'),
        concept('treatment.old', 'Retirado', { membershipStatus: 'RETIRED' }),
        concept('treatment.legacy_exemption', 'Isenção', { membershipStatus: 'RETIRED' }),
      ],
    },
    'treatment',
    'theme',
    steps,
  );

  assert.equal(compatibility.redirects['treatment.exemption'], 'theme.exemption');
  assert.equal(compatibility.redirects['treatment.st'], 'theme.tax_substitution');
  assert.equal(compatibility.redirects['treatment.zero_rate'], 'theme.zero_rate');
  assert.equal(compatibility.redirects['treatment.monophase'], 'theme.monophase');
  assert.equal(
    compatibility.redirects['treatment.legacy_exemption'],
    'theme.exemption',
    'already-retired historical codes redirect when an active successor exists',
  );
  assert.deepEqual(
    compatibility.retiredCodes,
    ['treatment.old'],
    'already-retired historical codes without an active successor become explicit retiredCodes',
  );
});


test('historical Treatment ignores a RETIRED suffix target and falls back to an active Theme by label', () => {
  const compatibility = planDimensionMergeCompatibility(
    {
      concepts: [
        concept('theme.legacy_exemption', 'Tema legado', {
          membershipStatus: 'RETIRED',
        }),
        concept('theme.exemption', 'Isenção'),
        concept('treatment.legacy_exemption', 'Isenção', {
          membershipStatus: 'RETIRED',
        }),
      ],
    },
    'treatment',
    'theme',
    [],
  );

  assert.deepEqual(compatibility.redirects, {
    'treatment.legacy_exemption': 'theme.exemption',
  });
  assert.deepEqual(compatibility.retiredCodes, []);
});

test('active suffix target keeps deterministic precedence over label fallback', () => {
  const compatibility = planDimensionMergeCompatibility(
    {
      concepts: [
        concept('theme.legacy_exemption', 'Outro rótulo'),
        concept('theme.exemption', 'Isenção'),
        concept('treatment.legacy_exemption', 'Isenção', {
          membershipStatus: 'RETIRED',
        }),
      ],
    },
    'treatment',
    'theme',
    [],
  );

  assert.equal(
    compatibility.redirects['treatment.legacy_exemption'],
    'theme.legacy_exemption',
  );
});

test('historical Treatment rejects ambiguous active label fallback', () => {
  assert.throws(
    () =>
      planDimensionMergeCompatibility(
        {
          concepts: [
            concept('theme.first', 'Isenção'),
            concept('theme.second', 'Isenção'),
            concept('treatment.legacy', 'Isenção', {
              membershipStatus: 'RETIRED',
            }),
          ],
        },
        'treatment',
        'theme',
        [],
      ),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      (error as Error & { code: string }).code ===
        'AMBIGUOUS_DIMENSION_MERGE_TARGET',
  );
});


test('detached historical Treatment redirects to an active Theme before retirement', () => {
  const result = planDetachedHistoricalMergeCompatibility(
    [
      { code: 'treatment.exemption', label: 'Isenção histórica' },
      { code: 'treatment.legacy_by_label', label: 'Crédito presumido' },
      { code: 'treatment.orphan', label: 'Tratamento sem sucessor' },
    ],
    [
      concept('theme.exemption', 'Isenção'),
      concept('theme.presumed_credit', 'Crédito presumido'),
    ],
    new Set<string>(),
  );

  assert.equal(result.redirects['treatment.exemption'], 'theme.exemption');
  assert.equal(
    result.redirects['treatment.legacy_by_label'],
    'theme.presumed_credit',
    'detached histories use the same label fallback as the normal merge',
  );
  assert.deepEqual(result.retiredCodes, ['treatment.orphan']);
});

test('planDimensionMerge rejects ambiguous target labels instead of picking the first', () => {
  assert.throws(
    () =>
      planDimensionMerge(
        {
          groups: [],
          concepts: [
            concept('theme.first', 'Benefício duplicado'),
            concept('theme.second', 'Benefício duplicado'),
            concept('treatment.legacy', 'Benefício duplicado'),
          ],
        },
        'treatment',
        'theme',
      ),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      (error as Error & { code: string }).code ===
        'AMBIGUOUS_DIMENSION_MERGE_TARGET',
  );
});

test('planDimensionMerge rejects two source concepts mapped to the same target', () => {
  assert.throws(
    () =>
      planDimensionMerge(
        {
          groups: [],
          concepts: [
            concept('theme.exemption', 'Isenção'),
            concept('treatment.exemption', 'Isenção'),
            concept('treatment.legacy_exemption', 'Isenção'),
          ],
        },
        'treatment',
        'theme',
      ),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      (error as Error & { code: string }).code ===
        'AMBIGUOUS_DIMENSION_MERGE_MANY_TO_ONE',
  );
});
