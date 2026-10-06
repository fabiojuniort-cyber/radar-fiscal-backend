import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDouEntries } from '../src/modules/collection/dou.parser.js';
import { normalizePublication } from '../src/modules/collection/publication.normalizer.js';
import { archiveContext } from './dou.fixtures.js';
import { evaluatePublicationExclusionPolicy, normalizeLegalBaseType,
  PROTECTED_LEGAL_BASE_TYPES, PUBLICATION_EXCLUSION_POLICY,
  type ExclusionPolicyPublication } from '../src/modules/collection/publication-exclusion-policy.js';

const envelope = (actType = 'AVISO DE DISPENSA DE LICITAÇÃO', section = 'DO3') => ({
  dou: { section, sourceActType: actType, abstract: '', continuationTitles: [], continuationAbstracts: [],
    parts: [{ attributes: { artType: actType, pubName: section } }] },
});
const notice = (patch: Partial<ExclusionPolicyPublication> = {}): ExclusionPolicyPublication => ({
  title: 'AVISO DE DISPENSA DE LICITAÇÃO', actType: 'AVISO DE DISPENSA DE LICITAÇÃO',
  agency: 'Prefeitura Municipal',
  content: 'Objeto: aquisição de papel A4. Modalidade: dispensa de licitação. Processo: 123. Valor: R$ 100.',
  metadata: envelope(patch.actType),
  ...patch,
});
const evaluate = (publication = notice(), sourceCode: string | undefined = 'dou') =>
  evaluatePublicationExclusionPolicy({ ...(sourceCode === undefined ? {} : { sourceCode }), publication });

test('comparison normalizes accents/case/whitespace/punctuation without changing official values', () => {
  const publication = notice({ title: '  aviso de dispensa de licitação. ', actType: ' aviso\tde DISPENSA-de LICITAÇÃO ' });
  const before = structuredClone(publication);
  const decision = evaluate(publication);
  assert.equal(decision.decision, 'EXCLUDE');
  assert.equal(decision.normalizedActType, 'AVISO DE DISPENSA DE LICITACAO');
  assert.deepEqual(publication, before);
  assert.equal(normalizeLegalBaseType(' ATO COTEPE/ICMS '), 'ATO COTEPE ICMS');
  assert.equal(normalizeLegalBaseType(undefined), '');
});

test('every exception is an explicit exact source-scoped value with versioned reason', () => {
  assert.equal(PUBLICATION_EXCLUSION_POLICY.rules.length, 9);
  assert.doesNotThrow(() => JSON.stringify(PUBLICATION_EXCLUSION_POLICY));
  const keys = new Set<string>();
  for (const rule of PUBLICATION_EXCLUSION_POLICY.rules) {
    assert.deepEqual(rule.sources, ['dou']);
    assert.deepEqual(rule.sections, ['DO3', 'DO3E']);
    for (const actType of rule.actTypes) {
      const key = normalizeLegalBaseType(actType);
      assert.equal(keys.has(key), false); keys.add(key);
      const result = evaluate(notice({ title: actType, actType }));
      assert.equal(result.decision, 'EXCLUDE');
      assert.equal(result.ruleId, rule.id);
      assert.equal(result.policyKey, PUBLICATION_EXCLUSION_POLICY.key);
      assert.equal(result.policyVersion, PUBLICATION_EXCLUSION_POLICY.version);
      assert.equal(result.reasonCode, rule.reasonCode);
      assert.notEqual(evaluate(notice({ title: actType, actType: `${actType} TRIBUTÁRIA` })).decision, 'EXCLUDE');
    }
  }
});

test('same type on other sources, unknown source and excluded/incomplete DOU sections fail open', () => {
  for (const source of ['confaz', 'sped', 'nfe-encat', 'rfb-normas', 'doe-sp', 'doe-sp-legado', 'cgibs', 'dou-alias']) {
    assert.equal(evaluate(notice(), source).decision, 'KEEP');
  }
  assert.equal(evaluatePublicationExclusionPolicy({ publication: notice() }).decision, 'REVIEW');
  for (const section of ['DO1', 'DO1E', 'DO2', 'DO2E', '', 'unknown']) {
    assert.equal(evaluate(notice({ metadata: { dou: { section, abstract: '', continuationTitles: [], continuationAbstracts: [] } } })).decision, 'REVIEW');
  }
  const extra = notice({ metadata: envelope(undefined, 'DO3E') });
  assert.equal(evaluate(extra).decision, 'EXCLUDE');
});

