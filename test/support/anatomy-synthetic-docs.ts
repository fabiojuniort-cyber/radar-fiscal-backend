import type { AnatomyRequest } from '../../src/modules/anatomy/engine.js';

/**
 * SYNTHETIC documents for the P1.B equivalence check. They exercise every rule moved into the profile (classes,
 * block starts, quotes, labels, NCM headers/blockers/markers, list tokens, range operators, exception markers) and
 * the fixed protections. No corpus entry, reserve item or official source is used.
 */
const req = (id: string, source: AnatomyRequest['input']['source'], html: string, codes: string[] = []): { id: string; request: AnatomyRequest } => ({ id,
  request: { publicationVersionId: `synthetic-${id}`, referenceDate: '2026-10-19', ruleSet: { id: 'synthetic', version: '1' },
    input: { source, representationId: `synthetic://${id}`, html }, ...(codes.length ? { catalog: { edition: 'synthetic-2026', codes } } : {}) } });

export const SYNTHETIC_DOCS: { id: string; request: AnatomyRequest }[] = [
  req('confaz-classes', 'CONFAZ', '<p class="TituloAcordo">CONVÊNIO ICMS 1/26</p><p class="Ementa">Dispõe sobre algo.</p>'
    + '<p class="DataPublicao">Publicado no DOU de 1.1.26</p><p class="TextoAcordo">O Conselho Nacional de Política Fazendária resolve:</p>'
    + '<p class="TextoAcordo">Cláusula primeira Fica reduzida a base NCM 8471.30.12 e 8471.41.00.</p>'
    + '<p class="Remisso">Nova redação dada pelo Conv. ICMS 2/26.</p><p class="RedaoAnt">Cláusula segunda Redação anterior NCM 8450.11.00.</p>'
    + '<p class="RemissoAnt">Redação anterior dada pelo Conv. ICMS 3/26.</p><p class="A5-1TextoAcordo">Clausula terceira Texto NCM 0101.21.00.</p>',
  ['84713012', '84714100', '84501100', '01012100']),
  req('confaz-annex-table', 'CONFAZ', '<p class="TextoAcordo">Cláusula primeira Ver anexo.</p><p class="TextoAcordo">ANEXO I</p>'
    + '<table><tr><td>ITEM</td><td>DESCRIÇÃO</td><td>NCM/SH</td></tr><tr><td>1</td><td>Máquina</td><td>8471.30.12</td></tr>'
    + '<tr><td>2</td><td>Outra</td><td>8471.41.00 a 8471.49.00</td></tr><tr><td colspan="2">Nota</td><td>8471.50.00</td></tr></table>'
    + '<p class="RedaoAnt">ANEXO II</p><table><tr><td>CÓDIGO NCM</td></tr><tr><td>7307.19.20</td></tr></table>',
  ['84713012', '84714100', '84714900', '84715000', '73071920']),
  req('confaz-headers-blockers', 'CONFAZ', '<table><tr><td>NCM / SH</td><td>NBM/SH</td><td>TIPI</td><td>CODIGO NCM/SH</td><td>CÓDIGO</td></tr>'
    + '<tr><td>8471.30.12</td><td>8471.30.1200</td><td>8471.30.12</td><td>0101.21.00</td><td>9999</td></tr></table>', ['84713012', '01012100']),
  req('dou-classes', 'DOU', '<p class="identifica">PORTARIA Nº 1</p><p class="ementa">Dispõe sobre algo.</p>'
    + '<p>O MINISTRO DE ESTADO resolve:</p><p>Art. 1º Fica incluído o NCM 8471.30.12.</p><p>Parágrafo único. Texto.</p>'
    + '<p>§ 1º Outro texto.</p><p>I - inciso;</p><p>a) alínea;</p><p class="assina">FULANO</p><p class="cargo">Ministro</p>', ['84713012']),
  req('dou-rectification', 'DOU', '<p class="identifica">RETIFICAÇÃO</p><p>Na Portaria nº 1, onde se lê o texto, fazer constar:</p>'
    + '<p>Onde se lê "NCM 8471.30.12",</p><p>Onde se le "outro",</p><p>Leia-se "NCM 8471.41.00", mantidas as demais.</p>'
    + '<p>Leia-seguinte não é retificação.</p>', ['84713012', '84714100']),
  req('quotes', 'DOU', '<p>Art. 1º A Instrução Normativa passa a vigorar com:</p><p>"Art. 5º Texto citado NCM 8471.30.12.</p>'
    + '<p>§ 1º Continua citado." (NR)</p><p>Art. 2º Texto próprio NCM 8471.41.00.</p><p>“Art. 6º Outro citado.”</p><p>"</p><p>Art. 3º Depois.</p>',
  ['84713012', '84714100']),
  req('preamble-variants', 'DOE-SP', '<p>O Secretário da Fazenda resolve:</p><p>O Secretario sem acento resolve:</p><p>A Secretária decide:</p>'
    + '<p>A Receita Federal informa:</p><p>CONSIDERANDO que algo;</p><p>O Governador decreta:</p><p>O Presidente determina:</p>'
    + '<p>O Ministro manda:</p><p>Artigo 1º Texto.</p><p>ANEXO 2 - Tabela</p><p>Anexo citado no meio da frase.</p>'),
  req('lists-tokens', 'RFB', '<p>Art. 1º Aplica-se aos NCM 8471.30.12, 8471.41.00 e 8471.49.00, ou 8471.50.00.</p>'
    + '<p>Art. 2º NCM códigos: 8471.30.12 até 8471.49.00 inclusive.</p><p>Art. 3º NCM nº 8471.30.12 ate 8471.41.00 de 2026.</p>'
    + '<p>Art. 4º NCM 8471.30.12 - 8471.41.00 – 8471.49.00.</p><p>Art. 5º NCM 8471.30.12 exceto 8471.41.00.</p>',
  ['84713012', '84714100', '84714900', '84715000']),
  req('exceptions', 'CONFAZ', '<p class="TextoAcordo">Cláusula primeira NCM 8471.30.12, 8471.41.00, excetuados 8471.41.00 e 8471.49.00.</p>'
    + '<p class="TextoAcordo">Cláusula segunda NCM 8471.30.12, salvo os de uso doméstico.</p>'
    + '<p class="TextoAcordo">Cláusula terceira NCM 8471.30.12 exclusive 8471.50.00.</p>'
    + '<p class="TextoAcordo">Cláusula quarta NCM 8471.30.12, excluídos 8471.41.00, excluidas as demais.</p>',
  ['84713012', '84714100', '84714900', '84715000']),
  req('protections', 'RFB', '<p>Art. 1º Processo SEI nº 12345.678901/2026-12, CNPJ 12.345.678/0001-90, CEP 01234-567, '
    + 'Lei nº 8.137, de 27 de dezembro de 1990, art. 3º, NCM 8471.30.12, NBM 8471.30.1200, CFOP 5102, CEST 01.001.00.</p>', ['84713012']),
  req('historical-ancestor', 'CONFAZ', '<div class="RedaoAnt"><p>Cláusula primeira NCM 8471.30.12.</p><table><tr><td>NCM</td></tr><tr><td>8471.41.00</td></tr></table></div>'
    + '<blockquote><p>Cláusula segunda NCM 8471.49.00.</p></blockquote>', ['84713012', '84714100', '84714900']),
  req('empty-and-plain', 'DOU', '<p></p><div><span>Texto solto sem marcador.</span></div>'),
];
