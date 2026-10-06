import { deepEqual, equal, match, notEqual, ok, rejects, throws } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { ClientBase } from 'pg';

import { cleanupCanonicalJson } from '../src/modules/collection/dou-historical-cleanup.plan.js';
import {
  EXCLUSION_DEPENDENCIES,
  PUBLICATION_EXCLUSION_HISTORY_VERSION,
  parsePublicationExclusionDryRunArgs,
  planPublicationExclusionHistory,
  runPublicationExclusionDryRun,
  summarizePublicationExclusionHistory,
  type ExclusionDependencyCounts,
  type ExclusionHistoryPublication,
  type PublicationExclusionHistoryDecision,
  type PublicationExclusionHistorySnapshot,
} from '../src/modules/collection/publication-exclusion-history.js';
import { PUBLICATION_EXCLUSION_POLICY } from '../src/modules/collection/publication-exclusion-policy.js';

const uuid = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const sourceId = uuid(1);
const actType = 'AVISO DE HOMOLOGAÇÃO';
const routine = 'Objeto: Aquisição de papel A4. Processo: 123/2026. Resultado: homologado.';
const officialUrl = 'https://pesquisa.in.gov.br/imprensa/jsp/visualiza/index.jsp?data=05/10/2026&jornal=530&pagina=1';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const counts = () => Object.fromEntries(EXCLUSION_DEPENDENCIES.map(key => [key, 0])) as ExclusionDependencyCounts;

function metadata(section = 'DO3'): Record<string, unknown> {
  return {
    sourceRole: 'PRIMARY', ingestionChannel: 'INLABS',
    dou: {
      section, publicationDate: '2026-10-05', officialMatterId: '12345678', edition: '180',
      sourceActType: actType, abstract: '', continuationTitles: [], continuationAbstracts: [],
      scopeStructureIncomplete: false, certifiedPageUrls: [officialUrl],
      archive: { section, date: '2026-10-05', filename: `2026-10-05-${section}.zip`, rawSha256: 'a'.repeat(64) },
      parts: [{ filename: '530_20261005_12345678.xml', rawSha256: 'b'.repeat(64), attributes: {
        pubName: section, pubDate: '05/10/2026', idMateria: '12345678', editionNumber: '180',
        artType: actType, numberPage: '1', pdfPage: officialUrl,
      } }],
    },
  };
}

function publication(number = 10, section = 'DO3'): ExclusionHistoryPublication {
  return {
    id: uuid(number), title: actType, act_type: actType, agency: 'União', primary_official_url: officialUrl,
    inventoryComplete: true, originCount: 1, versionCount: 1, inScope: true, dependencyCounts: counts(),
    origins: [{ id: uuid(number + 1), source_id: sourceId, external_id: `2026-10-05:${section}:180:12345678`,
      official_url: officialUrl, metadata: metadata(section) }],
    versions: [{ id: uuid(number + 2), is_current: true, content_text: routine,
      source_metadata: metadata(section), version_no: 1 } as ExclusionHistoryPublication['versions'][number]],
  };
}

function snapshot(...publications: ExclusionHistoryPublication[]): PublicationExclusionHistorySnapshot {
  return {
    schemaVersion: 'dou-cleanup-snapshot-v1', databaseIdentity: 'issue80-test-restored-snapshot',
    capturedAt: '2026-10-06T12:00:00.000Z', source: { id: sourceId, code: 'dou', connector_key: 'dou' },
    publications: publications.length ? publications : [publication()],
  };
}
function envelopes(row: ExclusionHistoryPublication) {
  return [...row.origins.map(origin => origin.metadata), ...row.versions.map(version => version.source_metadata)];
}
function dou(value: Record<string, unknown>) { return value.dou as Record<string, unknown>; }
function parts(value: Record<string, unknown>) { return dou(value).parts as Array<Record<string, unknown>>; }
function attributes(value: Record<string, unknown>) { return parts(value)[0]!.attributes as Record<string, unknown>; }
function decide(row: ExclusionHistoryPublication) { return planPublicationExclusionHistory(snapshot(row)).decisions[0]!; }
function review(row: ExclusionHistoryPublication, reason?: string) {
  const actual = decide(row);
  equal(actual.decision, 'REVIEW', JSON.stringify(actual));
  if (reason) ok(actual.reasonCodes.includes(reason), JSON.stringify(actual));
}

