import { deepEqual, equal, notEqual, ok, throws } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  cleanupCanonicalJson,
  parseDouCleanupCliArgs,
  planDouHistoricalCleanup,
  type CleanupPublication,
  type DouCleanupSnapshot,
} from '../src/modules/collection/dou-historical-cleanup.plan.js';
import { parseDouEntries } from '../src/modules/collection/dou.parser.js';

const uuid = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const sourceId = uuid(1);
const routine = 'Contratante: União. Contratada: Alfa Ltda. CNPJ: 12.345.678/0001-90. Pregão Eletrônico nº 7/2026. Objeto: Aquisição de papel A4. Valor Global: R$ 1.000. Vigência: 12 meses.';
function metadata(section = 'DO3'): Record<string, unknown> {
  return {
    sourceRole: 'PRIMARY', ingestionChannel: 'INLABS',
    dou: {
      section, publicationDate: '2026-10-05', officialMatterId: '12345678', edition: '180',
      sourceActType: 'EXTRATO DE CONTRATO', abstract: '',
      continuationTitles: [], continuationAbstracts: [], scopeStructureIncomplete: false,
      archive: { section, date: '2026-10-05', filename: `2026-10-05-${section}.zip`, rawSha256: 'a'.repeat(64) },
      parts: [{ filename: '530_20261005_12345678.xml', rawSha256: 'b'.repeat(64), attributes: {
        pubName: section, pubDate: '05/10/2026', idMateria: '12345678', editionNumber: '180', artType: 'EXTRATO DE CONTRATO',
      } }],
    },
  };
}
function publication(section = 'DO3'): CleanupPublication {
  return {
    id: uuid(2), title: 'EXTRATO DE CONTRATO Nº 7/2026', act_type: 'EXTRATO DE CONTRATO', agency: 'União',
    origins: [{ id: uuid(3), source_id: sourceId, external_id: `2026-10-05:${section}:180:12345678`, metadata: metadata(section) }],
    versions: [{ id: uuid(4), is_current: true, content_text: routine, source_metadata: metadata(section) }],
  };
}
function snapshot(row = publication()): DouCleanupSnapshot {
  return {
    schemaVersion: 'dou-cleanup-snapshot-v1', databaseIdentity: 'temporary-restore-issue80',
    capturedAt: '2026-10-05T12:00:00.000Z', source: { id: sourceId, code: 'dou', connector_key: 'dou' },
    publications: [row],
  };
}
function dou(value: Record<string, unknown>) { return value.dou as Record<string, unknown>; }
function parts(meta: Record<string, unknown>) { return dou(meta).parts as Array<Record<string, unknown>>; }
function attributes(meta: Record<string, unknown>) { return parts(meta)[0]!.attributes as Record<string, unknown>; }
function decision(row: CleanupPublication) { return planDouHistoricalCleanup(snapshot(row)).decisions[0]!; }

test('default is offline dry-run; no credential or execute mode exists', () => {
  deepEqual(parseDouCleanupCliArgs(['--input=/tmp/snapshot.json']), { inputPath: '/tmp/snapshot.json' });
  deepEqual(parseDouCleanupCliArgs(['--dry-run', '--input=/tmp/snapshot.json']), { inputPath: '/tmp/snapshot.json' });
  for (const option of ['--execute', '--confirm', '--apply=true', '--delete=false', '--unknown', 'confirm']) {
    throws(() => parseDouCleanupCliArgs(['--input=/tmp/snapshot.json', option]));
  }
  for (const args of [[], ['--input=relative.json'], ['--input=/a', '--input=/b']]) throws(() => parseDouCleanupCliArgs(args));
  const plan = planDouHistoricalCleanup(snapshot());
  equal(plan.executionAllowed, false); equal(plan.mode, 'DRY_RUN_OFFLINE_ONLY');
  equal(plan.blockers.length, 7);
});

