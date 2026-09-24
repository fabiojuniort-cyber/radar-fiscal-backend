export const RFB_SEARCH_FIXTURE = `<!doctype html><html><body>
<div>Total de atos localizados: 5</div><div>Página 1 de 1</div>
<table><tbody>
<tr><td><a href="https://normasinternet2.receita.fazenda.gov.br/#/consulta/externa/150001">Instrução Normativa</a></td><td>2.344</td><td>RFB</td><td>21/09/2026</td><td>Altera regras de tributação federal e obrigações acessórias.</td></tr>
<tr><td><a href="https://normasinternet2.receita.fazenda.gov.br/#/consulta/externa/150002">Solução de Consulta</a></td><td>180</td><td>Cosit</td><td>23/09/2026</td><td>Assunto: Cofins. Crédito presumido de ICMS. Não incidência.</td></tr>
<tr><td><a href="https://normasinternet2.receita.fazenda.gov.br/#/consulta/externa/150003">Portaria</a></td><td>732</td><td>RFB</td><td>23/09/2026</td><td>Suspende temporariamente as atividades da Agência da Receita Federal do Brasil que especifica.</td></tr>
<tr><td><a href="https://normasinternet2.receita.fazenda.gov.br/#/consulta/externa/150004">Ato Declaratório Executivo</a></td><td>123</td><td>Coana</td><td>23/09/2026</td><td>Certifica como Operador Econômico Autorizado a pessoa jurídica que especifica.</td></tr>
<tr><td><a href="https://normasinternet2.receita.fazenda.gov.br/#/consulta/externa/150005">Ato Declaratório Executivo</a></td><td>99</td><td>Cofis</td><td>23/09/2026</td><td>Dispõe sobre obrigação acessória DCTF e procedimento de declaração.</td></tr>
</tbody></table>
</body></html>`;


export const RFB_RETIFICATION_SEARCH_FIXTURE = `<!doctype html><html><body>
<div>Total de atos localizados: 2</div><div>Página 1 de 1</div>
<table><tbody>
<tr><td><a href="https://normasinternet2.receita.fazenda.gov.br/#/consulta/externa/148881">Portaria</a></td><td>619</td><td>RFB</td><td>05/12/2025</td><td>Retificação da Portaria RFB nº 619, de 3 de dezembro de 2025.</td></tr>
<tr><td><a href="https://normasinternet2.receita.fazenda.gov.br/#/consulta/externa/148882">Portaria</a></td><td>619</td><td>RFB</td><td>05/12/2025</td><td>Retificação da Portaria RFB nº 619, de 3 de dezembro de 2025.</td></tr>
</tbody></table>
</body></html>`;

export const RFB_EMPTY_FIXTURE = `<!doctype html><html><body>
<div>Total de atos localizados: 0</div><div>Página 1 de 1</div>
<table><tbody></tbody></table>
</body></html>`;

export const IN_ORIGINAL = `<!doctype html><html><body>
<h1>INSTRUÇÃO NORMATIVA RFB Nº 2.344, DE 22 DE SETEMBRO DE 2026</h1>
<p>Dispõe sobre regras de tributação federal e obrigações acessórias.</p>
<p>Art. 1º Esta Instrução Normativa disciplina o procedimento.</p>
<p>Art. 2º Esta Instrução Normativa entra em vigor na data de sua publicação.</p>
</body></html>`;

export const IN_VIGENTE = `<!doctype html><html><body>
<h1>INSTRUÇÃO NORMATIVA RFB Nº 2.344, DE 22 DE SETEMBRO DE 2026</h1>
<p>Texto vigente consolidado.</p><p>Art. 1º Esta Instrução Normativa disciplina o procedimento.</p>
</body></html>`;

export const IN_MULTIVIGENTE = `<!doctype html><html><body>
<h1>INSTRUÇÃO NORMATIVA RFB Nº 2.344, DE 22 DE SETEMBRO DE 2026</h1>
<p>Texto multivigente com histórico de alterações.</p>
</body></html>`;

export const IN_RELACIONAL = `<!doctype html><html><body>
<h1>INSTRUÇÃO NORMATIVA RFB Nº 2.344, DE 22 DE SETEMBRO DE 2026</h1>
<p>Alterada pela Instrução Normativa RFB nº 2.400, de 2026.</p>
</body></html>`;