test('complete exact notice proof only yields a dry-run candidate, with policy and evidence binding', () => {
  for (const section of ['DO3', 'DO3E']) {
    const row = publication(10, section);
    const before = structuredClone(row);
    const plan = planPublicationExclusionHistory(snapshot(row));
    const actual = plan.decisions[0]!;
    equal(actual.decision, 'EXCLUDE');
    equal(actual.category, 'ROUTINE_ADMINISTRATIVE_PROCUREMENT');
    deepEqual(actual.ruleIds, ['dou-procurement-homologation']);
    deepEqual(actual.reasonCodes, ['EXACT_TYPE_AND_ROUTINE_CONTENT_PROVEN', 'unanimous_policy_exclusion']);
    equal(plan.summary.historyVersion, PUBLICATION_EXCLUSION_HISTORY_VERSION);
    equal(plan.summary.mode, 'DRY_RUN_READ_ONLY');
    equal(plan.summary.executionAllowed, false);
    equal(plan.summary.policyKey, PUBLICATION_EXCLUSION_POLICY.key);
    equal(plan.summary.policyVersion, PUBLICATION_EXCLUSION_POLICY.version);
    equal(plan.summary.policySha256, hash(cleanupCanonicalJson(PUBLICATION_EXCLUSION_POLICY)));
    deepEqual(plan.summary.counts, { publicationsInspected: 1, excludedCandidates: 1, kept: 0, review: 0 });
    match(actual.evidenceSha256, /^[a-f0-9]{64}$/);
    deepEqual(row, before, 'planning must never modify source evidence');
  }
});

test('an unlisted family is REVIEW, and a protected exact normative type is KEEP', () => {
  for (const type of ['AVISO DE LICITAÇÃO', 'PORTARIA', 'EXTRATO', 'AVISO DE HOMOLOGAÇÃO COMPLEMENTAR']) {
    const row = publication(); row.title = type; row.act_type = type;
    for (const meta of envelopes(row)) { dou(meta).sourceActType = type; attributes(meta).artType = type; }
    review(row);
  }
  const row = publication(); row.title = 'LEI'; row.act_type = 'LEI';
  equal(decide(row).decision, 'KEEP');
  ok(decide(row).reasonCodes.includes('policy_keep_veto'));
});

test('missing, foreign-only and mixed origins cannot establish historical exclusion', () => {
  const absent = publication(); absent.origins = []; absent.originCount = 0;
  review(absent, 'missing_origins');
  const foreign = publication(); foreign.origins[0]!.source_id = uuid(900);
  review(foreign, 'cross_source_publication');
  const mixed = publication();
  mixed.origins.push({ ...structuredClone(mixed.origins[0]!), id: uuid(901), source_id: uuid(900) });
  mixed.originCount = 2;
  review(mixed, 'cross_source_publication');
});

test('completeness, current-version and scope assertions must be explicitly proven', () => {
  const changes: Array<(row: ExclusionHistoryPublication) => void> = [
    row => { delete row.inventoryComplete; }, row => { row.inventoryComplete = false; },
    row => { delete row.originCount; }, row => { row.originCount = 2; },
    row => { delete row.versionCount; }, row => { row.versionCount = 2; },
    row => { row.versions = []; row.versionCount = 0; },
    row => { row.versions[0]!.is_current = false; },
    row => { delete row.inScope; }, row => { row.inScope = false; },
  ];
  for (const change of changes) { const row = publication(); change(row); review(row); }
});

test('every dependency is a veto, and absent or invalid per-table counts fail closed', () => {
  deepEqual([...EXCLUSION_DEPENDENCIES].sort(), [
    'companyLinks', 'companyMatches', 'curatorTags', 'files', 'ncmMentions', 'ncmScans', 'taxonomyRuns', 'taxonomyScans',
  ]);
  for (const key of EXCLUSION_DEPENDENCIES) {
    const used = publication(); used.dependencyCounts![key] = 1;
    review(used, 'existing_dependent_records');
    const missing = publication(); delete (missing.dependencyCounts as Partial<ExclusionDependencyCounts>)[key];
    review(missing, 'unproven_dependency_inventory');
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '0', null]) {
      const invalid = publication(); (invalid.dependencyCounts as unknown as Record<string, unknown>)[key] = value;
      review(invalid, 'unproven_dependency_inventory');
    }
  }
  const row = publication(); delete row.dependencyCounts;
  review(row, 'unproven_dependency_inventory');
});

