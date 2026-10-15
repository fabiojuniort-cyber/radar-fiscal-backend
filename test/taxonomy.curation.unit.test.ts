import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseImportCsv } from '../src/api/routes/taxonomy-admin.route.js';
import { parseCclasstribCsv } from '../src/modules/taxonomy/catalogs/cclasstrib-catalog.source.js';
import { parseCnaePayload } from '../src/modules/taxonomy/catalogs/cnae-catalog.source.js';
import {
  extractCclasstribCodes,
  normalizeWithIndex,
  planCuratedClassification,
  type CuratedConceptInput,
} from '../src/modules/taxonomy/classification/classification.curated.js';
import {
  formatOfficialCode,
  isValidOfficialCode,
  normalizeOfficialCode,
} from '../src/modules/taxonomy/curation/curation.constants.js';
import {
  diffReleaseViews,
  normalizeCodes,
} from '../src/modules/taxonomy/curation/curation.draft.js';
import { loadRuntimeSettings, type ReleaseView } from '../src/modules/taxonomy/curation/curation.read.js';
import {
  LEGACY_SEGMENT_TARGETS,
  planLegacySegmentRetirement,
} from '../src/modules/taxonomy/curation/curation.legacy-segments.js';
import { matchSegmentsByCnae, segmentsForCnaes } from '../src/modules/taxonomy/curation/curation.suggestions.js';
import { resolveCuratorDecisions } from '../src/modules/taxonomy/curation/curation.tags.js';
import { parseTaxonomyCodeCompatibility } from '../src/modules/taxonomy/taxonomy-code-compatibility.js';

function concept(
  code: string,
  label: string,
  extra: Partial<CuratedConceptInput> = {},
): CuratedConceptInput {
  return {
    releaseConceptId: `rc-${code}`,
    code,
    label,
    classifyByLabel: true,
    aliases: [],
    ncmPrefixes: [],
    cclasstribCodes: [],
    ...extra,
  };
}

test('curated classifier tags by label, synonyms, NCM prefix and cClassTrib with explanations', () => {
  const plan = planCuratedClassification({
    publicationVersionId: '00000000-0000-4000-8000-000000000001',
    taxonomyReleaseId: '00000000-0000-4000-8000-000000000002',
    title: 'Portaria sobre Crédito Presumido',
    contentText:
      'Concede crédito presumido nas saídas de UREIA. Aplica-se a Lei 1. ' +
      'Informar o cClassTrib 200034 na NF-e. Item sujeito ao ISSQN.',
    ncmCodes: ['10063011'],
    concepts: [
      concept('theme.presumed_credit', 'Crédito presumido'),
      concept('product.urea', 'Ureia'),
      concept('act_type.law', 'Lei', { classifyByLabel: false }),
      concept('tax.iss', 'ISS', {
        aliases: [{ text: 'ISSQN', aliasType: 'ABBREVIATION' }],
      }),
      concept('tax.cofins', 'Cofins', {
        aliases: [{ text: 'NF-e', aliasType: 'SEARCH_RELATED' }],
      }),
      concept('product.rice', 'Arroz', { classifyByLabel: false, ncmPrefixes: ['1006'] }),
      concept('treatment.rate_reduction', 'Alíquota reduzida aplicada', {
        classifyByLabel: false,
        cclasstribCodes: ['200'],
      }),
    ],
  });

  const byCode = new Map(plan.assertions.map((a) => [a.conceptCode, a]));
  assert.deepEqual([...byCode.keys()].sort(), [
    'product.rice',
    'product.urea',
    'tax.cofins',
    'tax.iss',
    'theme.presumed_credit',
    'treatment.rate_reduction',
  ]);
  // A single kind of synonym: every synonym classifies, whatever its stored type.
  assert.equal(byCode.get('tax.cofins')!.matchedTerm, 'NF-e');
  assert.equal(byCode.get('theme.presumed_credit')!.reasonCode, 'CANONICAL_LABEL');
  assert.match(byCode.get('theme.presumed_credit')!.excerpt, /Crédito Presumido/);
  assert.match(byCode.get('product.urea')!.excerpt, /UREIA/);
  assert.equal(byCode.get('tax.iss')!.reasonCode, 'ABBREVIATION_ALIAS');
  assert.equal(byCode.get('tax.iss')!.matchedTerm, 'ISSQN');
  assert.equal(byCode.get('product.rice')!.reasonCode, 'OFFICIAL_CODE_NCM');
  assert.equal(byCode.get('product.rice')!.matchedTerm, '10063011');
  assert.equal(byCode.get('treatment.rate_reduction')!.reasonCode, 'OFFICIAL_CODE_CCLASSTRIB');
  assert.equal(byCode.get('treatment.rate_reduction')!.matchedTerm, '200034');
  assert.equal(plan.engineVersion, '2.3.0');
  assert.match(plan.fingerprint.runFingerprint, /^[a-f0-9]{64}$/);
});


