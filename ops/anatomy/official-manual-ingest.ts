/**
 * E9 / P2 — ingestion of the files Fábio saves by hand from portals that refuse this environment (OFFICIAL-ARQUIVOS-
 * MANUAIS.md). The bytes are stored exactly as received (never rewritten; exclusive creation, so nothing existing is
 * ever overwritten and a partial state — bytes without meta — is refused). The meta records the URL, when the file was
 * saved (or, when not informed, when it was received: an upper bound, said so), SHA-256, size, the declared encoding
 * and the origin "reprodução salva pelo navegador" — never "original". The expected title is checked in the file decoded
 * with ITS declared encoding (unsupported encoding → refused); the browser's own "saved from url" note, when present,
 * must name the same URL. Unknown items, foreign hosts and reserved acts (corpus/gold: 52/91, 100/97…) are refused;
 * every refusal is recorded. Nothing is promoted.
 *
 *   npx tsx ops/anatomy/official-manual-ingest.ts --item M5 --file <path> --url <url> [--saved-at <ISO>] [--received-at <ISO>]
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESERVED_ACT_KEYS, RESERVED_SOURCE_IDS } from '../../src/modules/anatomy/config/reserved-act-keys.js';

export const MANUAL_DIR = fileURLToPath(new URL('./official-identification/manual/', import.meta.url));

export interface ManualItem { item: string; act: string; actKey: string; source: 'Planalto' | 'CONFAZ' | 'DOU'; type: string; hosts: string[]; title: RegExp }
/** The pending items of the approved manual list (M6–M8 came from the RFB API; M1/M2 were also obtained via normas.leg.br). M10–M37: manual-input sheet; M27/M31/M36/M37 (act to be chosen by Fábio) are intentionally absent. M24 is the same act as M9 (HTML route). */
export const MANUAL_ITEMS: readonly ManualItem[] = Object.freeze([
  { item: 'M1', act: 'Lei nº 10.637/2002', actKey: 'lei 10637/02', source: 'Planalto', type: 'Lei', hosts: ['www.planalto.gov.br'], title: /LEI\s+N\S*\s*10\.637\s*[,–—-]?\s*DE\s+30\s+DE\s+DEZEMBRO\s+DE\s+2002/iu },
  { item: 'M2', act: 'Lei nº 10.833/2003', actKey: 'lei 10833/03', source: 'Planalto', type: 'Lei', hosts: ['www.planalto.gov.br'], title: /LEI\s+N\S*\s*10\.833\s*[,–—-]?\s*DE\s+29\s+DE\s+DEZEMBRO\s+DE\s+2003/iu },
  { item: 'M3', act: 'Convênio ICMS 142/18', actKey: 'conv 142/18', source: 'CONFAZ', type: 'Convênio ICMS', hosts: ['www.confaz.fazenda.gov.br'], title: /CONV[ÊE]NIO\s+ICMS\s+N?\S*\s*142\s*\/\s*(?:20)?18\b/iu },
  { item: 'M4', act: 'Convênio ICMS 190/17', actKey: 'conv 190/17', source: 'CONFAZ', type: 'Convênio ICMS', hosts: ['www.confaz.fazenda.gov.br'], title: /CONV[ÊE]NIO\s+ICMS\s+N?\S*\s*190\s*\/\s*(?:20)?17\b/iu },
  { item: 'M5', act: 'Ajuste SINIEF 07/05', actKey: 'ajuste 7/05', source: 'CONFAZ', type: 'Ajuste SINIEF', hosts: ['www.confaz.fazenda.gov.br'], title: /AJUSTE\s+SINIEF\s+N?\S*\s*0?7\s*\/\s*(?:20)?05\b/iu },
  { item: 'M9', act: 'IN RFB nº 2.237/2024 na página do DOU', actKey: 'in 2237/24', source: 'DOU', type: 'Instrução Normativa', hosts: ['www.in.gov.br'],
    title: /Publicado\s+em:?[\s\S]{0,200}Edi[çc][ãa]o[\s\S]{0,200}Se[çc][ãa]o[\s\S]{0,400}INSTRU[ÇC][ÃA]O\s+NORMATIVA\s+RFB\s+N\S*\s*2\.237/iu },
  { item: 'M10', act: 'Lei nº 10.168/2000', actKey: 'lei 10168/00', source: 'Planalto', type: 'Lei', hosts: ['www.planalto.gov.br'], title: /LEI\s+N(?:\S*|\s+[oº°])\s*10\.168\s*[,–—-]?\s*DE\s+29\s+DE\s+DEZEMBRO\s+DE\s+2000/iu },
  { item: 'M11', act: 'Lei nº 9.779/1999', actKey: 'lei 9779/99', source: 'Planalto', type: 'Lei', hosts: ['www.planalto.gov.br'], title: /LEI\s+N\S*\s*9\.779\b[\s\S]{0,60}1999/iu },
  { item: 'M12', act: 'Lei nº 9.718/1998', actKey: 'lei 9718/98', source: 'Planalto', type: 'Lei', hosts: ['www.planalto.gov.br'], title: /LEI\s+N\S*\s*9\.718\b[\s\S]{0,60}1998/iu },
  { item: 'M13', act: 'Lei nº 10.147/2000', actKey: 'lei 10147/00', source: 'Planalto', type: 'Lei', hosts: ['www.planalto.gov.br'], title: /LEI\s+N\S*\s*10\.147\b[\s\S]{0,60}2000/iu },
  { item: 'M14', act: 'Convênio ICMS 63/26', actKey: 'conv 63/26', source: 'CONFAZ', type: 'Convênio ICMS', hosts: ['www.confaz.fazenda.gov.br'], title: /CONV[ÊE]NIO\s+ICMS\s+N?\S*\s*63\s*\/\s*(?:20)?26\b/iu },
  { item: 'M15', act: 'Convênio ICMS 88/26', actKey: 'conv 88/26', source: 'CONFAZ', type: 'Convênio ICMS', hosts: ['www.confaz.fazenda.gov.br'], title: /CONV[ÊE]NIO\s+ICMS\s+N?\S*\s*88\s*\/\s*(?:20)?26\b/iu },
  { item: 'M16', act: 'Convênio ICMS 153/20', actKey: 'conv 153/20', source: 'CONFAZ', type: 'Convênio ICMS', hosts: ['www.confaz.fazenda.gov.br'], title: /CONV[ÊE]NIO\s+ICMS\s+N?\S*\s*153\s*\/\s*(?:20)?20\b/iu },
  { item: 'M17', act: 'Convênio ICMS 236/21', actKey: 'conv 236/21', source: 'CONFAZ', type: 'Convênio ICMS', hosts: ['www.confaz.fazenda.gov.br'], title: /CONV[ÊE]NIO\s+ICMS\s+N?\S*\s*236\s*\/\s*(?:20)?21\b/iu },
  { item: 'M18', act: 'Ajuste SINIEF 01/26', actKey: 'ajuste 1/26', source: 'CONFAZ', type: 'Ajuste SINIEF', hosts: ['www.confaz.fazenda.gov.br'], title: /AJUSTE\s+SINIEF\s+N?\S*\s*0?1\s*\/\s*(?:20)?26\b/iu },
  { item: 'M19', act: 'Ajuste SINIEF 19/16', actKey: 'ajuste 19/16', source: 'CONFAZ', type: 'Ajuste SINIEF', hosts: ['www.confaz.fazenda.gov.br'], title: /AJUSTE\s+SINIEF\s+N?\S*\s*19\s*\/\s*(?:20)?16\b/iu },
  { item: 'M20', act: 'Protocolo ICMS 88/26', actKey: 'protocolo 88/26', source: 'CONFAZ', type: 'Protocolo ICMS', hosts: ['www.confaz.fazenda.gov.br'], title: /PROTOCOLO\s+ICMS\s+N?\S*\s*88\s*\/\s*(?:20)?26\b/iu },
  { item: 'M21', act: 'Protocolo ICMS 21/11', actKey: 'protocolo 21/11', source: 'CONFAZ', type: 'Protocolo ICMS', hosts: ['www.confaz.fazenda.gov.br'], title: /PROTOCOLO\s+ICMS\s+N?\S*\s*21\s*\/\s*(?:20)?11\b/iu },
  { item: 'M22', act: 'Protocolo ICMS 41/08', actKey: 'protocolo 41/08', source: 'CONFAZ', type: 'Protocolo ICMS', hosts: ['www.confaz.fazenda.gov.br'], title: /PROTOCOLO\s+ICMS\s+N?\S*\s*41\s*\/\s*(?:20)?08\b/iu },
  { item: 'M23', act: 'IN RFB nº 1.932/2020', actKey: 'in 1932/20', source: 'DOU', type: 'Instrução Normativa', hosts: ['www.in.gov.br'], title: /INSTRU[ÇC][ÃA]O\s+NORMATIVA\s+(?:RFB\s+)?N\S*\s*1\.932\b/iu },
  { item: 'M24', act: 'IN RFB nº 2.237/2024', actKey: 'in 2237/24', source: 'DOU', type: 'Instrução Normativa', hosts: ['www.in.gov.br'], title: /INSTRU[ÇC][ÃA]O\s+NORMATIVA\s+RFB\s+N\S*\s*2\.237/iu },
  { item: 'M25', act: 'IN RFB nº 2.121/2022', actKey: 'in 2121/22', source: 'DOU', type: 'Instrução Normativa', hosts: ['www.in.gov.br'], title: /INSTRU[ÇC][ÃA]O\s+NORMATIVA\s+RFB\s+N\S*\s*2\.121/iu },
  { item: 'M26', act: 'Decreto nº 10.979/2022', actKey: 'decreto 10979/22', source: 'DOU', type: 'Decreto', hosts: ['www.in.gov.br'], title: /DECRETO\s+N\S*\s*10\.979/iu },
  { item: 'M28', act: 'Decreto nº 9.580/2018', actKey: 'decreto 9580/18', source: 'DOU', type: 'Decreto', hosts: ['www.in.gov.br'], title: /DECRETO\s+N\S*\s*9\.580/iu },
  { item: 'M29', act: 'Portaria RFB nº 514/2025', actKey: 'portaria 514/25', source: 'DOU', type: 'Portaria', hosts: ['www.in.gov.br'], title: /PORTARIA\s+RFB\s+N\S*\s*514/iu },
  { item: 'M30', act: 'Portaria RFB nº 635/2025', actKey: 'portaria 635/25', source: 'DOU', type: 'Portaria', hosts: ['www.in.gov.br'], title: /PORTARIA\s+RFB\s+N\S*\s*635/iu },
  { item: 'M32', act: 'Resolução CGSN nº 164/2022', actKey: 'resolucao 164/22', source: 'DOU', type: 'Resolução', hosts: ['www.in.gov.br'], title: /RESOLU[ÇC][ÃA]O\s+CGSN\s+N\S*\s*164/iu },
  { item: 'M33', act: 'Resolução CGSN nº 182/2025', actKey: 'resolucao 182/25', source: 'DOU', type: 'Resolução', hosts: ['www.in.gov.br'], title: /RESOLU[ÇC][ÃA]O\s+CGSN\s+N\S*\s*182/iu },
  { item: 'M34', act: 'Resolução CGSN nº 140/2018', actKey: 'resolucao 140/18', source: 'DOU', type: 'Resolução', hosts: ['www.in.gov.br'], title: /RESOLU[ÇC][ÃA]O\s+CGSN\s+N\S*\s*140/iu },
  { item: 'M35', act: 'Despacho SE/CONFAZ nº 174/2017', actKey: 'despacho 174/17', source: 'DOU', type: 'Despacho', hosts: ['www.in.gov.br'], title: /DESPACHO\s+(?:SE\s*\/\s*CONFAZ\s+)?N\S*\s*174\b[\s\S]{0,80}2017/iu },
]);

