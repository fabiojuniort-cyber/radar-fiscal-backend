import assert from 'node:assert/strict';
import { test } from 'node:test';

import { attachF2SourceSuggestions } from '../src/modules/taxonomy/curation/curation.f2-source.js';
import type { ReleaseView, SqlRunner } from '../src/modules/taxonomy/curation/curation.read.js';

const SEGMENT_SHA = '588a89871044a1ca67036fb5c17cdba3ba70f447bd1412fc476f14bb1d6440cd';
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

test('F2 source: duplicate CNAEs and wrong source hash fail closed', async () => {
  const view = mkView();
  const row = {
    cnae_code: '0111301', atuacao: 'Produção agropecuária',
    suggested_products: '', suggested_ncms: '', source_sha256: SEGMENT_SHA,
    source_batch_id: 'batch-1',
  };
  await assert.rejects(
    attachF2SourceSuggestions(async <T>() => [row, row] as T[], view),
    /F2_SOURCE_DUPLICATE_CNAE/,
  );
  await assert.rejects(
    attachF2SourceSuggestions(async <T>() =>
      [{ ...row, source_sha256: '0'.repeat(64) }] as T[], view),
    /F2_SOURCE_HASH_MISMATCH/,
  );
});
