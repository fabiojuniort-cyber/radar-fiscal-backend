import { createHash } from 'node:crypto';

import { classifyDouContractExcerpt, DOU_SCOPE_RULE_VERSION } from './dou-scope.rules.js';

/** Issue #80 / D-066. Offline candidate discovery only; NEVER an execution plan. */
export const DOU_CLEANUP_PLAN_VERSION = 'dou-cleanup-candidates-v1' as const;
type Metadata = Record<string, unknown>;
export interface CleanupOrigin { id: string; source_id: string; metadata: Metadata }
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

function provenance(metadata: Metadata): { section: string; dou: Metadata } | undefined {
  const dou = record(metadata.dou);
  if (metadata.sourceRole !== 'PRIMARY' || metadata.ingestionChannel !== 'INLABS' || typeof dou?.section !== 'string') return undefined;
  if (!EXCLUDED.has(dou.section) && !INCLUDED.has(dou.section)) return undefined;
  // Any supplied archive/part section must agree with the canonical section.
  const archive = record(dou.archive);
  if (dou.archive !== undefined && (!archive || archive.section !== dou.section)) return undefined;
  if (archive?.filename !== undefined) {
    if (typeof archive.filename !== 'string') return undefined;
    const filename = /^(\d{4}-\d{2}-\d{2})-(DO[123]E?)\.zip$/.exec(archive.filename);
    if (!filename || filename[2] !== dou.section || (archive.date !== undefined && archive.date !== filename[1]) ||
      (dou.publicationDate !== undefined && dou.publicationDate !== filename[1])) return undefined;
  }
  if (dou.parts !== undefined) {
    if (!Array.isArray(dou.parts) || !dou.parts.length || dou.parts.some(part => record(record(part)?.attributes)?.pubName !== dou.section)) return undefined;
  }
  return { section: dou.section, dou };
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
