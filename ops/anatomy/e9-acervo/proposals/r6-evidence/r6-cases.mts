// R6 contraprova: each case's promotion outcome under the engine in <root>
import { join } from 'node:path';
const root = process.argv[2]!;
const { readRfbInlineAttachments } = await import(join(root, 'src/modules/anatomy/rfb-inline-attachments.ts'));
const src = (await import('node:fs')).readFileSync(join(root, 'test/anatomy.rfb-inline-attachments.unit.test.ts'), 'utf8');
const TABLE = '<table><tr><td>NCM</td><td>Descrição</td></tr><tr><td>2402.20.00</td><td>Cigarros</td></tr></table>';
const frag = Buffer.from(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${TABLE}</body></html>`).toString('base64');
const ART2 = '<p>Art. 2º A autorização fica condicionada à comprovação.</p>';
const promotes = (art: string) => readRfbInlineAttachments(new TextEncoder().encode(JSON.stringify({ idAto: 900004, tiposSegmento: [{ idTipoSegmento: 3, siglaTipoSegmento: 'artigo' }],
  outrosSegmentos: [{ ordemSegmentoAto: 1, idTipoSegmento: 3, textoIntegra: `<p>${art}</p>` }, { ordemSegmentoAto: 2, idTipoSegmento: 3, arquivoBinario: { idArquivoBinario: 1, idTipoArquivo: 5, nomeArquivoBinario: 'T.html', arquivoBinario: frag } },
    { ordemSegmentoAto: 3, idTipoSegmento: 3, textoIntegra: ART2 }] })), 900004)[0]!.referenceContext === 'operative_candidate';
const r6 = src.slice(src.indexOf('// ---- R6'));
const rows: string[] = [];
for (const block of r6.split(/\ntest\(/u).slice(1)) {
  const prefix = block.includes('promotes(`Art. 1º ${art}`)') ? 'Art. 1º ' : '';
  for (const kind of ['neg', 'pos'] as const) {
    const m = new RegExp(`const ${kind}: \\[string, string\\]\\[\\] = \\[([\\s\\S]*?)\\n  \\];`, 'u').exec(block); if (!m) continue;
    for (const c of m[1]!.matchAll(/\['((?:[^'\\]|\\.)*)', '((?:[^'\\]|\\.)*)'\]/gu)) {
      const art = prefix + c[2]!.replace(/\\'/gu, "'"); const got = promotes(art); const want = kind === 'pos';
      rows.push(`${got === want ? 'OK  ' : 'FAIL'} want=${want ? 'promote' : 'block  '} got=${got ? 'promote' : 'block  '} | ${c[1]!.replace(/\\'/gu, "'")}`);
    }
  }
}
console.log(rows.join('\n'));