test('exact DO2 and DO2E provenance are candidates independent of act type and CNPJ', () => {
  for (const section of ['DO2', 'DO2E']) {
    const row = publication(section); row.title = 'PORTARIA Nº 1'; row.act_type = 'PORTARIA';
    row.versions[0]!.content_text = 'Nomeação de pessoa com CNPJ 12.345.678/0001-90.';
    deepEqual(decision(row).reasonCodes, ['excluded_dou_section']); equal(decision(row).disposition, 'CANDIDATE');
  }
});

test('a real parser-produced provenance envelope remains internally coherent without an invented journal-to-section map', () => {
  const filename = '603_20260918_24359694.xml';
  const parsed = parseDouEntries([{ name: filename, bytes: readFileSync(new URL('./fixtures/dou/' + filename, import.meta.url)) }], {
    date: '2026-09-18', section: 'DO1E', filename: '2026-09-18-DO1E.zip', rawSha256: 'a'.repeat(64),
    officialUrl: 'https://inlabs.in.gov.br/index.php?p=2026-09-18&dl=2026-09-18-DO1E.zip',
  });
  equal(parsed.partialFailures.length, 0); const source = parsed.publications[0]!; ok(source);
  const row = publication('DO1E'); row.title = source.title; row.act_type = source.actType ?? null;
  row.origins[0]!.external_id = source.externalId ?? null; row.origins[0]!.metadata = source.metadata!;
  row.versions[0]!.source_metadata = source.metadata!; row.versions[0]!.content_text = source.content ?? null;
  equal(decision(row).disposition, 'KEEP');
});

test('section exclusion has explicit precedence over contract relevance only for all-excluded evidence', () => {
  const row = publication('DO2'); row.versions[0]!.content_text = 'Objeto: Transação tributária.';
  equal(decision(row).disposition, 'CANDIDATE');
  row.versions[0]!.source_metadata = metadata('DO3');
  equal(decision(row).disposition, 'REVIEW');
});

test('strict routine proof produces a provisional candidate, never execution permission', () => {
  const plan = planDouHistoricalCleanup(snapshot());
  equal(plan.decisions[0]!.disposition, 'CANDIDATE');
  ok(plan.decisions[0]!.reasonCodes.includes('strict_routine_contract_excerpt'));
  equal(plan.executionAllowed, false);
});

test('tax, regulated concession and corporate materiality are KEEP', () => {
  for (const text of ['Transação tributária de débitos inscritos.', 'Contrato de concessão de serviços públicos.', 'Transferência de controle societário.']) {
    const row = publication(); row.versions[0]!.content_text = routine + ' ' + text;
    equal(decision(row).disposition, 'KEEP');
  }
});

test('unrecognized or CNPJ-only contracts are REVIEW; other act families are KEEP', () => {
  for (const text of ['CNPJ: 12.345.678/0001-90.', routine + ' Cláusula desconhecida.']) {
    const row = publication(); row.versions[0]!.content_text = text;
    equal(decision(row).disposition, 'REVIEW');
  }
  const row = publication(); row.title = 'PORTARIA Nº 7/2026'; row.versions[0]!.content_text = 'CNPJ: 12.345.678/0001-90.';
  equal(decision(row).disposition, 'KEEP');
});

test('materiality stored only in an origin or continuation vetoes deletion', () => {
  for (const field of ['abstract', 'continuationAbstracts', 'continuationTitles']) {
    const row = publication(); const text = 'Transação tributária de débitos inscritos.';
    dou(row.origins[0]!.metadata)[field] = field === 'abstract' ? text : [text];
    equal(decision(row).disposition, 'KEEP');
  }
});

test('persisted KEEP/REVIEW vetoes candidacy while persisted IGNORE is never positive proof', () => {
  for (const [stored, expected] of [['KEEP', 'KEEP'], ['REVIEW', 'REVIEW'], ['UNKNOWN', 'REVIEW']]) {
    const row = publication(); row.origins[0]!.metadata.douScope = { decision: stored };
    equal(decision(row).disposition, expected);
  }
  const row = publication(); row.versions[0]!.source_metadata.douScope = { decision: 'IGNORE' };
  row.versions[0]!.content_text = 'CNPJ: 12.345.678/0001-90.';
  equal(decision(row).disposition, 'REVIEW');
});