export const SC_ORIGINAL = `<!doctype html><html><body>
<h1>SOLUÇÃO DE CONSULTA COSIT Nº 180, DE 22 DE SETEMBRO DE 2026</h1>
<p>Assunto: Contribuição para o Financiamento da Seguridade Social - Cofins.</p>
<p>Crédito presumido de ICMS. Não incidência.</p>
<a href="/sijut2consulta/anexoOutros.action?idArquivoBinario=90001">Inteiro teor da Solução de Consulta</a>
</body></html>`;

export const ADE_ORIGINAL = `<!doctype html><html><body>
<h1>ATO DECLARATÓRIO EXECUTIVO COFIS Nº 99, DE 22 DE SETEMBRO DE 2026</h1>
<p>Dispõe sobre obrigação acessória DCTF e procedimento de declaração.</p>
</body></html>`;

export const OPTIONAL_EMPTY = `<!doctype html><html><body><p>Representação disponível sem conteúdo adicional.</p></body></html>`;

export function pdfBytes(label: string): Uint8Array {
  return new TextEncoder().encode('%PDF-1.7\\n' + label);
}


export function apiPayload(input: {
  idAto: number;
  typeName: string;
  typeSigla: string;
  number: string;
  agencySigla: string;
  agencyName: string;
  actDate: string;
  publicationDate: string;
  effectiveDate?: string;
  title: string;
  text: string;
  view?: string;
  attachmentId?: number;
  attachmentName?: string;
  current?: boolean;
}): Record<string, unknown> {
  return {
    idAto: input.idAto,
    epigrafe: {
      tipoAto: {
        idTipoAto: 1,
        siglaTipoAto: input.typeSigla,
        nomeTipoAto: input.typeName,
      },
      numeroAto: input.number,
      dataAto: input.actDate,
      orgaos: [{
        idOrgao: 1,
        siglaOrgao: input.agencySigla,
        nomeOrgao: input.agencyName,
      }],
      dataAtoPorExtenso: input.actDate,
    },
    epigrafeCompleta: input.title,
    epigrafeSimplificada: input.title,
    epigrafesAnteriores: [],
    epigrafeUrl: input.title,
    dadosPublicacao: `Publicado(a) no DOU de ${input.publicationDate.split('-').reverse().join('/')}, seção 1`,
    dataPublicacao: input.publicationDate,
    dataVigenciaInicio: input.effectiveDate ?? input.publicationDate,
    exibirVisoes: '1111',
    visao: input.view ?? 'original',
    integro: true,
    vigente: input.current ?? true,
    ehRepublicado: false,
    idAtoRepublicador: null,
    dataRepublicador: null,
    ehVisaoExclusiva: false,
    publicado: true,
    internet: true,
    ementas: [{
      idAto: input.idAto,
      idSegmento: 1,
      ordemSegmentoAto: 1,
      omitir: false,
      original: true,
      compilado: true,
      textoIntegra: input.text,
      arquivoBinario: null,
    }],
    outrosSegmentos: input.attachmentId ? [{
      idAto: input.idAto,
      idSegmento: 2,
      ordemSegmentoAto: 2,
      omitir: false,
      original: true,
      compilado: true,
      textoIntegra: input.attachmentName ?? '',
      arquivoBinario: {
        idArquivoBinario: input.attachmentId,
        nomeArquivoBinario: input.attachmentName ?? `arquivo-${input.attachmentId}.pdf`,
      },
    }] : [],
    ancorasRetificacaoEpigrafe: [],
    ancorasNoAto: [],
    historico: [],
    tiposSegmento: [],
  };
}

export const IN_API_ORIGINAL = apiPayload({
  idAto: 150001,
  typeName: 'Instrução Normativa',
  typeSigla: 'IN',
  number: '2.344',
  agencySigla: 'RFB',
  agencyName: 'Secretaria Especial da Receita Federal do Brasil',
  actDate: '2026-09-22',
  publicationDate: '2026-09-23',
  title: 'INSTRUÇÃO NORMATIVA RFB Nº 2.344, DE 22 DE SETEMBRO DE 2026',
  text: [
    'Dispõe sobre regras de tributação federal e obrigações acessórias.',
    'Art. 1º Esta Instrução Normativa disciplina o procedimento.',
    'Art. 2º Esta Instrução Normativa entra em vigor na data de sua publicação.',
  ].join(' '),
});

export const SC_API_ORIGINAL = apiPayload({
  idAto: 150002,
  typeName: 'Solução de Consulta',
  typeSigla: 'SC',
  number: '180',
  agencySigla: 'Cosit',
  agencyName: 'Coordenação-Geral de Tributação',
  actDate: '2026-09-22',
  publicationDate: '2026-09-23',
  title: 'SOLUÇÃO DE CONSULTA COSIT Nº 180, DE 22 DE SETEMBRO DE 2026',
  text: 'Assunto: Cofins. Crédito presumido de ICMS. Não incidência.',
  attachmentId: 90001,
  attachmentName: 'SC Cosit nº 180-2026.pdf',
});

