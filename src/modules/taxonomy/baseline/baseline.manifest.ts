import {
  BASELINE_MANIFEST_VERSION,
  BASELINE_PARSER_VERSION,
  BASELINE_TARGET_VERSION,
  RELATION_SEED_CONTRACT_VERSION,
} from './baseline.constants.js';
import {
  canonicalJson,
  sha256Hex,
} from './baseline.canonical-json.js';
import type {
  BaselineIntermediateModel,
  BaselineManifest,
  VerifiedSource,
} from './baseline.types.js';

export function buildDerivationFingerprint(input: {
  source: VerifiedSource;
  technicalContract: VerifiedSource;
  parserVersion?: string;
  manifestVersion?: string;
  relationSeedContractVersion?: string;
}): string {
  return sha256Hex(
    canonicalJson({
      sourceFingerprint: {
        repository:
          input.source.lock.canonicalRepository,
        path: input.source.lock.canonicalPath,
        gitSha: input.source.lock.canonicalGitSha,
        blobSha: input.source.gitBlobSha,
        sha256: input.source.sha256,
      },
      technicalContractFingerprint: {
        repository:
          input.technicalContract.lock.canonicalRepository,
        path:
          input.technicalContract.lock.canonicalPath,
        gitSha:
          input.technicalContract.lock.canonicalGitSha,
        blobSha: input.technicalContract.gitBlobSha,
        sha256: input.technicalContract.sha256,
      },
      parserVersion:
        input.parserVersion ?? BASELINE_PARSER_VERSION,
      manifestVersion:
        input.manifestVersion ?? BASELINE_MANIFEST_VERSION,
      relationSeedContractVersion:
        input.relationSeedContractVersion ??
        RELATION_SEED_CONTRACT_VERSION,
    }),
  );
}

export function buildManifest(
  model: BaselineIntermediateModel,
  source: VerifiedSource,
  technicalContract: VerifiedSource,
): BaselineManifest {
  const aliasBindingCount = model.aliases.reduce(
    (sum, alias) => sum + alias.bindings.length,
    0,
  );
  const multiBindLexicalAliasCount =
    model.aliases.filter(
      (alias) => alias.bindings.length > 1,
    ).length;
  const needsEvidence = model.concepts.filter(
    (concept) =>
      concept.evidenceStatus === 'NEEDS_EVIDENCE',
  ).length;

  return {
    manifestVersion: BASELINE_MANIFEST_VERSION,
    targetTaxonomyVersion: BASELINE_TARGET_VERSION,
    source: {
      repository: source.lock.canonicalRepository,
      path: source.lock.canonicalPath,
      gitSha: source.lock.canonicalGitSha,
      blobSha: source.gitBlobSha,
      sha256: source.sha256,
    },
    technicalContract: {
      contractVersion: 'tax-04/v1',
      repository:
        technicalContract.lock.canonicalRepository,
      path: technicalContract.lock.canonicalPath,
      gitSha:
        technicalContract.lock.canonicalGitSha,
      blobSha: technicalContract.gitBlobSha,
      sha256: technicalContract.sha256,
    },
    derivation: {
      parserVersion: BASELINE_PARSER_VERSION,
      relationSeedContractVersion:
        RELATION_SEED_CONTRACT_VERSION,
      fingerprint: buildDerivationFingerprint({
        source,
        technicalContract,
      }),
    },
    expected: {
      dimensions: model.dimensions.length,
      concepts: model.concepts.length,
      needsEvidence,
      lexicalAliasCount: model.aliases.length,
      aliasBindingCount,
      multiBindLexicalAliasCount,
    },
    dimensions: model.dimensions,
    concepts: model.concepts,
    aliases: model.aliases,
    relationTypes: model.relationTypes,
    relationRules: model.relationRules,
    relations: model.relations,
    evidence: model.evidence,
    officialCatalogs: model.officialCatalogs,
    officialMappings: model.officialMappings,
    gaps: model.gaps,
    validationCorpus: model.validationCorpus,
    limitations: model.limitations,
  };
}

export function manifestBytes(
  manifest: BaselineManifest,
): string {
  return canonicalJson(manifest) + '\n';
}

export function manifestSha256(
  manifest: BaselineManifest,
): string {
  return sha256Hex(manifestBytes(manifest));
}
