import {
  compareCanonicalText,
} from './baseline.canonical-json.js';
import {
  ALIAS_TYPES,
  DIMENSIONS,
  DIMENSION_CODES,
  type DimensionCode,
} from './baseline.constants.js';
import {
  buildBaselineRelations,
  RELATION_TYPE_SEEDS,
} from './baseline.relation-seeds.js';
import type {
  AliasType,
  BaselineAlias,
  BaselineConcept,
  BaselineCorpusEntry,
  BaselineGap,
  BaselineIntermediateModel,
  BaselineRelationRule,
} from './baseline.types.js';

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim();
}

function splitMarkdownRow(line: string): string[] {
  if (!line.startsWith('|') || !line.endsWith('|')) {
    throw new Error(
      'PARSER_SCHEMA_MISMATCH: malformed Markdown table row',
    );
  }

  return line
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
}

function sectionNumber(lines: string[], index: number): string {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const match = /^##\s+(\d+)\./.exec(lines[cursor] ?? '');
    if (match?.[1]) {
      return match[1];
    }
  }

  throw new Error(
    'PARSER_SCHEMA_MISMATCH: concept outside numbered section',
  );
}

function parseDefinition(value: string): {
  definition: string;
  positiveExample: string;
  negativeExample: string;
} {
  const positiveToken = '; + ';
  const negativeToken = '; − ';
  const positiveAt = value.indexOf(positiveToken);
  const negativeAt = value.indexOf(negativeToken);

  if (
    positiveAt < 0 ||
    negativeAt < 0 ||
    negativeAt <= positiveAt
  ) {
    throw new Error(
      'PARSER_SCHEMA_MISMATCH: definition/examples format changed',
    );
  }

  return {
    definition: stripInlineMarkdown(
      value.slice(0, positiveAt),
    ),
    positiveExample: stripInlineMarkdown(
      value.slice(
        positiveAt + positiveToken.length,
        negativeAt,
      ),
    ),
    negativeExample: stripInlineMarkdown(
      value.slice(negativeAt + negativeToken.length),
    ),
  };
}

function parseConcepts(lines: string[]): BaselineConcept[] {
  const start = lines.findIndex((line) =>
    line.startsWith('## 4.'),
  );
  const end = lines.findIndex((line) =>
    line.startsWith('## 14.'),
  );

  if (start < 0 || end <= start) {
    throw new Error(
      'PARSER_SCHEMA_MISMATCH: canonical dictionary boundary changed',
    );
  }

  const codePattern =
    /^\|\s*`?([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)`?\s*\|/;

  const concepts: BaselineConcept[] = [];

  for (let index = start; index < end; index += 1) {
    const line = lines[index] ?? '';

    if (!codePattern.test(line)) {
      continue;
    }

    const cells = splitMarkdownRow(line);

    if (cells.length !== 5) {
      throw new Error(
        'PARSER_SCHEMA_MISMATCH: concept row ' +
          String(index + 1) +
          ' has ' +
          String(cells.length) +
          ' columns',
      );
    }

    const code = stripInlineMarkdown(cells[0] ?? '');
    const dimensionCode = code.split('.')[0] as DimensionCode;

    if (!DIMENSION_CODES.includes(dimensionCode)) {
      throw new Error(
        'PARSER_SCHEMA_MISMATCH: unknown dimension ' +
          dimensionCode,
      );
    }

    const parsed = parseDefinition(cells[2] ?? '');
    const anchor = stripInlineMarkdown(cells[3] ?? '');

    concepts.push({
      code,
      dimensionCode,
      label: stripInlineMarkdown(cells[1] ?? ''),
      ...parsed,
      governanceStatus: 'PROPOSED',
      evidenceStatus: anchor.includes('NEEDS_EVIDENCE')
        ? 'NEEDS_EVIDENCE'
        : 'DOCUMENTED',
      sourceMetadata: {
        line: index + 1,
        section: sectionNumber(lines, index),
        anchor,
        linkage: stripInlineMarkdown(cells[4] ?? ''),
      },
    });
  }

  return concepts.sort((left, right) =>
    compareCanonicalText(left.code, right.code),
  );
}

export function normalizeAliasText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseAliases(lines: string[]): BaselineAlias[] {
  const start = lines.findIndex((line) =>
    line.startsWith('## 15.'),
  );
  const end = lines.findIndex(
    (line, index) =>
      index > start && line.startsWith('## 16.'),
  );

  if (start < 0 || end <= start) {
    throw new Error(
      'PARSER_SCHEMA_MISMATCH: alias section boundary changed',
    );
  }

  const aliases: BaselineAlias[] = [];

  for (let index = start; index < end; index += 1) {
    const line = lines[index] ?? '';

    if (!/^\|\s*“/.test(line)) {
      continue;
    }

    const cells = splitMarkdownRow(line);

    if (cells.length !== 4) {
      throw new Error(
        'PARSER_SCHEMA_MISMATCH: alias row ' +
          String(index + 1) +
          ' has ' +
          String(cells.length) +
          ' columns',
      );
    }

    const text = (cells[0] ?? '')
      .replace(/^“/, '')
      .replace(/”$/, '')
      .trim();
    const aliasType = stripInlineMarkdown(
      cells[2] ?? '',
    ) as AliasType;

    if (
      !ALIAS_TYPES.includes(
        aliasType as (typeof ALIAS_TYPES)[number],
      )
    ) {
      throw new Error(
        'PARSER_SCHEMA_MISMATCH: unknown alias type ' +
          aliasType,
      );
    }

    const targetCodes = [
      ...(cells[1] ?? '').matchAll(
        /`([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)`/g,
      ),
    ].map((match) => match[1] as string);

    if (targetCodes.length === 0) {
      throw new Error(
        'PARSER_SCHEMA_MISMATCH: alias ' +
          text +
          ' has no explicit target',
      );
    }

    aliases.push({
      text,
      normalizedText: normalizeAliasText(text),
      language: 'pt-BR',
      bindings: targetCodes
        .map((targetConceptCode) => ({
          targetConceptCode,
          aliasType,
        }))
        .sort((left, right) =>
          compareCanonicalText(
            left.targetConceptCode,
            right.targetConceptCode,
          ),
        ),
      decisionStatus: 'APPROVED',
      context: {},
      justification: stripInlineMarkdown(
        cells[3] ?? '',
      ),
      evidenceStatus: 'NOT_ASSESSED',
      sourceMetadata: {
        line: index + 1,
        section: '15',
      },
    });
  }

  return aliases.sort((left, right) =>
    compareCanonicalText(
      [left.normalizedText, left.language].join('|'),
      [right.normalizedText, right.language].join('|'),
    ),
  );
}