test('contradictory canonical act type cannot authorize contract removal', () => {
  for (const type of ['PORTARIA', null]) {
    const row = publication(); row.act_type = type;
    equal(decision(row).disposition, 'REVIEW');
  }
});

test('supplied archive filename section and date must agree with structured provenance', () => {
  for (const archive of [
    { filename: '2026-10-05-DO2.zip' },
    { filename: '2026-10-05-DO3.zip', date: '2026-10-04' },
    { filename: 'unknown.zip' },
  ]) {
    const row = publication(); Object.assign(dou(row.origins[0]!.metadata).archive as object, archive);
    equal(decision(row).disposition, 'REVIEW');
  }
});

test('all source identity fields must corroborate every XML part in excluded and included sections', () => {
  const mutations: Array<(meta: Record<string, unknown>) => void> = [
    meta => { attributes(meta).pubDate = '04/10/2026'; },
    meta => { attributes(meta).pubDate = '2026-10-05'; },
    meta => { delete attributes(meta).pubDate; },
    meta => { attributes(meta).idMateria = '87654321'; },
    meta => { delete attributes(meta).idMateria; },
    meta => { attributes(meta).editionNumber = '180-A'; },
    meta => { attributes(meta).pubName = 'DO1'; },
    meta => { attributes(meta).artType = 'PORTARIA'; },
    meta => { parts(meta)[0]!.filename = '530_20261004_12345678.xml'; },
    meta => { parts(meta)[0]!.filename = '530_20261005_87654321.xml'; },
    meta => { parts(meta)[0]!.filename = '../530_20261005_12345678.xml'; },
    meta => { delete parts(meta)[0]!.filename; },
    meta => { delete dou(meta).publicationDate; },
    meta => { dou(meta).publicationDate = '2026-02-30'; },
    meta => { dou(meta).officialMatterId = 12345678; },
    meta => { dou(meta).edition = '180:extra'; },
    meta => { (dou(meta).archive as Record<string, unknown>).date = '2026-10-04'; },
    meta => { delete (dou(meta).archive as Record<string, unknown>).date; },
    meta => { delete (dou(meta).archive as Record<string, unknown>).filename; },
    meta => { parts(meta)[0]!.rawSha256 = 'not-a-hash'; },
    meta => { parts(meta)[0]!.sizeBytes = 0; },
  ];
  for (const section of ['DO2', 'DO2E', 'DO3']) {
    for (const target of ['origin', 'version']) {
      for (const mutate of mutations) {
        const row = publication(section);
        mutate(target === 'origin' ? row.origins[0]!.metadata : row.versions[0]!.source_metadata);
        const actual = decision(row);
        equal(actual.disposition, 'REVIEW'); ok(actual.reasonCodes.includes('missing_or_conflicting_dou_provenance'));
      }
    }
  }
});

test('origin external_id must match its own date, section, edition and matter exactly', () => {
  for (const value of [null, undefined, '', '2026-10-04:DO2:180:12345678', '2026-10-05:DO3:180:12345678',
    '2026-10-05:DO2:181:12345678', '2026-10-05:DO2:180:87654321', '2026-10-05:DO2:180:12345678:embedded:PORTARIA:1']) {
    const row = publication('DO2');
    if (value === undefined) delete row.origins[0]!.external_id; else row.origins[0]!.external_id = value;
    equal(decision(row).disposition, 'REVIEW');
    ok(decision(row).reasonCodes.includes('missing_or_conflicting_origin_external_id'));
  }
});

