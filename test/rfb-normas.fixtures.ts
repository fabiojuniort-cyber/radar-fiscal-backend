export const RFB_SEARCH_FIXTURE = `<!doctype html><html><body>
<div>Total de atos localizados: 5</div><div>Página 1 de 1</div>
<table><tbody>
<tr><td><a href="https://normasinternet2.receita.fazenda.gov.br/#/consulta/externa/150001">Instrução Normativa</a></td><td>2.344</td><td>RFB</td><td>23/09/2026</td><td>Altera regras de tributação federal e obrigações acessórias.</td></tr>
<tr><td><a href="https://normasinternet2.receita.fazenda.gov.br/#/consulta/externa/150002">Solução de Consulta</a></td><td>180</td><td>Cosit</td><td>23/09/2026</td><td>Assunto: Cofins. Crédito presumido de ICMS. Não incidência.</td></tr>
<tr><td><a href="https://normasinternet2.receita.fazenda.gov.br/#/consulta/externa/150003">Portaria</a></td><td>732</td><td>RFB</td><td>23/09/2026</td><td>Suspende temporariamente as atividades da Agência da Receita Federal do Brasil que especifica.</td></tr>
<tr><td><a href="https://normasinternet2.receita.fazenda.gov.br/#/consulta/externa/150004">Ato Declaratório Executivo</a></td><td>123</td><td>Coana</td><td>23/09/2026</td><td>Certifica como Operador Econômico Autorizado a pessoa jurídica que especifica.</td></tr>
<tr><td><a href="https://normasinternet2.receita.fazenda.gov.br/#/consulta/externa/150005">Ato Declaratório Executivo</a></td><td>99</td><td>Cofis</td><td>23/09/2026</td><td>Dispõe sobre obrigação acessória DCTF e procedimento de declaração.</td></tr>
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