export const ADE_API_ORIGINAL = apiPayload({
  idAto: 150005,
  typeName: 'Ato Declaratório Executivo',
  typeSigla: 'ADE',
  number: '99',
  agencySigla: 'Cofis',
  agencyName: 'Coordenação-Geral de Fiscalização',
  actDate: '2026-09-22',
  publicationDate: '2026-09-23',
  title: 'ATO DECLARATÓRIO EXECUTIVO COFIS Nº 99, DE 22 DE SETEMBRO DE 2026',
  text: 'Dispõe sobre obrigação acessória DCTF e procedimento de declaração.',
});

export const RETIFICATION_API_ORIGINAL = apiPayload({
  idAto: 148881,
  typeName: 'Portaria',
  typeSigla: 'PORT',
  number: '619',
  agencySigla: 'RFB',
  agencyName: 'Secretaria Especial da Receita Federal do Brasil',
  actDate: '2025-12-03',
  publicationDate: '2025-12-05',
  title: 'Portaria RFB nº 619, de 3 de dezembro de 2025',
  text: [
    'Retificação',
    'No art. 2º da Portaria RFB nº 619, de 3 de dezembro de 2025, publicada no Diário Oficial da União nº 231, de 4 de dezembro de 2025, Seção 1, página 44:',
    'Onde se lê: "V - ao tratamento dos dados por terceiros com a finalidade exclusiva de avaliação de concessão de crédito pessoal; e"',
    'Leia-se: "V - ao tratamento dos dados por terceiros com a finalidade exclusiva de avaliação de concessão de crédito; e"',
    'Nota Normas: Esta retificação foi publicada em duplicata na mesma edição do DOU.',
  ].join(' '),
});

export const RETIFICATION_DUPLICATE_API_ORIGINAL = apiPayload({
  idAto: 148882,
  typeName: 'Portaria',
  typeSigla: 'PORT',
  number: '619',
  agencySigla: 'RFB',
  agencyName: 'Secretaria Especial da Receita Federal do Brasil',
  actDate: '2025-12-03',
  publicationDate: '2025-12-05',
  title: 'Portaria RFB nº 619, de 3 de dezembro de 2025',
  text: 'Retificação (publicação repetida) Nota Normas: Esta retificação foi publicada em duplicata na mesma edição do DOU.',
});

export const JOINT_PORTARIA_API_ORIGINAL = apiPayload({
  idAto: 151936,
  typeName: 'Portaria Conjunta',
  typeSigla: 'PORT CONJ',
  number: '140',
  agencySigla: 'Cofis / Coana / Cotec',
  agencyName: 'Coordenações-Gerais da Receita Federal',
  actDate: '2026-06-17',
  publicationDate: '2026-06-18',
  title: 'Portaria Conjunta Cofis / Coana / Cotec nº 140, de 17 de junho de 2026',
  text: 'Altera a Portaria Conjunta Cofis/Coana/Cotec nº 2, de 24 de novembro de 2020, para atualizar o trâmite da Requisição de Informações sobre a Movimentação Financeira.',
});

export const JOINT_PORTARIA_DUPLICATE_API_ORIGINAL = apiPayload({
  idAto: 151937,
  typeName: 'Portaria Conjunta',
  typeSigla: 'PORT CONJ',
  number: '140',
  agencySigla: 'Cofis / Coana / Cotec',
  agencyName: 'Coordenações-Gerais da Receita Federal',
  actDate: '2026-06-17',
  publicationDate: '2026-06-18',
  title: 'Portaria Conjunta Cofis / Coana / Cotec nº 140, de 17 de junho de 2026',
  text: 'Publicação repetida Nota Normas: Este ato foi publicado em duplicata na mesma edição do DOU. Clique no link acima para tomar conhecimento do seu conteúdo e de eventuais modificações que tenha sofrido.',
});



export function representationPayload(
  base: Record<string, unknown>,
  view: 'original' | 'vigente' | 'multivigente',
  textSuffix = '',
): Record<string, unknown> {
  const clone = structuredClone(base);
  clone.visao = view;
  const ementas = clone.ementas as Array<Record<string, unknown>>;
  if (textSuffix && ementas[0]) {
    ementas[0].textoIntegra = String(ementas[0].textoIntegra ?? '') + ' ' + textSuffix;
  }
  return clone;
}