test('a coherent historical version still requires a matching origin identity', () => {
  const row = publication('DO2');
  dou(row.versions[0]!.source_metadata).officialMatterId = '87654321';
  attributes(row.versions[0]!.source_metadata).idMateria = '87654321';
  parts(row.versions[0]!.source_metadata)[0]!.filename = '530_20261005_87654321.xml';
  equal(decision(row).disposition, 'REVIEW');
  ok(decision(row).reasonCodes.includes('version_provenance_without_matching_origin'));
  row.origins.push({ id: uuid(88), source_id: sourceId, external_id: '2026-10-05:DO2:180:87654321', metadata: structuredClone(row.versions[0]!.source_metadata) });
  equal(decision(row).disposition, 'CANDIDATE');
});

test('multipart provenance requires unique contiguous parts with the same source identity and journal', () => {
  const row = publication('DO2');
  const first = structuredClone(parts(row.origins[0]!.metadata)[0]!);
  const second = { ...structuredClone(first), filename: '530_20261005_12345678-2.xml' };
  for (const meta of [row.origins[0]!.metadata, row.versions[0]!.source_metadata]) dou(meta).parts = [structuredClone(second), structuredClone(first)];
  equal(decision(row).disposition, 'CANDIDATE');
  for (const filename of ['530_20261005_12345678-1.xml', '530_20261005_12345678-0.xml',
    '530_20261005_12345678-3.xml', '529_20261005_12345678-2.xml']) {
    const changed = structuredClone(row); parts(changed.origins[0]!.metadata)[0]!.filename = filename;
    equal(decision(changed).disposition, 'REVIEW');
  }
});

test('supplied archive and certified page URLs must corroborate the same date/file/journal/page', () => {
  const row = publication('DO2'); const meta = row.origins[0]!.metadata;
  const archive = dou(meta).archive as Record<string, unknown>;
  archive.officialUrl = 'https://inlabs.in.gov.br/index.php?p=2026-10-05&dl=2026-10-05-DO2.zip';
  attributes(meta).numberPage = '1';
  attributes(meta).pdfPage = 'https://pesquisa.in.gov.br/imprensa/jsp/visualiza/index.jsp?data=05/10/2026&jornal=530&pagina=1';
  equal(decision(row).disposition, 'CANDIDATE');
  for (const url of [
    'https://inlabs.in.gov.br/index.php?p=2026-10-04&dl=2026-10-05-DO2.zip',
    'https://inlabs.in.gov.br/index.php?p=2026-10-05&dl=2026-10-05-DO3.zip',
    'https://inlabs.in.gov.br/index.php?p=2026-10-05&p=2026-10-04&dl=2026-10-05-DO2.zip',
  ]) {
    const changed = structuredClone(row); (dou(changed.origins[0]!.metadata).archive as Record<string, unknown>).officialUrl = url;
    equal(decision(changed).disposition, 'REVIEW');
  }
  for (const query of ['data=04/10/2026&jornal=530&pagina=1', 'data=05/10/2026&jornal=529&pagina=1', 'data=05/10/2026&jornal=530&pagina=2']) {
    const changed = structuredClone(row); attributes(changed.origins[0]!.metadata).pdfPage = 'https://pesquisa.in.gov.br/imprensa/jsp/visualiza/index.jsp?' + query;
    equal(decision(changed).disposition, 'REVIEW');
  }
});

test('matching identity cannot hide divergent origin/version XML part inventories or hashes', () => {
  for (const section of ['DO2', 'DO3']) {
    const row = publication(section);
    parts(row.origins[0]!.metadata).push({ ...structuredClone(parts(row.origins[0]!.metadata)[0]!), filename: '530_20261005_12345678-2.xml' });
    equal(decision(row).disposition, 'REVIEW');
    ok(decision(row).reasonCodes.includes('version_and_origin_part_inventory_disagree'));
    const changedHash = publication(section); parts(changedHash.origins[0]!.metadata)[0]!.rawSha256 = 'c'.repeat(64);
    equal(decision(changedHash).disposition, 'REVIEW');
  }
});

