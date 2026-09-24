/*
 * Real DOE-SP payloads captured on 24/09/2026 from
 * do-api-web-search.doe.sp.gov.br / do-api-publication-pdf.doe.sp.gov.br
 * (Executivo > Atos Normativos, edition of 04/09/2026 and 02/09/2026).
 *
 * Trimming applied for size, never to the fields the connector parses:
 * - summaries keep a real subset of the day's tree/list;
 * - publication `content` had inline CSS (`<style>` blocks, style/class
 *   attributes) removed; the text is untouched;
 * - personal data (name/CPF) of the retification sample was redacted;
 * - PDFs are minimal synthetic PDFs (the API envelope is real; the connector
 *   only validates the PDF magic and hashes the bytes).
 */

export const SEARCH = 'https://do-api-web-search.doe.sp.gov.br/';
export const PDF = 'https://do-api-publication-pdf.doe.sp.gov.br/';

export const JOURNAL_EXECUTIVO = 'ca96256b-6ca1-407f-866e-567ef9430123';
export const SECTION_NORMATIVOS = '257b103f-1eb2-4f24-a170-4e553c7e4aac';

export const journals = {
  count: 5,
  items: [
    { id: 'ca96256b-6ca1-407f-866e-567ef9430123', name: 'Executivo', sequence: 1 },
    { id: '0953858b-7195-4020-ec15-08db6b8e0e4c', name: 'Legislativo', sequence: 2 },
    { id: 'd65936d7-1ca8-4267-934e-1dea132fa237', name: 'Municípios', sequence: 3 },
    { id: '8e1f4298-811b-4e36-0df1-08db6b8c9f7b', name: 'Empresarial', sequence: 4 },
    { id: 'fe4c14dc-e256-4834-b19f-8fd84d664171', name: 'Jucesp', sequence: 5 },
  ],
};

export const sections = {
  count: 3,
  items: [
    { id: '257b103f-1eb2-4f24-a170-4e553c7e4aac', journalId: JOURNAL_EXECUTIVO, name: 'Atos Normativos', sequence: 1, isCategorizable: false },
    { id: 'e6c70876-31ee-4b9a-8840-b8d5ea12352d', journalId: JOURNAL_EXECUTIVO, name: 'Atos de Pessoal', sequence: 2, isCategorizable: false },
    { id: '43e6eab1-caa1-41ba-ac1c-659cb871e265', journalId: JOURNAL_EXECUTIVO, name: 'Atos de Gestão e Despesas', sequence: 3, isCategorizable: true },
  ],
};

export const filters = {
  publicationTypes: [
    { id: '6dec67d3-32f2-4790-a6a2-4726f3c3aa09', name: 'Apostila' },
    { id: 'bf693e16-06db-4583-a88f-9e9d3ecc4185', name: 'Ata' },
    { id: '1dc04aca-8cb9-4b3e-8a01-59b72601895f', name: 'Aviso' },
    { id: 'f6ac099f-77a7-4366-a64a-fa20b90e6528', name: 'Comunicado' },
    { id: '07ca4ac4-a0f8-4305-b5cc-0d680a1ac38f', name: 'Decisão' },
    { id: '66bb9434-9108-4c3b-b3c1-5f26573262a5', name: 'Decreto Não Numerado' },
    { id: '4bfe9767-ed4a-40ed-941f-043854642699', name: 'Decreto Numerado' },
    { id: 'ce8b6a79-b240-45e6-98c8-d8e3ba1c7d9c', name: 'Despacho' },
    { id: '84e9b37e-1db1-48dd-a0db-bbc52986bfd0', name: 'Instrução Normativa' },
    { id: 'cb4ba2b1-3c31-4d79-85be-0c348ef04c66', name: 'Portaria' },
    { id: 'e0177e40-4b3a-48e4-b219-35cde3e1ac4c', name: 'Ratificação' },
    { id: 'a452e8e9-a073-4ed2-99c9-df55add8cdec', name: 'Resolução' },
    { id: '50f23a62-e5ba-45a0-a7ea-dd9b0295a36b', name: 'Retificação' },
    { id: '8828dd65-50a7-43e2-aea6-c25d59ce0cd7', name: 'Termos' },
  ],
};

