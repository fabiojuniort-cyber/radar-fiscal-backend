import {
  ALIAS_TYPES,
  BASELINE_MANIFEST_VERSION,
  BASELINE_PARSER_VERSION,
  CONCEPT_CODE_PATTERN,
  DIMENSIONS,
  EXPECTED,
  FORBIDDEN_MIT_CODES,
  R6_APPROVED_PROVENANCE,
  RELATION_SEED_CONTRACT_VERSION,
  TAX04_APPROVED_PROVENANCE,
} from './baseline.constants.js';
import {
  canonicalJson,
  sha256Hex,
} from './baseline.canonical-json.js';
import type {
  BaselineManifest,
  ValidationIssue,
  ValidationResult,
} from './baseline.types.js';

function cycleExists(
  manifest: BaselineManifest,
  family: string,
): boolean {
  const typeByCode = new Map(
    manifest.relationTypes.map((type) => [
      type.code,
      type,
    ]),
  );
  const adjacency = new Map<string, string[]>();

  for (const relation of manifest.relations) {
    const type = typeByCode.get(relation.relationType);

    if (
      !type ||
      type.canonicalStorageCode !== family ||
      !type.acyclic
    ) {
      continue;
    }

    const current =
      adjacency.get(relation.sourceConceptCode) ?? [];
    current.push(relation.targetConceptCode);
    adjacency.set(relation.sourceConceptCode, current);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(node: string): boolean {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;

    visiting.add(node);

    for (const next of adjacency.get(node) ?? []) {
      if (visit(next)) return true;
    }

    visiting.delete(node);
    visited.add(node);
    return false;
  }

  return [...adjacency.keys()].some((node) =>
    visit(node),
  );
}

export function validateManifest(
  manifest: BaselineManifest,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const conceptCodes = manifest.concepts.map(
    (concept) => concept.code,
  );
  const uniqueCodes = new Set(conceptCodes);
  const conceptSet = new Set(conceptCodes);
  const dimensionSet = new Set(
    manifest.dimensions.map((dimension) => dimension.code),
  );

  const add = (code: string, message: string): void => {
    issues.push({ code, message });
  };


  const expectedMetadata = {
    dimensions: EXPECTED.dimensions,
    concepts: EXPECTED.concepts,
    needsEvidence: EXPECTED.needsEvidence,
    lexicalAliasCount: EXPECTED.lexicalAliases,
    aliasBindingCount: EXPECTED.aliasBindings,
    multiBindLexicalAliasCount:
      EXPECTED.multiBindLexicalAliases,
  };

  if (
    canonicalJson(manifest.expected) !==
    canonicalJson(expectedMetadata)
  ) {
    add(
      'MANIFEST_EXPECTED_COUNTS_MISMATCH',
      canonicalJson(manifest.expected),
    );
  }

  if (
    manifest.manifestVersion !==
      BASELINE_MANIFEST_VERSION ||
    manifest.derivation.parserVersion !==
      BASELINE_PARSER_VERSION ||
    manifest.derivation.relationSeedContractVersion !==
      RELATION_SEED_CONTRACT_VERSION
  ) {
    add(
      'DERIVATION_VERSION_MISMATCH',
      canonicalJson(manifest.derivation),
    );
  }

  const approvedSource = {
    repository: R6_APPROVED_PROVENANCE.canonicalRepository,
    path: R6_APPROVED_PROVENANCE.canonicalPath,
    gitSha: R6_APPROVED_PROVENANCE.canonicalGitSha,
    blobSha: R6_APPROVED_PROVENANCE.canonicalBlobSha,
    sha256: R6_APPROVED_PROVENANCE.canonicalSha256,
  };
  const approvedContract = {
    contractVersion: 'tax-04/v1',
    repository:
      TAX04_APPROVED_PROVENANCE.canonicalRepository,
    path: TAX04_APPROVED_PROVENANCE.canonicalPath,
    gitSha: TAX04_APPROVED_PROVENANCE.canonicalGitSha,
    blobSha: TAX04_APPROVED_PROVENANCE.canonicalBlobSha,
    sha256: TAX04_APPROVED_PROVENANCE.canonicalSha256,
  };

  if (
    canonicalJson(manifest.source) !==
    canonicalJson(approvedSource)
  ) {
    add(
      'SOURCE_FINGERPRINT_MISMATCH',
      canonicalJson(manifest.source),
    );
  }

  if (
    canonicalJson(manifest.technicalContract) !==
    canonicalJson(approvedContract)
  ) {
    add(
      'TECHNICAL_CONTRACT_FINGERPRINT_MISMATCH',
      canonicalJson(manifest.technicalContract),
    );
  }

  const expectedDerivationFingerprint = sha256Hex(
    canonicalJson({
      sourceFingerprint: manifest.source,
      technicalContractFingerprint: {
        repository: manifest.technicalContract.repository,
        path: manifest.technicalContract.path,
        gitSha: manifest.technicalContract.gitSha,
        blobSha: manifest.technicalContract.blobSha,
        sha256: manifest.technicalContract.sha256,
      },
      parserVersion: manifest.derivation.parserVersion,
      manifestVersion: manifest.manifestVersion,
      relationSeedContractVersion:
        manifest.derivation.relationSeedContractVersion,
    }),
  );

  if (
    manifest.derivation.fingerprint !==
    expectedDerivationFingerprint
  ) {
    add(
      'DERIVATION_FINGERPRINT_MISMATCH',
      manifest.derivation.fingerprint,
    );
  }

  if (manifest.dimensions.length !== EXPECTED.dimensions) {
    add(
      'DIMENSION_COUNT_MISMATCH',
      String(manifest.dimensions.length),
    );
  }

  if (manifest.concepts.length !== EXPECTED.concepts) {
    add(
      'CONCEPT_COUNT_MISMATCH',
      String(manifest.concepts.length),
    );
  }

  if (uniqueCodes.size !== EXPECTED.uniqueConceptCodes) {
    add(
      'DUPLICATE_CONCEPT_CODE',
      String(uniqueCodes.size),
    );
  }

  const needsEvidence = manifest.concepts.filter(
    (concept) =>
      concept.evidenceStatus === 'NEEDS_EVIDENCE',
  ).length;

  if (needsEvidence !== EXPECTED.needsEvidence) {
    add(
      'NEEDS_EVIDENCE_COUNT_MISMATCH',
      String(needsEvidence),
    );
  }

  for (const [code, , expectedCount] of DIMENSIONS) {
    const actual = manifest.concepts.filter(
      (concept) => concept.dimensionCode === code,
    ).length;

    if (actual !== expectedCount) {
      add(
        'DIMENSION_CONCEPT_COUNT_MISMATCH',
        code +
          '=' +
          String(actual) +
          ', expected=' +
          String(expectedCount),
      );
    }
  }

  for (const concept of manifest.concepts) {
    if (!CONCEPT_CODE_PATTERN.test(concept.code)) {
      add('INVALID_CONCEPT_CODE', concept.code);
    }

    if (!dimensionSet.has(concept.dimensionCode)) {
      add('INVALID_DIMENSION', concept.code);
    }

    if (
      !concept.code.startsWith(
        concept.dimensionCode + '.',
      )
    ) {
      add(
        'CONCEPT_DIMENSION_PREFIX_MISMATCH',
        concept.code,
      );
    }
  }

  for (const forbidden of FORBIDDEN_MIT_CODES) {
    if (conceptSet.has(forbidden)) {
      add(
        'FORBIDDEN_MIT_CANONICALIZATION',
        forbidden,
      );
    }
  }

  const aliasBindingCount = manifest.aliases.reduce(
    (sum, alias) => sum + alias.bindings.length,
    0,
  );
  const multiBind = manifest.aliases.filter(
    (alias) => alias.bindings.length > 1,
  ).length;

  if (
    manifest.aliases.length !== EXPECTED.lexicalAliases
  ) {
    add(
      'LEXICAL_ALIAS_COUNT_MISMATCH',
      String(manifest.aliases.length),
    );
  }

  if (aliasBindingCount !== EXPECTED.aliasBindings) {
    add(
      'ALIAS_BINDING_COUNT_MISMATCH',
      String(aliasBindingCount),
    );
  }

  if (
    multiBind !== EXPECTED.multiBindLexicalAliases
  ) {
    add(
      'MULTI_BIND_ALIAS_COUNT_MISMATCH',
      String(multiBind),
    );
  }

  for (const alias of manifest.aliases) {
    for (const binding of alias.bindings) {
      if (
        !ALIAS_TYPES.includes(
          binding.aliasType as (typeof ALIAS_TYPES)[number],
        )
      ) {
        add(
          'INVALID_ALIAS_TYPE',
          alias.text + ' -> ' + binding.aliasType,
        );
      }

      if (!conceptSet.has(binding.targetConceptCode)) {
        add(
          'UNRESOLVED_ALIAS_TARGET',
          alias.text +
            ' -> ' +
            binding.targetConceptCode,
        );
      }
    }
  }

  const expectedRelationTypes = [
    ['narrower_than', 'broader_than', true, true, true, 'narrower_than'],
    ['broader_than', 'narrower_than', true, true, true, 'narrower_than'],
    ['part_of', null, true, true, false, 'part_of'],
    ['related_to', null, false, false, false, 'related_to'],
    ['replaced_by', 'supersedes', true, true, false, 'replaced_by'],
    ['supersedes', 'replaced_by', true, true, false, 'replaced_by'],
    ['applies_to', null, true, false, false, 'applies_to'],
  ];

  if (
    canonicalJson(
      manifest.relationTypes.map((type) => [
        type.code,
        type.inverseCode,
        type.directed,
        type.acyclic,
        type.hierarchical,
        type.canonicalStorageCode,
      ]),
    ) !== canonicalJson(expectedRelationTypes)
  ) {
    add(
      'RELATION_SEED_CONTRACT_MISMATCH',
      'relation-seed-contract/v1',
    );
  }

  const relationTypeByCode = new Map(
    manifest.relationTypes.map((type) => [
      type.code,
      type,
    ]),
  );
  const relationKeys = new Set<string>();

  for (const relation of manifest.relations) {
    const relationType = relationTypeByCode.get(
      relation.relationType,
    );

    if (!relationType) {
      add(
        'UNRESOLVED_RELATION_TYPE',
        relation.relationType,
      );
    } else if (
      relation.relationType !==
      relationType.canonicalStorageCode
    ) {
      add(
        'NON_CANONICAL_RELATION_DIRECTION',
        relation.relationType,
      );
    }
    if (
      !conceptSet.has(relation.sourceConceptCode) ||
      !conceptSet.has(relation.targetConceptCode)
    ) {
      add(
        'UNRESOLVED_RELATION_ENDPOINT',
        relation.sourceConceptCode +
          ' -> ' +
          relation.targetConceptCode,
      );
    }

    if (
      relation.sourceConceptCode ===
      relation.targetConceptCode
    ) {
      add(
        'RELATION_SELF_LOOP',
        relation.sourceConceptCode,
      );
    }

    const key = canonicalJson([
      relation.relationType,
      relation.sourceConceptCode,
      relation.targetConceptCode,
      relation.qualifiers,
    ]);

    if (relationKeys.has(key)) {
      add('DUPLICATE_RELATION', key);
    }

    relationKeys.add(key);
  }

  const conceptByCode = new Map(
    manifest.concepts.map((concept) => [
      concept.code,
      concept,
    ]),
  );
  const validRuleKeys = new Set(
    manifest.relations.map((relation) => {
      const source = conceptByCode.get(
        relation.sourceConceptCode,
      );
      const target = conceptByCode.get(
        relation.targetConceptCode,
      );

      return [
        relation.relationType,
        source?.dimensionCode ?? '',
        target?.dimensionCode ?? '',
      ].join('|');
    }),
  );

  const actualRuleKeys = new Set(
    manifest.relationRules.map((rule) =>
      [
        rule.relationType,
        rule.sourceDimension,
        rule.targetDimension,
      ].join('|'),
    ),
  );

  for (const relation of manifest.relations) {
    const source = conceptByCode.get(
      relation.sourceConceptCode,
    );
    const target = conceptByCode.get(
      relation.targetConceptCode,
    );

    if (source && target) {
      const key = [
        relation.relationType,
        source.dimensionCode,
        target.dimensionCode,
      ].join('|');

      if (!actualRuleKeys.has(key)) {
        add('MISSING_RELATION_RULE', key);
      }
    }
  }

  for (const rule of manifest.relationRules) {
    const key = [
      rule.relationType,
      rule.sourceDimension,
      rule.targetDimension,
    ].join('|');

    if (
      !validRuleKeys.has(key) ||
      !rule.allowed ||
      rule.requiresEvidence ||
      rule.acyclicOverride !== null
    ) {
      add('INVALID_RELATION_RULE', key);
    }
  }

  for (const family of [
    'narrower_than',
    'part_of',
    'replaced_by',
  ]) {
    if (cycleExists(manifest, family)) {
      add('RELATION_CYCLE', family);
    }
  }

  if (manifest.officialMappings.length !== 0) {
    add(
      'UNAPPROVED_OFFICIAL_MAPPING',
      String(manifest.officialMappings.length),
    );
  }

  if (manifest.officialCatalogs.length !== 0) {
    add(
      'UNAPPROVED_OFFICIAL_CATALOG',
      String(manifest.officialCatalogs.length),
    );
  }

  return {
    ok: issues.length === 0,
    issues,
  };
}

export function assertValidManifest(
  manifest: BaselineManifest,
): void {
  const result = validateManifest(manifest);

  if (!result.ok) {
    throw new Error(
      'BASELINE_VALIDATION_FAILED: ' +
        canonicalJson(result.issues),
    );
  }
}
