import { join } from 'node:path';
const root = process.argv[2]!;
const { readRfbInlineAttachments } = await import(join(root, 'src/modules/anatomy/rfb-inline-attachments.ts'));
const TABLE = '<table><tr><td>NCM</td><td>Descrição</td></tr><tr><td>2402.20.00</td><td>Cigarros</td></tr></table>';
const frag = Buffer.from(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${TABLE}</body></html>`).toString('base64');
const promotes = (art: string) => { const r = readRfbInlineAttachments(new TextEncoder().encode(JSON.stringify({ idAto: 900004, tiposSegmento: [{ idTipoSegmento: 3, siglaTipoSegmento: 'artigo' }],
  outrosSegmentos: [{ ordemSegmentoAto: 1, idTipoSegmento: 3, textoIntegra: `<p>${art}</p>` }, { ordemSegmentoAto: 2, idTipoSegmento: 3, arquivoBinario: { idArquivoBinario: 1, idTipoArquivo: 5, nomeArquivoBinario: 'T.html', arquivoBinario: frag } },
    { ordemSegmentoAto: 3, idTipoSegmento: 3, textoIntegra: '<p>Art. 2º A autorização fica condicionada à comprovação.</p>' }] })), 900004)[0]!;
  return { p: r.referenceContext === 'operative_candidate', legal: [...new Set(r.reading?.parts.map((x: any) => x.legalStatus) ?? [])] }; };
const IN='Instrução Normativa RFB nº 2.121, de 2022';
const cases: [string,'P'|'N',string][] = [
 ['ANA Estes', 'N', `Art. 1º Nos termos da ${IN}. Estes valores ficam aprovados, conforme tabela a seguir:`],
 ['ANA Os demais', 'N', `Art. 1º Aplica-se a ${IN}. Os demais valores ficam aprovados conforme tabela a seguir:`],
 ['ANA Referidas (sem artigo)', 'N', `Art. 1º Vigoram as alíquotas da ${IN}. Referidas alíquotas ficam aprovadas conforme tabela a seguir:`],
 ['ANA Essas', 'N', `Art. 1º Vigoram as alíquotas da ${IN}. Essas alíquotas ficam aprovadas conforme tabela a seguir:`],
 ['ANA Tais', 'N', `Art. 1º Vigoram as alíquotas da ${IN}. Tais alíquotas ficam aprovadas conforme tabela a seguir:`],
 ['ANA Aquelas', 'N', `Art. 1º Vigoram as alíquotas da ${IN}. Aquelas alíquotas ficam aprovadas conforme tabela a seguir:`],
 ['ANA Estas', 'N', `Art. 1º Vigoram as alíquotas da ${IN}. Estas alíquotas ficam aprovadas conforme tabela a seguir:`],
 ['ANA Ditas', 'N', `Art. 1º Vigoram as alíquotas da ${IN}. Ditas alíquotas ficam aprovadas conforme tabela a seguir:`],
 ['ANA Tais + self-ref', 'P', `Art. 1º Vigoram as alíquotas da ${IN}. Tais alíquotas ficam substituídas pelas fixadas nesta Portaria, conforme tabela a seguir:`],
 ['RES "do aludido"', 'N', `Art. 1º Ficam aprovadas, nos termos da ${IN}, as alíquotas do aludido ato, conforme tabela a seguir:`],
 ['RES "dela constantes"', 'N', `Art. 1º Ficam aprovadas, nos termos da ${IN}, as alíquotas dela constantes, conforme tabela a seguir:`],
 ['RES "naquela IN"', 'N', `Art. 1º Ficam aprovadas, nos termos da ${IN}, as alíquotas descritas naquela IN, conforme tabela a seguir:`],
 ['RES "descritas" (particípio fora da lista)', 'N', `Art. 1º Ficam aprovadas, nos termos da ${IN}, as alíquotas descritas no referido ato, conforme tabela a seguir:`],
 ['RES "dispostas" + "no mesmo"', 'N', `Art. 1º Ficam aprovadas, nos termos da ${IN}, as alíquotas dispostas no mesmo, conforme tabela a seguir:`],
 ['RES "estipuladas na IN retro"', 'N', `Art. 1º Ficam aprovadas, nos termos da ${IN}, as alíquotas estipuladas na IN retro, conforme tabela a seguir:`],
 ['RES "dessa IN"', 'N', `Art. 1º Ficam aprovadas, nos termos da ${IN}, as alíquotas dessa IN, conforme tabela a seguir:`],
 ['RES "na sobredita norma"', 'N', `Art. 1º Ficam aprovadas, nos termos da ${IN}, as alíquotas da sobredita norma, conforme tabela a seguir:`],
 ['RES "anteriormente citada"', 'N', `Art. 1º Ficam aprovadas, nos termos da ${IN}, as alíquotas da norma anteriormente indicada, conforme tabela a seguir:`],
 ['SELF "neste ato normativo"', 'P', `Art. 1º Ficam aprovadas, nos termos da Lei nº 9.532, de 1997, as alíquotas previstas neste ato normativo, conforme tabela a seguir:`],
 ['SELF "desta IN"', 'P', `Art. 1º Ficam aprovadas, nos termos da Lei nº 9.532, de 1997, as alíquotas previstas no Anexo desta IN, conforme tabela a seguir:`],
 ['SELF "da presente Instrução Normativa"', 'P', `Art. 1º Ficam aprovadas, nos termos da Lei nº 9.532, de 1997, as alíquotas constantes da presente Instrução Normativa, conforme tabela a seguir:`],
 ['SELF "deste diploma"', 'P', `Art. 1º Ficam aprovadas, nos termos da Lei nº 9.532, de 1997, as alíquotas fixadas neste diploma, conforme tabela a seguir:`],
 ['SELF ambíguo "nesta" + outra IN', 'N', `Art. 1º Ficam aprovadas as alíquotas previstas nesta Portaria e na ${IN}, conforme tabela a seguir:`],
 ['SELF falso "nesta data"', 'N', `Art. 1º Ficam aprovadas, nos termos da ${IN}, as alíquotas ali previstas, vigentes nesta data, conforme tabela a seguir:`],
 ['SELF falso "nesta Portaria" sobre outra', 'N', `Art. 1º Ficam aprovadas as alíquotas previstas na ${IN}, a que se refere esta Portaria, conforme tabela a seguir:`],
 ['ABBR "SRF." oculta citação', 'N', `Art. 1º Nos termos da IN SRF nº 1, de 2000, da SRF. Ficam aprovadas as alíquotas ali previstas, conforme tabela a seguir:`],
 ['ABBR "inc." minúsculo', 'N', `Art. 1º Ficam aprovadas, nos termos do art. 3º, inc. II, da ${IN}, as alíquotas ali previstas, conforme tabela a seguir:`],
 ['ABBR "IN" sozinha antes do ponto', 'N', `Art. 1º Aplicam-se as alíquotas da IN. Ficam aprovadas as alíquotas lá previstas, conforme tabela a seguir:`],
 ['ABBR "RFB." fim real (próprio)', 'P', `Art. 1º Compete à RFB. Ficam aprovadas as alíquotas de referência, conforme tabela a seguir:`],
 ['ABBR "Est." Title (merge)', 'N', `Art. 1º Nos termos do Dec. Est. nº 45.490, ficam aprovadas as alíquotas nele previstas, conforme tabela a seguir:`],
 ['ABBR "ICMS." fim + ANA "Os mesmos"', 'N', `Art. 1º Aplica-se a ${IN} ao ICMS. Os mesmos valores ficam aprovados conforme tabela a seguir:`],
 ['ABBR "D.O.U." pontos', 'N', `Art. 1º Ficam aprovadas, nos termos da ${IN}, publicada no D.O.U. de 2022, as alíquotas ali previstas, conforme tabela a seguir:`],
 ['CTL próprio sem citação', 'P', 'Art. 1º Ficam aprovadas as alíquotas de referência, conforme tabela a seguir:'],
 ['CTL fundamento sem marcador', 'P', `Art. 1º Ficam aprovadas, nos termos da ${IN}, as alíquotas de referência, conforme tabela a seguir:`],
];
let bad = 0; for (const [k, want, art] of cases) { const r = promotes(art); const got = r.p ? 'P' : 'N'; if (got !== want) bad++; console.log(`${got === want ? 'ok ' : 'XX '}${got}/${want} ${k}${r.legal.some((x: string) => x !== 'unknown') ? ' [legalStatus!=unknown]' : ''}`); }
console.log('divergências', bad, '/', cases.length);