export const ID = {
  decree70843: 'b768399b-6638-460d-bce0-08df049590c6',
  governorDecree: '1445d0d3-e469-4d7f-ed0b-08df081b20d4',
  governorDispatch: 'a2e9bf6e-6d2f-430e-23cc-08df09ae1af9',
  pgeSession: 'b8fb1bba-1e31-407d-ab7f-08df0495b84e',
  seducResolution: '9716c5c2-7f22-46eb-a80d-08df0495b6f6',
  urePortaria: '91174000-076a-4029-bc7f-08df049590c6',
  delegaciaCassacao: 'ffe36bfd-ee7d-487b-d449-08df09ac2b13',
  postoFiscal: 'e9181208-42ec-4f54-ab4f-08df0495b84e',
  sre43: '70413500-3dd4-4b9b-a88a-08df0495b6f6',
  dicar59: 'd7eb71ec-9daf-4804-7eae-08df0817934e',
  retification: 'a1f3e33f-e962-4ae9-ed58-08df04981eb4',
} as const;

/** v2/summary/structured, 2026-09-04 (real subset). */
export const structured0904 = {
  journalName: 'Executivo',
  items: [{
    id: SECTION_NORMATIVOS,
    name: 'Atos Normativos',
    children: [
      {
        id: '81f77c5c-d935-49ac-7d52-08db6b94d2bf', name: 'DECRETOS',
        publications: [
          { id: ID.decree70843, title: 'DECRETO Nº 70.843, DE 3 DE SETEMBRO DE 2026', slug: 'executivo/decretos/decreto-n-70843-de-3-de-setembro-de-2026-202609031182022102868' },
        ],
      },
      {
        id: '004bd8e7-fab1-4b53-b5b7-08db6b943832', name: 'ATOS DO GOVERNADOR',
        children: [
          { id: '7720b062-7611-4199-7d61-08db6b94d2bf', name: 'Decretos', publications: [
            { id: ID.governorDecree, title: 'DECRETO DE 3 DE SETEMBRO DE 2026', slug: 'executivo/atos-do-governador/decreto-de-3-de-setembro-de-2026-2026090311912012102887' },
          ] },
          { id: 'fe9a6b3f-84f6-4631-b5c7-08db6b943832', name: 'Despachos do Governador', publications: [
            { id: ID.governorDispatch, title: 'DESPACHO DO GOVERNADOR, DE 3 DE SETEMBRO DE 2026', slug: 'executivo/atos-do-governador/despacho-do-governador-de-3-de-setembro-de-2026-2026090311952042102876' },
          ] },
        ],
      },
      {
        id: '311a9383-5f54-4c22-e523-08db6b932348', name: 'PROCURADORIA GERAL DO ESTADO',
        children: [{ id: '85b244eb-6b72-4a59-e58e-08db6b932348', name: 'Conselho da Procuradoria Geral do Estado', publications: [
          { id: ID.pgeSession, title: '35ª SESSÃO ORDINÁRIA - BIÊNIO 2025/2026', slug: 'executivo/procuradoria-geral-do-estado/35-sessao-ordinaria-bienio-2025-2026-20260903111321992100255' },
        ] }],
      },
      {
        id: '771eb9b0-1e48-4769-7d58-08db6b94d2bf', name: 'SECRETARIA DA EDUCAÇÃO',
        children: [
          { id: 'bac6bfed-f36d-49b7-7d91-08db6b94d2bf', name: 'Gabinete do Secretário', publications: [
            { id: ID.seducResolution, title: 'RESOLUÇÃO SEDUC Nº 86, DE 3 DE SETEMBRO DE 2026', slug: 'executivo/secretaria-da-educacao/resolucao-seduc-n-86-de-3-de-setembro-de-2026-20260903112412202101665' },
          ] },
          { id: 'dc6dd98a-972a-4c70-e55e-08db6b932348', name: 'Unidades Regionais de Ensino ', children: [
            { id: 'e3b9ced7-800d-4c92-eaae-08db6b932348', name: 'Unidade Regional de Ensino Centro', publications: [
              { id: ID.urePortaria, title: 'PORTARIA URE 66, DE 01/09/2026', slug: 'executivo/secretaria-da-educacao/portaria-ure-66-de-01-09-2026-2026090311241192142102139' },
            ] },
          ] },
        ],
      },
      {
        id: 'e0e06c19-4428-471f-7d57-08db6b94d2bf', name: 'SECRETARIA DA FAZENDA E PLANEJAMENTO',
        children: [{
          id: '9965a111-5ca2-44cd-b5ea-08db6b943832', name: 'Subsecretaria da Receita Estadual',
          publications: [
            { id: ID.sre43, title: 'PORTARIA SRE 43, DE 3 DE SETEMBRO DE 2026', slug: 'executivo/secretaria-da-fazenda-e-planejamento/portaria-sre-43-de-3-de-setembro-de-2026-20260903112832142102360' },
          ],
          children: [{
            id: 'c3af95a1-ee78-434f-7fb5-08db6b94d2bf', name: 'Diretoria Geral Executiva da Administração Tributária',
            children: [{
              id: '366de31b-4d2e-4e51-ee24-08db6b932348', name: 'Delegacias Tributárias',
              children: [
                { id: '3183cc6b-0928-4cfd-eebd-08db6b932348', name: 'Delegacia Tributária da Capital III', publications: [
                  { id: ID.delegaciaCassacao, title: 'CASSAÇÃO DA EFICÁCIA DA INSCRIÇÃO ESTADUAL ', slug: 'executivo/secretaria-da-fazenda-e-planejamento/cassacao-da-eficacia-da-inscricao-estadual-20260903112834631992100095' },
                ] },
                { id: '4cb92ba8-78f1-41bb-bf5c-08db6b943832', name: 'Delegacia Tributária de Araçatuba - DT-9', children: [
                  { id: '18f0ccbe-2c7f-44b3-c15e-08db6b943832', name: 'Posto Fiscal de Araçatuba', publications: [
                    { id: ID.postoFiscal, title: 'CASSAÇÃO DE EFICÁCIA DE INSCRIÇÃO ESTADUAL', slug: 'executivo/secretaria-da-fazenda-e-planejamento/cassacao-de-eficacia-de-inscricao-estadual-2026090311283461161992099961' },
                  ] },
                ] },
              ],
            }],
          }],
        }],
      },
    ],
  }],
};

