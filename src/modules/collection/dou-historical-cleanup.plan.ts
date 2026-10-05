import { createHash } from 'node:crypto';

import { classifyDouContractExcerpt, DOU_SCOPE_RULE_VERSION } from './dou-scope.rules.js';

/** Issue #80 / D-066. Offline candidate discovery only; NEVER an execution plan. */
export const DOU_CLEANUP_PLAN_VERSION = 'dou-cleanup-candidates-v2' as const;
type Metadata = Record<string, unknown>;
export interface CleanupOrigin { id: string; source_id: string; external_id?: string | null; official_url?: string | null; metadata: Metadata }
export interface CleanupVersion {
  id: string;
  is_current: boolean;
  content_text: string | null;
  source_metadata: Metadata;
}
export interface CleanupPublication {
  id: string;
  title: string;
  act_type: string | null;
  agency: string | null;
  primary_official_url?: string | null;
  origins: CleanupOrigin[];
  versions: CleanupVersion[];
}
export interface DouCleanupSnapshot {
  schemaVersion: 'dou-cleanup-snapshot-v1';
  /** Non-secret identity of the exported database; never a connection URL. */
  databaseIdentity: string;
  capturedAt: string;
  source: { id: string; code: 'dou'; connector_key: 'dou' };
  publications: CleanupPublication[];
}
export interface DouCleanupCandidateDecision {
  publicationId: string;
  disposition: 'CANDIDATE' | 'KEEP' | 'REVIEW';
  reasonCodes: string[];
  originIds: string[];
  versionIds: string[];
  /** Includes all supplied row fields and metadata, not merely content_hash. */
  evidenceSha256: string;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const EXCLUDED = new Set(['DO2', 'DO2E']);
const INCLUDED = new Set(['DO1', 'DO1E', 'DO3', 'DO3E']);
const SHA256 = /^[a-f0-9]{64}$/;

function record(value: unknown): Metadata | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Metadata : undefined;
}
function required(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid cleanup snapshot: ${message}`);
}
function id(value: unknown, label: string): asserts value is string {
  required(typeof value === 'string' && UUID.test(value), `${label} must be a lowercase UUID`);
}
function nullableString(value: unknown): boolean { return value === null || typeof value === 'string'; }

/** Canonical JSON rejects unsupported values instead of silently dropping evidence. */
export function cleanupCanonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(cleanupCanonicalJson).join(',') + ']';
  const object = record(value);
  if (!object || Object.getPrototypeOf(object) !== Object.prototype) throw new Error('Cleanup evidence must contain JSON values only');
  return '{' + Object.keys(object).sort().map(key => JSON.stringify(key) + ':' + cleanupCanonicalJson(object[key])).join(',') + '}';
}
function digest(value: unknown): string {
  return createHash('sha256').update(cleanupCanonicalJson(value)).digest('hex');
}

export function validateDouCleanupSnapshot(input: unknown): asserts input is DouCleanupSnapshot {
  cleanupCanonicalJson(input);
  const root = record(input);
  required(root?.schemaVersion === 'dou-cleanup-snapshot-v1', 'unsupported schemaVersion');
  required(typeof root.databaseIdentity === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(root.databaseIdentity), 'databaseIdentity must be a non-secret label');
  required(typeof root.capturedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(root.capturedAt) &&
    Number.isFinite(Date.parse(root.capturedAt)) && new Date(root.capturedAt).toISOString() === root.capturedAt, 'capturedAt must be a valid UTC timestamp');
  const source = record(root.source);
  required(source?.code === 'dou' && source.connector_key === 'dou', 'source must be the explicit dou connector');
  id(source.id, 'source.id');
  required(Array.isArray(root.publications), 'publications must be an array');
  const publicationIds = new Set<string>();
  const originIds = new Set<string>();
  const versionIds = new Set<string>();
  function unique(value: unknown, label: string, seen: Set<string>) {
    id(value, label); required(!seen.has(value), `duplicate ${label}`); seen.add(value);
  }
  for (const raw of root.publications) {
    const publication = record(raw);
    required(publication, 'publication must be an object');
    unique(publication.id, 'publication.id', publicationIds);
    required(typeof publication.title === 'string' && publication.title.trim(), 'publication.title is required');
    required(nullableString(publication.act_type) && nullableString(publication.agency), 'act_type and agency must be string or null');
    required(Array.isArray(publication.origins) && Array.isArray(publication.versions), 'all origins and versions must be explicit arrays');
    const versionNumbers = new Set<number>();
    for (const rawOrigin of publication.origins) {
      const origin = record(rawOrigin); required(origin, 'origin must be an object');
      unique(origin.id, 'origin.id', originIds); id(origin.source_id, 'origin.source_id');
      required(origin.publication_id === undefined || origin.publication_id === publication.id, 'origin parent does not match publication');
      required(record(origin.metadata), 'origin.metadata must be an object');
    }
    for (const rawVersion of publication.versions) {
      const version = record(rawVersion); required(version, 'version must be an object');
      unique(version.id, 'version.id', versionIds);
      required(version.publication_id === undefined || version.publication_id === publication.id, 'version parent does not match publication');
      if (version.version_no !== undefined) {
        required(typeof version.version_no === 'number' && Number.isSafeInteger(version.version_no) && version.version_no > 0 &&
          !versionNumbers.has(version.version_no), 'invalid or duplicate version_no');
        versionNumbers.add(version.version_no);
      }
      required(typeof version.is_current === 'boolean' && nullableString(version.content_text), 'invalid version state/content');
      required(record(version.source_metadata), 'version.source_metadata must be an object');
    }
  }
}

interface DouProvenance { section: string; identity: string; partsSha256: string; pageKeys: Set<string>; dou: Metadata }
function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value + 'T00:00:00.000Z')) && new Date(value + 'T00:00:00.000Z').toISOString().slice(0, 10) === value;
}
function certifiedPageKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    const date = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(url.searchParams.get('data') ?? '');
    const journal = url.searchParams.get('jornal'); const page = url.searchParams.get('pagina');
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'pesquisa.in.gov.br' || url.username || url.password || url.port ||
      url.pathname !== '/imprensa/jsp/visualiza/index.jsp' || !date || !validDate(`${date[3]}-${date[2]}-${date[1]}`) ||
      !journal || !/^\d+$/.test(journal) || !page || !/^\d+$/.test(page) ||
      ['data', 'jornal', 'pagina'].some(key => url.searchParams.getAll(key).length !== 1)) return undefined;
    return `${date[3]}-${date[2]}-${date[1]}:${journal}:${page}`;
  } catch { return undefined; }
}
function provenance(metadata: Metadata): DouProvenance | undefined {
  const dou = record(metadata.dou);
  if (metadata.sourceRole !== 'PRIMARY' || metadata.ingestionChannel !== 'INLABS' || typeof dou?.section !== 'string') return undefined;
  if (!EXCLUDED.has(dou.section) && !INCLUDED.has(dou.section)) return undefined;
  // Never infer section, date or matter from whichever field happens to pass.
  // The source envelope, ZIP, every XML part and origin key must corroborate it.
  const date = dou.publicationDate;
  const matter = dou.officialMatterId;
  const edition = dou.edition;
  if (!validDate(date) || typeof matter !== 'string' || !/^\d+$/.test(matter) ||
    typeof edition !== 'string' || !/^[^:\s]+$/.test(edition) ||
    typeof dou.sourceActType !== 'string' || !dou.sourceActType.trim() || dou.embeddedAct === true) return undefined;
  const archive = record(dou.archive);
  if (!archive || archive.section !== dou.section || archive.date !== date ||
    archive.filename !== `${date}-${dou.section}.zip` || typeof archive.rawSha256 !== 'string' || !SHA256.test(archive.rawSha256)) return undefined;
  if (archive.officialUrl !== undefined) {
    if (typeof archive.officialUrl !== 'string') return undefined;
    try {
      const url = new URL(archive.officialUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'inlabs.in.gov.br' || url.username || url.password || url.port ||
        url.pathname !== '/index.php' || url.searchParams.getAll('p').length !== 1 || url.searchParams.get('p') !== date ||
        url.searchParams.getAll('dl').length !== 1 || url.searchParams.get('dl') !== archive.filename) return undefined;
    } catch { return undefined; }
  }
  if (!Array.isArray(dou.parts) || !dou.parts.length) return undefined;
  const partNumbers = new Set<number>();
  const pageKeys = new Set<string>();
  const partFingerprints: Array<{ filename: string; rawSha256: string }> = [];
  let journal: string | undefined;
  const brazilianDate = `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
  for (const raw of dou.parts) {
    const part = record(raw); const attributes = record(part?.attributes);
    if (!part || !attributes || typeof part.filename !== 'string' || typeof part.rawSha256 !== 'string' || !SHA256.test(part.rawSha256)) return undefined;
    const filename = /^(\d+)_(\d{8})_(\d+)(?:-(\d+))?\.xml$/.exec(part.filename);
    if (!filename || filename[2] !== date.replaceAll('-', '') || filename[3] !== matter ||
      attributes.pubName !== dou.section || attributes.pubDate !== brazilianDate || attributes.idMateria !== matter ||
      attributes.editionNumber !== edition || attributes.artType !== dou.sourceActType) return undefined;
    if (journal !== undefined && journal !== filename[1]) return undefined;
    journal = filename[1];
    const partNumber = Number(filename[4] ?? '1');
    if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumbers.has(partNumber)) return undefined;
    partNumbers.add(partNumber);
    partFingerprints.push({ filename: part.filename, rawSha256: part.rawSha256 });
    if (part.sizeBytes !== undefined && (typeof part.sizeBytes !== 'number' || !Number.isSafeInteger(part.sizeBytes) || part.sizeBytes <= 0)) return undefined;
    if (attributes.pdfPage !== undefined) {
      const key = certifiedPageKey(attributes.pdfPage);
      if (!key || key !== `${date}:${journal}:${attributes.numberPage}`) return undefined;
      pageKeys.add(key);
    }
  }
  // Parts are contiguous; both unsuffixed.xml and -1.xml denote part 1.
  if ([...partNumbers].some(number => number > partNumbers.size)) return undefined;
  if (dou.certifiedPageUrls !== undefined) {
    if (!Array.isArray(dou.certifiedPageUrls) || !dou.certifiedPageUrls.length) return undefined;
    const keys = dou.certifiedPageUrls.map(certifiedPageKey);
    if (keys.some(key => !key || !pageKeys.has(key)) || new Set(keys).size !== pageKeys.size) return undefined;
  }
  return { section: dou.section, identity: `${date}:${dou.section}:${edition}:${matter}`,
    partsSha256: digest(partFingerprints.sort((a, b) => a.filename.localeCompare(b.filename))), pageKeys, dou };
}

