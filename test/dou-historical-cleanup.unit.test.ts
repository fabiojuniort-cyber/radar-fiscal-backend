import { deepEqual, equal, notEqual, ok, throws } from 'node:assert/strict';
import { test } from 'node:test';

import {
  cleanupCanonicalJson,
  parseDouCleanupCliArgs,
  planDouHistoricalCleanup,
  type CleanupPublication,
  type DouCleanupSnapshot,
} from '../src/modules/collection/dou-historical-cleanup.plan.js';

const uuid = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const sourceId = uuid(1);
const routine = 'Contratante: União. Contratada: Alfa Ltda. CNPJ: 12.345.678/0001-90. Pregão Eletrônico nº 7/2026. Objeto: Aquisição de papel A4. Valor Global: R$ 1.000. Vigência: 12 meses.';
function metadata(section = 'DO3'): Record<string, unknown> {
  return {
    sourceRole: 'PRIMARY', ingestionChannel: 'INLABS',
    dou: {
      section, sourceActType: 'EXTRATO DE CONTRATO', abstract: '',
      continuationTitles: [], continuationAbstracts: [], scopeStructureIncomplete: false,
      archive: { section, rawSha256: 'a'.repeat(64) },
      parts: [{ rawSha256: 'b'.repeat(64), attributes: { pubName: section, artType: 'EXTRATO DE CONTRATO' } }],
    },
  };
}
function publication(section = 'DO3'): CleanupPublication {
  return {
    id: uuid(2), title: 'EXTRATO DE CONTRATO Nº 7/2026', act_type: 'EXTRATO DE CONTRATO', agency: 'União',
    origins: [{ id: uuid(3), source_id: sourceId, metadata: metadata(section) }],
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
  equal(plan.blockers.length, 6);
});

test('exact DO2 and DO2E provenance are candidates independent of act type and CNPJ', () => {
  for (const section of ['DO2', 'DO2E']) {
    const row = publication(section); row.title = 'PORTARIA Nº 1'; row.act_type = 'PORTARIA';
    row.versions[0]!.content_text = 'Nomeação de pessoa com CNPJ 12.345.678/0001-90.';
    deepEqual(decision(row).reasonCodes, ['excluded_dou_section']); equal(decision(row).disposition, 'CANDIDATE');
  }
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