test('persisted KEEP wins in every supported metadata namespace and envelope', () => {
  for (const key of ['douScope', 'publicationExclusion', 'publicationExclusionPolicy']) {
    for (const index of [0, 1]) {
      const row = publication(); envelopes(row)[index]![key] = { decision: 'KEEP' };
      const actual = decide(row); equal(actual.decision, 'KEEP');
      deepEqual(actual.reasonCodes, ['persisted_keep_decision']);
    }
  }
});

test('persisted REVIEW/unknown/malformed decisions veto; a stale EXCLUDE is never positive proof', () => {
  for (const key of ['douScope', 'publicationExclusion', 'publicationExclusionPolicy']) {
    for (const stored of [{ decision: 'REVIEW' }, { decision: 'UNKNOWN' }, {}, null, []]) {
      const row = publication(); row.origins[0]!.metadata[key] = stored;
      review(row, 'persisted_review_or_invalid_decision');
    }
    const row = publication(); row.origins[0]!.metadata[key] = { decision: 'EXCLUDE' };
    row.versions[0]!.content_text = 'Objeto desconhecido.';
    review(row);
  }
});

test('all origin and historical-version supplemental material must be examined', () => {
  for (const index of [0, 1]) {
    for (const field of ['abstract', 'continuationTitles', 'continuationAbstracts']) {
      for (const content of ['Transação tributária de débitos inscritos.', 'Cláusula adicional não classificada.']) {
        const row = publication(); dou(envelopes(row)[index]!)[field] = field === 'abstract' ? content : [content];
        review(row, 'policy_exclusion_not_unanimous');
      }
    }
    for (const field of ['abstract', 'continuationTitles', 'continuationAbstracts']) {
      const row = publication(); delete dou(envelopes(row)[index]!)[field];
      review(row, 'incomplete_historical_material');
    }
  }
});

test('the parser may omit a false structure flag, while true or malformed flags remain REVIEW', () => {
  const complete = publication();
  for (const meta of envelopes(complete)) delete dou(meta).scopeStructureIncomplete;
  equal(decide(complete).decision, 'EXCLUDE');
  for (const index of [0, 1]) for (const flag of [true, 'false', 'true', null, 0, {}]) {
    const row = publication(); dou(envelopes(row)[index]!).scopeStructureIncomplete = flag;
    review(row, 'incomplete_historical_material');
  }
});

test('DOU contract KEEP material survives even when present only in an origin supplement', () => {
  const row = publication(); row.title = 'EXTRATO DE CONTRATO'; row.act_type = 'EXTRATO DE CONTRATO';
  for (const meta of envelopes(row)) {
    dou(meta).sourceActType = 'EXTRATO DE CONTRATO'; attributes(meta).artType = 'EXTRATO DE CONTRATO';
  }
  dou(row.origins[0]!.metadata).abstract = 'Transação tributária de débitos inscritos.';
  equal(decide(row).decision, 'KEEP');
});

test('historical title uncertainty vetoes multiple versions, including routine old bodies', () => {
  for (const content of [routine, 'Transação tributária de débitos inscritos.', 'Cláusula antiga desconhecida.']) {
    const row = publication();
    (row.versions[0]! as unknown as Record<string, unknown>).version_no = 2;
    row.versions.push({ ...structuredClone(row.versions[0]!), id: uuid(99), is_current: false, content_text: content,
      version_no: 1 } as ExclusionHistoryPublication['versions'][number]);
    row.versionCount = 2;
    review(row, 'historical_titles_unproven');
  }
  const row = publication();
  row.versions.push({ ...structuredClone(row.versions[0]!), id: uuid(99), version_no: 2 } as ExclusionHistoryPublication['versions'][number]);
  row.versionCount = 2;
  review(row, 'missing_or_invalid_version_inventory');
});