test('F2-T03: curated classifier recognizes legal NCM by prefix in either direction', () => {
  const base = {
    publicationVersionId: '00000000-0000-4000-8000-000000000003',
    taxonomyReleaseId: '00000000-0000-4000-8000-000000000004',
    title: 'NCM citada sem descrição do produto',
    contentText: '',
    codeGitSha: 'f'.repeat(40),
  };
  const classify = (norm: string, conceptNcm: string) =>
    planCuratedClassification({
      ...base,
      ncmCodes: [norm],
      concepts: [concept('product.rice', 'Arroz', {
        classifyByLabel: false,
        ncmPrefixes: [conceptNcm],
      })],
    }).assertions.map(a => a.conceptCode);
  assert.deepEqual(classify('10063011', '1006'), ['product.rice']);
  assert.deepEqual(classify('1006', '10063011'), ['product.rice']);
  assert.deepEqual(classify('10.06', '1006.30.11'), ['product.rice']);
  assert.deepEqual(classify('1006.30.11', '10'), ['product.rice']);
  assert.deepEqual(classify('1006', '1007'), []);
  assert.deepEqual(classify('1006/30', '10063011'), []);
  assert.deepEqual(classify('10063011', '1006-30'), []);
});

test('label matching respects token boundaries and maps excerpts back to raw text', () => {
  const normalized = normalizeWithIndex('Lei Complementar nº 214, de 2025 — Imposto Seletivo.');
  assert.equal(normalized.text, 'lei complementar n 214 de 2025 imposto seletivo');

  const plan = planCuratedClassification({
    publicationVersionId: '00000000-0000-4000-8000-000000000001',
    taxonomyReleaseId: '00000000-0000-4000-8000-000000000002',
    title: 'Leilão de bens',
    contentText: 'Aleia Leiloeiro',
    ncmCodes: [],
    concepts: [concept('act_type.law', 'Lei')],
  });
  assert.equal(plan.assertions.length, 0);
});

test('cClassTrib extraction needs the code to be introduced as such', () => {
  const found = extractCclasstribCodes(
    'Tabela: cClassTrib: 000.001; código de classificação tributária 410999. Valor 123456 solto.',
  );
  assert.deepEqual([...found.keys()].sort(), ['000001', '410999']);
});

test('CNAE to segment: most specific prefix wins and primary CNAE pre-selects', () => {
  const segments = [
    { code: 'sector.agribusiness', label: 'Agronegócio', prefixes: ['01'] },
    { code: 'sector.wholesale', label: 'Atacado', prefixes: ['46'] },
    { code: 'sector.agri_inputs', label: 'Insumos agrícolas', prefixes: ['4683'] },
    { code: 'sector.insurance', label: 'Seguros', prefixes: ['65'] },
    { code: 'sector.health_plans', label: 'Planos de saúde', prefixes: ['655'] },
  ];
  const result = matchSegmentsByCnae(
    [
      { code: '4683-4/00', isPrimary: true },
      { code: '0115600', isPrimary: false },
      { code: '6550200', isPrimary: false },
      { code: '9999999', isPrimary: false },
    ],
    segments,
  );
  assert.deepEqual(
    result.map((s) => [s.conceptCode, s.strength]),
    [
      ['sector.agri_inputs', 'PRIMARY'],
      ['sector.agribusiness', 'SECONDARY'],
      ['sector.health_plans', 'SECONDARY'],
    ],
  );
});

