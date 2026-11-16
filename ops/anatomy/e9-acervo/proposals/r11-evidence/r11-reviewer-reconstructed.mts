// R11 baseline: cases RECONSTRUCTED from the R10 review (tribusca-control#116 c.6924070158). The reviewer's 34-case fixture
// was not published; only the fragments in the review table are reproduced here (prefixes marked "…" are reconstructed).
import { join } from 'node:path';
const root = process.argv[2]!;
const { readRfbInlineAttachments } = await import(join(root, 'src/modules/anatomy/rfb-inline-attachments.ts'));
const TABLE = '<table><tr><td>NCM</td><td>Descrição</td></tr><tr><td>2402.20.00</td><td>Cigarros</td></tr></table>';
const frag = Buffer.from(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${TABLE}</body></html>`).toString('base64');
const promotes = (art: string) => { const r = readRfbInlineAttachments(new TextEncoder().encode(JSON.stringify({ idAto: 900004, tiposSegmento: [{ idTipoSegmento: 3, siglaTipoSegmento: 'artigo' }],
  outrosSegmentos: [{ ordemSegmentoAto: 1, idTipoSegmento: 3, textoIntegra: `<p>${art}</p>` }, { ordemSegmentoAto: 2, idTipoSegmento: 3, arquivoBinario: { idArquivoBinario: 1, idTipoArquivo: 5, nomeArquivoBinario: 'T.html', arquivoBinario: frag } },
    { ordemSegmentoAto: 3, idTipoSegmento: 3, textoIntegra: '<p>Art. 2º A autorização fica condicionada à comprovação.</p>' }] })), 900004)[0]!;
  return { p: r.referenceContext === 'operative_candidate', legal: [...new Set(r.reading?.parts.map((x: any) => x.legalStatus) ?? [])] }; };
const cases: [string, 'P' | 'N', string][] = [
 ['DIV-1 sigla SRF. + ali previstas', 'N', 'Art. 1º Fica revogada a Instrução Normativa nº 52 da SRF. Ficam aprovadas as alíquotas ali previstas, conforme tabela a seguir:'],
 ['DIV-2 sigla IN. + lá previstas', 'N', 'Art. 1º Fica revogado o art. 3º da IN. Ficam aprovadas as alíquotas lá previstas, conforme tabela a seguir:'],
 ['DIV-3 nº 2.121 da RFB. + nela previstas', 'N', 'Art. 1º Fica revogado o Anexo III da Instrução Normativa nº 2.121 da RFB. Ficam aprovadas as alíquotas nela previstas, conforme tabela a seguir:'],
 ['DIV-4 abertura Estes', 'N', 'Art. 1º Estes valores ficam aprovados, conforme tabela a seguir:'],
 ['DIV-5 abertura Estas', 'N', 'Art. 1º Estas alíquotas ficam aprovadas, conforme tabela a seguir:'],
 ['DIV-6 abertura Os demais', 'N', 'Art. 1º Os demais valores ficam aprovados, conforme tabela a seguir:'],
 ['DIV-7 abertura Ditas', 'N', 'Art. 1º Ditas alíquotas ficam aprovadas conforme tabela a seguir:'],
 ['DIV-8 sobredita norma', 'N', 'Art. 1º Ficam aprovadas as alíquotas da sobredita norma, conforme tabela a seguir:'],
 ['DIV-9 neste diploma (próprio, falso negativo)', 'P', 'Art. 1º Nos termos da Lei nº 9.532, de 1997, ficam aprovadas as alíquotas fixadas neste diploma, conforme tabela a seguir:'],
 ['PONTO de 2000. + ali previstas', 'N', 'Art. 1º Aplica-se a Instrução Normativa SRF nº 52, de 2000. Ficam aprovadas as alíquotas ali previstas, conforme tabela a seguir:'],
 ['PONTO de 1997. + nela previstas', 'N', 'Art. 1º Aplica-se a Lei nº 9.532, de 1997. Ficam aprovadas as alíquotas nela previstas, conforme tabela a seguir:'],
 ['FIX Referidas (abertura)', 'N', 'Art. 1º Referidas alíquotas ficam aprovadas, conforme tabela a seguir:'],
 ['FIX Essas (abertura)', 'N', 'Art. 1º Essas alíquotas ficam aprovadas, conforme tabela a seguir:'],
 ['FIX Tais (abertura)', 'N', 'Art. 1º Tais alíquotas ficam aprovadas, conforme tabela a seguir:'],
 ['FIX Aquelas (abertura)', 'N', 'Art. 1º Aquelas alíquotas ficam aprovadas, conforme tabela a seguir:'],
 ['FIX aludido', 'N', 'Art. 1º Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas previstas no aludido ato, conforme tabela a seguir:'],
 ['FIX anteriormente indicada', 'N', 'Art. 1º Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas da norma anteriormente indicada, conforme tabela a seguir:'],
 ['FIX desta IN (próprio)', 'P', 'Art. 1º Nos termos da Lei nº 9.532, de 1997, ficam aprovadas as alíquotas previstas desta IN, conforme tabela a seguir:'],
 ['FIX da presente IN (próprio)', 'P', 'Art. 1º Nos termos da Lei nº 9.532, de 1997, ficam aprovadas as alíquotas da presente IN, conforme tabela a seguir:'],
 ['FIX nesta data (próprio)', 'P', 'Art. 1º Ficam aprovadas nesta data as alíquotas de referência, conforme tabela a seguir:'],
 ['FIX D.O.U. (fronteira)', 'P', 'Art. 1º Fica aprovado o modelo publicado no D.O.U. de 2 de janeiro de 2024, conforme tabela a seguir:'],
];
let bad = 0; for (const [k, want, art] of cases) { const r = promotes(art); const got = r.p ? 'P' : 'N'; if (got !== want) bad++; console.log(`${got === want ? 'ok ' : 'XX '}${got}/${want} ${k}${r.legal.some((x: string) => x !== 'unknown') ? ' [legalStatus!=unknown]' : ''}`); }
console.log('divergências', bad, '/', cases.length);
