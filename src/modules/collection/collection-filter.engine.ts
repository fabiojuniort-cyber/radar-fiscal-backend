export type CollectionFilterMode =
  | 'KEEP_ALWAYS'
  | 'KEEP_IF_TAX_TERM'
  | 'EXCLUDE_UNLESS_STRONG'
  | 'EXCLUDE_ALWAYS';

export type CollectionFilterTermStrength =
  | 'STRONG'
  | 'WEAK'
  | 'NEGATIVE';

export type CollectionFilterLocation =
  | 'TITLE'
  | 'SUMMARY'
  | 'BODY';

export interface CollectionFilterTypeRule {
  sourceCode: string;
  section?: string;
  canonicalType: string;
  mode: CollectionFilterMode;
}

export interface CollectionFilterTypeAlias {
  sourceCode: string;
  section?: string;
  alias: string;
  canonicalType: string;
}

export interface CollectionFilterTerm {
  text: string;
  strength: CollectionFilterTermStrength;
  sourceCode?: string;
  section?: string;
  canonicalType?: string;
  locationScope?: 'ANY' | CollectionFilterLocation;
}

export interface CollectionFilterPolicyInput {
  version: number;
  contextWindowWords: number;
  weakScoreThreshold: number;
  locationWeights: {
    title: number;
    summary: number;
    body: number;
  };
  rules: readonly CollectionFilterTypeRule[];
  aliases?: readonly CollectionFilterTypeAlias[];
  terms: readonly CollectionFilterTerm[];
}

export interface CollectionFilterPublication {
  sourceCode: string;
  section?: string | null;
  actType?: string | null;
  title: string;
  summary?: string | null;
  body?: string | null;
  evidenceComplete: boolean;
  materialAttachmentsUnexamined?: boolean;
  typeConflict?: boolean;
  /** Raw type supplied by the official source (may disagree with parsed actType). */
  sourceActType?: string | null | undefined;
  provenanceConflict?: boolean;
}

export interface CollectionFilterTermHit {
  text: string;
  strength: CollectionFilterTermStrength;
  location: CollectionFilterLocation;
  tokenIndex: number;
  weight: number;
  neutralizedByNegative: boolean;
}

export interface CollectionFilterDecision {
  policyVersion: number;
  decision: 'KEEP' | 'DISCARD';
  reasonCode:
    | 'UNKNOWN_TYPE'
    | 'INCOMPLETE_EVIDENCE'
    | 'UNEXAMINED_MATERIAL'
    | 'TYPE_CONFLICT'
    | 'TYPE_CONFLICT_BOTH_EXCLUDED'
    | 'PROVENANCE_CONFLICT'
    | 'PROTECTED_PUBLICATION'
    | 'KEEP_ALWAYS'
    | 'STRONG_TERM'
    | 'WEAK_TERM_THRESHOLD'
    | 'NO_TAX_TERM'
    | 'NO_STRONG_TERM'
    | 'EXCLUDE_ALWAYS';
  sourceCode: string;
  section: string;
  rawType: string;
  normalizedRawType: string;
  canonicalType?: string;
  mode?: CollectionFilterMode;
  requiresNewTypeReview: boolean;
  weakScore: number;
  termHits: CollectionFilterTermHit[];
  matchedPattern?: string;
  matchedSection?: string;
  matchedTypeSource?: 'OFFICIAL' | 'TITLE';
}

interface CompiledTerm {
  original: CollectionFilterTerm;
  normalized: string;
  tokens: string[];
  sourceCode?: string;
  section?: string;
  canonicalType?: string;
  locationScope: 'ANY' | CollectionFilterLocation;
}

export interface CompiledCollectionFilterPolicy {
  version: number;
  contextWindowWords: number;
  weakScoreThreshold: number;
  locationWeights: Record<CollectionFilterLocation, number>;
  rules: ReadonlyMap<string, CollectionFilterTypeRule>;
  aliases: ReadonlyMap<string, string>;
  terms: readonly CompiledTerm[];
  patterns: ReadonlyMap<string, readonly CompiledTypePattern[]>;
}

interface CompiledTypePattern {
  pattern: string;
  rule: CollectionFilterTypeRule;
  words: number;
}