test('CNAE to segment: a CNAE activity answers with the segment of its subsegment', () => {
  const concept = (code: string, label: string, officialCodes: string[], groupId: string | null = null) => ({
    code,
    label,
    dimensionCode: 'sector',
    officialCodes,
    groupId,
  });
  const view = {
    concepts: [
      concept('sector.trifaros_agro', 'Agropecuária, pesca e insumos agrícolas', []),
      concept('sector.cultivo_de_arroz', 'Cultivo de arroz', ['0111301'], 'g-agro-prod'),
      concept('sector.agribusiness', 'Agronegócio', ['01']),
      concept('sector.trifaros_com', 'Comércio multissetorial', []),
    ],
    groups: [{ id: 'g-agro-prod', segmentCodes: ['sector.trifaros_agro'] }],
  } as unknown as Parameters<typeof segmentsForCnaes>[1];

  const [rice, other] = segmentsForCnaes(
    [
      { code: '0111-3/01', isPrimary: true },
      { code: '0113000', isPrimary: false },
    ],
    view,
    'sector',
  );
  assert.deepEqual(rice, {
    cnaeCode: '0111301',
    isPrimary: true,
    segments: [{ code: 'sector.trifaros_agro', label: 'Agropecuária, pesca e insumos agrícolas' }],
    // The CNAE activity item itself, for the affinity with the act's CNAE tags.
    activityCodes: ['sector.cultivo_de_arroz'],
  });
  // No activity for this CNAE: the prefix item is the segment itself.
  assert.deepEqual(other!.segments, [{ code: 'sector.agribusiness', label: 'Agronegócio' }]);
  assert.deepEqual(other!.activityCodes, []);
});

test('spreadsheet import: blank keeps, "—" clears, ✓ flags and comma separated synonyms', () => {
  const rows = parseImportCsv(
    [
      'Segmento;Grupo;Item;Código oficial;Sinônimos;No perfil;Ordem',
      'Agronegócio;Fertilizantes;Ureia;3102.10;—;✓;1',
      'Agronegócio;Fertilizantes;Cloreto de potássio;3104.20;"KCl, potassa";✓;',
      'Agronegócio;Defensivos e adjuvantes;Espalhante adesivo;a definir;adjuvante;;',
      ';;;;;;',
      'Combustíveis;—;Diesel;;óleo diesel;não;',
      'Combustíveis;;Gasolina;-;;;',
    ].join('\n'),
  );
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0], {
    line: 2,
    group: 'Fertilizantes',
    item: 'Ureia',
    officialCodes: ['3102.10'],
    synonyms: [],
    profileVisible: true,
    classifyByLabel: null,
    definition: undefined,
    displayOrder: 1,
    code: null,
  });
  assert.deepEqual(rows[1]!.synonyms, ['KCl', 'potassa']);
  assert.equal(rows[2]!.officialCodes, undefined, '"a definir" keeps the current code');
  assert.equal(rows[2]!.profileVisible, null);
  assert.equal(rows[3]!.group, null, '"—" clears the group');
  assert.equal(rows[3]!.officialCodes, undefined, 'blank keeps the current code');
  assert.equal(rows[3]!.profileVisible, false);
  assert.equal(rows[4]!.group, undefined, 'blank keeps the current group');
  assert.deepEqual(rows[4]!.officialCodes, [], '"-" clears the codes');
  assert.equal(rows[4]!.synonyms, undefined);

  const marked = parseImportCsv(
    'Item;No perfil;Classificar pelo nome;Definição;Código TriBusca\nUreia;x;X;Fertilizante nitrogenado;\nGesso;;não;;',
  );
  assert.equal(marked[0]!.profileVisible, true, 'x marks like the export');
  assert.equal(marked[0]!.classifyByLabel, true);
  assert.equal(marked[0]!.definition, 'Fertilizante nitrogenado');
  assert.equal(marked[0]!.code, null, 'blank TriBusca code is generated from the item');
  assert.equal(marked[1]!.profileVisible, null);
  assert.equal(marked[1]!.classifyByLabel, false);

  const onlyProfile = parseImportCsv('Item;No perfil\nUreia;✓');
  assert.equal(onlyProfile[0]!.group, undefined);
  assert.equal(onlyProfile[0]!.officialCodes, undefined);
  assert.equal(onlyProfile[0]!.synonyms, undefined);
});

