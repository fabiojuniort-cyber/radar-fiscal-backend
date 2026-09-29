import type {
  DimensionCode,
} from './baseline.constants.js';

export interface SourceLock {
  schemaVersion: 'tribusca.taxonomy.source-lock/v1';
  canonicalRepository: string;
  canonicalPath: string;
  canonicalGitSha: string;
  canonicalBlobSha: string;
  canonicalSha256: string;
}

export interface VerifiedSource {
  lock: SourceLock;
  bytes: Buffer;
  text: string;
  gitBlobSha: string;
  sha256: string;
}

export type EvidenceStatus =
  | 'DOCUMENTED'
  | 'NEEDS_EVIDENCE'
  | 'NOT_ASSESSED';

export type AliasType =
  | 'EXACT_LEXICAL'
  | 'ABBREVIATION'
  | 'HISTORICAL_LABEL'
  | 'SEARCH_RELATED'
  | 'AMBIGUOUS';

export interface BaselineDimension {
  code: DimensionCode;
  name: string;
  description: string;
  identityStatus: 'CURRENT';
  governanceStatus: 'PROPOSED';
  expectedConceptCount: number;
}

export interface BaselineConcept {
  code: string;
  dimensionCode: DimensionCode;
  label: string;
  definition: string;
  positiveExample: string;
  negativeExample: string;
  governanceStatus: 'PROPOSED';
  evidenceStatus: EvidenceStatus;
  sourceMetadata: {
    line: number;
    section: string;
    anchor: string;
    linkage: string;
  };
}

export interface BaselineAliasBinding {
  targetConceptCode: string;
  aliasType: AliasType;
}

export interface BaselineAlias {
  text: string;
  normalizedText: string;
  language: 'pt-BR';
  bindings: BaselineAliasBinding[];
  decisionStatus: 'APPROVED';
  context: Record<string, unknown>;
  justification: string;
  evidenceStatus: 'NOT_ASSESSED';
  sourceMetadata: {
    line: number;
    section: '15';
  };
}

export interface RelationTypeSeed {
  code: string;
  inverseCode: string | null;
  directed: boolean;
  acyclic: boolean;
  hierarchical: boolean;
  canonicalStorageCode: string;
}

export interface BaselineRelation {
  sourceConceptCode: string;
  relationType: string;
  targetConceptCode: string;
  qualifiers: Record<string, unknown>;
  evidenceStatus: 'NOT_ASSESSED';
  sourceLocator: string;
}

export interface BaselineRelationRule {
  relationType: string;
  sourceDimension: DimensionCode;
  targetDimension: DimensionCode;
  allowed: true;
  requiresEvidence: false;
  acyclicOverride: null;
  derivation: {
    kind: 'R6_RELATION_EDGE';
    sourceLocator: string;
  };
}

export interface BaselineGap {
  code: string;
  status: string;
  sourceLocator: string;
}

export interface BaselineCorpusEntry {
  id: string;
  source: string;
  sourceLocator: string;
}

export interface BaselineIntermediateModel {
  dimensions: BaselineDimension[];
  concepts: BaselineConcept[];
  aliases: BaselineAlias[];
  relationTypes: RelationTypeSeed[];
  relations: BaselineRelation[];
  relationRules: BaselineRelationRule[];
  evidence: [];
  officialCatalogs: [];
  officialMappings: [];
  gaps: BaselineGap[];
  validationCorpus: BaselineCorpusEntry[];
  limitations: string[];
}

export interface BaselineManifest {
  manifestVersion: string;
  targetTaxonomyVersion: 'v1.0.0';
  source: {
    repository: string;
    path: string;
    gitSha: string;
    blobSha: string;
    sha256: string;
  };
  technicalContract: {
    contractVersion: 'tax-04/v1';
    repository: string;
    path: string;
    gitSha: string;
    blobSha: string;
    sha256: string;
  };
  derivation: {
    parserVersion: string;
    relationSeedContractVersion: string;
    fingerprint: string;
  };
  expected: {
    dimensions: number;
    concepts: number;
    needsEvidence: number;
    lexicalAliasCount: number;
    aliasBindingCount: number;
    multiBindLexicalAliasCount: number;
  };
  dimensions: BaselineDimension[];
  concepts: BaselineConcept[];
  aliases: BaselineAlias[];
  relationTypes: RelationTypeSeed[];
  relationRules: BaselineRelationRule[];
  relations: BaselineRelation[];
  evidence: [];
  officialCatalogs: [];
  officialMappings: [];
  gaps: BaselineGap[];
  validationCorpus: BaselineCorpusEntry[];
  limitations: string[];
}

export interface ValidationIssue {
  code: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

export type PlanAction =
  | 'CREATE_IDENTITY'
  | 'REUSE_IDENTITY'
  | 'CREATE_REVISION'
  | 'REUSE_REVISION'
  | 'CONFLICT';

export interface EntityPlan {
  code: string;
  identityAction: PlanAction;
  revisionAction: PlanAction;
  reason: string;
}

export interface BaselinePersistencePlan {
  releaseAction:
    | 'CREATE_RELEASE'
    | 'IDEMPOTENT_EXISTING_RELEASE'
    | 'VERSION_CONFLICT';
  dimensions: EntityPlan[];
  concepts: EntityPlan[];
  conflicts: string[];
  summary: {
    newIdentities: number;
    reusedIdentities: number;
    newRevisions: number;
    reusedRevisions: number;
  };
}

export interface BaselineReadback {
  dimensions: number;
  concepts: number;
  needsEvidence: number;
  lexicalAliases: number;
  aliasBindings: number;
  relationTypes: number;
  relationRules: number;
  relations: number;
  creditAliasIdentities: number;
  creditAmbiguousBindings: number;
  forbiddenMit: number;
  releaseVersion: string | null;
  releaseStatus: string | null;
  manifestSha256: string | null;
  derivationFingerprint: string | null;
}

export interface BaselineDryRunReport {
  readiness: 'READY' | 'BLOCKED';
  sourceIntegrity: 'PASS';
  counts: {
    dimensions: number;
    concepts: number;
    needsEvidence: number;
    lexicalAliases: number;
    aliasBindings: number;
    multiBindAliases: number;
  };
  validationIssues: ValidationIssue[];
  plan: BaselinePersistencePlan;
}

export interface ImportResult {
  status: 'SUCCESS' | 'IDEMPOTENT_ALREADY_IMPORTED';
  releaseId: string;
  readback: BaselineReadback;
}