/** Old captures may have silently lost Ementa/continuations. Absence is not proof. */
function hasRoutineEvidenceEnvelope(dou: Metadata): boolean {
  const strings = (value: unknown): boolean => Array.isArray(value) && value.every(item => typeof item === 'string');
  const archive = record(dou.archive);
  return dou.sourceActType === 'EXTRATO DE CONTRATO' && dou.titleFallback === undefined &&
    dou.scopeStructureIncomplete === false &&
    typeof dou.abstract === 'string' && strings(dou.continuationTitles) && strings(dou.continuationAbstracts) &&
    !!archive && typeof archive.rawSha256 === 'string' && SHA256.test(archive.rawSha256) &&
    Array.isArray(dou.parts) && dou.parts.length > 0 && dou.parts.every(part => {
      const item = record(part); const attributes = record(item?.attributes);
      return typeof item?.rawSha256 === 'string' && SHA256.test(item.rawSha256) &&
        attributes?.artType === 'EXTRATO DE CONTRATO';
    });
}

function decide(publication: CleanupPublication, sourceId: string): DouCleanupCandidateDecision {
  const base = {
    publicationId: publication.id,
    originIds: publication.origins.map(row => row.id).sort(),
    versionIds: publication.versions.map(row => row.id).sort(),
    evidenceSha256: digest(publication),
  };
  const result = (disposition: DouCleanupCandidateDecision['disposition'], ...reasonCodes: string[]): DouCleanupCandidateDecision =>
    ({ ...base, disposition, reasonCodes: [...new Set(reasonCodes)].sort() });
  if (!publication.origins.length) return result('REVIEW', 'missing_origins');
  if (!publication.origins.some(origin => origin.source_id === sourceId)) return result('KEEP', 'not_dou_source');
  if (publication.origins.some(origin => origin.source_id !== sourceId)) return result('REVIEW', 'cross_source_publication');
  if (!publication.versions.length || publication.versions.filter(version => version.is_current).length !== 1) return result('REVIEW', 'missing_or_invalid_version_inventory');

  const metadata = [...publication.origins.map(row => row.metadata), ...publication.versions.map(row => row.source_metadata)];
  const evidence = metadata.map(provenance);
  if (evidence.some(item => !item)) return result('REVIEW', 'missing_or_conflicting_dou_provenance');
  const originIdentities = new Set<string>();
  for (const [index, origin] of publication.origins.entries()) {
    const originEvidence = evidence[index]!;
    const identity = originEvidence.identity;
    if (origin.external_id !== identity) return result('REVIEW', 'missing_or_conflicting_origin_external_id');
    if (origin.official_url !== undefined) {
      const key = certifiedPageKey(origin.official_url);
      if (!key || !originEvidence.pageKeys.has(key)) return result('REVIEW', 'conflicting_origin_official_url');
    }
    originIdentities.add(identity);
  }
  if (evidence.slice(publication.origins.length).some(item => !originIdentities.has(item!.identity))) {
    return result('REVIEW', 'version_provenance_without_matching_origin');
  }
  if (evidence.slice(publication.origins.length).some(version => !evidence.slice(0, publication.origins.length)
    .some(origin => origin!.identity === version!.identity && origin!.partsSha256 === version!.partsSha256))) {
    return result('REVIEW', 'version_and_origin_part_inventory_disagree');
  }
  if (publication.primary_official_url !== undefined && publication.primary_official_url !== null) {
    const key = certifiedPageKey(publication.primary_official_url);
    if (!key || !evidence.some(item => item!.pageKeys.has(key))) return result('REVIEW', 'conflicting_primary_official_url');
  }
  if (evidence.every(item => EXCLUDED.has(item!.section))) return result('CANDIDATE', 'excluded_dou_section');
  if (evidence.some(item => EXCLUDED.has(item!.section))) return result('REVIEW', 'mixed_included_and_excluded_sections');

  // Check every historical body against every preserved metadata envelope:
  // origin-only Ementa updates and old KEEP versions must veto removal.
  const classifications = publication.versions.flatMap(version => metadata.map(meta => classifyDouContractExcerpt({
    title: publication.title, actType: publication.act_type, agency: publication.agency,
    content: version.content_text, metadata: meta,
  })));
  // Persisted KEEP/REVIEW is a safety veto, not positive evidence for deletion.
  // A stale IGNORE annotation never replaces fresh classification.
  const storedScopes = metadata.filter(meta => meta.douScope !== undefined).map(meta => record(meta.douScope));
  if (storedScopes.some(value => value?.decision === 'KEEP')) return result('KEEP', 'persisted_keep_decision');
  if (classifications.some(value => value?.decision === 'KEEP')) return result('KEEP', 'material_relevance',
    ...classifications.flatMap(value => value?.decision === 'KEEP' ? [value.category, ...value.reasonCodes] : []));
  if (classifications.every(value => value === null)) return result('KEEP', 'not_contract_excerpt');
  if (storedScopes.some(value => value?.decision !== 'IGNORE')) return result('REVIEW', 'persisted_review_or_invalid_scope');
  // Extra attachments are outside the body/supplementary proof. Even a file
  // labelled PROVENANCE is not silently assumed to contain no material text.
  const fileInventories = [...metadata.map(meta => meta.files),
    (publication as unknown as Metadata).files, ...publication.versions.map(version => (version as unknown as Metadata).files)];
  if (fileInventories.some(files => files !== undefined && (!Array.isArray(files) || files.length > 0))) {
    return result('REVIEW', 'unexamined_attached_material');
  }
  if (publication.act_type !== 'EXTRATO DE CONTRATO') return result('REVIEW', 'conflicting_or_missing_contract_act_type');
  // Versions do not store their own title. Applying today's mutable title to
  // an old body cannot establish the title family of that historical version.
  if (publication.versions.length !== 1) return result('REVIEW', 'historical_titles_unproven');
  if (evidence.some(item => !hasRoutineEvidenceEnvelope(item!.dou))) return result('REVIEW', 'historical_text_completeness_unproven');
  if (classifications.some(value => value?.decision !== 'IGNORE' || value.category !== 'CONTRATACAO_ADMINISTRATIVA_ROTINEIRA')) {
    return result('REVIEW', 'not_unanimously_proven_routine', ...classifications.flatMap(value => value?.reasonCodes ?? []));
  }
  return result('CANDIDATE', 'strict_routine_contract_excerpt', ...classifications.flatMap(value => value!.reasonCodes));
}

