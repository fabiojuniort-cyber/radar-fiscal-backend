import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDoeSpList, parseDoeSpTypeCatalogue } from '../src/modules/collection/doe-sp.parser.js';
import {
  decideDoeSpCapture,
  doeSpActType,
  doeSpNormativeIdentity,
  doeSpTitleDate,
} from '../src/modules/collection/doe-sp.rules.js';
import { ID, filters, list0901, list0902, list0904 } from './doe-sp.fixtures.js';

const types = parseDoeSpTypeCatalogue(filters);

function decisionFor(list: unknown, id: string) {
  const item = parseDoeSpList(list).items.find((entry) => entry.id === id)!;
  const typeName = item.publicationTypeId ? types.get(item.publicationTypeId) : undefined;
  return decideDoeSpCapture({ title: item.title, hierarchy: item.hierarchy, excerpt: item.excerpt, ...(typeName ? { typeName } : {}) });
}

test('DOE-SP capture rules on the real 04/09/2026 edition', () => {
  assert.deepEqual(decisionFor(list0904, ID.decree70843), { included: false, reason: 'NUMBERED_DECREE_WITHOUT_TAX_TERMS' });
  assert.deepEqual(decisionFor(list0904, ID.sre43), { included: true, category: 'SEFAZ_TAX_ADMINISTRATION' });
  assert.deepEqual(decisionFor(list0904, ID.delegaciaCassacao), { included: false, reason: 'INDIVIDUAL_TAX_ADMINISTRATIVE_ACT' });
  assert.deepEqual(decisionFor(list0904, ID.postoFiscal), { included: false, reason: 'INDIVIDUAL_TAX_ADMINISTRATIVE_ACT' });
  assert.deepEqual(decisionFor(list0904, ID.governorDecree), { included: false, reason: 'GOVERNOR_ACT_WITHOUT_TAX_TERMS' });
  assert.deepEqual(decisionFor(list0904, ID.governorDispatch), { included: false, reason: 'GOVERNOR_ACT_WITHOUT_TAX_TERMS' });
  assert.deepEqual(decisionFor(list0904, ID.pgeSession), { included: false, reason: 'PGE_WITHOUT_TAX_TERMS' });
  assert.deepEqual(decisionFor(list0904, ID.seducResolution), { included: false, reason: 'OTHER_ORGAN_WITHOUT_TAX_TERMS' });
  assert.deepEqual(decisionFor(list0904, ID.urePortaria), { included: false, reason: 'OTHER_ORGAN_WITHOUT_TAX_TERMS' });
  assert.deepEqual(decisionFor(list0902, ID.dicar59), { included: true, category: 'SEFAZ_TAX_ADMINISTRATION' });
  assert.deepEqual(decisionFor(list0901, ID.retification), { included: true, category: 'DECREES_SECTION' });
});