test('curator decisions survive treatment redirects and ignore retired codes', () => {
  const compatibility = parseTaxonomyCodeCompatibility({
    taxonomyCompatibility: {
      version: 1,
      redirects: {
        'treatment.exemption': 'theme.exemption',
      },
      retiredCodes: ['platform.sped'],
    },
  });
  const history = [
    {
      concept_code: 'treatment.exemption',
      action: 'REMOVE' as const,
      rationale: 'decisão antiga mais recente',
      created_at: '2026-10-07T10:00:00Z',
      id: '3',
    },
    {
      concept_code: 'theme.exemption',
      action: 'ADD' as const,
      rationale: 'decisão anterior no código novo',
      created_at: '2026-10-06T10:00:00Z',
      id: '2',
    },
    {
      concept_code: 'platform.sped',
      action: 'ADD' as const,
      rationale: 'não possui sucessor',
      created_at: '2026-10-05T10:00:00Z',
      id: '1',
    },
  ];

  const resolved = resolveCuratorDecisions(history, compatibility);
  assert.equal(resolved.size, 1);
  assert.equal(resolved.get('theme.exemption')?.action, 'REMOVE');
  assert.equal(
    resolved.get('theme.exemption')?.rationale,
    'decisão antiga mais recente',
  );
  assert.equal(resolved.has('platform.sped'), false);
});

test('official codes are normalized and validated by type', () => {
  assert.equal(normalizeOfficialCode(' 3102.10 '), '310210');
  assert.equal(normalizeOfficialCode('0111-3/01'), '0111301');
  assert.deepEqual(normalizeCodes('NCM', ['3102.10', '31', '310210']), ['310210', '31']);
  assert.throws(() => normalizeCodes('NCM', ['31021']), /inválido/);
  assert.equal(isValidOfficialCode('DOCUMENT_MODEL', '55'), true);
  assert.equal(isValidOfficialCode('CCLASSTRIB', '200034'), true);
  assert.equal(isValidOfficialCode('CNAE', '1011'), true);
  assert.equal(formatOfficialCode('NCM', '31042010'), '3104.20.10');
  assert.equal(formatOfficialCode('CNAE', '0111301'), '0111-3/01');
  assert.equal(formatOfficialCode('CNAE', '01113'), '01.11-3');
});

test('CNAE IBGE payload becomes a five-level hierarchy', () => {
  const entries = parseCnaePayload([
    {
      id: '0111301',
      descricao: 'CULTIVO DE ARROZ',
      classe: {
        id: '01113',
        descricao: 'CULTIVO DE CEREAIS',
        grupo: {
          id: '011',
          descricao: 'PRODUÇÃO DE LAVOURAS TEMPORÁRIAS',
          divisao: {
            id: '01',
            descricao: 'AGRICULTURA, PECUÁRIA E SERVIÇOS RELACIONADOS',
            secao: { id: 'A', descricao: 'AGRICULTURA, PECUÁRIA, PRODUÇÃO FLORESTAL, PESCA E AQÜICULTURA' },
          },
        },
      },
    },
  ]);
  assert.deepEqual(
    entries.map((e) => [e.officialCode, e.parentCode]),
    [
      ['A', null],
      ['01', 'A'],
      ['01.1', '01'],
      ['01.11-3', '01.1'],
      ['0111-3/01', '01.11-3'],
    ],
  );
});

