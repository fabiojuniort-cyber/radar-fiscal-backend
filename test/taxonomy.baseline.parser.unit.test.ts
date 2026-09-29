import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DIMENSIONS,
} from '../src/modules/taxonomy/baseline/baseline.constants.js';
import {
  parseR6,
} from '../src/modules/taxonomy/baseline/baseline.parser.js';
import {
  loadBaseline,
} from '../src/modules/taxonomy/baseline/baseline.source-reader.js';

test('R6 parser derives approved baseline cardinalities', async () => {
  const loaded = await loadBaseline();
  const model = loaded.model;

  assert.equal(model.dimensions.length, 20);
  assert.equal(model.concepts.length, 628);
  assert.equal(
    new Set(model.concepts.map((concept) => concept.code))
      .size,
    628,
  );
  assert.equal(
    model.concepts.filter(
      (concept) =>
        concept.evidenceStatus === 'NEEDS_EVIDENCE',
    ).length,
    55,
  );
  assert.equal(model.aliases.length, 21);
  assert.equal(
    model.aliases.reduce(
      (sum, alias) => sum + alias.bindings.length,
      0,
    ),
    23,
  );
  assert.equal(
    model.aliases.filter(
      (alias) => alias.bindings.length > 1,
    ).length,
    1,
  );

  for (const [code, , expectedCount] of DIMENSIONS) {
    assert.equal(
      model.concepts.filter(
        (concept) => concept.dimensionCode === code,
      ).length,
      expectedCount,
      code,
    );
  }
});

test('Crédito remains one lexical alias with three AMBIGUOUS bindings', async () => {
  const loaded = await loadBaseline();
  const credit = loaded.model.aliases.find(
    (alias) => alias.normalizedText === 'credito',
  );

  assert.ok(credit);
  assert.equal(credit.text, 'Crédito');
  assert.equal(credit.bindings.length, 3);
  assert.deepEqual(
    credit.bindings.map(
      (binding) => binding.targetConceptCode,
    ),
    [
      'theme.assessed_tax_credit',
      'theme.input_credit',
      'theme.presumed_credit',
    ],
  );
  assert.ok(
    credit.bindings.every(
      (binding) =>
        binding.aliasType === 'AMBIGUOUS',
    ),
  );
});

test('controlled relation specializations normalize without new types', async () => {
  const loaded = await loadBaseline();
  const relations = loaded.model.relations;

  const hints = relations
    .map((relation) => {
      const hint = relation.qualifiers.semanticHint;
      return typeof hint === 'string' ? hint : null;
    })
    .filter((value): value is string => value !== null)
    .sort();

  assert.deepEqual(hints, [
    'about',
    'fulfills',
    'hosted_by',
  ]);

  assert.equal(
    loaded.model.relationTypes.length,
    7,
  );
  assert.equal(
    loaded.model.relationTypes.some(
      (type) =>
        ['about', 'hosted_by', 'fulfills', 'fulfilled_by']
          .includes(type.code),
    ),
    false,
  );
});

test('parser rejects a structural dictionary row change', async () => {
  const loaded = await loadBaseline();
  const broken = loaded.source.text.replace(
    '| Código | Rótulo | Definição; + / − | Âncora | Vínculo/alerta |',
    '| Código | Rótulo | Definição |',
  );

  // Header changes alone are not semantic rows; remove a canonical cell too.
  const first = loaded.model.concepts[0];
  assert.ok(first);
  const canonicalLine =
    loaded.source.text
      .split(/\r?\n/)
      .find((line) =>
        line.includes('`' + first.code + '`'),
      );
  assert.ok(canonicalLine);
  const malformedLine = canonicalLine
    .split('|')
    .slice(0, -2)
    .join('|') + '|';

  const malformed = broken.replace(
    canonicalLine,
    malformedLine,
  );

  assert.throws(
    () => parseR6(malformed),
    /PARSER_SCHEMA_MISMATCH/,
  );
});
