/**
 * ANAT-CONFIG-01: the AI's reading of the SYNTHETIC samples (sample-inputs.ts), passage by passage, with the textual
 * evidence it relied on and an explicit SECOND CHECK by the same AI session. The second check is a re-reading, not an
 * independent review, and does not turn these samples into gold. Three dimensions are kept apart:
 *  - structure: what the passage is in the act's skeleton (epígrafe, cláusula, artigo, anexo...);
 *  - nature: what kind of text it is (dispositivo do ato, redação anterior, nota editorial, texto que altera outro ato,
 *    elemento estrutural, ou ambíguo);
 *  - validity: the legal status. Notes such as "Nova redação dada…" or "Acrescentado pelo…" do NOT decide, on their
 *    own, the validity of the provision they accompany: validity stays "not_determined" unless the act itself says so.
 */
export type Nature = 'operative' | 'historical' | 'editorial_note' | 'amendment' | 'structure' | 'ambiguous';
export type Validity = 'not_determined' | 'current' | 'repealed' | 'replaced';
export interface Annotation {
  /** The passage is the engine part whose text starts with this anchor (after trimming). */
  anchor: string;
  structure: string; nature: Nature; validity: Validity;
  evidence: string; explanation: string;
  references?: string[];
  /** Set when the AI could not decide; the nature is then 'ambiguous' and this says why. */
  ambiguity?: string;
  secondCheck: { agrees: boolean; note: string };
}
const ok = (note = 'Releitura confirma a leitura inicial.') => ({ agrees: true, note });

