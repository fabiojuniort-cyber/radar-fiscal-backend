import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeLegalPresentationHtml } from '../src/modules/collection/legal-presentation.js';
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
  assert.equal(first.contentText, 'Texto   integral da norma.');
});

test('document layout is preserved without changing canonical content hash semantics', () => {
  const structured = normalizePublication({
    sourceId: sourceA,
    publication: {
      title: 'Portaria 10/2026',
      agency: 'Órgão X',
      sphere: 'FEDERAL',
      actType: 'Portaria',
      actNumber: '10/2026',
      publishedAt: new Date('2026-09-30T00:00:00Z'),
      officialUrl: 'https://example.gov/portaria-10',
      content: [
        'CAPÍTULO I',
        '',
        'Art. 1º  Esta Portaria dispõe sobre:',
        '    I - primeiro item;',
        '    II - segundo item.',
      ].join('\n'),
    },
  });

  const flattened = normalizePublication({
    sourceId: sourceA,
    publication: {
      title: 'Portaria 10/2026',
      agency: 'Órgão X',
      sphere: 'FEDERAL',
      actType: 'Portaria',
      actNumber: '10/2026',
      publishedAt: new Date('2026-09-30T00:00:00Z'),
      officialUrl: 'https://example.gov/portaria-10',
      content:
        'CAPÍTULO I Art. 1º Esta Portaria dispõe sobre: I - primeiro item; II - segundo item.',
    },
  });

  assert.equal(
    structured.contentText,
    [
      'CAPÍTULO I',
      '',
      'Art. 1º  Esta Portaria dispõe sobre:',
      '    I - primeiro item;',
      '    II - segundo item.',
    ].join('\n'),
  );
  assert.equal(
    structured.contentHash,
    flattened.contentHash,
    'presentation whitespace must not create a semantic version',
  );
  assert.deepEqual(
    structured.metadata.presentation,
    {
      version: 1,
      format: 'PRESERVED_TEXT',
      preservesWhitespace: true,
    },
  );
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


test('raw attachment hash participates in content versioning and metadata preservation', () => {
  const first = normalizePublication({
    sourceId: sourceA,
    publication: {
      title: 'Ato com anexo',
      agency: 'Órgão X',
      sphere: 'FEDERAL',
      actType: 'Portaria',
      actNumber: '500/2026',
      publishedAt: new Date(
        '2026-09-19T00:00:00Z',
      ),
      content: 'Mesmo texto extraído.',
      officialUrl:
        'https://example.gov/ato-500',
      files: [
        {
          url: 'https://example.gov/anexo.pdf',
          name: 'Anexo.pdf',
          mimeType: 'application/pdf',
          rawSha256:
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          sizeBytes: 1234,
        },
      ],
    },
  });

  const changed = normalizePublication({
    sourceId: sourceA,
    publication: {
      title: 'Ato com anexo',
      agency: 'Órgão X',
      sphere: 'FEDERAL',
      actType: 'Portaria',
      actNumber: '500/2026',
      publishedAt: new Date(
        '2026-09-19T00:00:00Z',
      ),
      content: 'Mesmo texto extraído.',
      officialUrl:
        'https://example.gov/ato-500',
      files: [
        {
          url: 'https://example.gov/anexo.pdf',
          name: 'Anexo.pdf',
          mimeType: 'application/pdf',
          rawSha256:
            'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          sizeBytes: 1234,
        },
      ],
    },
  });

  assert.equal(
    first.identityHash,
    changed.identityHash,
  );
  assert.notEqual(
    first.contentHash,
    changed.contentHash,
  );
  assert.equal(first.files.length, 1);
  assert.deepEqual(
    first.metadata.files,
    first.files,
  );
});

test('invalid attachment hashes fail normalization', () => {
  assert.throws(
    () =>
      normalizePublication({
        sourceId: sourceA,
        publication: {
          title: 'Ato com anexo inválido',
          sphere: 'FEDERAL',
          officialUrl:
            'https://example.gov/invalid-file',
          files: [
            {
              url: 'https://example.gov/file.pdf',
              rawSha256: 'invalid',
            },
          ],
        },
      }),
    /64 hexadecimal characters/,
  );
});


test('canonical identity key correlates mirrored origins inside one logical source', () => {
  const primary = normalizePublication({
    sourceId: sourceA,
    publication: {
      title: 'Guia Prático EFD ICMS IPI versão 3.2.4',
      agency: 'SPED/RFB',
      sphere: 'FEDERAL',
      actType: 'GUIA PRÁTICO SPED',
      actNumber: 'v3.2.4',
      publishedAt: new Date('2026-09-10T00:00:00Z'),
      officialUrl: 'https://www.gov.br/sped/pt-br/guia-3-2-4',
      externalId: 'govbr:/sped/pt-br/guia-3-2-4',
      identityKey: 'SPED|EFD_ICMS_IPI|EFD ICMS/IPI Guia Prático|3.2.4|OFFICIAL_VERSION',
    },
  });

  const legacy = normalizePublication({
    sourceId: sourceA,
    publication: {
      title: 'Guia Prático EFD ICMS IPI versão 3.2.4',
      agency: 'SPED/RFB',
      sphere: 'FEDERAL',
      actType: 'GUIA PRÁTICO SPED',
      actNumber: 'v3.2.4',
      publishedAt: new Date('2026-09-09T00:00:00Z'),
      officialUrl: 'https://sped.rfb.gov.br/item/show/9999',
      externalId: 'item:9999',
      identityKey: 'SPED|EFD_ICMS_IPI|EFD ICMS/IPI Guia Prático|3.2.4|OFFICIAL_VERSION',
    },
  });

  assert.equal(primary.identityStrength, 'SOURCE_SCOPED');
  assert.equal(primary.identityBasis.sourceKeyType, 'CANONICAL_KEY');
  assert.equal(primary.identityHash, legacy.identityHash);
  assert.notEqual(primary.sourceItemKey, legacy.sourceItemKey);
});


test('sanitizes source presentation HTML while preserving legal structure', () => {
  const sanitized =
    sanitizeLegalPresentationHtml(
      [
        '<script>alert(1)</script>',
        '<h2 onclick="evil()">CAPÍTULO I</h2>',
        '<p style="position:fixed">Art. 1º Texto.</p>',
        '<table>',
        '<tr><th scope="col">Tributo</th><th colspan="2">Alíquota</th></tr>',
        '<tr><td>ICMS</td><td>18%</td></tr>',
        '</table>',
        '<a href="javascript:alert(1)">ruim</a>',
        '<a href="https://example.gov/ato">oficial</a>',
      ].join(''),
    );

  assert.ok(sanitized);
  assert.doesNotMatch(
    sanitized,
    /script|onclick|style=|javascript:/i,
  );
  assert.match(
    sanitized,
    /<h2>CAPÍTULO I<\/h2>/,
  );
  assert.match(
    sanitized,
    /<table>/,
  );
  assert.match(
    sanitized,
    /colspan="2"/,
  );
  assert.match(
    sanitized,
    /href="https:\/\/example\.gov\/ato"/,
  );
});

test('keeps only the official legal paragraph classes in presentation HTML', () => {
  const sanitized = sanitizeLegalPresentationHtml(
    [
      '<p class="DataPublicao">Publicado no DOU de 06.11.97.</p>',
      '<p class="Remisso evil-overlay">Nova redação dada ao caput.</p>',
      '<p class="RedaoAnt">Redação anterior.</p>',
      '<p class="hidden">Texto.</p>',
      '<p class="x&quot; onclick=&quot;evil()">Outro.</p>',
    ].join(''),
  );

  assert.ok(sanitized);
  assert.match(sanitized, /<p class="DataPublicao">Publicado/);
  assert.match(sanitized, /<p class="Remisso">Nova redação/);
  assert.match(sanitized, /<p class="RedaoAnt">Redação anterior/);
  assert.match(sanitized, /<p>Texto\.<\/p>/);
  assert.match(sanitized, /<p>Outro\.<\/p>/);
  assert.doesNotMatch(sanitized, /evil|hidden|onclick/);
});