test('version numbers must prove a contiguous inventory whose last version is current', () => {
  const missing = publication();
  delete (missing.versions[0]! as unknown as Record<string, unknown>).version_no;
  review(missing, 'incomplete_version_number_inventory');
  const loneSecond = publication();
  (loneSecond.versions[0]! as unknown as Record<string, unknown>).version_no = 2;
  review(loneSecond, 'incomplete_version_number_inventory');
  const wrongCurrent = publication();
  wrongCurrent.versions.push({ ...structuredClone(wrongCurrent.versions[0]!), id: uuid(99), is_current: false,
    version_no: 2 } as ExclusionHistoryPublication['versions'][number]);
  wrongCurrent.versionCount = 2;
  review(wrongCurrent, 'incomplete_version_number_inventory');
  const gap = publication();
  (gap.versions[0]! as unknown as Record<string, unknown>).version_no = 3;
  gap.versions.push({ ...structuredClone(gap.versions[0]!), id: uuid(99), is_current: false,
    version_no: 1 } as ExclusionHistoryPublication['versions'][number]);
  gap.versionCount = 2;
  review(gap, 'incomplete_version_number_inventory');
  gap.versions[1]!.source_metadata.publicationExclusionPolicy = { decision: 'KEEP' };
  equal(decide(gap).decision, 'KEEP', 'historical persisted KEEP takes precedence over incomplete inventory');
});

test('the new notice history policy never promotes an existing D-066-only routine contract to EXCLUDE', () => {
  const row = publication(); row.title = 'EXTRATO DE CONTRATO'; row.act_type = 'EXTRATO DE CONTRATO';
  for (const meta of envelopes(row)) {
    dou(meta).sourceActType = 'EXTRATO DE CONTRATO'; attributes(meta).artType = 'EXTRATO DE CONTRATO';
  }
  row.versions[0]!.content_text = 'Contratante: União. Contratada: Alfa Ltda. CNPJ: 12.345.678/0001-90. Pregão Eletrônico nº 7/2026. Objeto: Aquisição de papel A4. Valor Global: R$ 1.000. Vigência: 12 meses.';
  review(row, 'policy_exclusion_not_unanimous');
});

test('missing or contradictory XML/archive/origin proof never inherits a routine notice decision', () => {
  const changes: Array<(meta: Record<string, unknown>) => void> = [
    meta => { delete meta.dou; },
    meta => { delete dou(meta).archive; },
    meta => { delete (dou(meta).archive as Record<string, unknown>).rawSha256; },
    meta => { (dou(meta).archive as Record<string, unknown>).rawSha256 = 'invalid-hash'; },
    meta => { (dou(meta).archive as Record<string, unknown>).filename = '2026-10-05-DO2.zip'; },
    meta => { delete dou(meta).parts; },
    meta => { parts(meta)[0]!.rawSha256 = 'invalid-hash'; },
    meta => { parts(meta)[0]!.filename = '530_20261004_12345678.xml'; },
    meta => { attributes(meta).artType = 'PORTARIA'; },
    meta => { attributes(meta).idMateria = '99999999'; },
    meta => { dou(meta).section = 'DO2'; },
  ];
  for (const index of [0, 1]) for (const change of changes) {
    const row = publication(); change(envelopes(row)[index]!); review(row);
  }
  const originId = publication(); originId.origins[0]!.external_id = null; review(originId);
  const partHash = publication(); parts(partHash.origins[0]!.metadata)[0]!.rawSha256 = 'c'.repeat(64);
  review(partHash, 'version_and_origin_part_inventory_disagree');
  const official = publication(); official.primary_official_url = officialUrl.replace('pagina=1', 'pagina=2');
  review(official, 'conflicting_primary_official_url');
});

test('unexamined files and alternative presentations veto at every supplied evidence location', () => {
  for (const target of ['origin', 'version_metadata', 'publication', 'version']) {
    for (const files of [[{ versionRole: 'PROVENANCE', url: 'https://example.invalid/attachment.pdf' }], null, {}]) {
      const row = publication();
      const holder = target === 'origin' ? row.origins[0]!.metadata : target === 'version_metadata' ? row.versions[0]!.source_metadata
        : (target === 'publication' ? row : row.versions[0]!) as unknown as Record<string, unknown>;
      holder.files = files; review(row);
    }
  }
  for (const index of [0, 1]) {
    for (const presentation of [
      { version: 1, format: 'SANITIZED_HTML', html: '<p>Material adicional.</p>', preservesWhitespace: true },
      { version: 1, format: 'PRESERVED_TEXT', text: 'Material adicional.', preservesWhitespace: true }, null,
    ]) {
      const row = publication(); envelopes(row)[index]!.presentation = presentation; review(row);
    }
  }
  const row = publication();
  for (const meta of envelopes(row)) {
    meta.files = []; meta.presentation = { version: 1, format: 'PRESERVED_TEXT', preservesWhitespace: true };
  }
  equal(decide(row).decision, 'EXCLUDE');
});