test('row-level and certified page references must resolve to proven XML part pages', () => {
  const row = publication();
  const valid = 'https://pesquisa.in.gov.br/imprensa/jsp/visualiza/index.jsp?data=05/10/2026&jornal=530&pagina=1';
  const invalid = valid.replace('05/10/2026', '01/01/1900');
  for (const meta of [row.origins[0]!.metadata, row.versions[0]!.source_metadata]) {
    attributes(meta).numberPage = '1'; attributes(meta).pdfPage = valid; dou(meta).certifiedPageUrls = [valid];
  }
  row.origins[0]!.official_url = valid; row.primary_official_url = valid;
  equal(decision(row).disposition, 'CANDIDATE');
  const mutations: Array<(value: CleanupPublication) => void> = [
    value => { value.origins[0]!.official_url = invalid; },
    value => { value.primary_official_url = invalid; },
    value => { dou(value.origins[0]!.metadata).certifiedPageUrls = [invalid]; },
    value => { dou(value.versions[0]!.source_metadata).certifiedPageUrls = [invalid]; },
    value => { dou(value.origins[0]!.metadata).certifiedPageUrls = []; },
    value => { dou(value.origins[0]!.metadata).certifiedPageUrls = [null]; },
    value => { dou(value.origins[0]!.metadata).certifiedPageUrls = [valid, valid.replace('pagina=1', 'pagina=2')]; },
  ];
  for (const mutate of mutations) { const changed = structuredClone(row); mutate(changed); equal(decision(changed).disposition, 'REVIEW'); }
});

test('unexamined files cannot authorize a routine contract candidate, regardless of attachment label', () => {
  for (const role of ['MATERIAL_CONTENT', 'ATTACHMENT', 'PROVENANCE']) {
    for (const target of ['origin', 'version_metadata', 'publication', 'version']) {
      const row = publication(); const files = [{ versionRole: role, url: 'https://example.invalid/attachment.pdf' }];
      const holder = target === 'origin' ? row.origins[0]!.metadata : target === 'version_metadata' ? row.versions[0]!.source_metadata
        : (target === 'publication' ? row : row.versions[0]!) as unknown as Record<string, unknown>;
      holder.files = files;
      equal(decision(row).disposition, 'REVIEW'); ok(decision(row).reasonCodes.includes('unexamined_attached_material'));
    }
  }
  const row = publication(); row.origins[0]!.metadata.files = [];
  equal(decision(row).disposition, 'CANDIDATE');
  row.origins[0]!.metadata.files = null;
  equal(decision(row).disposition, 'REVIEW');
});

test('old KEEP version is preserved and routine multiversion lacks title proof', () => {
  const row = publication(); row.versions.push({ ...structuredClone(row.versions[0]!), id: uuid(5), is_current: false });
  equal(decision(row).disposition, 'REVIEW');
  ok(decision(row).reasonCodes.includes('historical_titles_unproven'));
  row.versions[1]!.content_text = 'Transação tributária de débitos inscritos.';
  equal(decision(row).disposition, 'KEEP');
});

test('missing or malformed historical evidence always fails closed', () => {
  const cases: Array<(meta: Record<string, unknown>) => void> = [
    meta => { delete dou(meta).abstract; },
    meta => { delete dou(meta).continuationTitles; },
    meta => { dou(meta).continuationAbstracts = [null, {}]; },
    meta => { delete dou(meta).scopeStructureIncomplete; },
    meta => { dou(meta).scopeStructureIncomplete = 'false'; },
    meta => { dou(meta).scopeStructureIncomplete = true; },
    meta => { dou(meta).titleFallback = 'ART_TYPE_AND_UNIT'; },
    meta => { dou(meta).parts = []; },
    meta => { dou(meta).archive = null; },
    meta => { dou(meta).sourceActType = 'PORTARIA'; },
    meta => { meta.dou = []; },
  ];
  for (const mutate of cases) {
    const row = publication(); mutate(row.origins[0]!.metadata);
    equal(decision(row).disposition, 'REVIEW');
  }
});

