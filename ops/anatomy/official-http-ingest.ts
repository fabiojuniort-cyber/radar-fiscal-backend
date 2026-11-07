/**
 * E9 / P2 — ingestion of HTTP response bytes captured from the official origins by ANOTHER session and delivered by git
 * (tribusca-control@fe60728d, branch evidence/e9-official-inputs-20261107, ZIP SHA-256 cce00c19…; COORD #303
 * c.6701983186 / c.6702061803). Not a browser reproduction and not a manual save: the meta says so.
 *
 * Rules: every file must match the manifest (SHA-256 + size) and the ZIP hash given; the URL host must be the official
 * host of the item; the bytes are stored unchanged with exclusive creation (no overwrite, no partial state). Encoding is
 * NEVER inferred: a file that declares no charset (and whose HTTP charset was not preserved) is identified only through
 * ASCII parts of its title and is recorded as not readable. The DOU PDF page is identified (header, footer, epigraph)
 * and its reach is recorded: a single page, act limits and continuation stated — header/footer evidence, not a complete
 * act. Nothing is promoted.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPdfLines } from '../../src/modules/anatomy/pdf-reader.js';
import { MANUAL_ITEMS, decodeDeclared } from './official-manual-ingest.js';

export const HTTP_DIR = fileURLToPath(new URL('./official-identification/e9-http/', import.meta.url));
export const PACKAGE = Object.freeze({ repo: 'fabiojuniort-cyber/tribusca-control', commit: 'fe60728db2929c84519df32f7bf6152260652874',
  branch: 'evidence/e9-official-inputs-20261107', path: 'docs/investigations/e9-inputs/E9-official-access-20261107.zip',
  zipSha256: 'cce00c19cc68b2b8e9007d632e620bedfb1da6e51afd5f6cfb0114c62f8aed5f' });
const HOSTS: Record<string, string[]> = { M1: ['www.planalto.gov.br'], M2: ['www.planalto.gov.br'], M3: ['www.confaz.fazenda.gov.br'], M4: ['www.confaz.fazenda.gov.br'],
  M5: ['www.confaz.fazenda.gov.br'], M9: ['pesquisa.in.gov.br'] };
/** ASCII-only title patterns: identity is checked without decoding text whose encoding is not declared. */
const ASCII_TITLE: Record<string, RegExp> = {
  M1: /LEI\s+N[^0-9]{0,4}10\.637[^0-9A-Z]{0,6}DE\s+30\s+DE\s+DEZEMBRO\s+DE\s+2002/u,
  M2: /LEI\s+N[^0-9]{0,4}10\.833[^0-9A-Z]{0,6}DE\s+29\s+DE\s+DEZEMBRO\s+DE\s+2003/u,
};
export interface ManifestEntry { id: string; sha256: string; bytes: number; url: string; retrieved_utc: string; origin: string; coverage: string; file: string }
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
export class HttpIngestError extends Error {}

export interface HttpMeta {
  item: string; act: string; source: string; type: string; url: string; retrievedAt: string; fileName: string; sha256: string; bytes: number;
  origin: 'resposta HTTP da origem oficial, capturada em outra sessão e entregue por git'; package: typeof PACKAGE; manifestOrigin: string; manifestCoverage: string;
  declaredCharset: string | null; readable: boolean; readableNote: string | null; representation: 'html' | 'pdf';
  identification: Record<string, unknown>; reach: string; promoted: false;
}