export function planDouHistoricalCleanup(input: unknown) {
  validateDouCleanupSnapshot(input);
  const decisions = input.publications.map(publication => decide(publication, input.source.id))
    .sort((left, right) => left.publicationId.localeCompare(right.publicationId));
  const plan = {
    planVersion: DOU_CLEANUP_PLAN_VERSION,
    ruleVersion: DOU_SCOPE_RULE_VERSION,
    mode: 'DRY_RUN_OFFLINE_ONLY' as const,
    executionAllowed: false as const,
    databaseIdentity: input.databaseIdentity,
    capturedAt: input.capturedAt,
    sourceId: input.source.id,
    snapshotSha256: digest(input),
    counts: {
      publicationsInspected: decisions.length,
      candidatePublications: decisions.filter(row => row.disposition === 'CANDIDATE').length,
      keptPublications: decisions.filter(row => row.disposition === 'KEEP').length,
      reviewPublications: decisions.filter(row => row.disposition === 'REVIEW').length,
    },
    blockers: [
      'executor_not_implemented',
      'historical_retention_and_cleanup_strategy_not_approved',
      'full_database_snapshot_and_fk_closure_not_verified',
      'deployed_code_and_no_reentry_not_verified',
      'backup_and_temporary_restore_test_not_verified',
      'exact_locked_transactional_dry_run_and_rollback_not_verified',
      'operational_lock_and_independent_approval_not_verified',
    ],
    decisions,
  };
  return { ...plan, planSha256: digest(plan) };
}

export function parseDouCleanupCliArgs(args: readonly string[]): { inputPath: string } {
  if (args.some(arg => /^(?:--execute|--confirm|--apply|--delete)(?:=|$)/.test(arg))) {
    throw new Error('Execution is intentionally unavailable. Issue #80 requires a separately reviewed, gated executor.');
  }
  const paths = args.filter(arg => arg.startsWith('--input=')).map(arg => arg.slice('--input='.length));
  if (paths.length !== 1 || !paths[0]?.startsWith('/') || args.some(arg => arg !== '--dry-run' && !arg.startsWith('--input='))) {
    throw new Error('Usage: dou-historical-cleanup --input=/absolute/snapshot.json [--dry-run]');
  }
  return { inputPath: paths[0] };
}