const NON_PRESERVING_POSITIVE_TERMS = new Set([
  'cnpj',
  'cpf',
  'processo',
  'processo administrativo',
  'numero do processo',
  'valor',
  'valor total',
  'valor global',
]);

export function normalizeCollectionFilterText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleUpperCase('pt-BR')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function normalizeCollectionFilterType(value: string): string {
  const withoutNumber = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLocaleUpperCase('pt-BR')
    .replace(/\b(?:N[º°]|N(?:O|UMERO)?\.?)[ \t]*\d+(?:[ \t]*[./-][ \t]*\d+)*/g, ' ')
    .replace(/\b\d+(?:[ \t]*\/[ \t]*\d+)\b/g, ' ')
    .replace(/\bN[º°](?=\s|$)/g, ' ');
  return normalizeCollectionFilterText(withoutNumber);
}

/** Only the first title line, before an act identifier, can provide a type. */
export function collectionFilterTitleType(title: string): string {
  const line = title.split(/[\r\n]/, 1)[0] ?? '';
  return line.split(/\s+N(?:[º°]|[oO]\.?|[úu]mero|\.)\s*\d/i, 1)[0]?.trim() ?? '';
}

/**
 * Source-provided DOU type is often a generic family (e.g. "Resolução")
 * while the canonical parser emits a specific act type. Treat a proper
 * normalized prefix as compatible, never an unrelated classification.
 * The final KEEP/DISCARD decision remains in evaluateCollectionFilter.
 */
export function collectionFilterTypeConflict(sourceActType: string | null | undefined,
  canonicalActType: string | null | undefined): boolean {
  const source = normalizeCollectionFilterType(sourceActType ?? '');
  if (!source) return false;
  const canonical = normalizeCollectionFilterType(canonicalActType ?? '');
  return source !== canonical && !canonical.startsWith(source + ' ');
}

export function normalizeCollectionFilterSection(value: string | null | undefined): string {
  return normalizeCollectionFilterText(value ?? '').replace(/^(DO[123])E$/, '$1');
}
// Saved extra-section rules remain distinct; editions inherit the principal
// scope during matching instead of silently merging rule identities.
function normalizedSection(value: string | null | undefined): string {
  return normalizeCollectionFilterText(value ?? '');
}

function normalizedSource(value: string): string {
  return normalizeCollectionFilterText(value);
}

function key(source: string, section: string, type: string): string {
  return `${source}\u0000${section}\u0000${type}`;
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new RangeError(`${name} must be an integer between 1 and 100`);
  }
}