const BASE: Record<string, readonly Annotation[]> = {
  'sint-confaz-convenio': [
    { anchor: 'CONVÊNIO ICMS EXEMPLO', structure: 'Epígrafe', nature: 'structure', validity: 'not_determined',
      evidence: 'estilo "TituloAcordo"; texto "CONVÊNIO ICMS EXEMPLO Nº 901, DE 4 DE MAIO DE 2099"',
      explanation: 'Título que identifica o ato; não é dispositivo.', secondCheck: ok() },
    { anchor: 'Altera o Convênio', structure: 'Ementa', nature: 'structure', validity: 'not_determined',
      evidence: 'estilo "Ementa"', explanation: 'Resumo do ato; não tem efeito normativo próprio.', references: ['Convênio ICMS Exemplo nº 900'], secondCheck: ok() },
    { anchor: 'O Conselho Nacional', structure: 'Preâmbulo', nature: 'structure', validity: 'not_determined',
      evidence: 'início "O Conselho"', explanation: 'Fórmula de abertura do órgão que edita o ato.', secondCheck: ok() },
    { anchor: 'Cláusula primeira Fica reduzida a base de cálculo nas saídas dos produtos da NCM 9031.80.99', structure: 'Cláusula primeira', nature: 'operative', validity: 'not_determined',
      evidence: 'rótulo "Cláusula primeira"; estilo "TextoAcordo"', explanation: 'Dispositivo do ato na redação atual do texto. A nota que segue indica alteração, mas não prova vigência.', secondCheck: ok() },
    { anchor: 'Nova redação dada', structure: 'Nota de alteração', nature: 'editorial_note', validity: 'not_determined',
      evidence: 'estilo "Remisso"; texto "Nova redação dada à cláusula primeira pelo Conv. ICMS Exemplo 950/99"',
      explanation: 'Nota do editor que registra a origem da redação. Não é texto normativo e, sozinha, não decide a vigência da cláusula.', references: ['Conv. ICMS Exemplo 950/99'], secondCheck: ok() },
    { anchor: 'Cláusula primeira Fica reduzida a base de cálculo nas saídas dos produtos da NCM 9031.80.00', structure: 'Cláusula primeira (redação anterior)', nature: 'historical', validity: 'replaced',
      evidence: 'estilo "RedaoAnt"; mesmo rótulo da cláusula vigente logo após a nota "Nova redação dada…"',
      explanation: 'Redação anterior mantida para consulta. O NCM 9031.80.00 nela não deve ser tratado como atual.',
      secondCheck: { agrees: true, note: 'Releitura confirma histórico. Divergência registrada: na primeira leitura a vigência foi marcada "não determinada"; a segunda conferência marcou "substituída" porque o próprio texto traz a nova redação logo acima. Mantido "substituída" só para este trecho histórico.' } },
    { anchor: 'Cláusula segunda', structure: 'Cláusula segunda', nature: 'operative', validity: 'not_determined',
      evidence: 'rótulo "Cláusula segunda"', explanation: 'Cláusula de vigência do próprio ato.', secondCheck: ok() },
    { anchor: 'Presidente do CONFAZ', structure: 'Assinatura', nature: 'structure', validity: 'not_determined',
      evidence: 'nome e cargo ao final; estilo "TextoAcordo" (o mesmo do corpo)',
      explanation: 'Assinatura. O motor trata como corpo porque o estilo é o mesmo do texto; não há palavra que a separe com segurança.',
      ambiguity: 'O estilo é igual ao do corpo; separar assinatura exigiria regra por posição, que a configuração não oferece.',
      secondCheck: { agrees: true, note: 'Mantido como caso para conferência: a IA não propõe regra porque "Presidente" também pode iniciar um dispositivo.' } },
  ],
  'sint-confaz-convenio-outro': [
    { anchor: 'CONVÊNIO ICMS EXEMPLO', structure: 'Epígrafe', nature: 'structure', validity: 'not_determined', evidence: 'estilo "TituloAcordo"', explanation: 'Identificação do ato.', secondCheck: ok() },
    { anchor: 'Autoriza procedimento', structure: 'Ementa', nature: 'structure', validity: 'not_determined', evidence: 'estilo "Ementa"', explanation: 'Resumo do ato.', secondCheck: ok() },
    { anchor: 'Cláusula primeira', structure: 'Cláusula primeira', nature: 'operative', validity: 'not_determined', evidence: 'rótulo "Cláusula primeira"', explanation: 'Dispositivo do ato.', secondCheck: ok() },
    { anchor: 'Cláusula segunda', structure: 'Cláusula segunda', nature: 'operative', validity: 'not_determined', evidence: 'rótulo "Cláusula segunda"', explanation: 'Cláusula de vigência.', secondCheck: ok() },
    { anchor: 'Presidente do CONFAZ', structure: 'Assinatura', nature: 'structure', validity: 'not_determined', evidence: 'nome e cargo ao final; estilo "TextoAcordo"',
      explanation: 'Assinatura com o mesmo estilo do corpo, como no Convênio 901.', ambiguity: 'O estilo é igual ao do corpo; a configuração não tem regra por posição.',
      secondCheck: { agrees: true, note: 'Mantido para conferência. Uma correção feita no Convênio 901 não vale para este ato.' } },
  ],
  'sint-dou-portaria': [
    { anchor: 'PORTARIA EXEMPLO', structure: 'Epígrafe', nature: 'structure', validity: 'not_determined', evidence: 'estilo "identifica"', explanation: 'Identificação do ato.', secondCheck: ok() },
    { anchor: 'Altera a Portaria', structure: 'Ementa', nature: 'structure', validity: 'not_determined', evidence: 'estilo "ementa"', explanation: 'Resumo do ato.', references: ['Portaria Exemplo nº 10, de 2090'], secondCheck: ok() },
    { anchor: 'O Secretário Exemplo', structure: 'Preâmbulo', nature: 'structure', validity: 'not_determined', evidence: 'início "O Secretário"', explanation: 'Fórmula de abertura.', secondCheck: ok() },
    { anchor: 'Art. 1º', structure: 'Art. 1º', nature: 'operative', validity: 'not_determined', evidence: 'rótulo "Art. 1º"',
      explanation: 'Dispositivo que altera outro ato. O texto entre aspas que segue pertence ao ato alterado.', references: ['Portaria Exemplo nº 10, de 2090'], secondCheck: ok() },
    { anchor: '"Art. 5º', structure: 'Texto citado (NR)', nature: 'amendment', validity: 'not_determined',
      evidence: 'abre com aspas e termina com "(NR)"', explanation: 'Nova redação de outro ato. Não é dispositivo desta portaria e não deve ser lido como norma dela.', secondCheck: ok() },
    { anchor: 'Art. 2º', structure: 'Art. 2º', nature: 'operative', validity: 'not_determined', evidence: 'rótulo "Art. 2º"; "Aplica-se o disposto no art. 3º da Lei…"',
      explanation: 'Dispositivo do ato que remete a outra norma.', references: ['art. 3º da Lei Exemplo nº 1.234, de 2080'], secondCheck: ok() },
    { anchor: 'Art. 3º', structure: 'Art. 3º', nature: 'operative', validity: 'not_determined', evidence: 'rótulo "Art. 3º"', explanation: 'Cláusula de vigência.', secondCheck: ok() },
    { anchor: 'FULANO EXEMPLO', structure: 'Assinatura', nature: 'structure', validity: 'not_determined', evidence: 'estilo "assina"', explanation: 'Assinatura.', secondCheck: ok() },
    { anchor: 'Secretário Exemplo', structure: 'Cargo do signatário', nature: 'structure', validity: 'not_determined', evidence: 'estilo "cargo"', explanation: 'Cargo de quem assina.', secondCheck: ok() },
  ],
  'sint-dou-retificacao': [
    { anchor: 'RETIFICAÇÃO', structure: 'Epígrafe', nature: 'structure', validity: 'not_determined', evidence: 'estilo "identifica"', explanation: 'Título da retificação.', secondCheck: ok() },
    { anchor: 'Na Portaria Exemplo', structure: 'Indicação do ato retificado', nature: 'structure', validity: 'not_determined',
      evidence: 'início "Na Portaria … publicada no DOU"', explanation: 'Diz qual ato é corrigido. O motor não reconhece este bloco.',
      references: ['Portaria Exemplo nº 77, de 2 de janeiro de 2099'],
      ambiguity: 'Não há palavra fixa que abra este bloco em todas as retificações ("Na Portaria", "No Decreto", "Na Resolução"…); uma regra por início de texto seria ampla demais.',
      secondCheck: { agrees: true, note: 'Mantido para conferência; a IA não sugere regra automática.' } },
    { anchor: 'Onde se lê', structure: 'Texto original', nature: 'amendment', validity: 'replaced', evidence: 'início "Onde se lê"', explanation: 'Texto errado que a retificação substitui.', secondCheck: ok() },
    { anchor: 'Leia-se', structure: 'Texto corrigido', nature: 'amendment', validity: 'not_determined', evidence: 'início "Leia-se"', explanation: 'Texto correto do ato retificado.', secondCheck: ok() },
  ],
  'sint-rfb-in-tabela': [
    { anchor: 'INSTRUÇÃO NORMATIVA EXEMPLO', structure: 'Epígrafe', nature: 'structure', validity: 'not_determined',
      evidence: 'texto em caixa alta no início, sem estilo', explanation: 'Identificação do ato. O motor não reconhece porque o HTML não traz estilo de epígrafe.',
      ambiguity: 'Sem estilo, só a posição e a caixa alta indicam a epígrafe; a configuração atual não tem regra por posição.',
      secondCheck: { agrees: true, note: 'Mantido para conferência.' } },
    { anchor: 'Art. 1º', structure: 'Art. 1º', nature: 'operative', validity: 'not_determined', evidence: 'rótulo "Art. 1º"; "exceto os da NCM 8471.30.19"',
      explanation: 'Dispositivo com exceção: o NCM 8471.30.19 está excluído, não incluído.', secondCheck: ok() },
    { anchor: 'Art. 2º', structure: 'Art. 2º', nature: 'operative', validity: 'not_determined', evidence: '"8471.30.11 a 8471.30.13"',
      explanation: 'Faixa de códigos.',
      secondCheck: { agrees: false, note: 'Divergência registrada: a primeira leitura tratou os dois códigos como itens isolados; a releitura identificou faixa ("a"). O motor também não marca faixa aqui; fica para conferência.' } },
    { anchor: 'ANEXO', structure: 'Título do anexo', nature: 'structure', validity: 'not_determined', evidence: 'palavra "ANEXO" isolada',
      explanation: 'Abre o anexo. O motor não reconhece o rótulo "ANEXO" quando está sozinho num parágrafo sem estilo.', secondCheck: ok() },
    { anchor: 'Item', structure: 'Tabela do anexo', nature: 'operative', validity: 'not_determined', evidence: 'cabeçalho "Item | NCM | Descrição"',
      explanation: 'Tabela de produtos; a coluna "NCM" é reconhecida pela configuração de fábrica.', secondCheck: ok() },
  ],
  'sint-doe-sp-resolucao': [
    { anchor: 'RESOLUÇÃO SFP EXEMPLO', structure: 'Ato inteiro (texto corrido)', nature: 'ambiguous', validity: 'not_determined',
      evidence: 'texto sem marcação; rótulos "Artigo 1º", "Parágrafo único."',
      explanation: 'A IA identifica epígrafe, ementa, preâmbulo, três artigos e um parágrafo único, mas o motor atual não segmenta texto corrido do DOE-SP.',
      ambiguity: 'Limitação do motor, não da configuração: nenhuma regra desta tela faz o texto simples ser dividido.',
      secondCheck: { agrees: true, note: 'Confirmado como limitação conhecida. O "Fica revogada" do art. 2º revoga OUTRO ato; não muda a vigência desta resolução.' } },
  ],
  'sint-confaz-estilo-novo': [
    { anchor: 'AJUSTE SINIEF EXEMPLO', structure: 'Epígrafe', nature: 'structure', validity: 'not_determined', evidence: 'estilo "TituloAcordo"', explanation: 'Identificação do ato.', secondCheck: ok() },
    { anchor: 'Altera o Ajuste', structure: 'Ementa', nature: 'structure', validity: 'not_determined', evidence: 'estilo "Ementa"', explanation: 'Resumo.', secondCheck: ok() },
    { anchor: 'Cláusula primeira', structure: 'Cláusula primeira', nature: 'operative', validity: 'not_determined', evidence: 'rótulo "Cláusula primeira"',
      explanation: 'Dispositivo. A nota "Acrescentado pelo…" que segue não decide sozinha a vigência desta cláusula.', secondCheck: ok() },
    { anchor: 'Acrescentado pelo', structure: 'Nota de alteração', nature: 'editorial_note', validity: 'not_determined',
      evidence: 'estilo "NotaAlteracao"; texto "Acrescentado pelo Ajuste SINIEF Exemplo 45/99, efeitos a partir de 01.09.99"',
      explanation: 'Nota do editor. Sugestão: tratar o estilo "NotaAlteracao" como nota editorial nos atos do CONFAZ.', references: ['Ajuste SINIEF Exemplo 45/99'], secondCheck: ok() },
    { anchor: 'Cláusula segunda', structure: 'Cláusula segunda', nature: 'operative', validity: 'not_determined', evidence: 'rótulo "Cláusula segunda"', explanation: 'Cláusula de vigência.', secondCheck: ok() },
  ],
};
/** The second version of the convênio is read like the first (same structure); its own text decides the match. */
export const SAMPLE_ANNOTATIONS: Readonly<Record<string, readonly Annotation[]>> = Object.freeze({ ...BASE, 'sint-confaz-convenio-v2': BASE['sint-confaz-convenio']! });