export async function ingestHttpPackage(dir: string, zipSha256: string, out = HTTP_DIR, now = () => new Date().toISOString()): Promise<HttpMeta[]> {
  if (zipSha256 !== PACKAGE.zipSha256) throw new HttpIngestError('ZIP hash differs from the delivered package');
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as ManifestEntry[];
  mkdirSync(out, { recursive: true });
  const metas: HttpMeta[] = [];
  for (const e of manifest) {
    const bytes = new Uint8Array(readFileSync(join(dir, e.file)));
    if (bytes.byteLength !== e.bytes || sha(bytes) !== e.sha256.toLowerCase()) throw new HttpIngestError(`${e.id}: bytes differ from the manifest`);
    const url = new URL(e.url);
    if (url.protocol !== 'https:' || !(HOSTS[e.id] ?? []).includes(url.hostname)) throw new HttpIngestError(`${e.id}: ${url.hostname} is not the official host of the item`);
    const spec = MANUAL_ITEMS.find((m) => m.item === e.id)!;
    const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
    let identification: Record<string, unknown>; let declaredCharset: string | null = null; let readable = false; let readableNote: string | null = null; let reach: string;
    let source: string = spec.source; let type = spec.type;
    if (isPdf) {
      const r = await extractPdfLines(bytes); const L = r.lines.map((l) => l.text);
      const header = L.find((t) => /Se[çc][ãa]o\s+1\b.*ISSN\s+1677-7042.*5\s+de\s+dezembro\s+de\s+2024/u.test(t)) ?? null;
      const footer = L.find((t) => /in\.gov\.br\/autenticidade\.html,\s*pelo\s+c[óo]digo\s+\d{17}/u.test(t)) ?? null;
      const epi = L.findIndex((t) => /^INSTRU[ÇC][ÃA]O NORMATIVA RFB N\S*\s*2\.237, DE 4 DE DEZEMBRO DE 2024/u.test(t));
      const arts = L.filter((t) => /^Art\.\s*\d+/u.test(t)).map((t) => /^Art\.\s*(\d+)/u.exec(t)![1]);
      if (!header || !footer || epi < 0 || r.pages !== 1) throw new HttpIngestError(`${e.id}: DOU page identity not confirmed (header/footer/epigraph/1 page)`);
      identification = { pages: r.pages, header, footer, footerCode: /c[óo]digo\s+(\d{17})/u.exec(footer)![1], epigraphLine: epi, epigraph: L[epi], articlesOnPage: arts };
      source = 'DOU'; type = 'Página do jornal (cabeçalho e rodapé)';
      reach = 'uma página (57) do DOU: cabeçalho e rodapé identificados; o ato começa nesta página e CONTINUA nas seguintes (não é o ato completo); o topo da página traz o fim de outra publicação; a extração mistura colunas na mesma linha, então a leitura da anatomia não é validada';
    } else {
      const head = new TextDecoder('latin1').decode(bytes.slice(0, 4096));
      declaredCharset = /charset\s*=\s*["']?([\w-]+)/iu.exec(head)?.[1] ?? null;
      if (declaredCharset) {
        const text = decodeDeclared(bytes, declaredCharset).replace(/<(script|style)[\s\S]*?<\/\1>/giu, ' ').replace(/<[^>]+>/gu, ' ').replace(/&nbsp;/gu, ' ').replace(/\s+/gu, ' ');
        const m = spec.title.exec(text); if (!m) throw new HttpIngestError(`${e.id}: expected title not found`);
        identification = { method: `título no texto decodificado com o charset declarado (${declaredCharset})`, matched: m[0] }; readable = true;
      } else {
        const ascii = new TextDecoder('latin1').decode(bytes).replace(/<[^>]+>/gu, ' ').replace(/&nbsp;|&#\d+;|&\w+;/gu, ' ').replace(/\s+/gu, ' ');
        const m = ASCII_TITLE[e.id]?.exec(ascii); if (!m) throw new HttpIngestError(`${e.id}: title not identified by its ASCII parts`);
        identification = { method: 'partes ASCII do título (sem decodificar: charset não declarado)', matched: m[0].replace(/[^\x20-\x7e]/gu, '?') };
        readableNote = 'charset não declarado no HTML e cabeçalho HTTP de charset não preservado: não inferido; leitura pendente de decisão';
      }
      reach = e.coverage;
    }
    const fileName = `${e.id}${isPdf ? '.pdf' : '.html'}`; const p = join(out, fileName); const mp = join(out, `${e.id}.meta.json`);
    if (existsSync(mp) || existsSync(p)) throw new HttpIngestError(`${e.id}: already present (never overwritten)`);
    const meta: HttpMeta = { item: e.id, act: spec.act, source, type, url: e.url, retrievedAt: e.retrieved_utc, fileName, sha256: sha(bytes), bytes: bytes.byteLength,
      origin: 'resposta HTTP da origem oficial, capturada em outra sessão e entregue por git', package: PACKAGE, manifestOrigin: e.origin, manifestCoverage: e.coverage,
      declaredCharset, readable, readableNote, representation: isPdf ? 'pdf' : 'html', identification, reach, promoted: false };
    writeFileSync(p, bytes, { flag: 'wx' });
    try { writeFileSync(mp, `${JSON.stringify(meta, null, 2)}\n`, { flag: 'wx' }); } catch (err) { unlinkSync(p); throw err; }
    metas.push(meta); void now;
  }
  return metas;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2]!; const zipSha = process.argv[3]!;
  const metas = await ingestHttpPackage(dir, zipSha);
  for (const m of metas) console.log(`${m.item} ${m.source} | ${m.type} | ${m.sha256.slice(0, 12)} | charset ${m.declaredCharset} | readable ${m.readable} | ${JSON.stringify(m.identification).slice(0, 120)}`);
}

/**
 * A single HTTP capture delivered later by the other session (tribusca-control@335160c7): DOU page 58 of the same
 * edition. Checked against the full SHA-256 and size announced; the page's own header/footer/continuity are recorded
 * as findings — the two pages together are NOT presumed to be the complete act.
 */
export const PACKAGE_NIGHT = Object.freeze({ repo: PACKAGE.repo, commit: '335160c7ea9f83b3687fb4ce4000448a354fe93e', branch: PACKAGE.branch,
  path: 'docs/investigations/e9-inputs/20261107-night/official-access/M9-page58.pdf' });
export async function ingestDouPage58(file: string, http: { url: string; at: string; status: number; headers: { contentType: string } }, expected: { sha256: string; bytes: number }, out = HTTP_DIR): Promise<HttpMeta> {
  const bytes = new Uint8Array(readFileSync(file));
  if (bytes.byteLength !== expected.bytes || sha(bytes) !== expected.sha256) throw new HttpIngestError('M9 page 58: bytes differ from the announced SHA-256/size');
  const url = new URL(http.url);
  if (url.protocol !== 'https:' || url.hostname !== 'pesquisa.in.gov.br' || url.searchParams.get('pagina') !== '58' || url.searchParams.get('data') !== '05/12/2024') throw new HttpIngestError('M9 page 58: URL is not the official page 58 of 05/12/2024');
  if (http.status !== 200 || !/^application\/pdf\b/u.test(http.headers.contentType)) throw new HttpIngestError('M9 page 58: HTTP status/type not 200 application/pdf');
  const r = await extractPdfLines(bytes); const L = r.lines.map((l) => l.text); const text = L.join('\n');
  const header = L.find((t) => /Se[çc][ãa]o\s+1\b.*ISSN\s+1677-7042.*5\s+de\s+dezembro\s+de\s+2024/u.test(t)) ?? null;
  const footer = L.find((t) => /in\.gov\.br\/autenticidade\.html,\s*pelo\s+c[óo]digo\s+05152024120500058/u.test(t)) ?? null;
  const signatureLine = L.findIndex((t) => /ROBINSON SAKIYAMA BARREIRINHAS/u.test(t));
  if (!header || !footer || r.pages !== 1) throw new HttpIngestError('M9 page 58: header/footer/1 page not confirmed');
  const arts = [...new Set([...text.matchAll(/Art\.\s*(\d+)º?/gu)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  const fileName = 'M9-p58.pdf'; const p = join(out, fileName); const mp = join(out, 'M9-p58.meta.json');
  if (existsSync(p) || existsSync(mp)) throw new HttpIngestError('M9 page 58: already present (never overwritten)');
  const meta: HttpMeta = { item: 'M9-p58', act: 'IN RFB nº 2.237/2024 na página 58 do DOU', source: 'DOU', type: 'Página do jornal (cabeçalho e rodapé)', url: http.url, retrievedAt: http.at,
    fileName, sha256: expected.sha256, bytes: expected.bytes, origin: 'resposta HTTP da origem oficial, capturada em outra sessão e entregue por git',
    package: { ...PACKAGE, commit: PACKAGE_NIGHT.commit, path: PACKAGE_NIGHT.path } as unknown as typeof PACKAGE, manifestOrigin: `HTTP ${http.status} ${http.headers.contentType}`,
    manifestCoverage: 'single DOU page 58 (continuation)', declaredCharset: null, readable: false, readableNote: null, representation: 'pdf',
    identification: { pages: r.pages, header, footer, footerCode: '05152024120500058', startsWith: L[1]?.slice(0, 40) ?? null, continuesFromPage57: /^XV\b/u.test(L[1] ?? ''),
      articlesOnPage: arts, signatureLine, contentAfterSignature: L.slice(signatureLine + 1).filter((t) => !/autenticidade|Documento assinado digitalmente|ICP-Brasil/u.test(t)).length },
    reach: 'página 58: continua o art. 8º (inciso XV) e vai ao art. 19 e à assinatura; depois da assinatura só o rodapé. Com a página 57: epígrafe → arts. 1–19 → assinatura, sem anexo mencionado. NÃO se presume ato completo: anexos publicados em outro lugar, ordem visual (colunas misturadas na extração) e assinatura criptográfica não foram verificados',
    promoted: false };
  writeFileSync(p, bytes, { flag: 'wx' });
  try { writeFileSync(mp, `${JSON.stringify(meta, null, 2)}\n`, { flag: 'wx' }); } catch (err) { unlinkSync(p); throw err; }
  return meta;
}