test('protected normative types and fiscal source variants never become exceptions', () => {
  for (const actType of PROTECTED_LEGAL_BASE_TYPES) assert.equal(evaluate(notice({ actType })).decision, 'KEEP', actType);
  for (const actType of ['PORTARIA', 'RESOLUÇÃO', 'EDITAL', 'EXTRATO', 'COMUNICADO', 'CONVÊNIO', 'ATO', 'DECISÃO',
    'DESPACHO', 'ATO DE PESSOAL', 'EDITAL DE CONCURSO PÚBLICO', 'PORTARIA RFB/PGFN', 'INSTRUÇÃO NORMATIVA RFB',
    'EDITAL DE TRANSAÇÃO POR ADESÃO', 'MANUAL DA EFD ICMS IPI', 'TABELA SPED', 'VERSÃO SOFTWARE SPED', '']) {
    assert.notEqual(evaluate(notice({ actType })).decision, 'EXCLUDE', actType);
  }
});

test('candidate type is insufficient: unknown body, object, title, structure or attachment stays REVIEW', () => {
  for (const patch of [
    { content: '' }, { content: 'Aviso de aquisição de papel A4.' },
    { content: 'Objeto: aquisição de equipamento desconhecido. Processo: 123.' },
    { content: `${notice().content} Cláusula extraordinária com efeito jurídico não classificado.` },
    { content: 'Objeto: aquisição de papel A4. Objeto: fornecimento de material de limpeza. Processo: 123.' },
    { title: 'EDITAL DE TRANSAÇÃO', actType: notice().actType },
    { title: 'AVISO DE DISPENSA DE LICITAÇÃO E OUTRAS PROVIDÊNCIAS' },
    { metadata: {} }, { metadata: { dou: { section: 'DO3' } } },
    { metadata: { dou: { section: 'DO3', abstract: '', continuationTitles: [], continuationAbstracts: [], scopeStructureIncomplete: true } } },
    { metadata: { dou: { section: 'DO3', abstract: '', continuationTitles: [], continuationAbstracts: [], titleFallback: 'ART_TYPE_AND_UNIT' } } },
    { files: [{ url: 'https://example.invalid/unknown.pdf' }] },
    { metadata: { ...notice().metadata, files: [{ url: 'https://example.invalid/hidden.pdf' }] } },
    { originMetadata: { files: [{ url: 'https://example.invalid/origin.pdf' }] } },
    { metadata: { dou: { section: 'DO3', abstract: '', continuationTitles: [], continuationAbstracts: [], parts: [{ hasHighlightImage: true }] } } },
  ] as Partial<ExclusionPolicyPublication>[]) assert.equal(evaluate(notice(patch)).decision, 'REVIEW', JSON.stringify(patch));
  assert.equal(evaluate(notice({ title: 'AVISO DE DISPENSA DE LICITAÇÃO Nº 12/2026' })).decision, 'EXCLUDE');
});

test('tax, registered-CNPJ, regulatory and corporate signals veto in body, ementa and continuations', () => {
  for (const signal of ['Crédito tributário de ICMS', 'Benefício aduaneiro', 'IBS e CBS', 'Concessão de serviço público',
    'Incorporação societária', 'CNPJ 12.345.678/0001-90', 'Empresa 12345678000190', 'CNPJ 12.ABC.345/01DE-35']) {
    assert.equal(evaluate(notice({ content: `${notice().content} ${signal}.` })).decision, 'REVIEW');
    for (const field of ['abstract', 'continuationTitles', 'continuationAbstracts']) {
      const dou = { section: 'DO3', abstract: '', continuationTitles: [] as string[], continuationAbstracts: [] as string[],
        [field]: field === 'abstract' ? signal : [signal] };
      assert.equal(evaluate(notice({ metadata: { dou } })).decision, 'REVIEW', `${field}: ${signal}`);
    }
  }
});

test('existing DOU KEEP and REVIEW annotations are safety vetoes, not overridden by a list', () => {
  for (const decision of ['KEEP', 'REVIEW'] as const) {
    const publication = notice(); publication.metadata!.douScope = { decision, ruleVersion: 'dou-scope-v4' };
    assert.equal(evaluate(publication).decision, decision);
  }
});

