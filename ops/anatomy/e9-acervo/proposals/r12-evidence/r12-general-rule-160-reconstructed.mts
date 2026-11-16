// R12: general-rule matrix RECONSTRUCTED from the R11 review description (c.6930068067): the reviewer's g.mts (SHA-256 bafb3153…)
// was not published. 5 boundaries × 13 markers × resumption at the START and in the MIDDLE of the next sentence, plus the same
// markers in the SAME sentence as the citation, plus own-content controls at every boundary. Expected: N everywhere except controls.
import { join } from 'node:path';
const root = process.argv[2]!;
const { readRfbInlineAttachments } = await import(join(root, 'src/modules/anatomy/rfb-inline-attachments.ts'));
const TABLE = '<table><tr><td>NCM</td><td>Descrição</td></tr><tr><td>2402.20.00</td><td>Cigarros</td></tr></table>';
const frag = Buffer.from(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${TABLE}</body></html>`).toString('base64');
const promotes = (art: string) => { const r = readRfbInlineAttachments(new TextEncoder().encode(JSON.stringify({ idAto: 900004, tiposSegmento: [{ idTipoSegmento: 3, siglaTipoSegmento: 'artigo' }],
  outrosSegmentos: [{ ordemSegmentoAto: 1, idTipoSegmento: 3, textoIntegra: `<p>${art}</p>` }, { ordemSegmentoAto: 2, idTipoSegmento: 3, arquivoBinario: { idArquivoBinario: 1, idTipoArquivo: 5, nomeArquivoBinario: 'T.html', arquivoBinario: frag } },
    { ordemSegmentoAto: 3, idTipoSegmento: 3, textoIntegra: '<p>Art. 2º A autorização fica condicionada à comprovação.</p>' }] })), 900004)[0]!;
  return { p: r.referenceContext === 'operative_candidate', legal: [...new Set(r.reading?.parts.map((x: any) => x.legalStatus) ?? [])] }; };
const T = ', conforme tabela a seguir:';
// sentence BEFORE the resumption (each ends with a real sentence boundary)
const BOUNDARY: [string, string][] = [
  ['SRF.', 'Art. 1º Fica revogada a Instrução Normativa nº 52 da SRF.'],
  ['RFB.', 'Art. 1º Fica revogado o Anexo III da Instrução Normativa nº 2.121 da RFB.'],
  ['IN.', 'Art. 1º Fica revogado o art. 3º da IN.'],
  ['ponto comum', 'Art. 1º Aplica-se a Lei nº 9.532, de 1997.'],
  ['PGFN.', 'Art. 1º Fica revogada a Portaria Conjunta nº 1 da PGFN.'],
];
// 13 markers: [label, start-form object, middle-form object]
const MARKER: [string, string][] = [
  ['ali', 'as alíquotas ali previstas'], ['nela', 'as alíquotas nela previstas'], ['lá', 'as alíquotas lá previstas'],
  ['supracitado', 'as alíquotas do supracitado ato'], ['referido', 'as alíquotas do referido ato'], ['seu Anexo', 'as alíquotas de seu Anexo'],
  ['precitada', 'as alíquotas da precitada norma'], ['retrocitada', 'as alíquotas da retrocitada norma'], ['sobredita', 'as alíquotas da sobredita norma'],
  ['em tela', 'as alíquotas da norma em tela'], ['em comento', 'as alíquotas do ato em comento'], ['susodito', 'as alíquotas do susodito ato'],
  ['ato anterior', 'as alíquotas do ato anterior'],
];
const cases: [string, 'P' | 'N', string][] = [];
for (const [b, pre] of BOUNDARY) for (const [m, obj] of MARKER) {
  cases.push([`${b} | ${m} | início`, 'N', `${pre} Ficam aprovadas ${obj}${T}`]);
  cases.push([`${b} | ${m} | meio`, 'N', `${pre} Ficam aprovadas, para os fins deste artigo, ${obj}${T}`]);
}
const IN = 'Instrução Normativa RFB nº 2.121, de 2022';
for (const [m, obj] of MARKER) cases.push([`mesma frase | ${m}`, 'N', `Art. 1º Ficam aprovadas, nos termos da ${IN}, ${obj}${T}`]);
for (const [b, pre] of BOUNDARY) {
  cases.push([`${b} | CTL próprio`, 'P', `${pre} Ficam aprovadas as alíquotas de referência${T}`]);
  cases.push([`${b} | CTL nesta Portaria`, 'P', `${pre} Ficam aprovadas as alíquotas previstas nesta Portaria${T}`]);
  cases.push([`${b} | CTL neste diploma`, 'P', `${pre} Ficam aprovadas as alíquotas fixadas neste diploma${T}`]);
}
cases.push(['CTL "anterior" sem ato/norma (data)', 'P', `Art. 1º Ficam aprovadas as alíquotas de referência do exercício anterior${T}`]);
cases.push(['CTL "em tela" ausente', 'P', `Art. 1º Ficam aprovadas, nos termos da ${IN}, as alíquotas de referência${T}`]);
let bad = 0; for (const [k, want, art] of cases) { const r = promotes(art); const got = r.p ? 'P' : 'N'; if (got !== want) bad++; console.log(`${got === want ? 'ok ' : 'XX '}${got}/${want} ${k}${r.legal.join(',') === 'unknown' || r.legal.length === 0 ? '' : ' legal=' + r.legal.join(',')}`); }
console.log(`divergências ${bad} / ${cases.length}`);
