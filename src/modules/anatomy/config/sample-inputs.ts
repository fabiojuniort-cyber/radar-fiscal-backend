/**
 * ANAT-CONFIG-01: SYNTHETIC sample acts used by the configuration screen (preview before/after, review list).
 * Every text below was written for this purpose. None is copied from an official act, the corpus, a gold file or the
 * reserve, and none of them is evidence about real legislation. Official samples (URL, consultation date, version)
 * are added to `OFFICIAL_SAMPLES` only after the sources were consulted one by one; see docs/anatomy/CONFIG-01.md.
 */
export interface SampleInput {
  /** Entry id (one per document version shown on screen). */
  id: string;
  /** Stable document identity and its version label. A passage correction is bound to documentId + the SHA-256 of this version's content. */
  documentId: string; version: string;
  title: string; source: 'CONFAZ' | 'DOU' | 'DOE-SP' | 'RFB'; family: string | null;
  format: 'html' | 'text'; content: string;
  provenance: { kind: 'synthetic'; note: string } | { kind: 'official'; url: string; consultedAt: string; version: string; reason: string };
  /** What this sample exercises (why it is in the set). */
  covers: string[];
}
const synthetic = (note: string) => ({ kind: 'synthetic' as const, note });

export const SYNTHETIC_SAMPLES: readonly SampleInput[] = Object.freeze([
  { id: 'sint-confaz-convenio', documentId: 'sint-confaz-convenio', version: 'v1', title: 'Convênio ICMS fictício com redação anterior e nota de alteração', source: 'CONFAZ', family: null, format: 'html',
    provenance: synthetic('Convênio inventado no formato HTML do CONFAZ (classes de estilo por bloco).'),
    covers: ['estilos do CONFAZ', 'redação anterior', 'nota de alteração', 'NCM no texto'],
    content: '<html><body><p class="TituloAcordo">CONVÊNIO ICMS EXEMPLO Nº 901, DE 4 DE MAIO DE 2099</p>'
      + '<p class="Ementa">Altera o Convênio ICMS Exemplo nº 900, que trata de equipamentos de teste.</p>'
      + '<p class="TextoAcordo">O Conselho Nacional de Política Fazendária, na sua 999ª reunião, resolve celebrar o seguinte</p>'
      + '<p class="TextoAcordo">Cláusula primeira Fica reduzida a base de cálculo nas saídas dos produtos da NCM 9031.80.99.</p>'
      + '<p class="Remisso">Nova redação dada à cláusula primeira pelo Conv. ICMS Exemplo 950/99.</p>'
      + '<p class="RedaoAnt">Cláusula primeira Fica reduzida a base de cálculo nas saídas dos produtos da NCM 9031.80.00.</p>'
      + '<p class="TextoAcordo">Cláusula segunda Este convênio entra em vigor na data da publicação.</p>'
      + '<p class="TextoAcordo">Presidente do CONFAZ - Fulano Exemplo</p></body></html>' },
  { id: 'sint-confaz-convenio-v2', documentId: 'sint-confaz-convenio', version: 'v2', title: 'Convênio ICMS fictício — versão 2 (assinatura e vigência alteradas)', source: 'CONFAZ', family: null, format: 'html',
    provenance: synthetic('Segunda versão inventada do mesmo convênio: a assinatura e a cláusula de vigência mudaram.'),
    covers: ['documento modificado', 'correção pontual desatualizada'],
    content: '<html><body><p class="TituloAcordo">CONVÊNIO ICMS EXEMPLO Nº 901, DE 4 DE MAIO DE 2099</p>'
      + '<p class="Ementa">Altera o Convênio ICMS Exemplo nº 900, que trata de equipamentos de teste.</p>'
      + '<p class="TextoAcordo">O Conselho Nacional de Política Fazendária, na sua 999ª reunião, resolve celebrar o seguinte</p>'
      + '<p class="TextoAcordo">Cláusula primeira Fica reduzida a base de cálculo nas saídas dos produtos da NCM 9031.80.99.</p>'
      + '<p class="Remisso">Nova redação dada à cláusula primeira pelo Conv. ICMS Exemplo 950/99.</p>'
      + '<p class="RedaoAnt">Cláusula primeira Fica reduzida a base de cálculo nas saídas dos produtos da NCM 9031.80.00.</p>'
      + '<p class="TextoAcordo">Cláusula segunda Este convênio entra em vigor no primeiro dia do mês seguinte.</p>'
      + '<p class="TextoAcordo">Presidente do CONFAZ - Beltrano Exemplo</p></body></html>' },
  { id: 'sint-confaz-convenio-outro', documentId: 'sint-confaz-convenio-outro', version: 'v1', title: 'Outro convênio fictício com a mesma assinatura', source: 'CONFAZ', family: null, format: 'html',
    provenance: synthetic('Outro convênio inventado, semelhante ao primeiro, com a mesma linha de assinatura no estilo do corpo.'),
    covers: ['documento semelhante', 'correção pontual não se estende a outros atos'],
    content: '<html><body><p class="TituloAcordo">CONVÊNIO ICMS EXEMPLO Nº 902, DE 4 DE MAIO DE 2099</p>'
      + '<p class="Ementa">Autoriza procedimento fictício de teste.</p>'
      + '<p class="TextoAcordo">Cláusula primeira Fica autorizado o procedimento de teste.</p>'
      + '<p class="TextoAcordo">Cláusula segunda Este convênio entra em vigor na data da publicação.</p>'
      + '<p class="TextoAcordo">Presidente do CONFAZ - Fulano Exemplo</p></body></html>' },
  { id: 'sint-dou-portaria', documentId: 'sint-dou-portaria', version: 'v1', title: 'Portaria fictícia no DOU com texto citado (NR)', source: 'DOU', family: null, format: 'html',
    provenance: synthetic('Portaria inventada no formato HTML do DOU (identifica/ementa/assina).'),
    covers: ['estilos do DOU', 'texto que altera outro ato (NR)', 'citação de outro ato', 'assinatura'],
    content: '<html><body><p class="identifica">PORTARIA EXEMPLO Nº 77, DE 2 DE JANEIRO DE 2099</p>'
      + '<p class="ementa">Altera a Portaria Exemplo nº 10, de 2090.</p>'
      + '<p>O Secretário Exemplo, no uso das atribuições, resolve:</p>'
      + '<p>Art. 1º A Portaria Exemplo nº 10, de 2090, passa a vigorar com a seguinte alteração:</p>'
      + '<p>"Art. 5º O prazo de entrega é de trinta dias." (NR)</p>'
      + '<p>Art. 2º Aplica-se o disposto no art. 3º da Lei Exemplo nº 1.234, de 2080.</p>'
      + '<p>Art. 3º Esta Portaria entra em vigor na data de sua publicação.</p>'
      + '<p class="assina">FULANO EXEMPLO</p><p class="cargo">Secretário Exemplo</p></body></html>' },
  { id: 'sint-dou-retificacao', documentId: 'sint-dou-retificacao', version: 'v1', title: 'Retificação fictícia no DOU (Onde se lê / Leia-se)', source: 'DOU', family: null, format: 'html',
    provenance: synthetic('Retificação inventada.'),
    covers: ['retificação', 'texto original e texto corrigido'],
    content: '<html><body><p class="identifica">RETIFICAÇÃO</p>'
      + '<p>Na Portaria Exemplo nº 77, de 2 de janeiro de 2099, publicada no DOU fictício de 3 de janeiro de 2099:</p>'
      + '<p>Onde se lê: "trinta dias"</p><p>Leia-se: "quarenta dias"</p></body></html>' },
  { id: 'sint-rfb-in-tabela', documentId: 'sint-rfb-in-tabela', version: 'v1', title: 'Instrução Normativa fictícia da RFB com tabela de NCM e exceção', source: 'RFB', family: null, format: 'html',
    provenance: synthetic('Instrução normativa inventada com anexo em tabela.'),
    covers: ['tabela com coluna NCM', 'faixa de códigos', 'exceção', 'anexo'],
    content: '<html><body><p>INSTRUÇÃO NORMATIVA EXEMPLO Nº 3.001, DE 5 DE JUNHO DE 2099</p>'
      + '<p>Art. 1º Ficam sujeitos ao regime os produtos relacionados no Anexo, exceto os da NCM 8471.30.19.</p>'
      + '<p>Art. 2º O regime abrange os códigos 8471.30.11 a 8471.30.13.</p>'
      + '<p>ANEXO</p><table><tr><th>Item</th><th>NCM</th><th>Descrição</th></tr>'
      + '<tr><td>1</td><td>8471.30.12</td><td>Equipamento de teste portátil</td></tr>'
      + '<tr><td>2</td><td>9031.80.99</td><td>Instrumento de medida fictício</td></tr></table></body></html>' },
  { id: 'sint-doe-sp-resolucao', documentId: 'sint-doe-sp-resolucao', version: 'v1', title: 'Resolução fictícia no DOE-SP em texto corrido', source: 'DOE-SP', family: null, format: 'text',
    provenance: synthetic('Resolução inventada em texto simples (sem estilos).'),
    covers: ['texto sem marcação', 'considerandos', 'parágrafos', 'revogação'],
    content: 'RESOLUÇÃO SFP EXEMPLO Nº 15, DE 9 DE JULHO DE 2099\n'
      + 'Disciplina procedimentos fictícios de teste.\n'
      + 'O Secretário da Fazenda Exemplo, considerando a necessidade de testes, resolve:\n'
      + 'Artigo 1º Os contribuintes observarão o disposto nesta resolução.\n'
      + 'Parágrafo único. O disposto neste artigo não se aplica a operações internas.\n'
      + 'Artigo 2º Fica revogada a Resolução SFP Exemplo nº 2, de 2090.\n'
      + 'Artigo 3º Esta resolução entra em vigor na data de sua publicação.\n' },
  { id: 'sint-confaz-estilo-novo', documentId: 'sint-confaz-estilo-novo', version: 'v1', title: 'Ajuste fictício do CONFAZ com estilo de nota não reconhecido', source: 'CONFAZ', family: null, format: 'html',
    provenance: synthetic('Ajuste inventado que usa um estilo de nota fora da configuração de fábrica ("NotaAlteracao").'),
    covers: ['estilo desconhecido', 'caso para configurar'],
    content: '<html><body><p class="TituloAcordo">AJUSTE SINIEF EXEMPLO Nº 44, DE 1º DE AGOSTO DE 2099</p>'
      + '<p class="Ementa">Altera o Ajuste SINIEF Exemplo nº 40.</p>'
      + '<p class="TextoAcordo">Cláusula primeira O prazo passa a ser de dez dias.</p>'
      + '<p class="NotaAlteracao">Acrescentado pelo Ajuste SINIEF Exemplo 45/99, efeitos a partir de 01.09.99.</p>'
      + '<p class="TextoAcordo">Cláusula segunda Este ajuste entra em vigor na data da publicação.</p></body></html>' },
]);
