import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizePublication } from '../src/modules/collection/publication.normalizer.js';

const sourceA =
  '11111111-1111-4111-8111-111111111111';
const sourceB =
  '22222222-2222-4222-8222-222222222222';

test('same source publication normalizes to stable identity and content hashes', () => {
  const publication = {
    title: '  Ajuste   SINIEF  10/2026 ',
    agency: ' CONFAZ ',
    sphere: 'FEDERAL' as const,
    actType: ' Ajuste SINIEF ',
    actNumber: '10/2026',
    publishedAt: new Date('2026-09-19T15:00:00Z'),
    effectiveAt: new Date('2026-10-01T00:00:00Z'),
    content: 'Texto   integral da norma.',
    officialUrl: 'https://example.gov/ato/10-2026',
    externalId: ' ato-10-2026 ',
  };

  const first = normalizePublication({
    sourceId: sourceA,
    publication,
  });
  const second = normalizePublication({
    sourceId: sourceA,
    publication,
  });

  assert.equal(first.identityHash, second.identityHash);
  assert.equal(first.contentHash, second.contentHash);
  assert.equal(first.identityStrength, 'STRONG');
  assert.equal(first.title, 'Ajuste SINIEF 10/2026');
  assert.equal(first.contentText, 'Texto integral da norma.');
});

test('same strong identity with changed content produces a new content hash', () => {
  const base = {
    title: 'Convênio ICMS 100/2026',
    agency: 'CONFAZ',
    sphere: 'FEDERAL' as const,
    actType: 'Convênio ICMS',
    actNumber: '100/2026',
    publishedAt: new Date('2026-09-19T00:00:00Z'),
    officialUrl: 'https://source-a.gov/100-2026',
  };

  const first = normalizePublication({
    sourceId: sourceA,
    publication: {
      ...base,
      content: 'Versão original.',
    },
  });

  const updated = normalizePublication({
    sourceId: sourceA,
    publication: {
      ...base,
      content: 'Versão atualizada.',
    },
  });

  assert.equal(first.identityHash, updated.identityHash);
  assert.notEqual(first.contentHash, updated.contentHash);
});

test('strong identity merges across sources only when normative identity is complete', () => {
  const publicationA = normalizePublication({
    sourceId: sourceA,
    publication: {
      title: 'Ato 42',
      agency: 'Órgão X',
      sphere: 'STATE',
      stateCode: 'go',
      actType: 'Portaria',
      actNumber: '42/2026',
      publishedAt: new Date('2026-09-19T12:00:00Z'),
      officialUrl: 'https://source-a.gov/42',
      externalId: 'source-a-42',
    },
  });

  const publicationB = normalizePublication({
    sourceId: sourceB,
    publication: {
      title: 'Ato 42 republicado em outra fonte',
      agency: 'ÓRGÃO X',
      sphere: 'STATE',
      stateCode: 'GO',
      actType: 'PORTARIA',
      actNumber: '42/2026',
      publishedAt: new Date('2026-09-19T18:00:00Z'),
      officialUrl: 'https://source-b.gov/42',
      externalId: 'source-b-999',
    },
  });

  assert.equal(publicationA.identityStrength, 'STRONG');
  assert.equal(publicationB.identityStrength, 'STRONG');
  assert.equal(
    publicationA.identityHash,
    publicationB.identityHash,
  );
});

test('weak similar publications from different sources do not auto-merge', () => {
  const publicationA = normalizePublication({
    sourceId: sourceA,
    publication: {
      title: 'Comunicado tributário',
      sphere: 'FEDERAL',
      officialUrl: 'https://source-a.gov/comunicado',
      content: 'Mesmo texto.',
    },
  });

  const publicationB = normalizePublication({
    sourceId: sourceB,
    publication: {
      title: 'Comunicado tributário',
      sphere: 'FEDERAL',
      officialUrl: 'https://source-b.gov/comunicado',
      content: 'Mesmo texto.',
    },
  });

  assert.equal(
    publicationA.identityStrength,
    'SOURCE_SCOPED',
  );
  assert.equal(
    publicationB.identityStrength,
    'SOURCE_SCOPED',
  );
  assert.notEqual(
    publicationA.identityHash,
    publicationB.identityHash,
  );
});

test('source-scoped identity prefers stable externalId over URL', () => {
  const first = normalizePublication({
    sourceId: sourceA,
    publication: {
      title: 'Comunicado sem identidade normativa forte',
      sphere: 'FEDERAL',
      officialUrl: 'https://example.gov/old-url',
      externalId: 'external-123',
    },
  });

  const moved = normalizePublication({
    sourceId: sourceA,
    publication: {
      title: 'Comunicado sem identidade normativa forte',
      sphere: 'FEDERAL',
      officialUrl: 'https://example.gov/new-url',
      externalId: 'external-123',
    },
  });

  assert.equal(first.identityHash, moved.identityHash);
  assert.equal(first.sourceItemKey, 'external-123');
});

test('state publications require a valid UF', () => {
  assert.throws(
    () =>
      normalizePublication({
        sourceId: sourceA,
        publication: {
          title: 'Ato estadual',
          sphere: 'STATE',
          officialUrl: 'https://example.gov/state',
        },
      }),
    /stateCode is required/,
  );
});

test('federal publications reject UF to avoid ambiguous scope', () => {
  assert.throws(
    () =>
      normalizePublication({
        sourceId: sourceA,
        publication: {
          title: 'Ato federal',
          sphere: 'FEDERAL',
          stateCode: 'GO',
          officialUrl: 'https://example.gov/federal',
        },
      }),
    /stateCode must be omitted/,
  );
});