const T_DECRETO_NUM = '4bfe9767-ed4a-40ed-941f-043854642699';
const T_DECRETO_NN = '66bb9434-9108-4c3b-b3c1-5f26573262a5';
const T_DESPACHO = 'ce8b6a79-b240-45e6-98c8-d8e3ba1c7d9c';
const T_COMUNICADO = 'f6ac099f-77a7-4366-a64a-fa20b90e6528';
const T_PORTARIA = 'cb4ba2b1-3c31-4d79-85be-0c348ef04c66';
const T_RESOLUCAO = 'a452e8e9-a073-4ed2-99c9-df55add8cdec';

/** v2/summary/list, 2026-09-04 (the same real subset, in source order). */
export const list0904 = {
  pages: 44,
  pageSize: 10,
  publications: [
    { isLegacy: false, id: ID.decree70843, publicationTypeId: T_DECRETO_NUM, secondLevelSectionId: '81f77c5c-d935-49ac-7d52-08db6b94d2bf', date: '2026-09-04T01:01:06.1307482', title: 'DECRETO Nº 70.843, DE 3 DE SETEMBRO DE 2026', slug: 'executivo/decretos/decreto-n-70843-de-3-de-setembro-de-2026-202609031182022102868', excerpt: 'SEI/GESP - 0119661739 - DOE: Decreto numerado Dispõe sobre a classificação institucional da Casa Civil nos Sistemas de Administração Financeira e Orçamentária do Estado. O GOVERNADOR DO ESTADO DE SÃO PAULO, no uso de suas atribuições legais, com fundamento no artigo 6º do Decreto-Lei nº 233, de 28 de abril de 1970, que', hierarchy: 'Executivo > Atos Normativos > Decretos', totalTermsFound: 0 },
    { isLegacy: false, id: ID.governorDecree, publicationTypeId: T_DECRETO_NN, secondLevelSectionId: '004bd8e7-fab1-4b53-b5b7-08db6b943832', thirdLevelSectionId: '7720b062-7611-4199-7d61-08db6b94d2bf', date: '2026-09-04T01:01:27.5880314', title: 'DECRETO DE 3 DE SETEMBRO DE 2026', slug: 'executivo/atos-do-governador/decreto-de-3-de-setembro-de-2026-2026090311912012102887', excerpt: 'SEI/GESP - 0118983160 - DOE: Decreto corrido (Seção 1 - Normativo) O GOVERNADOR DO ESTADO DE SÃO PAULO, no uso de suas atribuições legais e nos termos do artigo 7º da Lei nº 185, de 12 de dezembro de 1973, com a redação dada pela Lei nº 15.050, de 20 de junho de 2013, e à vista do disposto no processo SEI 161.00199400/', hierarchy: 'Executivo > Atos Normativos > Atos do Governador > Decretos', totalTermsFound: 0 },
    { isLegacy: false, id: ID.governorDispatch, publicationTypeId: T_DESPACHO, secondLevelSectionId: '004bd8e7-fab1-4b53-b5b7-08db6b943832', thirdLevelSectionId: 'fe9a6b3f-84f6-4631-b5c7-08db6b943832', date: '2026-09-04T01:01:41.9159321', title: 'DESPACHO DO GOVERNADOR, DE 3 DE SETEMBRO DE 2026', slug: 'executivo/atos-do-governador/despacho-do-governador-de-3-de-setembro-de-2026-2026090311952042102876', excerpt: 'SEI/GESP - 0117220784 - DOE: Despacho (Seção 1 - Normativo) Nº do Processo: 018.00024869/2024-72 Interessada: Secretaria de Gestão e Governo Digital/Subsecretaria de Patrimônio do Estado. Assunto: Alienação onerosa do imóvel que especifica. Diante dos elementos de instrução dos autos, em especial as Decisões n°s 102/20', hierarchy: 'Executivo > Atos Normativos > Atos do Governador > Despachos do Governador', totalTermsFound: 0 },
    { isLegacy: false, id: ID.pgeSession, publicationTypeId: T_COMUNICADO, secondLevelSectionId: '311a9383-5f54-4c22-e523-08db6b932348', thirdLevelSectionId: '85b244eb-6b72-4a59-e58e-08db6b932348', date: '2026-09-04T01:01:14.8155404', title: '35ª SESSÃO ORDINÁRIA - BIÊNIO 2025/2026', slug: 'executivo/procuradoria-geral-do-estado/35-sessao-ordinaria-bienio-2025-2026-20260903111321992100255', excerpt: 'SEI/GESP - 0120179698 - DOE: Comunicado (Seção 1 - Normativo) PAUTA DA 35ª SESSÃO ORDINÁRIA - BIÊNIO 2025/2026 DATA DA REALIZAÇÃO: 11/09/2026 - HORÁRIO 09h30min A 35ª Sessão Ordinária do Egrégio Conselho da Procuradoria Geral do Estado será realizada VIRTUALMENTE, por meio da plataforma Microsoft Teams. O link para aco', hierarchy: 'Executivo > Atos Normativos > Procuradoria Geral do Estado > Conselho da Procuradoria Geral do Estado', totalTermsFound: 0 },
    { isLegacy: false, id: ID.urePortaria, publicationTypeId: T_PORTARIA, secondLevelSectionId: '771eb9b0-1e48-4769-7d58-08db6b94d2bf', thirdLevelSectionId: 'dc6dd98a-972a-4c70-e55e-08db6b932348', date: '2026-09-04T01:01:05.1577625', title: 'Portaria URE 66, de 01/09/2026', slug: 'executivo/secretaria-da-educacao/portaria-ure-66-de-01-09-2026-2026090311241192142102139', excerpt: 'SEI/GESP - 0120284871 - DOE: Portaria (Seção 1 - Normativo) O Coordenador-Dirigente Regional de Ensino Centro, conforme as competências que lhe são conferidas pelo Decreto 69.665/2025, com fundamento na Deliberação CEE 138/2016, Deliberação CEE nº 207/2022, Indicação CEE nº 215/2022, Resolução SEDUC 130/2025 e demais n', hierarchy: 'Executivo > Atos Normativos > Secretaria da Educação > Unidades Regionais de Ensino  > Unidade Regional de Ensino Centro', totalTermsFound: 0 },
    { isLegacy: false, id: ID.seducResolution, publicationTypeId: T_RESOLUCAO, secondLevelSectionId: '771eb9b0-1e48-4769-7d58-08db6b94d2bf', thirdLevelSectionId: 'bac6bfed-f36d-49b7-7d91-08db6b94d2bf', date: '2026-09-04T01:00:31.8701991', title: 'RESOLUÇÃO SEDUC Nº 86, DE 3 DE SETEMBRO DE 2026', slug: 'executivo/secretaria-da-educacao/resolucao-seduc-n-86-de-3-de-setembro-de-2026-20260903112412202101665', excerpt: 'Disciplina a celebração, a execução, o acompanhamento e a prestação de contas dos convênios de alimentação escolar celebrados entre o Estado de São Paulo e os Municípios paulistas O Secretário da Educação do Estado de São Paulo, no uso de suas atribuições legais, considerando o disposto na Lei federal nº 11.947, de 16 ', hierarchy: 'Executivo > Atos Normativos > Secretaria da Educação > Gabinete do Secretário', totalTermsFound: 0 },
    { isLegacy: false, id: ID.delegaciaCassacao, publicationTypeId: T_COMUNICADO, secondLevelSectionId: 'e0e06c19-4428-471f-7d57-08db6b94d2bf', thirdLevelSectionId: '9965a111-5ca2-44cd-b5ea-08db6b943832', date: '2026-09-04T01:00:50.9160663', title: 'Cassação da eficácia da Inscrição Estadual ', slug: 'executivo/secretaria-da-fazenda-e-planejamento/cassacao-da-eficacia-da-inscricao-estadual-20260903112834631992100095', excerpt: 'Posto Fiscal da Capital – Butantã Rua Butantã, nº 260 – São Paulo - SP O(s) contribuinte(s) abaixo identificado(s), fica(m) notificado(s) da cassação da eficácia da Inscrição Estadual, em virtude da não localização do estabelecimento, nos termos dos artigos 11 e 12 da Portaria CAT-95/2006. Poderá(ão) apresentar recurso', hierarchy: 'Executivo > Atos Normativos > Secretaria da Fazenda e Planejamento > Subsecretaria da Receita Estadual > Diretoria Geral Executiva da Administração Tributária > Delegacias Tributárias > Delegacia Tributária da Capital III', totalTermsFound: 0 },
    { isLegacy: false, id: ID.postoFiscal, publicationTypeId: T_COMUNICADO, secondLevelSectionId: 'e0e06c19-4428-471f-7d57-08db6b94d2bf', thirdLevelSectionId: '9965a111-5ca2-44cd-b5ea-08db6b943832', date: '2026-09-04T01:01:14.2533036', title: 'Cassação de eficácia de Inscrição Estadual', slug: 'executivo/secretaria-da-fazenda-e-planejamento/cassacao-de-eficacia-de-inscricao-estadual-2026090311283461161992099961', excerpt: 'SEI/GESP - 0120182519 - DOE: Comunicado (Seção 1 - Normativo) O Chefe do POSTO FISCAL DE ARAÇATUBA, com base no artigo 12 da Portaria CAT 95, de 24.11.2006, faz saber que, em decorrência do que ficou apurado nas Ordens de Serviço Fiscal (OSF) relacionadas, foram cassadas as eficácias das Inscrições Estaduais, a seguir ', hierarchy: 'Executivo > Atos Normativos > Secretaria da Fazenda e Planejamento > Subsecretaria da Receita Estadual > Diretoria Geral Executiva da Administração Tributária > Delegacias Tributárias > Delegacia Tributária de Araçatuba - DT-9 > Posto Fiscal de Araçatuba', totalTermsFound: 0 },
    { isLegacy: false, id: ID.sre43, publicationTypeId: T_PORTARIA, secondLevelSectionId: 'e0e06c19-4428-471f-7d57-08db6b94d2bf', thirdLevelSectionId: '9965a111-5ca2-44cd-b5ea-08db6b943832', date: '2026-09-04T01:01:11.6807106', title: 'PORTARIA SRE 43, DE 3 DE SETEMBRO DE 2026', slug: 'executivo/secretaria-da-fazenda-e-planejamento/portaria-sre-43-de-3-de-setembro-de-2026-20260903112832142102360', excerpt: 'SEI/GESP - 0119293835 - DOE: Portaria (Seção 1 - Normativo) Altera a Portaria CAT 125/11, de 9 de setembro de 2011, que institui o Sistema Ambiente de Pagamentos e o Documento de Arrecadação de Receitas Estaduais - DARE-SP. O SUBSECRETÁRIO DA RECEITA ESTADUAL, tendo em vista o disposto no artigo 7º da Resolução SFP 43/', hierarchy: 'Executivo > Atos Normativos > Secretaria da Fazenda e Planejamento > Subsecretaria da Receita Estadual', totalTermsFound: 0 },
  ],
};

