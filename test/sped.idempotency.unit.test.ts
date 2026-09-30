import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizePublication } from '../src/modules/collection/publication.normalizer.js';
import { SpedConnector, sameIdentityExceptTitleFamily, spedBaseIdentityKey } from '../src/modules/collection/sped.connector.js';
import { descriptorFromPage, parseSpedPage } from '../src/modules/collection/sped.parser.js';
import type { ConnectorPublication } from '../src/modules/collection/connector.contract.js';
import {
  GOV,
  documentHtml,
  fakePortal,
  productionLikeInventory,
  type FakeDocument,
} from './sped.govbr.fixtures.js';

const CONTEXT = {
  sourceId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  attemptId: '33333333-3333-4333-8333-333333333333',
  signal: new AbortController().signal,
};

function contentHashes(publications: ConnectorPublication[]): Map<string, string> {
  return new Map(publications.map((publication) => [
    publication.externalId!,
    normalizePublication({ sourceId: CONTEXT.sourceId, publication }).contentHash,
  ]));
}

function descriptorFor(module: 'EFD_ICMS_IPI' | 'EFD_CONTRIBUICOES' | 'EFD_REINF' | 'DERE', doc: FakeDocument) {
  const page = parseSpedPage(documentHtml(doc), GOV + doc.path);
  const descriptor = descriptorFromPage(module, page);
  assert.ok(descriptor, 'expected a document descriptor for ' + doc.title);
  return descriptor;
}

// ---------------------------------------------------------------------------
// Teste C — content_hash stability
// ---------------------------------------------------------------------------

test('C: volatile gov.br portal data never reaches document content', () => {
  const doc: FakeDocument = {
    path: '/assuntos/comunicados/efd-reinf/nota-tecnica-01-2026',
    title: 'Nota Técnica 01/2026 – Ajustes nos leiautes da versão 2.1.2',
    type: 'Document',
    published: '25/03/2026',
    body: 'Tendo em vista a redução dos benefícios fiscais instituída pela Lei Complementar nº 224/2025.',
  };
  const first = parseSpedPage(documentHtml(doc), GOV + doc.path);
  const second = parseSpedPage(documentHtml(doc), GOV + doc.path);

  assert.equal(first.documentTextSource, 'VOLTO_CONTENT');
  assert.equal(first.documentText, second.documentText);
  assert.doesNotMatch(first.text, /window\.__data|window\.env|rpid=|color:red/);
  assert.doesNotMatch(first.documentText, /router|Ir para o conteúdo|Creative Commons|Compartilhe/);
  assert.match(first.documentText, /Lei Complementar nº 224\/2025/);
});

test('C: same documents fetched twice produce the same content_hash; a real text change produces a new one', async () => {
  const inventory = productionLikeInventory();
  const portal = fakePortal(inventory);
  const connector = new SpedConnector({ fetch: portal.fetch });

  const first = contentHashes((await connector.collect(CONTEXT)).publications);
  const second = contentHashes((await connector.collect(CONTEXT)).publications);
  assert.ok(first.size >= 10);
  assert.deepEqual([...second.entries()].sort(), [...first.entries()].sort());

  const announcement = inventory.documents.find((doc) => doc.path.includes('/comunicados/'))!;
  announcement.body = announcement.body + ' Prazo prorrogado para 01/01/2027.';
  const changed = contentHashes((await connector.collect(CONTEXT)).publications);
  const differing = [...changed.entries()].filter(([externalId, hash]) => first.get(externalId) !== hash);
  assert.deepEqual(differing.map(([externalId]) => externalId), ['govbr:' + '/sped/pt-br' + announcement.path]);
});

// ---------------------------------------------------------------------------
// Teste D — identity collisions
// ---------------------------------------------------------------------------

