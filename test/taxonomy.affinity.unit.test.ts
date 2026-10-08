import assert from 'node:assert/strict';
import test from 'node:test';

import {
  affinityLevel,
  computePublicationAffinity,
} from '../src/modules/taxonomy/affinity/publication-affinity.js';
import type { PublicationTaxonomyView } from '../src/modules/taxonomy/curation/curation.tags.js';

function tag(dimensionCode: string, code: string, label: string, extra: Record<string, unknown> = {}) {
  return {
    kind: 'CONCEPT' as const,
    conceptCode: code,
    groupCode: null,
    label,
    dimensionCode,
    groupLabel: null,
    origin: 'AUTOMATIC' as const,
    assertionId: null,
    removed: false,
    reason: { type: 'TEXT' as const, term: label, excerpt: null },
    ...extra,
  };
}

function view(tags: ReturnType<typeof tag>[], status: PublicationTaxonomyView['status'] = 'CLASSIFIED'): PublicationTaxonomyView {
  return {
    publicationId: 'p',
    publicationVersionId: 'v',
    release: null,
    status,
    classifiedAt: null,
    sections: [{ name: 'Todas', order: 1, tags }],
  };
}

const CV100 = view([
  tag('sector', 'sector.agribusiness', 'Agronegócio', { reason: { type: 'PRODUCTS', term: 'Uréia', excerpt: null } }),
  tag('product', 'product.urea', 'Uréia'),
  tag('tax', 'tax.icms', 'ICMS'),
  tag('theme', 'theme.tax_base_reduction', 'Redução de base de cálculo'),
  tag('act_type', 'act_type.icms_agreement', 'Convênio ICMS'),
  tag('product', 'product.soy', 'Soja', { removed: true }),
]);

test('weights: product/segment 3, tax/operation/theme 2; act type does not count', () => {
  const result = computePublicationAffinity({
    view: CV100,
    profileCodes: ['sector.agribusiness', 'product.urea', 'tax.icms', 'theme.tax_base_reduction', 'act_type.icms_agreement'],
    profileProductGroups: new Map(),
  });
  assert.equal(result.status, 'OK');
  assert.equal(result.score, 3 + 3 + 2 + 2);
  assert.equal(result.level, 'HIGH');
  assert.deepEqual(result.matches.map((m) => m.code), ['sector.agribusiness', 'product.urea', 'tax.icms', 'theme.tax_base_reduction']);
});

test('levels: tax only is low, tax + theme is medium, segment only is medium, nothing is none', () => {
  const run = (codes: string[]) =>
    computePublicationAffinity({ view: CV100, profileCodes: codes, profileProductGroups: new Map() });
  assert.equal(run(['tax.icms']).level, 'LOW');
  assert.equal(run(['tax.icms', 'theme.tax_base_reduction']).level, 'MEDIUM');
  assert.equal(run(['sector.agribusiness']).level, 'MEDIUM');
  assert.equal(run(['tax.ipi']).level, 'NONE');
  // A tag the curator removed never counts.
  assert.equal(run(['product.soy']).level, 'NONE');
  // Score without products/segments never reaches HIGH.
  assert.equal(affinityLevel(8, false), 'MEDIUM');
});

test('a product group cited by NCM matches the profile products of that group', () => {
  const group = view([
    {
      ...tag('product', '', 'Fertilizantes e corretivos'),
      kind: 'GROUP' as const,
      conceptCode: null as unknown as string,
      groupCode: 'fertilizantes',
    },
  ]);
  const result = computePublicationAffinity({
    view: group,
    profileCodes: ['product.urea'],
    profileProductGroups: new Map([['product.urea', 'fertilizantes']]),
  });
  assert.equal(result.matches[0]?.via, 'PRODUCT_GROUP');
  assert.equal(result.level, 'MEDIUM');
});

test('no profile and not yet classified are reported as such', () => {
  assert.equal(
    computePublicationAffinity({ view: CV100, profileCodes: [], profileProductGroups: new Map() }).status,
    'NO_PROFILE',
  );
  // Any profile parameter starts the comparison, even without codes.
  assert.equal(
    computePublicationAffinity({ view: CV100, profileCodes: [], profileProductGroups: new Map(), hasProfile: true }).level,
    'NONE',
  );
  assert.equal(
    computePublicationAffinity({ view: view([], 'DISABLED'), profileCodes: ['tax.icms'], profileProductGroups: new Map() }).status,
    'NOT_CLASSIFIED',
  );
});