export function compileCollectionFilterPolicy(
  input: CollectionFilterPolicyInput,
): CompiledCollectionFilterPolicy {
  if (!Number.isSafeInteger(input.version) || input.version < 1) {
    throw new RangeError('policy version must be a positive integer');
  }
  if (
    !Number.isSafeInteger(input.contextWindowWords) ||
    input.contextWindowWords < 0 ||
    input.contextWindowWords > 100
  ) {
    throw new RangeError('contextWindowWords must be between 0 and 100');
  }
  validatePositiveInteger(
    input.weakScoreThreshold,
    'weakScoreThreshold',
  );
  validatePositiveInteger(input.locationWeights.title, 'titleWeight');
  validatePositiveInteger(
    input.locationWeights.summary,
    'summaryWeight',
  );
  validatePositiveInteger(input.locationWeights.body, 'bodyWeight');

  const rules = new Map<string, CollectionFilterTypeRule>();
  for (const rule of input.rules) {
    const sourceCode = normalizedSource(rule.sourceCode);
    const section = normalizedSection(rule.section);
    const canonicalType = normalizeCollectionFilterType(
      rule.canonicalType,
    );
    if (!sourceCode || !canonicalType) {
      throw new Error('filter rule source/type must not be blank');
    }
    const ruleKey = key(sourceCode, section, canonicalType);
    const existingRule = rules.get(ruleKey);
    if (existingRule) {
      if (existingRule.mode !== rule.mode) throw new Error(`conflicting filter rule: ${ruleKey}`);
      // Normalize redundant identities in memory only; never edit saved rules.
      continue;
    }
    rules.set(ruleKey, {
      ...rule,
      sourceCode,
      section,
      canonicalType,
    });
  }

  const aliases = new Map<string, string>();
  for (const alias of input.aliases ?? []) {
    const sourceCode = normalizedSource(alias.sourceCode);
    const section = normalizedSection(alias.section);
    const normalizedAlias = normalizeCollectionFilterType(alias.alias);
    const canonicalType = normalizeCollectionFilterType(
      alias.canonicalType,
    );
    if (!sourceCode || !normalizedAlias || !canonicalType) {
      throw new Error('filter alias fields must not be blank');
    }
    const aliasKey = key(sourceCode, section, normalizedAlias);
    const existing = aliases.get(aliasKey);
    if (existing && existing !== canonicalType) {
      throw new Error(`conflicting filter alias: ${aliasKey}`);
    }
    aliases.set(aliasKey, canonicalType);
  }

  const terms: CompiledTerm[] = input.terms.map((term) => {
    const normalized = normalizeCollectionFilterText(term.text);
    if (!normalized) throw new Error('filter term must not be blank');
    const normalizedLower = normalized.toLocaleLowerCase('pt-BR');
    if (
      term.strength !== 'NEGATIVE' &&
      NON_PRESERVING_POSITIVE_TERMS.has(normalizedLower)
    ) {
      throw new Error(
        `term cannot preserve a publication by itself: ${term.text}`,
      );
    }
    return {
      original: term,
      normalized,
      tokens: normalized.split(' '),
      ...(term.sourceCode
        ? { sourceCode: normalizedSource(term.sourceCode) }
        : {}),
      ...(term.section !== undefined
        ? { section: normalizedSection(term.section) }
        : {}),
      ...(term.canonicalType
        ? {
            canonicalType: normalizeCollectionFilterType(
              term.canonicalType,
            ),
          }
        : {}),
      locationScope: term.locationScope ?? 'ANY',
    };
  });

  const termScopes = new Map<string, CollectionFilterTermStrength>();
  for (const term of terms) {
    const scopeKey = [
      term.normalized,
      term.sourceCode ?? '',
      term.section ?? '',
      term.canonicalType ?? '',
      term.locationScope,
    ].join('\u0000');
    const existing = termScopes.get(scopeKey);
    if (existing) {
      if (existing === term.original.strength) {
        throw new Error(`duplicate filter term: ${term.normalized}`);
      }
      throw new Error(
        `conflicting filter term strength: ${term.normalized}`,
      );
    }
    termScopes.set(scopeKey, term.original.strength);
  }

  const patterns = new Map<string, CompiledTypePattern[]>();
  const addPattern = (pattern: string, rule: CollectionFilterTypeRule) => {
    const firstWord = pattern.split(' ')[0] ?? '';
    const bucketKey = key(rule.sourceCode, rule.section ?? '', firstWord);
    const bucket = patterns.get(bucketKey) ?? [];
    bucket.push({ pattern, rule, words: pattern.split(' ').length });
    patterns.set(bucketKey, bucket);
  };
  for (const rule of rules.values()) addPattern(rule.canonicalType, rule);
  for (const [aliasKey, canonical] of aliases) {
    const [source, section, alias] = aliasKey.split('\u0000');
    if (!source || section === undefined || !alias) continue;
    const rule = rules.get(key(source, section, canonical));
    if (rule) addPattern(alias, rule);
  }

  return {
    version: input.version,
    contextWindowWords: input.contextWindowWords,
    weakScoreThreshold: input.weakScoreThreshold,
    locationWeights: {
      TITLE: input.locationWeights.title,
      SUMMARY: input.locationWeights.summary,
      BODY: input.locationWeights.body,
    },
    rules,
    aliases,
    terms,
    patterns,
  };
}

interface TokenizedLocation {
  location: CollectionFilterLocation;
  tokens: string[];
}

function tokenize(value: string | null | undefined): string[] {
  const normalized = normalizeCollectionFilterText(value ?? '');
  return normalized ? normalized.split(' ') : [];
}