test('D: different official documents never share a base identity key', () => {
  const reinf = '/assuntos/escrituracoes-digitais/efd-reinf';
  const icms = '/assuntos/escrituracoes-digitais/efd-icms-ipi/manuais-e-documentos-tecnicos';
  const cases: Array<[Parameters<typeof descriptorFor>[0], FakeDocument]> = [
    // Guides: different official versions.
    ['EFD_ICMS_IPI', { path: icms + '/guia-3-2-3', title: 'Guia Prático da EFD ICMS IPI 3.2.3.pdf', type: 'File', created: '01/07/2026', file: 'g323' }],
    ['EFD_ICMS_IPI', { path: icms + '/guia-3-2-4', title: 'Guia Prático EFD - Versão 3.2.4.pdf', type: 'File', created: '03/09/2026', file: 'g324' }],
    // Manuals without version at different official locations.
    ['EFD_REINF', { path: reinf + '/versao-atual/manual', title: 'Manual de Orientação do Usuário', type: 'File', created: '02/06/2026', file: 'ma' }],
    ['EFD_REINF', { path: reinf + '/historico/manual', title: 'Manual de Orientação do Usuário', type: 'File', created: '02/06/2025', file: 'mb' }],
    // XSD pages without number/version (current vs history).
    ['EFD_REINF', { path: reinf + '/versao-atual/esquemas-xsd', title: 'Esquemas XSD', type: 'Document', published: '02/06/2026', body: 'Atual' }],
    ['EFD_REINF', { path: reinf + '/historico/esquemas-xsd', title: 'Esquemas XSD', type: 'Document', published: '02/06/2026', body: 'Histórico' }],
    ['EFD_REINF', { path: reinf + '/versao-atual/xsd-4010', title: 'XSD Evento R-4010', type: 'File', created: '02/06/2026', file: 'x4010' }],
    ['EFD_REINF', { path: reinf + '/versao-atual/xsd-1000', title: 'XSD Evento R-1000', type: 'File', created: '02/06/2026', file: 'x1000' }],
    // Tables.
    ['EFD_CONTRIBUICOES', { path: '/assuntos/escrituracoes-digitais/efd-contribuicoes/tabela-4-3-1', title: 'Tabela 4.3.1 - Tabela Código de Situação Tributária', type: 'File', created: '01/01/2026', file: 't431' }],
    ['EFD_CONTRIBUICOES', { path: '/assuntos/escrituracoes-digitais/efd-contribuicoes/tabela-4-3-2', title: 'Tabela 4.3.2 - Tabela Código de Situação Tributária', type: 'File', created: '01/01/2026', file: 't432' }],
    // Notes: technical/orientation, document vs announcement.
    ['EFD_REINF', { path: reinf + '/notas/1-2026', title: 'Nota técnica EFD-Reinf 1-2026', type: 'File', created: '02/06/2026', file: 'nt1' }],
    ['EFD_REINF', { path: reinf + '/notas/2-2026', title: 'Nota técnica EFD-Reinf 2-2026', type: 'File', created: '02/07/2026', file: 'nt2' }],
    ['EFD_REINF', { path: '/assuntos/comunicados/efd-reinf/nt-01-2026', title: 'Nota Técnica 01/2026 – Ajustes nos leiautes', type: 'Document', published: '25/03/2026', body: 'Comunicado' }],
    ['EFD_ICMS_IPI', { path: icms + '/no-2026-001', title: 'Nota Orientativa EFD ICMS IPI 2026.001 v1.0', type: 'File', created: '01/08/2026', file: 'no1' }],
    // Operational notices without number/version.
    ['EFD_ICMS_IPI', { path: '/assuntos/comunicados/efd-icms-ipi/indisponibilidade-10-09', title: 'Indisponibilidade do ambiente de recepção', type: 'Document', published: '10/09/2026', body: 'Janela A' }],
    ['EFD_ICMS_IPI', { path: '/assuntos/comunicados/efd-icms-ipi/indisponibilidade-20-09', title: 'Indisponibilidade do ambiente de recepção', type: 'Document', published: '20/09/2026', body: 'Janela B' }],
  ];

  const descriptors = cases.map(([module, doc]) => descriptorFor(module, doc));
  const keys = descriptors.map((descriptor) => spedBaseIdentityKey(descriptor));
  const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
  assert.deepEqual(duplicates, [], 'identity collisions: ' + JSON.stringify(duplicates));

  const byTitle = new Map(descriptors.map((descriptor, index) => [descriptor.title + '@' + descriptor.canonicalPath, keys[index]!]));
  // Numbered/versioned documents keep a portal-independent key (no PATH part),
  // which is what allows gov.br x legacy correlation.
  assert.doesNotMatch(byTitle.get('Guia Prático EFD - Versão 3.2.4.pdf@' + '/sped/pt-br' + icms + '/guia-3-2-4')!, /PATH:/);
  assert.doesNotMatch(byTitle.get('Nota técnica EFD-Reinf 1-2026@/sped/pt-br' + reinf + '/notas/1-2026')!, /PATH:/);
  // Weak identities (no number, no version) use the canonical path fallback.
  assert.match(byTitle.get('Esquemas XSD@/sped/pt-br' + reinf + '/historico/esquemas-xsd')!, /\|PATH:\/sped\/pt-br\/.*historico\/esquemas-xsd$/);
});

