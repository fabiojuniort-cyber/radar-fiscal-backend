import { join } from 'node:path';
const root = process.argv[2]!;
const { readRfbInlineAttachments } = await import(join(root, 'src/modules/anatomy/rfb-inline-attachments.ts'));
const TABLE = '<table><tr><td>NCM</td><td>Descrição</td></tr><tr><td>2402.20.00</td><td>Cigarros</td></tr></table>';
const frag = Buffer.from(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${TABLE}</body></html>`).toString('base64');
const promotes = (art: string) => { const r = readRfbInlineAttachments(new TextEncoder().encode(JSON.stringify({ idAto: 900004, tiposSegmento: [{ idTipoSegmento: 3, siglaTipoSegmento: 'artigo' }],
  outrosSegmentos: [{ ordemSegmentoAto: 1, idTipoSegmento: 3, textoIntegra: `<p>${art}</p>` }, { ordemSegmentoAto: 2, idTipoSegmento: 3, arquivoBinario: { idArquivoBinario: 1, idTipoArquivo: 5, nomeArquivoBinario: 'T.html', arquivoBinario: frag } },
    { ordemSegmentoAto: 3, idTipoSegmento: 3, textoIntegra: '<p>Art. 2º A autorização fica condicionada à comprovação.</p>' }] })), 900004)[0]!;
  return { p: r.referenceContext === 'operative_candidate', legal: [...new Set(r.reading?.parts.map((x: any) => x.legalStatus) ?? [])] }; };
const pre: [string,string][] = [['SRF.','Nos termos da IN SRF nº 1, de 2000, editada pela SRF.'],['RFB.','Aplica-se a Instrução Normativa nº 2.121 da RFB.'],['IN.','Aplicam-se as alíquotas da IN.'],['ponto','Aplica-se a Lei nº 9.532, de 1997.'],['PGFN.','Observa-se a Portaria Conjunta RFB/PGFN nº 1, da PGFN.']];
const mk: [string,string,string][] = [
 ['ali','as alíquotas ali previstas',''],['nela','as alíquotas nela fixadas',''],['lá','as alíquotas lá definidas',''],['supracitado','as alíquotas do supracitado ato',''],
 ['referido','as alíquotas previstas no referido ato',''],['seu Anexo','as alíquotas constantes de seu Anexo',''],['sobredita','as alíquotas da sobredita norma',''],['precitada','as alíquotas da norma precitada',''],
 ['retrocitada','as alíquotas da norma retrocitada',''],['em tela','as alíquotas da norma em tela',''],['em comento','as alíquotas do ato em comento',''],['susodito','as alíquotas do susodito ato',''],['anterior','as alíquotas do ato anterior',''],
];
const cases: [string,'P'|'N',string][] = [];
for (const [pn,p] of pre) for (const [mn,m] of mk) {
  cases.push([`${pn} meio ${mn}`,'N',`Art. 1º ${p} Ficam aprovadas ${m}, conforme tabela a seguir:`]);
  cases.push([`${pn} início ${mn}`,'N',`Art. 1º ${p} Nos termos do art. 2º, ficam aprovadas ${m}, conforme tabela a seguir:`]);
}
for (const [pn,p] of pre) {
  cases.push([`${pn} CTL próprio`,'P',`Art. 1º ${p} Ficam aprovadas as alíquotas de referência, conforme tabela a seguir:`]);
  cases.push([`${pn} CTL nesta Portaria`,'P',`Art. 1º ${p} Ficam aprovadas as alíquotas previstas nesta Portaria, conforme tabela a seguir:`]);
  cases.push([`${pn} R11-1 mencionadas nesta Portaria`,'P',`Art. 1º ${p} Ficam aprovadas as alíquotas mencionadas nesta Portaria, conforme tabela a seguir:`]);
  cases.push([`${pn} R11-2 seus campos`,'P',`Art. 1º ${p} Fica aprovada a tabela de alíquotas, com seus campos, conforme tabela a seguir:`]);
}
cases.push(['CTL sem frase anterior, seus campos','P','Art. 1º Fica aprovada a tabela de alíquotas, com seus campos, conforme tabela a seguir:']);
cases.push(['CTL "ficam aprovadas, nesta data, as alíquotas de referência"','P','Art. 1º Ficam aprovadas, nesta data, as alíquotas de referência, conforme tabela a seguir:']);
cases.push(['ANA Os demais + self','P','Art. 1º Aplica-se a Lei nº 9.532, de 1997. Os demais valores ficam fixados nesta Portaria, conforme tabela a seguir:']);
let d=0; const legal=new Set<string>();
for (const [n,e,a] of cases){ const r=promotes(a); r.legal.forEach((x:string)=>legal.add(x)); const g=r.p?'P':'N'; if(g!==e) d++; console.log(`${g===e?'ok':'DIV'} ${e}/${g} ${n}`); }
console.log(`divergências ${d} / ${cases.length}; legalStatus ${[...legal].join(',')}`);