test('DOE-SP capture rules: legislation, tax terms outside SEFAZ, non-tax SEFAZ units and scope', () => {
  const base = ['Executivo', 'Atos Normativos'];
  assert.deepEqual(decideDoeSpCapture({ title: 'LEI Nº 18.345, DE 28 DE NOVEMBRO DE 2025', hierarchy: [...base, 'Leis'], typeName: 'Lei' }), { included: true, category: 'LEGISLATION' });
  assert.deepEqual(decideDoeSpCapture({ title: 'LEI COMPLEMENTAR Nº 1.436, DE 28 DE NOVEMBRO DE 2025', hierarchy: [...base, 'Leis Complementares'] }), { included: true, category: 'LEGISLATION' });
  assert.deepEqual(decideDoeSpCapture({
    title: 'DECRETO Nº 70.900, DE 23 DE SETEMBRO DE 2026', hierarchy: [...base, 'Decretos'], typeName: 'Decreto Numerado',
    excerpt: 'Introduz alterações no Regulamento do ICMS do Estado de São Paulo.',
  }), { included: true, category: 'NUMBERED_DECREE' });
  assert.deepEqual(decideDoeSpCapture({
    title: 'DECRETO Nº 70.901, DE 23 DE SETEMBRO DE 2026', hierarchy: [...base, 'Decretos'], typeName: 'Decreto Numerado',
    excerpt: 'Dispõe sobre abertura de crédito suplementar ao Orçamento Fiscal.',
  }), { included: false, reason: 'NUMBERED_DECREE_WITHOUT_TAX_TERMS' });
  assert.deepEqual(decideDoeSpCapture({
    title: 'RESOLUÇÃO SAA Nº 50, DE 1 DE JULHO DE 2026', hierarchy: [...base, 'Secretaria de Agricultura e Abastecimento', 'Gabinete do Secretário'],
    typeName: 'Resolução', excerpt: 'Dispõe sobre o diferimento do ICMS nas saídas de produtor rural',
  }), { included: true, category: 'OTHER_ORGAN_TAX_TERMS' });
  assert.deepEqual(decideDoeSpCapture({
    title: 'PORTARIA Nº 12, DE 22 DE SETEMBRO DE 2026', hierarchy: [...base, 'Procuradoria Geral do Estado', 'Área de Contencioso Tributário-fiscal'], typeName: 'Portaria',
  }), { included: true, category: 'PGE_TAX' });
  assert.deepEqual(decideDoeSpCapture({
    title: 'PORTARIA SO Nº 08, DE 4 DE SETEMBRO DE 2026', hierarchy: [...base, 'Secretaria da Fazenda e Planejamento', 'Subsecretaria de Orçamento'], typeName: 'Portaria',
    excerpt: 'Dispõe sobre a abertura de crédito suplementar',
  }), { included: false, reason: 'SEFAZ_NON_TAX_UNIT' });
  assert.deepEqual(decideDoeSpCapture({
    title: 'COMUNICADO DA DIVULGAÇÃO DA QUOTA-PARTE MUNICIPAL DO ICMS E DO FUNDO DE EXPORTAÇÃO',
    hierarchy: [...base, 'Secretaria da Fazenda e Planejamento', 'Subsecretaria do Tesouro Estadual', 'Diretoria Geral de Finanças'],
  }), { included: true, category: 'SEFAZ_OTHER_TAX_TERMS' });
  assert.deepEqual(decideDoeSpCapture({
    title: 'RESOLUÇÃO SFP-25 DE 31-08-2026', hierarchy: [...base, 'Secretaria da Fazenda e Planejamento', 'Gabinete do Secretário'],
  }), { included: true, category: 'SEFAZ_CABINET' });
  assert.deepEqual(decideDoeSpCapture({
    title: 'RESOLUÇÃO SFP/AEFP Nº 739 DE 16 DE SETEMBRO DE 2026', hierarchy: [...base, 'Secretaria da Fazenda e Planejamento', 'Gabinete do Secretário'], typeName: 'Resolução',
    excerpt: 'Dispõe sobre Índices de Reajustes de Preços de Contratos de Serviços.',
  }), { included: false, reason: 'SEFAZ_CABINET_NON_TAX_INDEX' });
  assert.deepEqual(decideDoeSpCapture({
    title: 'RESOLUÇÃO SFP/AEFP Nº 740 DE 16 DE SETEMBRO DE 2026', hierarchy: [...base, 'Secretaria da Fazenda e Planejamento', 'Gabinete do Secretário'], typeName: 'Resolução',
    excerpt: 'Autoriza a divulgação dos Índices de Preços de Obras Públicas.',
  }), { included: false, reason: 'SEFAZ_CABINET_NON_TAX_INDEX' });
  assert.deepEqual(decideDoeSpCapture({
    title: 'Autorização para Transferência de Valores de Apoio', hierarchy: [...base, 'Secretaria da Cultura, Economia e Indústria Criativas'], typeName: 'Comunicado',
    excerpt: 'Assunto: PROAC INCENTIVO FISCAL - ICMS - PROJETO CULTURAL - CÓDIGO 55.579.',
  }), { included: false, reason: 'OTHER_ORGAN_INDIVIDUAL_TAX_INCENTIVE' });
  assert.deepEqual(decideDoeSpCapture({
    title: 'COMISSÃO DE ANÁLISE DE PROJETOS - CAP', hierarchy: [...base, 'Secretaria da Cultura, Economia e Indústria Criativas'], typeName: 'Comunicado',
    excerpt: 'Aprovação de projetos do PROAC Incentivo Fiscal - ICMS.',
  }), { included: false, reason: 'OTHER_ORGAN_INDIVIDUAL_TAX_INCENTIVE' });
  assert.deepEqual(decideDoeSpCapture({
    title: 'Publicação n.005/26 – Quebra de Ordem Cronológica', hierarchy: [...base, 'Universidade Estadual Paulista'], typeName: 'Comunicado',
    excerpt: 'Pagamento de notas fiscais fora da ordem cronológica.',
  }), { included: false, reason: 'OTHER_ORGAN_PAYMENT_ORDER' });
  assert.deepEqual(decideDoeSpCapture({
    title: 'EXTRATO DE CONTRATO', hierarchy: ['Executivo', 'Atos de Gestão e Despesas', 'Secretaria da Fazenda e Planejamento'],
  }), { included: false, reason: 'OUT_OF_SCOPE_SECTION' });
  // "fiscal do contrato" is not tax vocabulary.
  assert.deepEqual(decideDoeSpCapture({
    title: 'PORTARIA DO DIRETOR, DE 3 DE SETEMBRO DE 2026', hierarchy: [...base, 'Secretaria da Saúde', 'Hospital'], typeName: 'Portaria',
    excerpt: 'Designa o fiscal do contrato e a comissão de recebimento',
  }), { included: false, reason: 'OTHER_ORGAN_WITHOUT_TAX_TERMS' });
  assert.deepEqual(decideDoeSpCapture({
    title: 'EXTRATO', hierarchy: [...base, 'Secretaria da Saúde'], typeName: 'Apostila', excerpt: 'ICMS',
  }), { included: false, reason: 'NON_NORMATIVE_TYPE' });
});