test('D: a real crawl emits distinct keys except for proven mirrors (same files)', async () => {
  const portal = fakePortal(productionLikeInventory());
  const result = await new SpedConnector({ fetch: portal.fetch }).collect(CONTEXT);
  const groups = new Map<string, ConnectorPublication[]>();
  for (const publication of result.publications) {
    groups.set(publication.identityKey!, [...(groups.get(publication.identityKey!) ?? []), publication]);
  }
  const shared = [...groups.values()].filter((members) => members.length > 1);
  for (const members of shared) {
    const fileSets = members.map((member) => (member.files ?? []).map((file) => file.rawSha256).sort().join(','));
    assert.ok(fileSets[0], 'shared identity must be backed by files');
    assert.ok(fileSets.every((set) => set === fileSets[0]), 'shared identity must be a proven mirror');
    // Mirrors emit one canonical representation (no alternating versions).
    const hashes = new Set(members.map((member) => normalizePublication({ sourceId: CONTEXT.sourceId, publication: member }).contentHash));
    assert.equal(hashes.size, 1);
  }
  assert.equal(shared.length, 1, 'only the DeRE mirror is expected to share identity');

  const audit = (result.metadata as { sped: { identityAudit: { unresolvedCollisions: number; mirrorGroups: unknown[] } } }).sped.identityAudit;
  assert.equal(audit.unresolvedCollisions, 0);
  assert.equal(audit.mirrorGroups.length, 1);
});

test('D: runtime guard disambiguates two different documents that derive the same base key', async () => {
  const layout = '/assuntos/escrituracoes-digitais/efd-contribuicoes/documentos-tecnicos';
  const documents: FakeDocument[] = [
    { path: layout + '/atual/leiaute', title: 'Leiaute da EFD-Contribuições versão 1.0', type: 'File', created: '01/01/2026', file: 'leiaute-a' },
    { path: layout + '/anterior/leiaute', title: 'Leiaute da EFD-Contribuições versão 1.0', type: 'File', created: '01/01/2025', file: 'leiaute-b' },
  ];
  const portal = fakePortal({ listings: [{ path: layout, title: 'Documentos técnicos', items: documents.map((doc) => doc.path) }], documents });
  const connector = new SpedConnector({ fetch: portal.fetch });
  const result = await connector.collect(CONTEXT);
  const keys = result.publications.map((publication) => publication.identityKey!);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
  const audit = (result.metadata as { sped: { identityAudit: { collisionsResolved: Array<{ baseKey: string; collidedWith: unknown[] }> } } }).sped.identityAudit;
  assert.equal(audit.collisionsResolved.length, 1);
  assert.equal(audit.collisionsResolved[0]!.collidedWith.length, 1);

  // The resolution is stable across runs: replaying with the emitted state
  // gives both origins exactly the same keys, even if only one is seen.
  const state = result.checkpoint!.state as never;
  const replay = await new SpedConnector({
    fetch: portal.fetch,
    readState: async () => state,
    revisitAfterMs: 0,
    maxRechecksPerRun: 100,
  }).collect(CONTEXT);
  assert.deepEqual(
    replay.publications.map((publication) => publication.identityKey).sort(),
    [...keys].sort(),
  );
});

// ---------------------------------------------------------------------------
// gov.br folders (production gate: EFD-Reinf XSD 2.1.2 package)
// ---------------------------------------------------------------------------

