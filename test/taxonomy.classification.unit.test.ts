import assert from 'node:assert/strict';
import test from 'node:test';

import {
  allowsDerivedSegment,
  hasAutomotiveApplication,
  planCuratedClassification,
} from '../src/modules/taxonomy/classification/classification.curated.js';
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
  assert.equal(assertions[0]?.reasonCode, 'EXACT_LEXICAL_ALIAS');
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

test('chapter 87 mentions require contextual evidence to derive the automotive segment in new scans', () => {
  const segment = 'Automotivo e equipamentos de transporte';
  const input = {
    publicationVersionId: 'pub-version',
    taxonomyReleaseId: 'release',
    ncmCodes: ['87019490', '87162000'],
    concepts: [{
      releaseConceptId: 'tractor', code: 'product.tractor', label: 'Trator',
      classifyByLabel: false, aliases: [], ncmPrefixes: ['87019490'], cclasstribCodes: [],
    }],
  };
  for (const [title, contentText, expected] of [
    ['Convênio ICMS 52/91', 'Concede redução da base de cálculo nas operações com equipamentos industriais e implementos agrícolas.', false],
    ['Tratores agrícolas', 'Operações com tratores e reboques de uso agrícola.', false],
    ['Convênio ICMS', 'Operações com veículos rodoviários e autopeças.', true],
    ['Equipamentos industriais', 'Operações com máquinas industriais.\nRedação anterior: operações com autopeças.', false],
    ['Convênio ICMS', 'Concede isenção nas saídas de máquinas industriais, exceto caminhões e ônibus.', false],
    ['Convênio ICMS', 'Reduz a base de cálculo de máquinas agrícolas; não se aplica a caminhões.', false],
    ['Convênio ICMS', 'Prorroga o benefício de que trata o Convênio ICMS 133/02 sobre caminhões.', false],
    ['Convênio ICMS', 'Concede isenção nas saídas de ônibus destinados ao transporte escolar.', true],
  ] as const) {
    const plan = planCuratedClassification({ ...input, title, contentText });
    const application = plan.configSnapshot.automotiveApplication as boolean;
    assert.equal(application, expected);
    assert.equal(allowsDerivedSegment(segment, application), expected);
    assert.ok(plan.assertions.some(assertion => assertion.reasonCode === 'OFFICIAL_CODE_NCM'));
  }
  assert.equal(allowsDerivedSegment(segment, null), true);
  assert.equal(allowsDerivedSegment('Agropecuária', false), true);
});

test('automotive application needs an affirmative clause in the title or first non-blank line', () => {
  const cases: Array<[string, string | null, boolean, string]> = [
    ['Convênio ICMS 52/91', 'Concede redução da base de cálculo nas operações com equipamentos industriais e implementos agrícolas.', false, 'no automotive application'],
    ['Convênio ICMS', 'Isenção para máquinas, exceto caminhões.', false, 'exclusion (exceto)'],
    ['Convênio ICMS', 'O benefício não se aplica a caminhões e ônibus.', false, 'exclusion (não se aplica)'],
    ['Convênio ICMS', 'Altera o benefício previsto no Convênio ICMS 133/02 para ônibus.', false, 'incidental reference to another act'],
    ['Convênio ICMS', 'Equipamentos industriais.\nRedação anterior: autopeças.', false, 'later line only'],
    ['Convênio ICMS', '\n\nConcede isenção nas saídas de caminhões.', true, 'first non-blank line'],
    ['Isenção para caminhões', null, true, 'title'],
    ['Convênio ICMS', 'Concede isenção a caminhões, não se aplicando a reboques.', true, 'affirmative clause next to an exclusion'],
    ['Convênio ICMS', 'Não incide ICMS nas saídas de caminhões.', true, 'non-incidence applies to trucks'],
    ['Convênio ICMS', 'Regime não cumulativo nas operações com autopeças.', true, 'non-cumulative regime applies to parts'],
    ['Convênio ICMS', 'O benefício não deixa de alcançar caminhões.', true, 'scope remains affirmative'],
    ['Convênio ICMS', 'Os valores das saídas de caminhões não integram a base de cálculo.', true, 'exclusion from tax base applies to trucks'],
    ['Convênio ICMS', 'Concede isenção a caminhões e não a reboques.', true, 'first object remains in scope'],
    ['Convênio ICMS', 'Concede isenção a máquinas agrícolas e não a caminhões.', false, 'second object is outside scope'],
    ['Convênio ICMS', 'Dispõe sobre operações com veículos automotores.', true, 'automotive terminology in use in official acts'],
    ['Convênio ICMS', 'É vedado o crédito nas operações com autopeças.', false, 'conservative limit: credit prohibition'],
    ['Convênio ICMS', 'Fica vedado o crédito nas saídas de caminhões.', false, 'conservative limit: credit prohibition on truck sales'],
    ['Convênio ICMS', 'Fica vedada a apropriação de crédito nas saídas de caminhões.', false, 'conservative limit: credit appropriation prohibition'],
    ['Convênio ICMS', 'Fica vedada a aplicação aos caminhões.', false, 'application is prohibited'],
    ['Convênio ICMS', 'É vedada a fruição do benefício nas saídas de ônibus.', false, 'enjoyment of the benefit is prohibited'],
    ['Convênio ICMS', 'Vedado o benefício para veículos automotores.', false, 'benefit is prohibited'],
    ['Convênio ICMS', 'Concede isenção a caminhões conforme o Convênio ICMS 133/02.', false, 'conservative limit: trailing reference'],
    ['Convênio ICMS', 'Concede isenção a máquinas conforme o Convênio ICMS 133/02 sobre caminhões.', false, 'reference alone does not establish scope'],
    ['Convênio ICMS', 'Isenção conforme Convênio ICMS 133/02 para caminhões', false, 'conservative limit: application only after conforme'],
    ['Convênio ICMS', 'Fica vedada, nas saídas de caminhões, a aplicação do benefício.', false, 'comma does not detach an item from its prohibition'],
    ['Convênio ICMS', 'É proibida a aplicação do benefício aos caminhões.', false, 'explicit prohibition of the application'],
    ['Convênio ICMS', 'O benefício não poderá ser aplicado a caminhões.', false, 'future passive exclusion'],
    ['Convênio ICMS', 'Nos termos da Lei nº 10.485, os veículos automotores novos.', false, 'comma does not detach a reference'],
    ['Convênio ICMS', 'Redação anterior: operações com veículos automotores.', false, 'colon does not detach historical wording'],
    ['Convênio ICMS', 'É proibida a venda com isenção de veículos automotores.', false, 'prohibition governs the exemption'],
    ['Convênio ICMS', 'As isenções não poderão ser concedidas para caminhões.', false, 'plural future passive exclusion'],
    ['Convênio ICMS', 'O benefício não poderá ser utilizado para caminhões.', false, 'future passive exclusion of use'],
  ];
  for (const [title, text, expected, why] of cases) assert.equal(hasAutomotiveApplication(title, text), expected, why);
  for (const exclusion of ['não se aplica a', 'não alcança', 'não abrange', 'não compreende', 'não inclui', 'não se estende a', 'não beneficia', 'exceto', 'salvo', 'ressalvados', 'excluídos', 'com exceção de']) {
    assert.equal(hasAutomotiveApplication('Convênio ICMS', `O benefício ${exclusion} caminhões.`), false, exclusion);
  }
});