test('DOE-SP title dates', () => {
  assert.equal(doeSpTitleDate('DECRETO Nº 70.842, DE 1º DE SETEMBRO DE 2026'), '2026-09-01');
  assert.equal(doeSpTitleDate('RESOLUÇÃO SFP-25 DE 31-08-2026'), '2026-08-31');
  assert.equal(doeSpTitleDate('Portaria URE 66, de 01/09/2026'), '2026-09-01');
  assert.equal(doeSpTitleDate('DECRETO Nº 70.859, DE 13 DE MARÇO DE 2026'), '2026-03-13');
  assert.equal(doeSpTitleDate('COMUNICADO'), undefined);
  assert.equal(doeSpTitleDate('PORTARIA, DE 31 DE FEVEREIRO DE 2026'), undefined);
});

test('DOE-SP act types', () => {
  assert.equal(doeSpActType('PORTARIA CONJUNTA SRE/STE 05, DE 3 DE SETEMBRO DE 2026'), 'PORTARIA CONJUNTA');
  assert.equal(doeSpActType('RETIFICAÇÃO DO DOESP DE 26 DE AGOSTO DE 2026'), 'RETIFICAÇÃO');
  assert.equal(doeSpActType('35ª SESSÃO ORDINÁRIA', 'Comunicado'), 'COMUNICADO');
  assert.equal(doeSpActType('Tabela'), 'ATO');
});

