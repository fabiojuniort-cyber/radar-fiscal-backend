export type AutoAliasType = 'EXACT_LEXICAL' | 'ABBREVIATION';

export interface ClassificationAlias {
  text: string;
  aliasType:
    | AutoAliasType
    | 'HISTORICAL_LABEL'
    | 'SEARCH_RELATED'
    | 'AMBIGUOUS';
}

export interface LexicalConceptInput {
  releaseConceptId: string;
  code: string;
  label: string;
  aliases: ClassificationAlias[];
}

export interface LexicalAssertion {
  releaseConceptId: string;
  conceptCode: string;
  confidence: number;
  reasonCode:
    | 'CANONICAL_LABEL'
    | 'EXACT_LEXICAL_ALIAS'
    | 'ABBREVIATION_ALIAS';
  matchedTerm: string;
}

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsTerm(text: string, term: string): boolean {
  const normalizedTerm = normalize(term);
  if (!normalizedTerm) return false;
  return (' ' + text + ' ').includes(' ' + normalizedTerm + ' ');
}

export function classifyLexically(
  rawText: string,
  concepts: readonly LexicalConceptInput[],
): LexicalAssertion[] {
  const text = normalize(rawText);
  const found = new Map<string, LexicalAssertion>();

  for (const concept of concepts) {
    if (containsTerm(text, concept.label)) {
      found.set(concept.releaseConceptId, {
        releaseConceptId: concept.releaseConceptId,
        conceptCode: concept.code,
        confidence: 0.95,
        reasonCode: 'CANONICAL_LABEL',
        matchedTerm: concept.label,
      });
    }

    for (const alias of concept.aliases) {
      if (
        alias.aliasType !== 'EXACT_LEXICAL' &&
        alias.aliasType !== 'ABBREVIATION'
      ) {
        continue;
      }

      if (!containsTerm(text, alias.text)) continue;

      const candidate: LexicalAssertion = {
        releaseConceptId: concept.releaseConceptId,
        conceptCode: concept.code,
        confidence: alias.aliasType === 'ABBREVIATION' ? 0.99 : 0.97,
        reasonCode:
          alias.aliasType === 'ABBREVIATION'
            ? 'ABBREVIATION_ALIAS'
            : 'EXACT_LEXICAL_ALIAS',
        matchedTerm: alias.text,
      };

      const current = found.get(concept.releaseConceptId);
      if (!current || candidate.confidence > current.confidence) {
        found.set(concept.releaseConceptId, candidate);
      }
    }
  }

  return [...found.values()].sort((left, right) =>
    left.conceptCode.localeCompare(right.conceptCode),
  );
}
