import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSearchTsquery } from '../src/modules/catalog/search-query.js';

test('last word matches as a prefix while it is being typed', () => {
  assert.equal(buildSearchTsquery('Conv'), 'conv:*');
  assert.equal(buildSearchTsquery('Convênio ic'), 'convênio & ic:*');
});

test('numbers stay exact so 1216 does not match 12160', () => {
  assert.equal(buildSearchTsquery('Portaria 1216'), 'portaria & 1216');
});

test('tsquery operators typed by the user are discarded', () => {
  assert.equal(
    buildSearchTsquery("lei & !(x | y) <-> 'a':* \\ ;"),
    'lei & x & y & a:*',
  );
});

test('accents are kept for the unaccent configuration to normalize', () => {
  assert.equal(buildSearchTsquery('ICMS São Paulo'), 'icms & são & paulo:*');
});

test('nothing searchable yields null', () => {
  assert.equal(buildSearchTsquery('  -- !! ..'), null);
});

test('at most 12 terms are used', () => {
  const query = buildSearchTsquery(
    Array.from({ length: 20 }, (_, index) => `t${index}`).join(' '),
  );
  assert.equal(query?.split(' & ').length, 12);
});

test('stopwords are passed through for PostgreSQL to drop', () => {
  // The pt_unaccent configuration removes "de"; an all-stopword query
  // becomes empty in PostgreSQL and matches nothing (covered by the
  // integration test).
  assert.equal(buildSearchTsquery('Lei de'), 'lei & de:*');
  assert.equal(buildSearchTsquery('de da'), 'de & da:*');
});
