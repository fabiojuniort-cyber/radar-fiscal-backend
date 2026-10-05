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

test('weights: product/segment 3, tax/operation 2, theme 1; act type does not count', () => {
  const result = computePublicationAffinity({
    view: CV100,
    profileCodes: ['sector.agribusiness', 'product.urea', 'tax.icms', 'theme.tax_base_reduction', 'act_type.icms_agreement'],
    profileProductGroups: new Map(),
  });
  assert.equal(result.status, 'OK');
  assert.equal(result.score, 3 + 3 + 2 + 1);
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
  assert.equal(
    computePublicationAffinity({ view: view([], 'DISABLED'), profileCodes: ['tax.icms'], profileProductGroups: new Map() }).status,
    'NOT_CLASSIFIED',
  );
});