test('NCMs of the company mentioned in the act count like a product, even before classification', () => {
  const pending = view([], 'PENDING');
  const ncmOnly = computePublicationAffinity({
    view: pending,
    profileCodes: [],
    profileProductGroups: new Map(),
    profileNcms: ['31021010'],
    publicationNcms: [
      { code: '31021010', description: 'Ureia com teor de nitrogênio superior a 45 %' },
      { code: '10063011', description: 'Arroz' },
    ],
  });
  assert.equal(ncmOnly.status, 'OK');
  assert.equal(ncmOnly.level, 'MEDIUM');
  assert.deepEqual(ncmOnly.matches, [
    {
      code: '31021010',
      label: '3102.10.10 · Ureia com teor de nitrogênio superior a 45 %',
      dimensionCode: 'ncm',
      weight: 3,
      via: 'SAME_ITEM',
    },
  ]);

  // NCM + tax tags of a classified act: strong (NCM) and above 5 = HIGH.
  const both = computePublicationAffinity({
    view: CV100,
    profileCodes: ['tax.icms'],
    profileProductGroups: new Map(),
    profileNcms: ['31021010'],
    publicationNcms: [{ code: '31021010', description: null }],
  });
  assert.equal(both.level, 'HIGH');
  assert.deepEqual(both.matches.map((m) => m.code), ['31021010', 'tax.icms']);

  // No NCM in common and not classified: still pending classification.
  const none = computePublicationAffinity({
    view: pending,
    profileCodes: [],
    profileProductGroups: new Map(),
    profileNcms: ['31021010'],
    publicationNcms: [],
  });
  assert.equal(none.status, 'NOT_CLASSIFIED');
});

test('a single free-text item of the profile is compared: same tag name, or written in the act', () => {
  const run = (profileTerms: Parameters<typeof computePublicationAffinity>[0]['profileTerms'], actText: string | null = null) =>
    computePublicationAffinity({ view: CV100, profileCodes: [], profileProductGroups: new Map(), hasProfile: true, profileTerms, actText });

  // A keyword equal to a tag of the act counts as that tag.
  const keyword = run([{ term: 'reducao de base de calculo', kind: 'keyword' }]);
  assert.deepEqual(keyword.matches.map((m) => m.code), ['theme.tax_base_reduction']);
  // A product typed by the user equal to a product tag counts as that product.
  assert.equal(run([{ term: 'Ureia', kind: 'product' }]).matches[0]?.code, 'product.urea');
  // Otherwise the term written in the wording in force counts by text.
  const text = run(
    [{ term: 'Martelete', kind: 'product' }, { term: 'Lucro Real', kind: 'regime' }, { term: 'drone', kind: 'keyword' }],
    'Ficam isentas as saídas de marteletes e do martelete rompedor por empresa do lucro real.',
  );
  assert.deepEqual(text.matches.map((m) => [m.label, m.via, m.weight]), [
    ['Martelete', 'TEXT', 2],
    ['Lucro Real', 'TEXT', 1],
  ]);
  assert.equal(text.level, 'MEDIUM');
  // Text matches count even before the act is classified.
  const unclassified = computePublicationAffinity({
    view: view([], 'DISABLED'),
    profileCodes: [],
    profileProductGroups: new Map(),
    hasProfile: true,
    profileTerms: [{ term: 'Martelete', kind: 'product' }],
    actText: 'martelete',
  });
  assert.equal(unclassified.status, 'OK');
});

test('R3 F05: lexical relevance must not span independent CURRENT legal fragments', () => {
  const run = (actFragments: string[]) => computePublicationAffinity({
    view: view([], 'PENDING'),
    profileCodes: [],
    profileProductGroups: new Map(),
    hasProfile: true,
    profileTerms: [{ term: 'crédito presumido', kind: 'keyword' }],
    actFragments,
  });
  const separate = run(['Crédito', 'presumido']);
  assert.equal(separate.matches.some((match) => match.via === 'TEXT'), false);
  assert.equal(separate.status, 'NOT_CLASSIFIED');
  const together = run(['Concede-se crédito presumido para operações internas.']);
  assert.equal(together.matches[0]?.via, 'TEXT');
  assert.equal(together.matches[0]?.label, 'crédito presumido');
});
