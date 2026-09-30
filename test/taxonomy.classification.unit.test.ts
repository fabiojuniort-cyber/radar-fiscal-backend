import assert from 'node:assert/strict';
import test from 'node:test';

import {
  planLexicalClassification,
} from '../src/modules/taxonomy/classification/classification.engine.js';
import {
  buildClassificationFingerprint,
} from '../src/modules/taxonomy/classification/classification.fingerprint.js';
import {
  classifyLexically,
} from '../src/modules/taxonomy/classification/classification.lexical.js';

const sha = 'a'.repeat(64);

test('classification fingerprint is canonical and material changes alter it', () => {
  const left = buildClassificationFingerprint({
    publicationVersionId: 'pv-1',
    taxonomyReleaseId: 'release-1',
    methodType: 'RULE',
    engineKey: 'engine',
    engineVersion: '1',
    configSnapshot: { b: 2, a: 1 },
    inputSha256: sha,
  });
  const right = buildClassificationFingerprint({
    publicationVersionId: 'pv-1',
    taxonomyReleaseId: 'release-1',
    methodType: 'RULE',
    engineKey: 'engine',
    engineVersion: '1',
    configSnapshot: { a: 1, b: 2 },
    inputSha256: sha,
  });

  assert.equal(left.configSha256, right.configSha256);
  assert.equal(left.runFingerprint, right.runFingerprint);

  const changed = buildClassificationFingerprint({
    publicationVersionId: 'pv-1',
    taxonomyReleaseId: 'release-1',
    methodType: 'RULE',
    engineKey: 'engine',
    engineVersion: '2',
    configSnapshot: { a: 1, b: 2 },
    inputSha256: sha,
  });
  assert.notEqual(changed.runFingerprint, left.runFingerprint);
});

test('MODEL fingerprint requires model identity', () => {
  assert.throws(
    () =>
      buildClassificationFingerprint({
        publicationVersionId: 'pv',
        taxonomyReleaseId: 'release',
        methodType: 'MODEL',
        engineKey: 'engine',
        engineVersion: '1',
        configSnapshot: {},
        inputSha256: sha,
      }),
    /requires modelKey/,
  );
});

test('lexical engine maps canonical/exact/abbreviation but never ambiguous/search aliases', () => {
  const assertions = classifyLexically(
    'A norma altera ICMS e trata do imposto sobre circulação. Crédito foi citado.',
    [
      {
        releaseConceptId: 'rc-icms',
        code: 'tax.icms',
        label: 'ICMS',
        aliases: [
          { text: 'imposto sobre circulação', aliasType: 'EXACT_LEXICAL' },
        ],
      },
      {
        releaseConceptId: 'rc-credit',
        code: 'theme.input_credit',
        label: 'Crédito de insumo',
        aliases: [
          { text: 'Crédito', aliasType: 'AMBIGUOUS' },
          { text: 'crédito relacionado', aliasType: 'SEARCH_RELATED' },
        ],
      },
    ],
  );

  assert.equal(assertions.length, 1);
  assert.equal(assertions[0]?.conceptCode, 'tax.icms');
  assert.equal(assertions[0]?.reasonCode, 'ABBREVIATION_ALIAS');
});

test('lexical classification plan is reproducible and input-sensitive', () => {
  const concepts = [
    {
      releaseConceptId: 'rc-nfe',
      code: 'document.nfe',
      label: 'NF-e',
      aliases: [{ text: 'NFe', aliasType: 'ABBREVIATION' as const }],
    },
  ];

  const a = planLexicalClassification({
    publicationVersionId: 'pv',
    taxonomyReleaseId: 'release',
    title: 'Nota Técnica NF-e',
    contentText: 'Atualiza leiaute.',
    concepts,
    codeGitSha: 'f'.repeat(40),
  });
  const b = planLexicalClassification({
    publicationVersionId: 'pv',
    taxonomyReleaseId: 'release',
    title: 'Nota Técnica NF-e',
    contentText: 'Atualiza leiaute.',
    concepts,
    codeGitSha: 'f'.repeat(40),
  });
  const c = planLexicalClassification({
    publicationVersionId: 'pv',
    taxonomyReleaseId: 'release',
    title: 'Nota Técnica NF-e',
    contentText: 'Atualiza leiaute e validações.',
    concepts,
    codeGitSha: 'f'.repeat(40),
  });

  assert.equal(a.fingerprint.runFingerprint, b.fingerprint.runFingerprint);
  assert.notEqual(a.fingerprint.runFingerprint, c.fingerprint.runFingerprint);
  assert.equal(a.assertions.length, 1);
});