function termMatchesAt(
  tokens: readonly string[],
  term: readonly string[],
  index: number,
): boolean {
  if (index + term.length > tokens.length) return false;
  for (let offset = 0; offset < term.length; offset += 1) {
    if (tokens[index + offset] !== term[offset]) return false;
  }
  return true;
}

function scoped(
  term: CompiledTerm,
  sourceCode: string,
  section: string,
  canonicalType: string,
  location: CollectionFilterLocation,
): boolean {
  return (
    (!term.sourceCode || term.sourceCode === sourceCode) &&
    (term.section === undefined || term.section === section) &&
    (!term.canonicalType || term.canonicalType === canonicalType) &&
    (term.locationScope === 'ANY' ||
      term.locationScope === location)
  );
}

function distance(
  leftIndex: number,
  leftLength: number,
  rightIndex: number,
  rightLength: number,
): number {
  const leftEnd = leftIndex + leftLength - 1;
  const rightEnd = rightIndex + rightLength - 1;
  if (leftEnd < rightIndex) return rightIndex - leftEnd;
  if (rightEnd < leftIndex) return leftIndex - rightEnd;
  return 0;
}

export function evaluateCollectionFilter(
  policy: CompiledCollectionFilterPolicy,
  publication: CollectionFilterPublication,
): CollectionFilterDecision {
  const sourceCode = normalizedSource(publication.sourceCode);
  const rawSection = normalizedSection(publication.section);
  const section = normalizeCollectionFilterSection(publication.section);
  const official = publication.sourceActType ?? publication.actType ?? '';
  const inputs = [
    { raw: official.trim(), from: 'OFFICIAL' as const },
    { raw: collectionFilterTitleType(publication.title), from: 'TITLE' as const },
  ];
  const matches: Array<{ item: CompiledTypePattern; raw: string; from: 'OFFICIAL'|'TITLE' }> = [];
  for (const input of inputs) {
    const type = normalizeCollectionFilterType(input.raw);
    if (!type) continue;
    const first = type.split(' ')[0] ?? '';
    for (const ruleSection of new Set([rawSection, section, ''])) {
      for (const item of policy.patterns.get(key(sourceCode, ruleSection, first)) ?? []) {
        if (type === item.pattern || type.startsWith(item.pattern + ' ')) {
          matches.push({ item, raw: input.raw, from: input.from });
        }
      }
    }
  }
  const maximumWords = Math.max(0, ...matches.map(match => match.item.words));
  const top = matches.filter(match => match.item.words === maximumWords);
  if (!top.length) {
    const rawType = official.trim() || inputs[1]!.raw;
    return { policyVersion: policy.version, sourceCode, section, rawType,
      normalizedRawType: normalizeCollectionFilterType(rawType), decision: 'KEEP',
      reasonCode: 'UNKNOWN_TYPE', requiresNewTypeReview: true, weakScore: 0, termHits: [] };
  }
  const decisions = top.map(match => ({ match, decision: evaluateMatchedRule(policy,
    publication, match.item.rule, match.raw, match.from, match.item.pattern) }));
  // Mode-specific term gates are evaluated before tie-breaking: any KEEP wins.
  decisions.sort((a, b) => Number(b.decision.decision === 'KEEP') - Number(a.decision.decision === 'KEEP')
    || Number(Boolean(b.match.item.rule.section)) - Number(Boolean(a.match.item.rule.section))
    || a.match.item.pattern.localeCompare(b.match.item.pattern, 'en')
    || a.match.from.localeCompare(b.match.from, 'en'));
  return decisions[0]!.decision;
}