test('cClassTrib CSV keeps CST parents and all official columns as metadata', () => {
  const parsed = parseCclasstribCsv(
    [
      'Tabela de Classificação Tributária',
      'CST-IBS/CBS;Descrição CST-IBS/CBS;cClassTrib;Nome cClassTrib;LC Redação;pRedIBS;pRedCBS',
      '000;Tributação integral;000001;Situações tributadas integralmente;Art. 4º;0;0',
      '200;Alíquota reduzida;200034;Insumos agropecuários;Art. 138;60;60',
      '200;Alíquota reduzida;200035;"Produtos hortícolas; frutas";Art. 137;100;100',
    ].join('\n'),
  );
  assert.equal(parsed.cstCount, 2);
  assert.equal(parsed.classificationCount, 3);
  const reduced = parsed.entries.find((e) => e.officialCode === '200034')!;
  assert.equal(reduced.parentCode, '200');
  assert.equal(reduced.description, 'Insumos agropecuários');
  assert.equal(reduced.metadata.pRedIBS, '60');
  assert.equal(
    parsed.entries.find((e) => e.officialCode === '200035')!.description,
    'Produtos hortícolas; frutas',
  );
});

test('release diff reports added, removed and changed concepts and groups', () => {
  const base = (version: string): ReleaseView => ({
    release: {
      id: version,
      version,
      status: 'PUBLISHED',
      createdAt: '',
      publishedAt: null,
      previousReleaseId: null,
      changeNotes: null,
    },
    dimensions: [],
    groups: [],
    concepts: [],
  });
  const conceptView = (code: string, label: string, groupCode: string | null = null) => ({
    releaseConceptId: code,
    conceptId: code,
    code,
    dimensionCode: code.split('.')[0]!,
    label,
    definition: `Definição ${code}`,
    positiveExample: null,
    negativeExample: null,
    governanceStatus: 'PROPOSED',
    evidenceStatus: 'NOT_ASSESSED',
    notes: null,
    releaseNotes: null,
    revisionNo: 1,
    membershipStatus: 'INCLUDED',
    groupId: groupCode,
    groupCode,
    profileVisible: true,
    displayOrder: null,
    helpText: null,
    classifyByLabel: true,
    officialCodes: [],
    aliases: [],
  });

  const source = base('v1.1.0');
  source.concepts = [conceptView('document.nfe', 'NF-e; 55'), conceptView('product.old', 'Old')];
  const target = base('v1.2.0');
  target.concepts = [conceptView('document.nfe', 'NF-e', 'mercadorias'), conceptView('product.new', 'New')];
  target.groups = [
    {
      id: 'g',
      dimensionCode: 'document',
      code: 'mercadorias',
      label: 'Mercadorias',
      displayOrder: 1,
      helpText: null,
      detailSection: null,
      officialCodes: [],
      segmentCodes: [],
    },
  ];

  const diff = diffReleaseViews(source, target);
  assert.deepEqual(diff.addedConcepts, ['product.new']);
  assert.deepEqual(diff.removedConcepts, ['product.old']);
  assert.deepEqual(diff.changedConcepts, [
    { code: 'document.nfe', fields: ['label', 'groupCode'] },
  ]);
  assert.deepEqual(diff.addedGroups, ['document/mercadorias']);
});