test('input and nested inventory ordering and capture time do not perturb stable manifest hashes', () => {
  const first = publication();
  first.origins.push({ ...structuredClone(first.origins[0]!), id: uuid(13) }); first.originCount = 2;
  const second = publication(20); second.dependencyCounts!.files = 1;
  const third = publication(30);
  (third.versions[0]! as unknown as Record<string, unknown>).version_no = 2;
  third.versions.push({ ...structuredClone(third.versions[0]!), id: uuid(39), is_current: false,
    version_no: 1 } as ExclusionHistoryPublication['versions'][number]);
  third.versionCount = 2;
  const input = snapshot(first, second, third);
  const before = planPublicationExclusionHistory(input);
  const reordered = structuredClone(input); reordered.publications.reverse();
  reordered.publications.forEach(row => { row.origins.reverse(); row.versions.reverse(); });
  reordered.capturedAt = '2026-10-07T23:59:00.000Z';
  const after = planPublicationExclusionHistory(reordered);
  deepEqual(after.decisions, before.decisions);
  equal(after.summary.candidateSetSha256, before.summary.candidateSetSha256);
  equal(after.summary.inspectedSetSha256, before.summary.inspectedSetSha256);
  deepEqual(after.summary.bySourceTypeGroup, before.summary.bySourceTypeGroup);
  deepEqual(after.summary.byReason, before.summary.byReason);
  notEqual(after.summary.capturedAt, before.summary.capturedAt);
});

test('mixed KEEP/REVIEW envelopes preserve representative categories and aggregates under inventory permutations', () => {
  const withOrigins = publication();
  withOrigins.origins[0]!.metadata.douScope = { decision: 'KEEP' };
  withOrigins.origins.push({ ...structuredClone(withOrigins.origins[0]!), id: uuid(13), metadata: metadata() });
  withOrigins.originCount = 2;
  (withOrigins.versions[0]! as unknown as Record<string, unknown>).version_no = 2;
  withOrigins.versions.push({ ...structuredClone(withOrigins.versions[0]!), id: uuid(14), is_current: false,
    version_no: 1, source_metadata: { ...metadata(), douScope: { decision: 'REVIEW' } },
  } as ExclusionHistoryPublication['versions'][number]);
  withOrigins.versionCount = 2;

  // With no origins the first envelope is drawn from versions instead; its
  // representative category must be stable even for a non-candidate record.
  const versionsOnly = publication(20); versionsOnly.origins = []; versionsOnly.originCount = 0;
  versionsOnly.versions[0]!.source_metadata.douScope = { decision: 'KEEP' };
  (versionsOnly.versions[0]! as unknown as Record<string, unknown>).version_no = 2;
  versionsOnly.versions.push({ ...structuredClone(versionsOnly.versions[0]!), id: uuid(24), is_current: false,
    version_no: 1, source_metadata: metadata(),
  } as ExclusionHistoryPublication['versions'][number]);
  versionsOnly.versionCount = 2;

  const input = snapshot(withOrigins, versionsOnly, publication(30));
  const sourceEvidence = structuredClone(input);
  const expected = planPublicationExclusionHistory(input);
  equal(expected.decisions[0]!.category, 'PRESERVED_DOU_DECISION');
  equal(expected.decisions[1]!.category, 'PRESERVED_DOU_DECISION');
  deepEqual(expected.summary.counts, { publicationsInspected: 3, excludedCandidates: 1, kept: 2, review: 0 });
  for (const reverseOrigins of [false, true]) for (const reverseVersions of [false, true]) {
    const permuted = structuredClone(input); permuted.publications.reverse();
    for (const row of permuted.publications) {
      if (reverseOrigins) row.origins.reverse();
      if (reverseVersions) row.versions.reverse();
    }
    const untouched = structuredClone(permuted);
    deepEqual(planPublicationExclusionHistory(permuted), expected,
      `all decisions, aggregate categories and digests must be stable: origins=${reverseOrigins}, versions=${reverseVersions}`);
    deepEqual(permuted, untouched, 'sorting must not mutate source arrays');
  }
  deepEqual(input, sourceEvidence);
});