/** v2/summary/list, 2026-09-02 (DICAR communiqué with attachment). */
export const list0902 = {
  pages: 1,
  pageSize: 10,
  publications: [
    { isLegacy: false, id: ID.dicar59, publicationTypeId: T_COMUNICADO, secondLevelSectionId: 'e0e06c19-4428-471f-7d57-08db6b94d2bf', thirdLevelSectionId: '9965a111-5ca2-44cd-b5ea-08db6b943832', date: '2026-09-02T01:00:58.1234567', title: 'COMUNICADO DICAR Nº 59, DE 1 DE SETEMBRO DE 2026', slug: 'executivo/secretaria-da-fazenda-e-planejamento/comunicado-dicar-n-59-de-1-de-setembro-de-2026-2026090111283431992092442', excerpt: 'Divulga a Tabela Prática para Cálculo dos Juros de Mora aplicáveis até 30 de setembro de 2026 para os débitos de ITCMD e de IPVA.', hierarchy: 'Executivo > Atos Normativos > Secretaria da Fazenda e Planejamento > Subsecretaria da Receita Estadual > Diretoria Geral Executiva da Administração Tributária >  Diretoria de Cobrança e Arrecadação', totalTermsFound: 0 },
  ],
};

export const structured0902 = {
  journalName: 'Executivo',
  items: [{
    id: SECTION_NORMATIVOS, name: 'Atos Normativos',
    children: [
      { id: 'e0e06c19-4428-471f-7d57-08db6b94d2bf', name: 'SECRETARIA DA FAZENDA E PLANEJAMENTO', publications: [
        { id: ID.dicar59, title: 'COMUNICADO DICAR Nº 59, DE 1 DE SETEMBRO DE 2026', slug: list0902.publications[0]!.slug },
      ] },
    ],
  }],
};