test('unknown, conflicting and cross-source provenance cannot target a publication', () => {
  const cases: Array<(row: CleanupPublication) => void> = [
    row => { dou(row.origins[0]!.metadata).section = 'DO2-other'; },
    row => { row.versions[0]!.source_metadata = metadata('DO3'); },
    row => { (dou(row.origins[0]!.metadata).archive as Record<string, unknown>).section = 'DO3'; },
    row => { row.versions[0]!.source_metadata.ingestionChannel = 'OTHER'; },
    row => { row.origins.push({ ...structuredClone(row.origins[0]!), id: uuid(6), source_id: uuid(7) }); },
    row => { row.versions = []; },
    row => { row.origins = []; },
    row => { row.versions[0]!.is_current = false; },
    row => { row.versions.push({ ...structuredClone(row.versions[0]!), id: uuid(8) }); },
  ];
  for (const mutate of cases) { const row = publication('DO2'); mutate(row); equal(decision(row).disposition, 'REVIEW'); }
});

test('non-DOU origin is outside scope even if metadata says DO2', () => {
  const row = publication('DO2'); row.origins[0]!.source_id = uuid(999);
  equal(decision(row).disposition, 'KEEP');
});

test('fingerprints bind all evidence, including metadata, row identities and extra row fields', () => {
  const original = snapshot(); const changed = structuredClone(original);
  (changed.publications[0]! as unknown as Record<string, unknown>).content_hash = 'unchanged';
  notEqual(planDouHistoricalCleanup(original).snapshotSha256, planDouHistoricalCleanup(changed).snapshotSha256);
  const before = planDouHistoricalCleanup(original);
  dou(original.publications[0]!.origins[0]!.metadata).abstract = 'Cláusula desconhecida.';
  const after = planDouHistoricalCleanup(original);
  notEqual(before.planSha256, after.planSha256); notEqual(before.decisions[0]!.evidenceSha256, after.decisions[0]!.evidenceSha256);
  equal(after.decisions[0]!.disposition, 'REVIEW');
  original.publications[0]!.id = uuid(999);
  notEqual(after.snapshotSha256, planDouHistoricalCleanup(original).snapshotSha256);
});

test('deterministic output does not disclose body, title, metadata or database credentials', () => {
  const input = snapshot(); deepEqual(planDouHistoricalCleanup(input), planDouHistoricalCleanup(input));
  const report = JSON.stringify(planDouHistoricalCleanup(input));
  for (const secret of ['12.345.678/0001-90', 'EXTRATO DE CONTRATO Nº', 'Aquisição de papel', 'content_text', 'source_metadata']) equal(report.includes(secret), false);
  equal(cleanupCanonicalJson({ b: 2, a: 1 }), cleanupCanonicalJson({ a: 1, b: 2 }));
  throws(() => cleanupCanonicalJson({ missing: undefined }));
});

test('malformed snapshots and duplicate IDs abort the whole plan, not partial output', () => {
  const cases: Array<(input: DouCleanupSnapshot) => void> = [
    input => { input.publications.push(structuredClone(input.publications[0]!)); },
    input => { input.publications[0]!.versions.push(structuredClone(input.publications[0]!.versions[0]!)); },
    input => { input.publications[0]!.origins.push(structuredClone(input.publications[0]!.origins[0]!)); },
    input => { input.capturedAt = '2026-02-30T00:00:00.000Z'; },
    input => { input.databaseIdentity = 'postgresql://user:password@host/db'; },
    input => { (input.source as Record<string, unknown>).connector_key = 'other'; },
    input => { (input.publications[0]!.origins[0]! as unknown as Record<string, unknown>).publication_id = uuid(999); },
    input => { (input.publications[0]!.versions[0]! as unknown as Record<string, unknown>).publication_id = uuid(999); },
    input => { (input.publications[0]!.versions[0]! as unknown as Record<string, unknown>).version_no = 0; },
    input => {
      const row = input.publications[0]!;
      (row.versions[0]! as unknown as Record<string, unknown>).version_no = 1;
      row.versions.push({ ...structuredClone(row.versions[0]!), id: uuid(99), is_current: false });
    },
  ];
  for (const mutate of cases) { const input = snapshot(); mutate(input); throws(() => planDouHistoricalCleanup(input)); }
});