test('engine 2.2.0: Roman-numeral terms ignore item numbering; matching ignores case and accents', () => {
  const concepts = [
    { releaseConceptId: 'rc-ii', code: 'tax.ii', label: 'II', classifyByLabel: true, aliases: [], ncmPrefixes: [], cclasstribCodes: [] },
    { releaseConceptId: 'rc-ipi', code: 'tax.ipi', label: 'IPI', classifyByLabel: true, aliases: [], ncmPrefixes: [], cclasstribCodes: [] },
  ];
  const plan = (contentText: string) =>
    planCuratedClassification({
      publicationVersionId: 'v',
      taxonomyReleaseId: 'r',
      title: 'Ato',
      contentText,
      ncmCodes: [],
      concepts,
      codeGitSha: null,
    }).assertions.map((a) => a.conceptCode).sort();

  // Conv. ICMS 100/97: items and lists of items are not the tax.
  assert.deepEqual(
    plan(
      'Cláusula terceira Ficam isentas:\nI - as saídas internas;\nII - às saídas, a título de retorno;\n' +
        'nos incisos I e II do artigo 21, conforme Anexo II, itens II a IV, inciso II do caput.',
    ),
    [],
  );
  // The tax itself still classifies, whatever the case.
  assert.deepEqual(plan('Reduz o II e o IPI na importação de máquinas.'), ['tax.ii', 'tax.ipi']);
  assert.deepEqual(plan('reduz o ii e o ipi'), ['tax.ii', 'tax.ipi']);
  assert.deepEqual(plan('Imposto de Importação (II) incide sobre bens.'), ['tax.ii']);
  assert.deepEqual(plan('Inciso II - texto. Também se aplica ao II.'), ['tax.ii']);
  // Lowercase item numbering is still numbering.
  assert.deepEqual(plan('nos incisos i e ii do artigo; ii - às saídas'), []);
});

test('legacy segments: every old baseline item maps to a TriFaros segment', () => {
  assert.equal(Object.keys(LEGACY_SEGMENT_TARGETS).length, 45);
  const trifaros = new Set(['inst', 'agro', 'amb', 'ali', 'aut', 'bel', 'cas', 'com', 'con', 'cons', 'edu', 'ene', 'fin', 'imo', 'ind', 'jur', 'loc', 'mkt', 'cul', 'min', 'mod', 'pap', 'qui', 'res', 'apo', 'sau', 'seg', 'pes', 'tec', 'log', 'tur', 'pet']);
  for (const [legacy, target] of Object.entries(LEGACY_SEGMENT_TARGETS)) {
    assert.ok(trifaros.has(target), `${legacy} -> ${target}`);
  }
});

test('legacy segments: groups move to the TriFaros segment before old items retire', () => {
  const concept = (code: string) => ({ code, membershipStatus: 'INCLUDED' });
  const view = {
    concepts: [
      concept('sector.agribusiness'),
      concept('sector.rural_production'),
      concept('sector.chemical_industry'),
      concept('sector.trifaros_agro'),
      concept('sector.trifaros_qui'),
      concept('sector.trifaros_com'),
    ],
    groups: [
      { id: 'g1', label: 'Fertilizantes', segmentCodes: ['sector.agribusiness', 'sector.chemical_industry'] },
      { id: 'g2', label: 'Grãos', segmentCodes: ['sector.agribusiness', 'sector.rural_production'] },
      { id: 'g3', label: 'Agro / Produção', segmentCodes: ['sector.trifaros_agro'] },
    ],
  } as unknown as Parameters<typeof planLegacySegmentRetirement>[0];

  const plan = planLegacySegmentRetirement(view);
  assert.deepEqual(plan.groupUpdates.map((item) => [item.group, item.to]), [
    ['Fertilizantes', ['sector.trifaros_agro', 'sector.trifaros_qui']],
    ['Grãos', ['sector.trifaros_agro']],
  ]);
  assert.deepEqual(plan.retire, ['sector.agribusiness', 'sector.chemical_industry', 'sector.rural_production']);
  assert.deepEqual(plan.missingTargets, []);

  // A link to a TriFaros segment missing from the draft stops the change.
  const withoutQui = { ...view, concepts: view.concepts.filter((item) => item.code !== 'sector.trifaros_qui') };
  assert.deepEqual(planLegacySegmentRetirement(withoutQui).missingTargets, ['sector.trifaros_qui']);
});



test('legacy excluded-source settings never restrict classification of the Acervo', async () => {
  const settings = await loadRuntimeSettings(async <T>() => [
    { key: 'classification_enabled', value: true, updated_at: '2026-10-15T00:00:00Z', updated_by: 'test' },
    { key: 'classification_excluded_sources', value: ['doe-sp', 'any-source'], updated_at: '2026-10-15T00:00:00Z', updated_by: 'test' },
  ] as T[]);
  assert.equal(settings.classificationEnabled, true);
  assert.deepEqual(settings.classificationExcludedSources, []);
});