/** v2/summary/list, 2026-09-01 (retification published in the DECRETOS section). */
export const list0901 = {
  pages: 1,
  pageSize: 10,
  publications: [
    { isLegacy: false, id: ID.retification, publicationTypeId: '50f23a62-e5ba-45a0-a7ea-dd9b0295a36b', secondLevelSectionId: '81f77c5c-d935-49ac-7d52-08db6b94d2bf', date: '2026-09-01T01:00:40.5000000', title: 'RETIFICAÇÃO DO DOESP DE 26 DE AGOSTO DE 2026', slug: 'executivo/decretos/retificacao-do-doesp-de-26-de-agosto-de-2026-202608311182232092227', excerpt: 'No Decreto nº 70.818, de 25 de agosto de 2026, no Anexo I, leia-se como segue e não como constou:', hierarchy: 'Executivo > Atos Normativos > Decretos', totalTermsFound: 0 },
  ],
};

/** Supplement acts of 23/09/2026 are listed with a midnight timestamp (real). */
export const supplementItem0923 = { isLegacy: false, id: '739fada3-fd86-49b8-1845-08df197a65f4', publicationTypeId: T_RESOLUCAO, date: '2026-09-23T00:00:00', title: 'RESOLUÇÃO SEDUC Nº 91, DE 23 DE SETEMBRO DE 2026', slug: 'executivo/secretaria-da-educacao/resolucao-seduc-n-91-de-23-de-setembro-de-2026-20260923112412202150848', excerpt: '', hierarchy: 'Executivo > Atos Normativos > Secretaria da Educação > Gabinete do Secretário', totalTermsFound: 0 };