test('contract excerpts stay under D-066 and are never a simple act_type deny rule', () => {
  const contract = notice({ title: 'EXTRATO DE CONTRATO Nº 7/2026', actType: 'EXTRATO DE CONTRATO',
    content: 'Contratante: União. Contratada: Alfa Ltda. CNPJ: 12.345.678/0001-90. Pregão Eletrônico nº 7/2026. Objeto: aquisição de papel A4. Valor Global: R$ 1.000. Vigência: 12 meses.' });
  assert.equal(evaluate(contract).decision, 'REVIEW');
  assert.equal(evaluate(notice({ ...contract, content: `${contract.content} A cláusula concede isenção do ICMS.` })).decision, 'KEEP');
});

test('normalizer contentText uses the same decision and removing/changing an exact type fails open', () => {
  const value = notice(); const { content, ...rest } = value;
  assert.deepEqual(evaluate({ ...rest, contentText: content! }), evaluate(value));
  const changed = evaluate(notice({ actType: 'AVISO DE DISPENSA DE LICITAÇÃO FUTURO' }));
  assert.equal(changed.decision, 'REVIEW');
});

test('official article and continuation types/sections must agree with the normalized exception', () => {
  for (const type of ['EDITAL DE TRANSAÇÃO', 'PORTARIA', '', undefined]) {
    const metadata = envelope();
    Object.assign(metadata.dou, { sourceActType: type });
    assert.equal(evaluate(notice({ metadata })).reasonCode, 'OFFICIAL_ACT_TYPE_MISSING_OR_CONFLICTING');
  }
  for (const parts of [[], null, [{ attributes: { artType: 'EDITAL DE TRANSAÇÃO', pubName: 'DO3' } }],
    [{ attributes: { artType: notice().actType, pubName: 'DO1' } }], [{}]]) {
    const metadata = envelope(); Object.assign(metadata.dou, { parts });
    assert.equal(evaluate(notice({ metadata })).reasonCode, 'OFFICIAL_PART_TYPE_OR_SECTION_NOT_PROVEN');
  }
});

test('parser title refinement cannot hide a protected official sourceActType', () => {
  const title = 'AVISO DE HOMOLOGAÇÃO Nº 1/2026';
  const entry = {
    name: '530_20260918_12345678.xml',
    bytes: Buffer.from(`<xml><article id="123456781" idMateria="12345678" pubDate="18/09/2026" pubName="DO3" editionNumber="180" artCategory="União" artType="EDITAL DE TRANSAÇÃO" numberPage="1" pdfPage="https://pesquisa.in.gov.br/imprensa/jsp/visualiza/index.jsp?data=18/09/2026&amp;jornal=530&amp;pagina=1"><body><Identifica><![CDATA[${title}]]></Identifica><Ementa></Ementa><Texto><![CDATA[Objeto: Aquisição de papel A4. Processo: 123/2026. Resultado: homologado.]]></Texto></body></article></xml>`),
  };
  const parsed = parseDouEntries([entry], archiveContext('DO3'));
  assert.deepEqual(parsed.partialFailures, []);
  assert.equal(parsed.publications[0]!.actType, 'AVISO DE HOMOLOGAÇÃO');
  const normalized = normalizePublication({ sourceId: 'dou', publication: parsed.publications[0]! });
  assert.equal(evaluate(normalized).reasonCode, 'OFFICIAL_ACT_TYPE_MISSING_OR_CONFLICTING');
});

test('origin KEEP/REVIEW and conflicting evidence veto exclusion before and after normalization', () => {
  const fiscal = envelope(); fiscal.dou.abstract = 'Transação tributária com isenção do ICMS.';
  const contradictory = envelope(undefined, 'DO1');
  const officialConflict = envelope(); officialConflict.dou.sourceActType = 'EDITAL DE TRANSAÇÃO';
  for (const [originMetadata, expected] of [
    [{ douScope: { decision: 'KEEP' } }, 'KEEP'],
    [{ douScope: { decision: 'REVIEW' } }, 'REVIEW'],
    [fiscal, 'REVIEW'], [contradictory, 'REVIEW'], [officialConflict, 'REVIEW'],
    [{ dou: { section: 'DO3' } }, 'REVIEW'],
  ] as const) {
    const publication = notice({ originMetadata });
    const before = structuredClone(publication);
    assert.equal(evaluate(publication).decision, expected);
    const normalized = normalizePublication({ sourceId: 'dou', publication: {
      ...publication, sphere: 'FEDERAL', officialUrl: 'https://example.invalid/notice',
    } });
    assert.equal(evaluate(normalized).decision, expected);
    assert.deepEqual(publication, before);
  }
  assert.equal(evaluate(notice({ originMetadata: envelope() })).decision, 'EXCLUDE');
});