test('manifest hashes bind every evidence field, database identity and the complete versioned policy', () => {
  const input = snapshot(); const before = planPublicationExclusionHistory(input);
  const changed = structuredClone(input); changed.publications[0]!.agency = 'Ministério da Gestão';
  const after = planPublicationExclusionHistory(changed);
  equal(after.decisions[0]!.decision, 'EXCLUDE');
  notEqual(after.decisions[0]!.evidenceSha256, before.decisions[0]!.evidenceSha256);
  notEqual(after.summary.candidateSetSha256, before.summary.candidateSetSha256);
  notEqual(after.summary.inspectedSetSha256, before.summary.inspectedSetSha256);
  const anotherDatabase = planPublicationExclusionHistory({ ...input, databaseIdentity: 'different-restored-snapshot' });
  notEqual(anotherDatabase.summary.candidateSetSha256, before.summary.candidateSetSha256);
  const expectedManifest = (policy: unknown, decisions: PublicationExclusionHistoryDecision[]) => {
    const policyHash = hash(cleanupCanonicalJson(policy));
    return hash(`${PUBLICATION_EXCLUSION_HISTORY_VERSION}:${input.databaseIdentity}:${policyHash}\n` + decisions
      .map(row => `${row.publicationId}:${row.evidenceSha256}:${policyHash}:${row.decision}:${row.reasonCodes.join('|')}`).join('\n'));
  };
  equal(before.summary.candidateSetSha256, expectedManifest(PUBLICATION_EXCLUSION_POLICY, before.decisions));
  notEqual(before.summary.candidateSetSha256, expectedManifest({ ...PUBLICATION_EXCLUSION_POLICY, version: 'next-policy-version' }, before.decisions));
  notEqual(before.summary.candidateSetSha256, expectedManifest({ ...PUBLICATION_EXCLUSION_POLICY, rules: [] }, before.decisions));
});

test('duplicate identities and unsupported evidence fail validation, and empty inventories remain harmless', () => {
  const row = publication();
  throws(() => planPublicationExclusionHistory(snapshot(row, structuredClone(row))), /duplicate publication/);
  const planned = planPublicationExclusionHistory(snapshot());
  throws(() => summarizePublicationExclusionHistory(snapshot(), [planned.decisions[0]!, planned.decisions[0]!]), /Duplicate history decision/);
  const invalid = snapshot(); (invalid.publications[0] as unknown as Record<string, unknown>).unsupported = undefined;
  throws(() => planPublicationExclusionHistory(invalid), /JSON values only/);
  const empty = planPublicationExclusionHistory({ ...snapshot(), publications: [] });
  deepEqual(empty.summary.counts, { publicationsInspected: 0, excludedCandidates: 0, kept: 0, review: 0 });
  deepEqual(empty.summary.bySourceTypeGroup, []); deepEqual(empty.summary.byReason, {});
});

test('CLI accepts only the optional dry-run switch and rejects every mutation/unknown form', () => {
  equal(parsePublicationExclusionDryRunArgs([]), undefined);
  equal(parsePublicationExclusionDryRunArgs(['--dry-run']), undefined);
  for (const flag of ['--apply', '--apply=true', '--apply=false', '--delete', '--delete=false', '--suppress',
    '--suppress=false', '--restore', '--execute', '--confirm', '--all', '--allunknown', '--unknown', 'apply', '--dry-run=true', '--help']) {
    throws(() => parsePublicationExclusionDryRunArgs([flag]), /Only read-only dry-run/);
    throws(() => parsePublicationExclusionDryRunArgs(['--dry-run', flag]), /Only read-only dry-run/);
  }
  throws(() => parsePublicationExclusionDryRunArgs(['--dry-run', '--dry-run']), /Only read-only dry-run/);
});

