/**
 * E9 / P2 — ingestion of the files Fábio saves by hand from portals that refuse this environment (OFFICIAL-ARQUIVOS-
 * MANUAIS.md). The bytes are stored exactly as received (never rewritten); the meta records the URL Fábio gives, when he
 * saved it, SHA-256, size and the origin "reprodução salva pelo navegador" — never "original". The expected title is
 * checked in the file itself; a mismatch, a reserved act (corpus: 52/91, 100/97, …) or an unknown item is refused and the
 * refusal is recorded. Nothing is promoted.
 *
 *   npx tsx ops/anatomy/official-manual-ingest.ts --item M3 --file <path> --url <url> --saved-at <ISO date/time>
 */
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESERVED_ACT_KEYS, RESERVED_SOURCE_IDS } from '../../src/modules/anatomy/config/reserved-act-keys.js';

export const MANUAL_DIR = fileURLToPath(new URL('./official-identification/manual/', import.meta.url));

export interface ManualItem { item: string; act: string; actKey: string; source: 'Planalto' | 'CONFAZ' | 'DOU'; type: string; hosts: string[]; title: RegExp }
/** The pending items of the approved manual list (M6–M8 were collected by the RFB API; M1/M2 also via normas.leg.br). */
export const MANUAL_ITEMS: readonly ManualItem[] = Object.freeze([
  { item: 'M1', act: 'Lei nº 10.637/2002', actKey: 'lei 10637/02', source: 'Planalto', type: 'Lei', hosts: ['www.planalto.gov.br'], title: /LEI\s+N\S*\s*10\.637\s*[,–—-]?\s*DE\s+30\s+DE\s+DEZEMBRO\s+DE\s+2002/iu },
  { item: 'M2', act: 'Lei nº 10.833/2003', actKey: 'lei 10833/03', source: 'Planalto', type: 'Lei', hosts: ['www.planalto.gov.br'], title: /LEI\s+N\S*\s*10\.833\s*[,–—-]?\s*DE\s+29\s+DE\s+DEZEMBRO\s+DE\s+2003/iu },
  { item: 'M3', act: 'Convênio ICMS 142/18', actKey: 'conv 142/18', source: 'CONFAZ', type: 'Convênio ICMS', hosts: ['www.confaz.fazenda.gov.br'], title: /CONV[ÊE]NIO\s+ICMS\s+N?\S*\s*142\s*\/\s*(?:20)?18/iu },
  { item: 'M4', act: 'Convênio ICMS 190/17', actKey: 'conv 190/17', source: 'CONFAZ', type: 'Convênio ICMS', hosts: ['www.confaz.fazenda.gov.br'], title: /CONV[ÊE]NIO\s+ICMS\s+N?\S*\s*190\s*\/\s*(?:20)?17/iu },
  { item: 'M5', act: 'Ajuste SINIEF 07/05', actKey: 'ajuste 7/05', source: 'CONFAZ', type: 'Ajuste SINIEF', hosts: ['www.confaz.fazenda.gov.br'], title: /AJUSTE\s+SINIEF\s+N?\S*\s*0?7\s*\/\s*(?:20)?05/iu },
  { item: 'M9', act: 'IN RFB nº 2.237/2024 na página do DOU', actKey: 'in 2237/24', source: 'DOU', type: 'Página de ato do DOU', hosts: ['www.in.gov.br'],
    title: /Publicado\s+em:?[\s\S]{0,200}Edi[çc][ãa]o[\s\S]{0,200}Se[çc][ãa]o[\s\S]{0,400}INSTRU[ÇC][ÃA]O\s+NORMATIVA\s+RFB\s+N\S*\s*2\.237/iu },
]);

export interface ManualMeta {
  item: string; act: string; source: string; type: string; url: string; savedAt: string; ingestedAt: string; fileName: string;
  sha256: string; bytes: number; declaredCharset: string | null; origin: 'obtido manualmente pelo Fábio — reprodução salva pelo navegador';
  original: false; titleCheck: { pattern: string; matched: string }; representation: 'html' | 'pdf'; promoted: false;
}
export type IngestResult = { status: 'accepted'; meta: ManualMeta } | { status: 'refused'; reason: string };

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const visibleText = (bytes: Uint8Array, charset: string | null): string => {
  const label = charset && /^(utf-?8|windows-1252|iso-8859-1)$/iu.test(charset) ? charset.toLowerCase() : 'utf-8';
  const raw = new TextDecoder(label === 'iso-8859-1' ? 'windows-1252' : label).decode(bytes);
  return raw.replace(/<(script|style)[\s\S]*?<\/\1>/giu, ' ').replace(/<[^>]+>/gu, ' ').replace(/&nbsp;/gu, ' ').replace(/&#(\d+);/gu, (_, n) => String.fromCodePoint(Number(n))).replace(/\s+/gu, ' ');
};

/** Pure check + store. `dir` defaults to MANUAL_DIR; `now` is injectable for tests. */
export function ingestManual(input: { item: string; file: string; url: string; savedAt: string }, dir = MANUAL_DIR, now = () => new Date().toISOString()): IngestResult {
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
  if (Number.isNaN(Date.parse(input.savedAt))) return refuse('savedAt is not a date');
  if (!existsSync(input.file)) return refuse('file not found');
  const bytes = new Uint8Array(readFileSync(input.file));
  if (!bytes.byteLength) return refuse('empty file');
  const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  if (isPdf) return refuse('PDF received: the PDF reader path for manual files needs its own check (title cannot be read here); keep the file and ask for the HTML page');
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 4096));
  const declaredCharset = /charset\s*=\s*["']?([\w-]+)/iu.exec(head)?.[1] ?? null;
  const text = visibleText(bytes, declaredCharset);
  const found = spec.title.exec(text);
  if (!found) return refuse(`expected title not found in the file (${spec.act})`);
  mkdirSync(dir, { recursive: true });
  const fileName = `${spec.item}${input.file.toLowerCase().endsWith('.htm') ? '.htm' : '.html'}`;
  if (existsSync(join(dir, `${spec.item}.meta.json`))) return refuse(`${spec.item} was already ingested; a new capture needs its own decision (bytes are never overwritten)`);
  copyFileSync(input.file, join(dir, fileName));
  const meta: ManualMeta = { item: spec.item, act: spec.act, source: spec.source, type: spec.type, url: input.url, savedAt: new Date(input.savedAt).toISOString(), ingestedAt: now(),
    fileName, sha256: sha(bytes), bytes: bytes.byteLength, declaredCharset, origin: 'obtido manualmente pelo Fábio — reprodução salva pelo navegador', original: false,
    titleCheck: { pattern: spec.title.source, matched: found[0].replace(/\s+/gu, ' ').slice(0, 200) }, representation: 'html', promoted: false };
  if (sha(new Uint8Array(readFileSync(join(dir, fileName)))) !== meta.sha256) throw new Error('stored bytes differ from the received file');
  writeFileSync(join(dir, `${spec.item}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
  return { status: 'accepted', meta };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] ?? '' : ''; };
  const r = ingestManual({ item: arg('--item'), file: arg('--file'), url: arg('--url'), savedAt: arg('--saved-at') });
  console.log(JSON.stringify(r, null, 2)); if (r.status !== 'accepted') process.exitCode = 1;
}