/** v1/editions/status/2026-09-04 (real subset). */
export const status0904 = {
  operationDateTime: '2026-09-24T07:55:38.7420185-03:00',
  editionsProcessed: [
    { editionId: 'ee5b35e6-18fb-4a37-a644-562dceb96e52', editionName: 'Executivo_Atos_de_Pessoal', publications: 2019, editionAuthCode: 'E.2026.09.04.1.6.1', elapsedTime: '01:02:41.0520875', status: 'Pronto', volume: 136, number: 169 },
    { editionId: 'c4853c75-f456-49e3-8e06-331d8cbc397f', editionName: 'Executivo_Atos_Normativos', publications: 430, editionAuthCode: 'E.2026.09.04.1.26.1', elapsedTime: '00:06:42.8693175', status: 'Pronto', volume: 136, number: 169 },
  ],
};

export const editionUrl0904 = {
  fileName: '2d9ae845-29b5-4e1f-bae8-a3a532cbae7f',
  url: 'http://do-api-publication-pdf.doe.sp.gov.br/v1/editions/2d9ae845-29b5-4e1f-bae8-a3a532cbae7f',
};

export const supplementaryUrls = {
  supplementaryEditionsUrls: [{
    fileName: '47108331-cb05-4785-bb71-09b534aff0aa',
    url: 'http://do-api-publication-pdf.doe.sp.gov.br/v1/supplementary-editions/47108331-cb05-4785-bb71-09b534aff0aa',
    status: { description: 'A renderização da edição foi concluída.', name: 'Pronto', value: 6 },
    complementary: false,
  }],
};

const SEI_HEAD = (title: string) => `<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">\n<html lang="pt-br">\n<head>\n<meta http-equiv="Pragma" content="no-cache">\n<meta name="robots" content="noindex">\n<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">\n<title>${title}</title>\n<style>p.Citacao {font-size:10pt; font-family:Calibri;}</style>\n</head>\n<body>\n`;