type SqlCall = { sql: string; values: readonly unknown[] };
type Guard = { identity: string; read_only: string; default_read_only: string; isolation: string; unfiltered: boolean };
function mockClient(publications: ExclusionHistoryPublication[] = [publication()], options: {
  guard?: Partial<Guard>; noGuard?: boolean; sources?: Array<{ id: string }>;
  pages?: Array<Array<{ id: string }>>; failOn?: RegExp; dropPublications?: boolean; dropDependencies?: boolean;
} = {}) {
  const calls: SqlCall[] = [];
  let pageNumber = 0;
  const query = async (sql: string, values: readonly unknown[] = []) => {
    calls.push({ sql, values });
    if (options.failOn?.test(sql)) throw new Error('synthetic read failure');
    if (/^(?:BEGIN|ROLLBACK)\b/.test(sql)) return { rows: [] };
    if (sql.includes('pg_control_system()')) return { rows: options.noGuard ? [] : [{
      identity: 'c'.repeat(64), read_only: 'on', default_read_only: 'on', isolation: 'repeatable read', unfiltered: true,
      ...options.guard,
    }] };
    if (sql.includes('FROM public.sources')) return { rows: options.sources ?? [{ id: sourceId }] };
    if (sql.startsWith('SELECT p.id FROM public.publications p WHERE')) {
      if (options.pages) return { rows: options.pages[pageNumber++] ?? [] };
      const [lastId, requestedSource, batchSize] = values;
      equal(requestedSource, sourceId);
      return { rows: publications.filter(row => lastId === null || row.id > (lastId as string))
        .sort((a, b) => a.id.localeCompare(b.id)).slice(0, batchSize as number).map(row => ({ id: row.id })) };
    }
    const ids = values[0] as string[];
    const selected = publications.filter(row => ids.includes(row.id));
    if (sql.includes('public.publication_scope_is_in_scope(id)')) return { rows: options.dropPublications ? [] : selected.map(row => ({
      id: row.id, title: row.title, act_type: row.act_type, agency: row.agency, primary_official_url: row.primary_official_url,
      in_scope: row.inScope,
    })) };
    if (sql.startsWith('SELECT id, publication_id, source_id')) return { rows: selected.flatMap(row => row.origins.map(origin => ({ ...origin, publication_id: row.id }))) };
    if (sql.startsWith('SELECT id, publication_id, version_no')) return { rows: selected.flatMap(row => row.versions.map(version => ({ ...version, publication_id: row.id }))) };
    if (sql.includes('jsonb_build_object(')) return { rows: options.dropDependencies ? [] : selected.map(row => ({ id: row.id, dependency_counts: row.dependencyCounts })) };
    throw new Error(`Unexpected SQL in read-only mock: ${sql}`);
  };
  return { client: { query } as unknown as ClientBase, calls };
}

function assertReadOnly(calls: SqlCall[]) {
  equal(calls[0]!.sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  equal(calls[calls.length - 1]!.sql, 'ROLLBACK');
  equal(calls.filter(call => call.sql === 'ROLLBACK').length, 1);
  for (const call of calls) {
    ok(/^(?:SELECT|BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|ROLLBACK)\b/.test(call.sql), call.sql);
    ok(!/\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|CREATE|DROP|COMMIT|SET)\b/i.test(call.sql), call.sql);
  }
}

test('runner uses one guarded repeatable-read read-only transaction, full dependencies and rollback', async () => {
  const mock = mockClient();
  const summary = await runPublicationExclusionDryRun(mock.client, { now: () => new Date('2026-10-06T12:00:00.000Z') });
  assertReadOnly(mock.calls);
  equal(summary.mode, 'DRY_RUN_READ_ONLY'); equal(summary.executionAllowed, false);
  equal(summary.counts.excludedCandidates, 1);
  equal(summary.databaseIdentity, `pg:${'c'.repeat(32)}`);
  const guardSql = mock.calls[1]!.sql;
  for (const token of ['transaction_read_only', 'default_transaction_read_only', 'transaction_isolation', 'rolsuper OR rolbypassrls']) ok(guardSql.includes(token));
  const dependenciesSql = mock.calls.find(call => call.sql.includes('jsonb_build_object('))!.sql;
  for (const table of ['company_publications', 'publication_matches', 'publication_taxonomy_runs', 'publication_taxonomy_scans',
    'publication_taxonomy_curator_tags', 'publication_ncm_mentions', 'publication_ncm_scans', 'publication_files']) ok(dependenciesSql.includes(`public.${table}`), table);
  const inventorySql = mock.calls.filter(call => /FROM public.publication_(?:origins|versions) WHERE/.test(call.sql));
  equal(inventorySql.length, 2);
  for (const call of inventorySql) ok(!/\bis_current\s*=|source_id\s*=|\bLIMIT\b/i.test(call.sql), 'origin/version loaders must be unfiltered');
  const encoded = JSON.stringify(summary);
  for (const sensitive of [uuid(10), uuid(11), uuid(12), routine, officialUrl, '12345678']) ok(!encoded.includes(sensitive), sensitive);
});