function evaluateMatchedRule(policy: CompiledCollectionFilterPolicy,
  publication: CollectionFilterPublication, rule: CollectionFilterTypeRule,
  rawType: string, matchedTypeSource: 'OFFICIAL'|'TITLE', matchedPattern: string): CollectionFilterDecision {
  const sourceCode = normalizedSource(publication.sourceCode);
  const section = normalizedSection(publication.section);
  const normalizedRawType = normalizeCollectionFilterType(rawType);

  const base = {
    policyVersion: policy.version,
    sourceCode,
    section,
    rawType,
    normalizedRawType,
    requiresNewTypeReview: false,
    weakScore: 0,
    termHits: [] as CollectionFilterTermHit[],
  };

  const canonicalType = rule.canonicalType;

  const safeBase = {
    ...base,
    canonicalType,
    mode: rule.mode,
    matchedPattern,
    matchedSection: rule.section ?? '',
    matchedTypeSource,
  };

  if (publication.provenanceConflict || !sourceCode) {
    return { ...safeBase, decision: 'KEEP', reasonCode: 'PROVENANCE_CONFLICT' };
  }
  if (rule.mode === 'EXCLUDE_ALWAYS') {
    return { ...safeBase, decision: 'DISCARD', reasonCode: 'EXCLUDE_ALWAYS' };
  }

  if (!publication.evidenceComplete) {
    return {
      ...safeBase,
      decision: 'KEEP',
      reasonCode: 'INCOMPLETE_EVIDENCE',
    };
  }
  if (publication.materialAttachmentsUnexamined) {
    return {
      ...safeBase,
      decision: 'KEEP',
      reasonCode: 'UNEXAMINED_MATERIAL',
    };
  }
  if (publication.provenanceConflict) {
    return {
      ...safeBase,
      decision: 'KEEP',
      reasonCode: 'PROVENANCE_CONFLICT',
    };
  }
  if (rule.mode === 'KEEP_ALWAYS') {
    return {
      ...safeBase,
      decision: 'KEEP',
      reasonCode: 'KEEP_ALWAYS',
    };
  }

  const locations: TokenizedLocation[] = [
    { location: 'TITLE', tokens: tokenize(publication.title) },
    { location: 'SUMMARY', tokens: tokenize(publication.summary) },
    { location: 'BODY', tokens: tokenize(publication.body) },
  ];

  type RawHit = {
    term: CompiledTerm;
    location: CollectionFilterLocation;
    tokenIndex: number;
  };
  const rawHits: RawHit[] = [];
  for (const location of locations) {
    for (const term of policy.terms) {
      if (
        !scoped(
          term,
          sourceCode,
          section,
          canonicalType,
          location.location,
        )
      ) {
        continue;
      }
      for (
        let index = 0;
        index <= location.tokens.length - term.tokens.length;
        index += 1
      ) {
        if (termMatchesAt(location.tokens, term.tokens, index)) {
          rawHits.push({
            term,
            location: location.location,
            tokenIndex: index,
          });
        }
      }
    }
  }

  const negativeHits = rawHits.filter(
    (hit) => hit.term.original.strength === 'NEGATIVE',
  );
  let weakScore = 0;
  let strong = false;
  const termHits: CollectionFilterTermHit[] = rawHits.map((hit) => {
    const strength = hit.term.original.strength;
    const weight = policy.locationWeights[hit.location];
    let neutralizedByNegative = false;
    if (strength === 'STRONG') {
      strong = true;
    } else if (strength === 'WEAK') {
      neutralizedByNegative = negativeHits.some(
        (negative) =>
          negative.location === hit.location &&
          distance(
            hit.tokenIndex,
            hit.term.tokens.length,
            negative.tokenIndex,
            negative.term.tokens.length,
          ) <= policy.contextWindowWords,
      );
      if (!neutralizedByNegative) weakScore += weight;
    }
    return {
      text: hit.term.original.text,
      strength,
      location: hit.location,
      tokenIndex: hit.tokenIndex,
      weight,
      neutralizedByNegative,
    };
  });

  const evaluatedBase = {
    ...safeBase,
    weakScore,
    termHits,
  };

  if (strong) {
    return {
      ...evaluatedBase,
      decision: 'KEEP',
      reasonCode: 'STRONG_TERM',
    };
  }

  if (rule.mode === 'EXCLUDE_UNLESS_STRONG') {
    return {
      ...evaluatedBase,
      decision: 'DISCARD',
      reasonCode: 'NO_STRONG_TERM',
    };
  }

  if (weakScore >= policy.weakScoreThreshold) {
    return {
      ...evaluatedBase,
      decision: 'KEEP',
      reasonCode: 'WEAK_TERM_THRESHOLD',
    };
  }

  return {
    ...evaluatedBase,
    decision: 'DISCARD',
    reasonCode: 'NO_TAX_TERM',
  };
}
