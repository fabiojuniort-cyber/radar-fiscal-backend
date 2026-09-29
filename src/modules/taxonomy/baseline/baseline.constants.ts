export const BASELINE_TARGET_VERSION = 'v1.0.0' as const;
export const BASELINE_MANIFEST_VERSION =
  'tribusca.taxonomy.baseline-manifest/v1' as const;
export const BASELINE_PARSER_VERSION =
  'r6-markdown-parser/v1' as const;
export const RELATION_SEED_CONTRACT_VERSION =
  'relation-seed-contract/v1' as const;

export const R6_MIRROR_PATH =
  'docs/taxonomy/baseline/source/TAX-02_DICIONARIO_FUNCIONAL_TAXONOMIA_TRIBUSCA_V1_R6.md';
export const R6_LOCK_PATH =
  'docs/taxonomy/baseline/source/R6.source-lock.json';
export const TAX04_MIRROR_PATH =
  'docs/taxonomy/baseline/source/TAX-04_MODELO_TECNICO_TAXONOMIA_TRIBUSCA_V1.md';
export const TAX04_LOCK_PATH =
  'docs/taxonomy/baseline/source/TAX-04.source-lock.json';

export const MANIFEST_PATH =
  'docs/taxonomy/baseline/TAXONOMY_BASELINE_V1_MANIFEST.json';

export const DIMENSIONS = [
  ['tax_species', 'Espécie tributária', 5],
  ['tax', 'Tributo', 43],
  ['theme', 'Tema', 44],
  ['treatment', 'Tratamento', 12],
  ['regime', 'Regime', 19],
  ['operation', 'Operação', 150],
  ['operation_scope', 'Âmbito da operação', 3],
  ['operation_purpose', 'Finalidade da operação', 10],
  ['operation_channel', 'Canal da operação', 3],
  ['document', 'Documento', 12],
  ['platform', 'Plataforma', 2],
  ['obligation', 'Obrigação', 22],
  ['sector', 'Setor', 45],
  ['product', 'Produto', 188],
  ['sphere', 'Esfera', 4],
  ['subject', 'Sujeito', 26],
  ['event', 'Evento', 13],
  ['act_type', 'Tipo de ato', 8],
  ['impact_operational', 'Impacto operacional', 10],
  ['impact_system', 'Impacto sistêmico', 9],
] as const;

export type DimensionCode = (typeof DIMENSIONS)[number][0];

export const DIMENSION_CODES = DIMENSIONS.map(
  ([code]) => code,
) as readonly DimensionCode[];

export const EXPECTED = {
  dimensions: 20,
  concepts: 628,
  uniqueConceptCodes: 628,
  needsEvidence: 55,
  forbiddenMitConcepts: 0,
  lexicalAliases: 21,
  aliasBindings: 23,
  multiBindLexicalAliases: 1,
} as const;

export const FORBIDDEN_MIT_CODES = [
  'platform.mit',
  'obligation.mit',
  'bookkeeping.mit',
] as const;

export const CONCEPT_CODE_PATTERN =
  /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

export const ALIAS_TYPES = [
  'EXACT_LEXICAL',
  'ABBREVIATION',
  'HISTORICAL_LABEL',
  'SEARCH_RELATED',
  'AMBIGUOUS',
] as const;

export const EVIDENCE_STATUSES = [
  'DOCUMENTED',
  'NEEDS_EVIDENCE',
  'NOT_ASSESSED',
] as const;