test('runner manifests are independent of batch size and capture time', async () => {
  const rows = [publication(30), publication(10), publication(20)]; rows[2]!.dependencyCounts!.files = 1;
  const first = mockClient(rows); const second = mockClient(rows);
  const small = await runPublicationExclusionDryRun(first.client, { batchSize: 1, now: () => new Date('2026-10-06T12:00:00.000Z') });
  const large = await runPublicationExclusionDryRun(second.client, { batchSize: 5000, now: () => new Date('2026-10-07T12:00:00.000Z') });
  equal(small.candidateSetSha256, large.candidateSetSha256); equal(small.inspectedSetSha256, large.inspectedSetSha256);
  deepEqual(small.counts, { publicationsInspected: 3, excludedCandidates: 2, kept: 0, review: 1 });
  deepEqual(small.bySourceTypeGroup, large.bySourceTypeGroup); deepEqual(small.byReason, large.byReason);
  assertReadOnly(first.calls); assertReadOnly(second.calls);
});

test('runner rejects unsafe role/session/database guards before publication reads and still rolls back', async () => {
  for (const guard of [
    { read_only: 'off' }, { default_read_only: 'off' }, { isolation: 'read committed' },
    { unfiltered: false }, { identity: '' }, { identity: 'c'.repeat(63) }, { identity: 'G'.repeat(64) },
  ]) {
    const mock = mockClient([], { guard });
    await rejects(runPublicationExclusionDryRun(mock.client), /Read-only unfiltered snapshot guard failed/);
    assertReadOnly(mock.calls); equal(mock.calls.length, 3);
  }
  const mock = mockClient([], { noGuard: true });
  await rejects(runPublicationExclusionDryRun(mock.client), /Read-only unfiltered snapshot guard failed/);
  assertReadOnly(mock.calls); equal(mock.calls.length, 3);
});

test('source ambiguity, failed reads, incomplete batches and invalid pagination all rollback', async () => {
  const cases: Array<[Parameters<typeof mockClient>[1], RegExp]> = [
    [{ sources: [] }, /Exactly one DOU source/],
    [{ sources: [{ id: sourceId }, { id: uuid(999) }] }, /Exactly one DOU source/],
    [{ failOn: /FROM public.sources/ }, /synthetic read failure/],
    [{ failOn: /jsonb_build_object/ }, /synthetic read failure/],
    [{ dropPublications: true }, /Incomplete snapshot batch/],
    [{ dropDependencies: true }, /Incomplete snapshot batch/],
    [{ pages: [[{ id: uuid(20) }, { id: uuid(10) }]] }, /Invalid snapshot page order/],
    [{ pages: [[{ id: uuid(10) }, { id: uuid(10) }]] }, /Invalid snapshot page order/],
    [{ pages: [[{ id: uuid(10) }], [{ id: uuid(10) }]] }, /Invalid snapshot page order/],
  ];
  for (const [options, error] of cases) {
    const mock = mockClient([publication()], options);
    await rejects(runPublicationExclusionDryRun(mock.client), error); assertReadOnly(mock.calls);
  }
});

test('invalid batch bounds fail before opening a transaction; a rejected BEGIN does not claim rollback', async () => {
  for (const batchSize of [0, -1, 0.5, 5001, Number.MAX_SAFE_INTEGER, Number.NaN, Number.POSITIVE_INFINITY]) {
    const mock = mockClient(); await rejects(runPublicationExclusionDryRun(mock.client, { batchSize }), /Invalid batch size/);
    deepEqual(mock.calls, []);
  }
  const mock = mockClient([], { failOn: /^BEGIN/ });
  await rejects(runPublicationExclusionDryRun(mock.client), /synthetic read failure/);
  equal(mock.calls.length, 1); equal(mock.calls[0]!.sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
});