test('DOE-SP normative identity: strong only for unambiguous numbering series', () => {
  const sefaz = (title: string) => doeSpNormativeIdentity({ title, category: 'SEFAZ_TAX_ADMINISTRATION' });
  assert.deepEqual(doeSpNormativeIdentity({ title: 'DECRETO Nº 70.843, DE 3 DE SETEMBRO DE 2026', typeName: 'Decreto Numerado', category: 'NUMBERED_DECREE' }), {
    agency: 'GOVERNO-SP', actType: 'DECRETO', actNumber: '70843/2026', signedOn: '2026-09-03',
  });
  assert.deepEqual(doeSpNormativeIdentity({ title: 'LEI COMPLEMENTAR  Nº 1.437, DE 23 DE DEZEMBRO DE 2025', category: 'LEGISLATION' }), {
    agency: 'GOVERNO-SP', actType: 'LEI COMPLEMENTAR', actNumber: '1437/2025', signedOn: '2025-12-23',
  });
  assert.deepEqual(sefaz('PORTARIA SRE 43, DE 3 DE SETEMBRO DE 2026'), {
    agency: 'SEFAZ-SP/SRE', actType: 'PORTARIA', actNumber: '43/2026', designation: 'SRE', signedOn: '2026-09-03',
  });
  // DOE-SP-40: a stray space after the thousands separator must not truncate the number
  // (Leis 17.834 and 17.839 collided as "17/2023").
  const lei = (title: string) => doeSpNormativeIdentity({ title, category: 'LEGISLATION' })?.actNumber;
  assert.equal(lei('LEI Nº 17. 839, DE 1º DE NOVEMBRO DE 2023'), '17839/2023');
  assert.equal(lei('LEI Nº 17.834, DE 1º DE NOVEMBRO DE 2023'), '17834/2023');
  assert.equal(lei('LEI Nº 17839, DE 1º DE NOVEMBRO DE 2023'), '17839/2023');
  assert.equal(lei('LEI Nº 17 .839, DE 1º DE NOVEMBRO DE 2023'), undefined);
  assert.equal(lei('LEI Nº 17, 839, DE 1º DE NOVEMBRO DE 2023'), undefined);
  assert.equal(lei('LEI Nº 1.234.567, DE 1º DE NOVEMBRO DE 2023'), '1234567/2023');
  assert.equal(sefaz('RESOLUÇÃO SFP Nº 1.234, DE 3 DE SETEMBRO DE 2026'), undefined);
  assert.equal(sefaz('PORTARIA CONJUNTA SRE/STE 05, DE 3 DE SETEMBRO DE 2026')?.agency, 'SEFAZ-SP/SRE/STE');
  assert.equal(sefaz('PORTARIA CONJUNTA SRE/STE 05, DE 3 DE SETEMBRO DE 2026')?.actNumber, '5/2026');
  assert.equal(sefaz('COMUNICADO DICAR Nº 59, DE 1 DE SETEMBRO DE 2026')?.actNumber, '59/2026');
  assert.equal(sefaz('COMUNICADO DIGES Nº 12/2025, DE 28 DE NOVEMBRO DE 2025')?.actNumber, '12/2025');
  assert.equal(sefaz('PORTARIA DEAT 062/2026')?.actNumber, '62/2026');
  assert.equal(doeSpNormativeIdentity({ title: 'RESOLUÇÃO SFP-25 DE 31-08-2026', category: 'SEFAZ_CABINET' })?.agency, 'SEFAZ-SP/SFP');
  assert.equal(doeSpNormativeIdentity({ title: 'RESOLUÇÃO SFP/AEFP N° 704 DE 25-03-2025', category: 'SEFAZ_CABINET' })?.actNumber, '704/2025');
  assert.equal(doeSpNormativeIdentity({ title: 'RESOLUÇÃO CONJUNTA SFP-PGE Nº 3, DE 1 DE JULHO DE 2026', category: 'SEFAZ_CABINET' })?.agency, 'SEFAZ-SP/SFP-PGE');
  // No designation / ambiguous issuer / retification -> DOE publication id identity.
  assert.equal(sefaz('PORTARIA Nº 09, DE 2 DE ABRIL DE 2026'), undefined);
  assert.equal(sefaz('COMUNICADO, DE 22 DE SETEMBRO DE 2026'), undefined);
  assert.equal(sefaz('COMUNICADO DIFIS SÉRIE PORTARIA CAT 32/04 Nº 01, DE 27 DE MARÇO DE 2025'), undefined);
  assert.equal(doeSpNormativeIdentity({ title: 'PORTARIA DA SUBSECRETÁRIA Nº 11, DE 03 DE SETEMBRO DE 2026', category: 'SEFAZ_TAX_ADMINISTRATION' }), undefined);
  assert.equal(doeSpNormativeIdentity({ title: 'RESOLUÇÃO SEDUC Nº 86, DE 3 DE SETEMBRO DE 2026', category: 'OTHER_ORGAN_TAX_TERMS' }), undefined);
  assert.equal(doeSpNormativeIdentity({ title: 'RETIFICAÇÃO DO DOESP DE 26 DE AGOSTO DE 2026', category: 'DECREES_SECTION' }), undefined);
  assert.equal(doeSpNormativeIdentity({ title: 'DECRETO DE 3 DE SETEMBRO DE 2026', category: 'GOVERNOR_ACT_TAX_TERMS' }), undefined);
});
