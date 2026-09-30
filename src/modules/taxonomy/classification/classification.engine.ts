import {
  sha256Hex,
} from '../baseline/baseline.canonical-json.js';
import {
  buildClassificationFingerprint,
  type ClassificationFingerprint,
} from './classification.fingerprint.js';
import {
  classifyLexically,
  type LexicalAssertion,
  type LexicalConceptInput,
} from './classification.lexical.js';

export const LEXICAL_ENGINE_KEY = 'tribusca.taxonomy.lexical';
export const LEXICAL_ENGINE_VERSION = '1';

export interface LexicalClassificationPlanInput {
  publicationVersionId: string;
  taxonomyReleaseId: string;
  title: string;
  contentText?: string | null;
  concepts: readonly LexicalConceptInput[];
  codeGitSha?: string | null;
}

export interface LexicalClassificationPlan {
  publicationVersionId: string;
  taxonomyReleaseId: string;
  methodType: 'RULE';
  engineKey: string;
  engineVersion: string;
  codeGitSha: string | null;
  configSnapshot: Record<string, unknown>;
  inputSha256: string;
  fingerprint: ClassificationFingerprint;
  assertions: LexicalAssertion[];
}

export function planLexicalClassification(
  input: LexicalClassificationPlanInput,
): LexicalClassificationPlan {
  const effectiveInput = [
    input.title.trim(),
    input.contentText?.trim() ?? '',
  ].join('\n');

  const configSnapshot = {
    policyVersion: 1,
    canonicalLabel: true,
    autoAliasTypes: ['EXACT_LEXICAL', 'ABBREVIATION'],
    excludedAliasTypes: [
      'HISTORICAL_LABEL',
      'SEARCH_RELATED',
      'AMBIGUOUS',
    ],
    normalization: 'NFD_LOWER_ALNUM_TOKENS',
  };

  const inputSha256 = sha256Hex(effectiveInput);
  const fingerprint = buildClassificationFingerprint({
    publicationVersionId: input.publicationVersionId,
    taxonomyReleaseId: input.taxonomyReleaseId,
    methodType: 'RULE',
    engineKey: LEXICAL_ENGINE_KEY,
    engineVersion: LEXICAL_ENGINE_VERSION,
    codeGitSha: input.codeGitSha ?? null,
    configSnapshot,
    inputSha256,
  });

  return {
    publicationVersionId: input.publicationVersionId,
    taxonomyReleaseId: input.taxonomyReleaseId,
    methodType: 'RULE',
    engineKey: LEXICAL_ENGINE_KEY,
    engineVersion: LEXICAL_ENGINE_VERSION,
    codeGitSha: input.codeGitSha ?? null,
    configSnapshot,
    inputSha256,
    fingerprint,
    assertions: classifyLexically(effectiveInput, input.concepts),
  };
}
