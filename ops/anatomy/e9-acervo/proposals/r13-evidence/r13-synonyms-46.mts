// R13 (EXEC, new): the four reviewer synonyms × genders/accents/case × 5 positions + own-content controls.
import { join } from 'node:path';
const root = process.argv[2]!;
const { readRfbInlineAttachments } = await import(join(root, 'src/modules/anatomy/rfb-inline-attachments.ts'));
const TABLE = '<table><tr><td>NCM</td><td>Descrição</td></tr><tr><td>2402.20.00</td><td>Cigarros</td></tr></table>';
const frag = Buffer.from(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${TABLE}</body></html>`).toString('base64');
const promotes = (art: string) => { const r = readRfbInlineAttachments(new TextEncoder().encode(JSON.stringify({ idAto: 900004, tiposSegmento: [{ idTipoSegmento: 3, siglaTipoSegmento: 'artigo' }],
  outrosSegmentos: [{ ordemSegmentoAto: 1, idTipoSegmento: 3, textoIntegra: `<p>${art}</p>` }, { ordemSegmentoAto: 2, idTipoSegmento: 3, arquivoBinario: { idArquivoBinario: 1, idTipoArquivo: 5, nomeArquivoBinario: 'T.html', arquivoBinario: frag } },
    { ordemSegmentoAto: 3, idTipoSegmento: 3, textoIntegra: '<p>Art. 2º A autorização fica condicionada à comprovação.</p>' }] })), 900004)[0]!;
  return { p: r.referenceContext === 'operative_candidate', legal: [...new Set(r.reading?.parts.map((x: any) => x.legalStatus) ?? [])] }; };
const cases: [string,'P'|'N',string][] = [
 ['multicitado | citação meio','N','Art. 1º Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, de 2022, as alíquotas do multicitado ato, conforme tabela a seguir:'],
 ['multicitado | citação início','N','Art. 1º Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas do multicitado ato, conforme tabela a seguir:'],
 ['multicitado | sem citação após frase comum','N','Art. 1º Aplica-se a Lei nº 9.532, de 1997. Ficam aprovadas as alíquotas do multicitado ato, conforme tabela a seguir:'],
 ['multicitado | sem citação após SRF.','N','Art. 1º Fica revogada a Instrução Normativa nº 52 da SRF. Ficam aprovadas as alíquotas do multicitado ato, conforme tabela a seguir:'],
 ['multicitado | sem nenhuma citação','N','Art. 1º Ficam aprovadas as alíquotas do multicitado ato, conforme tabela a seguir:'],
 ['multicitada | citação meio','N','Art. 1º Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, de 2022, as alíquotas da multicitada norma, conforme tabela a seguir:'],
 ['multicitada | citação início','N','Art. 1º Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas da multicitada norma, conforme tabela a seguir:'],
 ['multicitada | sem citação após frase comum','N','Art. 1º Aplica-se a Lei nº 9.532, de 1997. Ficam aprovadas as alíquotas da multicitada norma, conforme tabela a seguir:'],
 ['multicitada | sem citação após SRF.','N','Art. 1º Fica revogada a Instrução Normativa nº 52 da SRF. Ficam aprovadas as alíquotas da multicitada norma, conforme tabela a seguir:'],
 ['multicitada | sem nenhuma citação','N','Art. 1º Ficam aprovadas as alíquotas da multicitada norma, conforme tabela a seguir:'],
 ['em epígrafe | citação meio','N','Art. 1º Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, de 2022, as alíquotas da norma em epígrafe, conforme tabela a seguir:'],
 ['em epígrafe | citação início','N','Art. 1º Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas da norma em epígrafe, conforme tabela a seguir:'],
 ['em epígrafe | sem citação após frase comum','N','Art. 1º Aplica-se a Lei nº 9.532, de 1997. Ficam aprovadas as alíquotas da norma em epígrafe, conforme tabela a seguir:'],
 ['em epígrafe | sem citação após SRF.','N','Art. 1º Fica revogada a Instrução Normativa nº 52 da SRF. Ficam aprovadas as alíquotas da norma em epígrafe, conforme tabela a seguir:'],
 ['em epígrafe | sem nenhuma citação','N','Art. 1º Ficam aprovadas as alíquotas da norma em epígrafe, conforme tabela a seguir:'],
 ['em epigrafe (sem acento) | citação meio','N','Art. 1º Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, de 2022, as alíquotas da norma em epigrafe, conforme tabela a seguir:'],
 ['em epigrafe (sem acento) | citação início','N','Art. 1º Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas da norma em epigrafe, conforme tabela a seguir:'],
 ['em epigrafe (sem acento) | sem citação após frase comum','N','Art. 1º Aplica-se a Lei nº 9.532, de 1997. Ficam aprovadas as alíquotas da norma em epigrafe, conforme tabela a seguir:'],
 ['em epigrafe (sem acento) | sem citação após SRF.','N','Art. 1º Fica revogada a Instrução Normativa nº 52 da SRF. Ficam aprovadas as alíquotas da norma em epigrafe, conforme tabela a seguir:'],
 ['em epigrafe (sem acento) | sem nenhuma citação','N','Art. 1º Ficam aprovadas as alíquotas da norma em epigrafe, conforme tabela a seguir:'],
 ['em questão | citação meio','N','Art. 1º Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, de 2022, as alíquotas do ato em questão, conforme tabela a seguir:'],
 ['em questão | citação início','N','Art. 1º Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas do ato em questão, conforme tabela a seguir:'],
 ['em questão | sem citação após frase comum','N','Art. 1º Aplica-se a Lei nº 9.532, de 1997. Ficam aprovadas as alíquotas do ato em questão, conforme tabela a seguir:'],
 ['em questão | sem citação após SRF.','N','Art. 1º Fica revogada a Instrução Normativa nº 52 da SRF. Ficam aprovadas as alíquotas do ato em questão, conforme tabela a seguir:'],
 ['em questão | sem nenhuma citação','N','Art. 1º Ficam aprovadas as alíquotas do ato em questão, conforme tabela a seguir:'],
 ['em questao (sem acento) | citação meio','N','Art. 1º Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, de 2022, as alíquotas do ato em questao, conforme tabela a seguir:'],
 ['em questao (sem acento) | citação início','N','Art. 1º Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas do ato em questao, conforme tabela a seguir:'],
 ['em questao (sem acento) | sem citação após frase comum','N','Art. 1º Aplica-se a Lei nº 9.532, de 1997. Ficam aprovadas as alíquotas do ato em questao, conforme tabela a seguir:'],
 ['em questao (sem acento) | sem citação após SRF.','N','Art. 1º Fica revogada a Instrução Normativa nº 52 da SRF. Ficam aprovadas as alíquotas do ato em questao, conforme tabela a seguir:'],
 ['em questao (sem acento) | sem nenhuma citação','N','Art. 1º Ficam aprovadas as alíquotas do ato em questao, conforme tabela a seguir:'],
 ['em causa | citação meio','N','Art. 1º Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, de 2022, as alíquotas da norma em causa, conforme tabela a seguir:'],
 ['em causa | citação início','N','Art. 1º Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas da norma em causa, conforme tabela a seguir:'],
 ['em causa | sem citação após frase comum','N','Art. 1º Aplica-se a Lei nº 9.532, de 1997. Ficam aprovadas as alíquotas da norma em causa, conforme tabela a seguir:'],
 ['em causa | sem citação após SRF.','N','Art. 1º Fica revogada a Instrução Normativa nº 52 da SRF. Ficam aprovadas as alíquotas da norma em causa, conforme tabela a seguir:'],
 ['em causa | sem nenhuma citação','N','Art. 1º Ficam aprovadas as alíquotas da norma em causa, conforme tabela a seguir:'],
 ['Em Epígrafe (caixa) | citação meio','N','Art. 1º Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, de 2022, as alíquotas da norma Em Epígrafe, conforme tabela a seguir:'],
 ['Em Epígrafe (caixa) | citação início','N','Art. 1º Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas da norma Em Epígrafe, conforme tabela a seguir:'],
 ['Em Epígrafe (caixa) | sem citação após frase comum','N','Art. 1º Aplica-se a Lei nº 9.532, de 1997. Ficam aprovadas as alíquotas da norma Em Epígrafe, conforme tabela a seguir:'],
 ['Em Epígrafe (caixa) | sem citação após SRF.','N','Art. 1º Fica revogada a Instrução Normativa nº 52 da SRF. Ficam aprovadas as alíquotas da norma Em Epígrafe, conforme tabela a seguir:'],
 ['Em Epígrafe (caixa) | sem nenhuma citação','N','Art. 1º Ficam aprovadas as alíquotas da norma Em Epígrafe, conforme tabela a seguir:'],
 ['CTL próprio','P','Art. 1º Ficam aprovadas as alíquotas de referência, conforme tabela a seguir:'],
 ['CTL fundamento próprio','P','Art. 1º Nos termos da Lei nº 9.532, de 1997, ficam aprovadas as alíquotas de referência, conforme tabela a seguir:'],
 ['CTL nesta Portaria','P','Art. 1º Ficam aprovadas, nos termos da Lei nº 9.532, de 1997, as alíquotas previstas nesta Portaria, conforme tabela a seguir:'],
 ['CTL epígrafe do próprio ato (palavra isolada)','P','Art. 1º Ficam aprovadas as alíquotas de referência indicadas na epígrafe desta Portaria, conforme tabela a seguir:'],
 ['CTL questão (sem "em")','P','Art. 1º Ficam aprovadas as alíquotas de referência para a questão tarifária, conforme tabela a seguir:'],
 ['CTL causa (sem "em")','P','Art. 1º Ficam aprovadas as alíquotas de referência, por causa da demanda sazonal, conforme tabela a seguir:'],
];
let d=0; const legal=new Set<string>();
for (const [n,e,a] of cases){ const r=promotes(a); r.legal.forEach((x:string)=>legal.add(x)); const g=r.p?'P':'N'; if(g!==e) d++; console.log(`${g===e?'ok':'DIV'} ${e}/${g} ${n}`); }
console.log(`divergências ${d} / ${cases.length}; legalStatus ${[...legal].join(',')}`);