export interface ManualMeta {
  item: string; act: string; source: string; type: string; url: string; savedAt: string | null; receivedAt: string; savedAtNote: string | null;
  ingestedAt: string; fileName: string; sha256: string; bytes: number; declaredCharset: string;
  browserSavedFromUrl: string | null; origin: 'obtido manualmente pelo Fábio — reprodução salva pelo navegador';
  original: false; titleCheck: { pattern: string; matched: string }; representation: 'html'; promoted: false;
}
export type IngestResult = { status: 'accepted'; meta: ManualMeta } | { status: 'refused'; reason: string };

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const SUPPORTED: Record<string, string> = { 'utf-8': 'utf-8', utf8: 'utf-8', 'windows-1252': 'windows-1252', 'iso-8859-1': 'windows-1252', latin1: 'windows-1252' };
export class UnsupportedEncodingError extends Error {}
/** Decode with the encoding the file declares (fatal for UTF-8); anything else is refused, never guessed. */
export function decodeDeclared(bytes: Uint8Array, declared: string | null): string {
  const label = SUPPORTED[(declared ?? '').toLowerCase()];
  if (!label) throw new UnsupportedEncodingError(`declared encoding ${declared ?? '(none)'} is not supported`);
  return new TextDecoder(label, { fatal: label === 'utf-8' }).decode(bytes);
}
const visibleText = (html: string): string => html.replace(/<(script|style)[\s\S]*?<\/\1>/giu, ' ').replace(/<[^>]+>/gu, ' ').replace(/&nbsp;/gu, ' ')
  .replace(/&#(\d+);/gu, (_, n) => String.fromCodePoint(Number(n))).replace(/\s+/gu, ' ');

export function ingestManual(input: { item: string; file: string; url: string; savedAt?: string | undefined; receivedAt?: string | undefined },
  dir = MANUAL_DIR, now = () => new Date().toISOString()): IngestResult {
  const refuse = (reason: string): IngestResult => {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'refusals.jsonl'), `${JSON.stringify({ at: now(), item: input.item, file: basename(input.file), url: input.url, reason })}\n`);
    return { status: 'refused', reason };
  };
  const spec = MANUAL_ITEMS.find((m) => m.item === input.item);
  if (!spec) return refuse(`unknown item ${input.item}`);
  if ((RESERVED_ACT_KEYS as readonly string[]).includes(spec.actKey) || RESERVED_SOURCE_IDS.some((id) => input.url.includes(id))) return refuse('reserved act (corpus/gold) — never ingested');
  let url: URL; try { url = new URL(input.url); } catch { return refuse('invalid URL'); }
  if (url.protocol !== 'https:' || !spec.hosts.includes(url.hostname.toLowerCase())) return refuse(`URL host ${url.hostname} is not the official host of ${spec.source}`);
  if (input.savedAt !== undefined && Number.isNaN(Date.parse(input.savedAt))) return refuse('savedAt is not a date');
  if (input.receivedAt !== undefined && Number.isNaN(Date.parse(input.receivedAt))) return refuse('receivedAt is not a date');
  if (!existsSync(input.file)) return refuse('file not found');
  const bytes = new Uint8Array(readFileSync(input.file));
  if (!bytes.byteLength) return refuse('empty file');
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return refuse('PDF received: a PDF page needs its own path (title read by the PDF reader); not ingested here');
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 4096));
  const declaredCharset = /charset\s*=\s*["']?([\w-]+)/iu.exec(head)?.[1] ?? null;
  let html: string;
  try { html = decodeDeclared(bytes, declaredCharset); } catch (e) { return refuse(e instanceof UnsupportedEncodingError ? e.message : `bytes are not valid ${declaredCharset}`); }
  const savedFrom = /<!--\s*saved from url=\(\d+\)(\S+?)\s*-->/iu.exec(head)?.[1] ?? null;
  if (savedFrom && savedFrom !== input.url) return refuse(`the browser recorded "saved from url=${savedFrom}", which differs from the URL given`);
  const found = spec.title.exec(visibleText(html));
  if (!found) return refuse(`expected title not found in the file (${spec.act})`);
  mkdirSync(dir, { recursive: true });
  const fileName = `${spec.item}.html`; const htmlPath = join(dir, fileName); const metaPath = join(dir, `${spec.item}.meta.json`);
  if (existsSync(metaPath)) return refuse(`${spec.item} was already ingested; a new capture needs its own decision (bytes are never overwritten)`);
  if (existsSync(htmlPath)) return refuse(`${spec.item}: partial state (bytes without meta) — refused; inspect and resolve by decision, never overwrite`);
  const receivedAt = new Date(input.receivedAt ?? now()).toISOString();
  const meta: ManualMeta = { item: spec.item, act: spec.act, source: spec.source, type: spec.type, url: input.url,
    savedAt: input.savedAt ? new Date(input.savedAt).toISOString() : null, receivedAt,
    savedAtNote: input.savedAt ? null : 'hora do salvamento não informada; receivedAt é o limite superior (recebimento do arquivo)',
    ingestedAt: now(), fileName, sha256: sha(bytes), bytes: bytes.byteLength, declaredCharset: declaredCharset!, browserSavedFromUrl: savedFrom,
    origin: 'obtido manualmente pelo Fábio — reprodução salva pelo navegador', original: false,
    titleCheck: { pattern: spec.title.source, matched: found[0].replace(/\s+/gu, ' ').slice(0, 200) }, representation: 'html', promoted: false };
  // Exclusive creation of bytes then meta; if the meta cannot be created, the bytes just written are removed (no orphan).
  try { writeFileSync(htmlPath, bytes, { flag: 'wx' }); } catch { return refuse(`${spec.item}: could not create the bytes file exclusively (concurrent ingestion?)`); }
  if (sha(new Uint8Array(readFileSync(htmlPath))) !== meta.sha256) { unlinkSync(htmlPath); throw new Error('stored bytes differ from the received file'); }
  try { writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, { flag: 'wx' }); } catch { unlinkSync(htmlPath); return refuse(`${spec.item}: could not create the meta exclusively (concurrent ingestion?)`); }
  return { status: 'accepted', meta };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
  const r = ingestManual({ item: arg('--item') ?? '', file: arg('--file') ?? '', url: arg('--url') ?? '', savedAt: arg('--saved-at'), receivedAt: arg('--received-at') });
  console.log(JSON.stringify(r, null, 2)); if (r.status !== 'accepted') process.exitCode = 1;
}