function parseGaps(lines: string[]): BaselineGap[] {
  const start = lines.findIndex((line) =>
    line.startsWith('### 24.11'),
  );
  const end = lines.findIndex(
    (line, index) =>
      index > start && line.startsWith('### 24.12'),
  );

  if (start < 0 || end <= start) {
    throw new Error(
      'PARSER_SCHEMA_MISMATCH: gap matrix boundary changed',
    );
  }

  return lines
    .slice(start, end)
    .flatMap((line, offset) => {
      if (!/^\|\s*G\d{2}\s*\|/.test(line)) {
        return [];
      }

      const cells = splitMarkdownRow(line);

      return [{
        code: cells[0]?.trim() ?? '',
        status: cells[cells.length - 1]?.trim() ?? '',
        sourceLocator:
          'R6 line ' + String(start + offset + 1),
      }];
    })
    .sort((left, right) =>
      compareCanonicalText(left.code, right.code),
    );
}

function parseCorpus(lines: string[]): BaselineCorpusEntry[] {
  const start = lines.findIndex((line) =>
    line.startsWith('### 24.10'),
  );
  const end = lines.findIndex(
    (line, index) =>
      index > start && line.startsWith('#### Reexecução'),
  );

  if (start < 0 || end <= start) {
    throw new Error(
      'PARSER_SCHEMA_MISMATCH: corpus boundary changed',
    );
  }

  return lines
    .slice(start, end)
    .flatMap((line, offset) => {
      if (!/^\|\s*C\d{2}\s*\|/.test(line)) {
        return [];
      }

      const cells = splitMarkdownRow(line);

      return [{
        id: cells[0]?.trim() ?? '',
        source: stripInlineMarkdown(cells[1] ?? ''),
        sourceLocator:
          'R6 line ' + String(start + offset + 1),
      }];
    })
    .sort((left, right) =>
      compareCanonicalText(left.id, right.id),
    );
}

function deriveRelationRules(
  concepts: BaselineConcept[],
): BaselineRelationRule[] {
  const relations = buildBaselineRelations();
  const dimensionByCode = new Map(
    concepts.map((concept) => [
      concept.code,
      concept.dimensionCode,
    ]),
  );
  const byKey = new Map<string, BaselineRelationRule>();

  for (const relation of relations) {
    const sourceDimension = dimensionByCode.get(
      relation.sourceConceptCode,
    );
    const targetDimension = dimensionByCode.get(
      relation.targetConceptCode,
    );

    if (!sourceDimension || !targetDimension) {
      throw new Error(
        'PARSER_SCHEMA_MISMATCH: relation endpoint missing for ' +
          relation.sourceConceptCode +
          ' -> ' +
          relation.targetConceptCode,
      );
    }

    const key = [
      relation.relationType,
      sourceDimension,
      targetDimension,
    ].join('|');

    if (!byKey.has(key)) {
      byKey.set(key, {
        relationType: relation.relationType,
        sourceDimension,
        targetDimension,
        allowed: true,
        requiresEvidence: false,
        acyclicOverride: null,
        derivation: {
          kind: 'R6_RELATION_EDGE',
          sourceLocator: relation.sourceLocator,
        },
      });
    }
  }

  return [...byKey.values()].sort((left, right) =>
    compareCanonicalText(
      [
        left.relationType,
        left.sourceDimension,
        left.targetDimension,
      ].join('|'),
      [
        right.relationType,
        right.sourceDimension,
        right.targetDimension,
      ].join('|'),
    ),
  );
}

export function parseR6(
  markdown: string,
): BaselineIntermediateModel {
  const lines = markdown.split(/\r?\n/);
  const concepts = parseConcepts(lines);
  const aliases = parseAliases(lines);
  const relations = buildBaselineRelations();

  return {
    dimensions: DIMENSIONS.map(
      ([code, name, expectedConceptCount]) => ({
        code,
        name,
        description: null,
        identityStatus: 'CURRENT',
        governanceStatus: 'PROPOSED',
        expectedConceptCount,
      }),
    ),
    concepts,
    aliases,
    relationTypes: [...RELATION_TYPE_SEEDS],
    relations,
    relationRules: deriveRelationRules(concepts),
    evidence: [],
    officialCatalogs: [],
    officialMappings: [],
    gaps: parseGaps(lines),
    validationCorpus: parseCorpus(lines),
    limitations: [
      'MIT remains UNMAPPED_DIMENSION and is not a canonical concept.',
      'No official catalog or CNAE/NCM/NBS mapping is materialized from R6 without edition/code evidence.',
      'R6 source anchors remain concept sourceMetadata; no synthetic taxonomy_evidence row is invented.',
    ],
  };
}