test('gov.br folder pages are containers: children are captured and new children are discovered incrementally', async () => {
  const inventory = productionLikeInventory();
  const portal = fakePortal(inventory);
  const first = await new SpedConnector({ fetch: portal.fetch }).collect(CONTEXT);
  const titles = first.publications.map((publication) => publication.title);
  assert.ok(titles.includes('Pacote XSD Eventos EFD Reinf v 2.1.2'), 'XSD package reachable only through the folder');
  assert.ok(titles.includes('XSD Evento R-4010'));
  assert.ok(titles.includes('Esquemas XSD'), 'the folder page itself is still captured');

  const state = first.checkpoint!.state as { pages: Record<string, { kind: string }> };
  const folder = Object.entries(state.pages).find(([url]) => url.endsWith('/versao-atual/esquemas-xsd'));
  assert.equal(folder?.[1].kind, 'CONTAINER');

  // A new package appears inside the folder: the next incremental run finds it.
  const reinf = '/assuntos/escrituracoes-digitais/efd-reinf/manuais-e-documentos-tecnicos';
  const newChild = reinf + '/versao-atual/esquemas-xsd/xsd-2.1.2';
  inventory.documents.push({ path: newChild, title: 'XSD EFD-Reinf v2.1.2 - CNPJ Alfanumérico', type: 'File', created: '20/09/2026', file: 'xsd-cnpj-alfa' });
  inventory.documents.find((doc) => doc.path === reinf + '/versao-atual/esquemas-xsd')!.children!.push(newChild);
  const incremental = await new SpedConnector({
    fetch: fakePortal(inventory).fetch,
    readState: async () => first.checkpoint!.state as never,
  }).collect(CONTEXT);
  const found = incremental.publications.map((publication) => publication.title);
  assert.ok(found.includes('XSD EFD-Reinf v2.1.2 - CNPJ Alfanumérico'));
  assert.ok(!found.includes('Pacote XSD Eventos EFD Reinf v 2.1.2'), 'known documents are still skipped');
  // The CNPJ package and the classic package are distinct publications.
  const keys = new Set([...first.publications, ...incremental.publications].map((publication) => publication.identityKey));
  assert.equal(keys.size, new Set([...first.publications, ...incremental.publications].map((publication) => publication.externalId)).size - 1);
});

// ---------------------------------------------------------------------------
// Production 2026-09-28: gov.br reworded the title of the same DeRE XSD file
// ("06-Arquivos XSD (v.1.2.0)" -> "06-Arquivos XSD (v.1.2.0 PRODUÇÃO)").
// ---------------------------------------------------------------------------

test('a reworded title keeps the origin identity; a new edition still gets a new one', async () => {
  const folder = '/assuntos/documentos-fiscais/dere/manuais-e-documentos-tecnicos/versao-atual-1';
  const xsd: FakeDocument = {
    path: folder + '/06-arquivos-xsd-v-1-2-0.zip',
    title: '06-Arquivos XSD (v.1.2.0)',
    type: 'File',
    created: '05/09/2026',
    file: 'dere-xsd-120',
  };
  const listing = () => ({ path: folder, title: 'Versão atual', items: [xsd.path] });
  const portal = fakePortal({ listings: [listing()], documents: [xsd] });

  const first = await new SpedConnector({ fetch: portal.fetch }).collect(CONTEXT);
  assert.equal(first.publications.length, 1);
  const originalKey = first.publications[0]!.identityKey!;
  const originalHash = normalizePublication({ sourceId: CONTEXT.sourceId, publication: first.publications[0]! }).contentHash;
  const state = first.checkpoint!.state as never;

  // Same file, same URL, same version: only the title changed.
  xsd.title = '06-Arquivos XSD (v.1.2.0 PRODUÇÃO)';
  const renamedPortal = fakePortal({ listings: [listing()], documents: [xsd] });
  const renamed = await new SpedConnector({
    fetch: renamedPortal.fetch,
    readState: async () => state,
    revisitAfterMs: 0,
    maxRechecksPerRun: 100,
  }).collect(CONTEXT);
  const renamedPublication = renamed.publications.find((publication) => publication.externalId === first.publications[0]!.externalId)!;
  assert.ok(renamedPublication, 'the reworded document is still emitted');
  assert.notEqual(spedBaseIdentityKey(descriptorFor('DERE', xsd)), originalKey, 'the derived base key really changed');
  assert.equal(renamedPublication.identityKey, originalKey, 'identity is kept for the same origin');
  assert.notEqual(
    normalizePublication({ sourceId: CONTEXT.sourceId, publication: renamedPublication }).contentHash,
    originalHash,
    'the new title becomes a new version',
  );

  // A new official edition at the same URL is a different document.
  xsd.title = '06-Arquivos XSD (v.1.3.0 PRODUÇÃO)';
  const newEditionPortal = fakePortal({ listings: [listing()], documents: [xsd] });
  const newEdition = await new SpedConnector({
    fetch: newEditionPortal.fetch,
    readState: async () => state,
    revisitAfterMs: 0,
    maxRechecksPerRun: 100,
  }).collect(CONTEXT);
  const newEditionKey = newEdition.publications.find((publication) => publication.externalId === first.publications[0]!.externalId)?.identityKey;
  assert.ok(newEditionKey);
  assert.notEqual(newEditionKey, originalKey);
});