export const details: Record<string, Record<string, unknown>> = {
  [ID.sre43]: {
    id: ID.sre43, journalId: JOURNAL_EXECUTIVO, sectionId: '9965a111-5ca2-44cd-b5ea-08db6b943832', firstLevelSectionId: SECTION_NORMATIVOS, secondLevelSectionId: 'e0e06c19-4428-471f-7d57-08db6b94d2bf',
    title: 'PORTARIA SRE 43, DE 3 DE SETEMBRO DE 2026',
    slug: 'executivo/secretaria-da-fazenda-e-planejamento/portaria-sre-43-de-3-de-setembro-de-2026-20260903112832142102360',
    date: '2026-09-04', journal: 'Executivo', section: 'Subsecretaria da Receita Estadual', firstLevelSectionName: 'Atos Normativos', secondLevelSectionName: 'Secretaria da Fazenda e Planejamento', publicationType: 'Portaria', editionPages: [],
    content: SEI_HEAD('SEI/GESP - 0119293835 - DOE: Portaria (Seção 1 - Normativo)') + '<p><em>Altera a Portaria CAT 125/11, de 9 de setembro de 2011, que institui o Sistema Ambiente de Pagamentos e o Documento de Arrecada&ccedil;&atilde;o de Receitas Estaduais - DARE-SP.</em></p>\r\n\r\n<p>O <b>SUBSECRET&Aacute;RIO DA RECEITA ESTADUAL</b>, tendo em vista o disposto no artigo 7&ordm; da Resolu&ccedil;&atilde;o SFP 43/20, de 27 de maio de 2020, expede a seguinte portaria:</p>\r\n\r\n<p><b>Artigo 1&ordm;</b> - Fica acrescentado, com a reda&ccedil;&atilde;o que se segue, o c&oacute;digo de receita 630-0 ao Anexo &Uacute;nico da Portaria CAT 125/11, de 9 de setembro de 2011:</p>\r\n\r\n<p>&ldquo;</p>\r\n\r\n<table>\r\n\t<tbody>\r\n\t\t<tr>\r\n\t\t\t<td>C&Oacute;DIGO</td>\r\n\t\t\t<td>DISCRIMINA&Ccedil;&Atilde;O</td>\r\n\t\t</tr>\r\n\t\t<tr>\r\n\t\t\t<td>630-0</td>\r\n\t\t\t<td>Receita n&atilde;o tribut&aacute;ria - FED - Centro de Estudos PGE</td>\r\n\t\t</tr>\r\n\t</tbody>\r\n</table>\r\n\r\n<p>&rdquo; (NR).</p>\r\n\r\n<p><b>Artigo 2&ordm;</b> - Esta portaria entra em vigor na data de sua publica&ccedil;&atilde;o.</p>\r\n\r\n</body>\n</html>\n',
    attachments: [],
    authCode: '2026.09.03.1.1.28.3.214.2102360',
  },
  [ID.decree70843]: {
    id: ID.decree70843, journalId: JOURNAL_EXECUTIVO, sectionId: '81f77c5c-d935-49ac-7d52-08db6b94d2bf', firstLevelSectionId: SECTION_NORMATIVOS, secondLevelSectionId: '81f77c5c-d935-49ac-7d52-08db6b94d2bf',
    title: 'DECRETO Nº 70.843, DE 3 DE SETEMBRO DE 2026',
    slug: 'executivo/decretos/decreto-n-70843-de-3-de-setembro-de-2026-202609031182022102868',
    date: '2026-09-04', journal: 'Executivo', section: 'Decretos', firstLevelSectionName: 'Atos Normativos', secondLevelSectionName: 'Decretos', publicationType: 'Decreto Numerado', editionPages: [],
    content: SEI_HEAD('SEI/GESP - 0119661739 - DOE: Decreto numerado') + '\r\n<p><span>Disp&otilde;e sobre a classifica&ccedil;&atilde;o institucional da Casa Civil nos Sistemas de Administra&ccedil;&atilde;o Financeira e Or&ccedil;ament&aacute;ria do Estado.</span></p>\r\n\r\n<p><b>O GOVERNADOR DO ESTADO DE S&Atilde;O PAULO</b>, no uso de suas atribui&ccedil;&otilde;es legais, com fundamento no artigo 6&ordm; do Decreto-Lei n&ordm; 233, de 28 de abril de 1970, que estabelece normas para a estrutura&ccedil;&atilde;o dos Sistemas de Administra&ccedil;&atilde;o Financeira e Or&ccedil;ament&aacute;ria do Estado, e &agrave; vista do disposto nos Decretos n&ordm; 68.742, de 5 de agosto de 2024, e n&ordm;s 70.049 e 70.050, ambos de 5 de novembro de 2025,</p>\r\n\r\n<p><b>Decreta:</b></p>\r\n\r\n<p>Artigo 1&ordm; - Constituem Unidades Or&ccedil;ament&aacute;rias da Casa Civil:</p>\r\n<p>I - Casa Civil;</p>\r\n<p>II - Casa Militar;</p>\r\n<p>III - Fundo Social de S&atilde;o Paulo - FUSSP.</p>\r\n\r\n<p>Artigo 7&ordm; - Este decreto entra em vigor na data de sua publica&ccedil;&atilde;o, ficando revogadas as disposi&ccedil;&otilde;es em contr&aacute;rio, em especial:</p>\r\n<p>I - o Decreto n&ordm; 67.483, de 10 de fevereiro de 2023;</p>\r\n<p>II - o Decreto n&ordm; 67.559, de 9 de mar&ccedil;o de 2023.</p>\r\n\r\n<div>\r\n<p>TARC&Iacute;SIO DE FREITAS</p>\r\n</div>\r\n</body>\n</html>\n',
    attachments: [],
    authCode: '2026.09.03.1.1.8.202.2102868',
  },
  [ID.dicar59]: {
    id: ID.dicar59, journalId: JOURNAL_EXECUTIVO, sectionId: 'a75c7feb-558a-43e1-865b-08db6b94d2bf', firstLevelSectionId: SECTION_NORMATIVOS, secondLevelSectionId: 'e0e06c19-4428-471f-7d57-08db6b94d2bf',
    title: 'COMUNICADO DICAR Nº 59, DE 1 DE SETEMBRO DE 2026',
    slug: 'executivo/secretaria-da-fazenda-e-planejamento/comunicado-dicar-n-59-de-1-de-setembro-de-2026-2026090111283431992092442',
    date: '2026-09-02', journal: 'Executivo', section: ' Diretoria de Cobrança e Arrecadação', firstLevelSectionName: 'Atos Normativos', secondLevelSectionName: 'Secretaria da Fazenda e Planejamento', publicationType: 'Comunicado', editionPages: [],
    content: '<p><em>Divulga a Tabela Pr&aacute;tica para C&aacute;lculo dos Juros de Mora aplic&aacute;veis at&eacute; 30 de setembro de 2026 para os d&eacute;bitos de ITCMD e de IPVA.</em></p>\n<p>O Diretor de Cobran&ccedil;a e Arrecada&ccedil;&atilde;o, considerando o disposto no artigo 1&ordm; da Lei 10.175, de 30/12/98, divulga a Tabela Pr&aacute;tica para C&aacute;lculo dos Juros de Mora, aplic&aacute;veis aos d&eacute;bitos de ITCMD e IPVA, anexa a este comunicado.</p>',
    attachments: [{ id: 'ede64d5b-2bdc-4c9b-bfd3-841a1c69eded', name: 'Anexo_Com DICAR-59 - Publicação Juros ITCMD e IPVA - SET-26.pdf', position: 0, createdAt: '2026-09-01T12:02:00.835Z' }],
    authCode: '2026.09.01.1.1.28.3.4.3.199.2092442',
  },
  [ID.retification]: {
    id: ID.retification, journalId: JOURNAL_EXECUTIVO, sectionId: '81f77c5c-d935-49ac-7d52-08db6b94d2bf', firstLevelSectionId: SECTION_NORMATIVOS, secondLevelSectionId: '81f77c5c-d935-49ac-7d52-08db6b94d2bf',
    title: 'RETIFICAÇÃO DO DOESP DE 26 DE AGOSTO DE 2026',
    slug: 'executivo/decretos/retificacao-do-doesp-de-26-de-agosto-de-2026-202608311182232092227',
    date: '2026-09-01', journal: 'Executivo', section: 'Decretos', firstLevelSectionName: 'Atos Normativos', secondLevelSectionName: 'Decretos', publicationType: 'Retificação', editionPages: [],
    content: SEI_HEAD('SEI/GESP - 0119664981 - DOE: Retificação (Seção 1 - Normativo)') + '<p>No Decreto n&ordm; 70.818, de 25 de agosto de 2026, no Anexo I, leia-se como segue e n&atilde;o como constou:</p>\r\n<p>A N E X O I</p>\r\n<table><tbody><tr><td>CARGO</td><td>SQC</td><td>OCUPANTE</td></tr><tr><td>Auxiliar de Enfermagem</td><td>SQC-III</td><td>[REDACTED]</td></tr></tbody></table>\r\n</body>\n</html>\n',
    attachments: [],
    authCode: '2026.08.31.1.1.8.223.2092227',
  },
};

/** Minimal valid PDF bytes (synthetic). */
export function pdfBytes(label: string): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n% ${label}\ntrailer << /Root 1 0 R >>\n%%EOF\n`);
}

/** v2/authentication/download/{authCode} envelope (real shape). */
export function authPdfEnvelope(id: string): Record<string, unknown> {
  return { name: `${id}.pdf`, content: Buffer.from(pdfBytes('auth ' + id)).toString('base64'), contentType: 'application/pdf' };
}
