import assert from 'node:assert/strict';
import { test } from 'node:test';

import { attachF2SourceSuggestions, F2_SOURCE_SEGMENT_SHA256 } from '../src/modules/taxonomy/curation/curation.f2-source.js';
import type { ReleaseView, SqlRunner } from '../src/modules/taxonomy/curation/curation.read.js';

const SEGMENT_SHA = F2_SOURCE_SEGMENT_SHA256;
const mkView = (): ReleaseView => ({
  release: { id: 'release-test', version: 'v1', status: 'DRAFT', createdAt: '', publishedAt: null, previousReleaseId: null, changeNotes: null },
  dimensions: [], groups: [],
  concepts: [
    { code: 'sector.cnae_rice', dimensionCode: 'sector', membershipStatus: 'INCLUDED', officialCodes: ['0111301'] },
    { code: 'sector.general', dimensionCode: 'sector', membershipStatus: 'INCLUDED', officialCodes: ['01'] },
    { code: 'product.rice', dimensionCode: 'product', membershipStatus: 'INCLUDED', officialCodes: ['0111301'] },
    { code: 'sector.double', dimensionCode: 'sector', membershipStatus: 'INCLUDED', officialCodes: ['0111301','0111302'] },
    { code: 'sector.retired', dimensionCode: 'sector', membershipStatus: 'RETIRED', officialCodes: ['0111301'] },
  ] as unknown as ReleaseView['concepts'],
});

test('F2 source: admin overlay uses exact 7-digit CNAE and remains read-only', async () => {
  const view = mkView();
  let reads = 0;
  const run: SqlRunner = async <T>(sql: string, params: readonly unknown[] = []) => {
    reads++;
    assert.match(sql, /^SELECT cnae_code/);
    assert.match(sql, /FROM taxonomy_f2_segment_suggestions_readonly/);
    assert.deepEqual(params, [['0111301']]);
    return [{
      cnae_code: '0111301', atuacao: 'Produção agropecuária',
      suggested_products: 'Arroz em casca', suggested_ncms: '1006.10.92',
      source_sha256: SEGMENT_SHA, source_batch_id: 'batch-1',
    }] as T[];
  };
  const updated = await attachF2SourceSuggestions(run, view);
  assert.equal(reads, 1);
  assert.deepEqual(updated.concepts[0]?.f2Source, {
    atuacao: 'Produção agropecuária',
    suggestedProducts: 'Arroz em casca',
    suggestedNcms: '1006.10.92',
    sourceSha256: SEGMENT_SHA, sourceBatchId: 'batch-1',
  });
  assert.deepEqual(updated.concepts.slice(1).map(concept => concept.f2Source),
    [undefined, undefined, undefined, undefined]);
  assert.equal(view.concepts[0]?.f2Source, undefined, 'read must not mutate original release');
});

test('F2 source: absent stage returns unchanged view, never fabricates suggestions', async () => {
  const view = mkView();
  const updated = await attachF2SourceSuggestions(async () => [], view);
  assert.equal(updated, view);
  assert.ok(updated.concepts.every(concept => concept.f2Source === undefined));
});

test('F2 source: no exact CNAE never reads staging at all', async () => {
  const view = mkView();
  view.concepts = view.concepts.slice(1);
  const updated = await attachF2SourceSuggestions(async () => {
    throw new Error('should not read');
  }, view);
  assert.equal(updated, view);
});

test('F2 source: duplicate CNAEs or wrong source hash omit overlay, never crash the curator', async () => {
  const view = mkView();
  const row = {
    cnae_code: '0111301', atuacao: 'Produção agropecuária',
    suggested_products: '', suggested_ncms: '', source_sha256: SEGMENT_SHA,
    source_batch_id: 'batch-1',
  };
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
  try {
    const duplicate = await attachF2SourceSuggestions(
      async <T>() => [row, row] as T[], view,
    );
    assert.equal(duplicate, view);
    assert.deepEqual(duplicate.concepts.map(c => c.f2Source),
      [undefined, undefined, undefined, undefined, undefined]);

    const mismatch = await attachF2SourceSuggestions(
      async <T>() => [{ ...row, source_sha256: '0'.repeat(64) }] as T[], view,
    );
    assert.equal(mismatch, view);
    assert.ok(mismatch.concepts.every(c => c.f2Source === undefined));
    assert.deepEqual(warnings, [
      'F2_SOURCE_SUGGESTIONS_SKIPPED=F2_SOURCE_DUPLICATE_CNAE',
      'F2_SOURCE_SUGGESTIONS_SKIPPED=F2_SOURCE_HASH_MISMATCH',
    ]);
  } finally {
    console.warn = originalWarn;
  }
});

test('F2 source: unavailable SQL view only drops suggestions, original release still loads', async () => {
  const view = mkView();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
  try {
    const unchanged = await attachF2SourceSuggestions(async () => {
      throw new Error('permission denied: never expose SQL credentials');
    }, view);
    assert.equal(unchanged, view);
    assert.deepEqual(warnings, ['F2_SOURCE_SUGGESTIONS_SKIPPED=F2_SOURCE_OVERLAY_UNAVAILABLE']);
  } finally {
    console.warn = originalWarn;
  }
});