test('a reworded title keeps the persisted identity when the checkpoint dropped it (failed item)', async () => {
  const folder = '/assuntos/documentos-fiscais/dere/manuais-e-documentos-tecnicos/versao-atual-1';
  const xsd: FakeDocument = {
    path: folder + '/06-arquivos-xsd-v-1-2-0.zip',
    title: '06-Arquivos XSD (v.1.2.0)',
    type: 'File',
    created: '05/09/2026',
    file: 'dere-xsd-120',
  };
  const listing = () => ({ path: folder, title: 'Versão atual', items: [xsd.path] });
  const first = await new SpedConnector({ fetch: fakePortal({ listings: [listing()], documents: [xsd] }).fetch }).collect(CONTEXT);
  const original = first.publications[0]!;
  const checkpoint = first.checkpoint!.state as { identities: Record<string, unknown> };

  // Production state after the item failed: readSpedSourceState removed the
  // origin's identity from the checkpoint, but the origin is still linked to
  // the publication persisted with the original key.
  const withoutIdentity = { ...checkpoint, identities: {} };
  xsd.title = '06-Arquivos XSD (v.1.2.0 PRODUÇÃO)';
  const run = (persistedIdentityKeys: Record<string, string>) => new SpedConnector({
    fetch: fakePortal({ listings: [listing()], documents: [xsd] }).fetch,
    readState: async () => ({ ...withoutIdentity, persistedIdentityKeys }) as never,
    revisitAfterMs: 0,
    maxRechecksPerRun: 100,
  }).collect(CONTEXT);

  const withoutReference = await run({});
  assert.notEqual(
    withoutReference.publications.find((publication) => publication.externalId === original.externalId)?.identityKey,
    original.identityKey,
    'without the persisted reference the new title derives a different key (the production conflict)',
  );

  const recovered = await run({ [original.externalId!]: original.identityKey! });
  const publication = recovered.publications.find((item) => item.externalId === original.externalId)!;
  assert.equal(publication.identityKey, original.identityKey, 'the persisted identity is kept');
  const stored = (recovered.checkpoint!.state as { identities: Record<string, { key: string }> }).identities[original.externalId!];
  assert.equal(stored?.key, original.identityKey, 'the checkpoint records the kept identity for next runs');
  assert.equal(
    'persistedIdentityKeys' in (recovered.checkpoint!.state as object),
    false,
    'persisted keys are transient, never written to the checkpoint',
  );

  // A persisted key of another edition is not reused.
  xsd.title = '06-Arquivos XSD (v.1.3.0 PRODUÇÃO)';
  const newEdition = await run({ [original.externalId!]: original.identityKey! });
  assert.notEqual(
    newEdition.publications.find((item) => item.externalId === original.externalId)?.identityKey,
    original.identityKey,
  );
});

test('the title rule accepts exactly one differing token', () => {
  const descriptor = {
    module: 'DERE', carrier: 'DOCUMENT', kind: 'XSD_SCHEMA', documentNumber: undefined,
    officialVersion: '1.2.0', revisionKind: 'ORIGINAL', canonicalPath: '/x',
  } as never;
  const candidate = { descriptor, baseKey: 'SPED|v2|DERE|DOCUMENT|XSD_SCHEMA|NEW|1.2.0|ORIGINAL' };
  assert.equal(sameIdentityExceptTitleFamily('SPED|v2|DERE|DOCUMENT|XSD_SCHEMA|OLD|1.2.0|ORIGINAL', candidate), true);
  assert.equal(sameIdentityExceptTitleFamily('SPED|v2|DERE|DOCUMENT|XSD_SCHEMA|OLD|EXTRA|1.2.0|ORIGINAL', candidate), false);
  assert.equal(sameIdentityExceptTitleFamily('SPED|v2|DERE|DOCUMENT|XSD_SCHEMA|OLD|1.2.0|ORIGINAL|PATH:/y', candidate), false);
  assert.equal(sameIdentityExceptTitleFamily('SPED|v2|DERE|DOCUMENT|MANUAL|OLD|1.2.0|ORIGINAL', candidate), false);
  assert.equal(sameIdentityExceptTitleFamily(candidate.baseKey, candidate), false);
});

test('numbered documents never reuse an identity through the title rule', () => {
  const base = {
    module: 'DERE', carrier: 'DOCUMENT', kind: 'TECHNICAL_NOTE', documentNumber: '2026.001',
    officialVersion: undefined, revisionKind: 'ORIGINAL', canonicalPath: '/x',
  } as never;
  assert.equal(
    sameIdentityExceptTitleFamily('SPED|v2|DERE|DOCUMENT|TECHNICAL_NOTE|OTHER||ORIGINAL|PATH:/x', { descriptor: base, baseKey: 'different' }),
    false,
  );
});
