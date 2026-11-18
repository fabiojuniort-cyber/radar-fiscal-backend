/**
 * E9 / P3 — official coverage matrix "fonte × tipo de ato × variação de layout × porte" (direction approved by Fábio,
 * #116 c.6514510003; E9 criterion STATUS-MATRIX-02 §9; R2 of #303 c.6701945748).
 *
 * ONE grid (`GRID`) is the single source of the mandatory categories: pending cells, absent categories and completeness
 * are all derived from it, so a category with no proof can never let E9 be complete. A cell is covered only by a sample
 * that matches ALL FOUR axes exactly AND reached the `validated` stage. Stages are kept apart:
 *   captured   — bytes present and SHA-256 + size equal to the recorded provenance (checked before any use);
 *   identified — the act's identity was checked in the bytes (title / idAto);
 *   read       — read by the engine with the source's OWN profile (a diagnostic with another profile is not a read);
 *   validated  — conservative invariants hold and the output is locked by a regression baseline run by a CI test;
 *   accepted   — independent review recorded for that sample (none yet: collection acceptance ≠ anatomy acceptance).
 *
 * Size criterion: canonical characters produced by the engine. pequeno < 10.000; médio 10.000–49.999; grande ≥ 50.000.
 * `--write` regenerates docs/anatomy/official-coverage-matrix.json and docs/anatomy/official-samples-baseline.json.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeAnatomy } from '../../src/modules/anatomy/engine.js';
import { ANATOMY_ENGINE_BUILD_HASH } from '../../src/modules/anatomy/build-identity.js';
import { prepareSefazSpPortalPage } from '../../src/modules/anatomy/sefaz-sp-preparation.js';
import { MANUAL_DIR, decodeDeclared, type ManualMeta } from './official-manual-ingest.js';
import { HTTP_DIR, type HttpMeta } from './official-http-ingest.js';
import { APPROVED_FALLBACK, compareWithIndependent, decodeWithPolicy, PASSAGES } from './charset-policy.js';

const ROOT = fileURLToPath(new URL('./official-identification/', import.meta.url));
export const MATRIX_FILE = fileURLToPath(new URL('../../docs/anatomy/official-coverage-matrix.json', import.meta.url));
export const SAMPLES_BASELINE = fileURLToPath(new URL('../../docs/anatomy/official-samples-baseline.json', import.meta.url));
const LOT_BASELINE = fileURLToPath(new URL('../../docs/anatomy/official-lot-rfb.json', import.meta.url));
export type Size = 'pequeno' | 'médio' | 'grande';
export const sizeOf = (chars: number): Size => (chars < 10_000 ? 'pequeno' : chars < 50_000 ? 'médio' : 'grande');
const SIZES: readonly Size[] = ['pequeno', 'médio', 'grande'];
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
/** Canonical JSON (sorted keys) so a digest does not depend on key order. */
const canonJson = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));
/**
 * E9 (tribusca-control#116): formal acceptances are DATA (docs/anatomy/e9-acceptances.json), never a hard-coded `accepted: true`.
 * Same record shape as the NORMAS-LEG branch (#305). For an RFB sample a record counts only while it pins the sha256 of the
 * sample's canonical lot entry AND the current engine identity, and only when the reading is COMPLETE: status complete,
 * 0 unidentified characters, 0 attachments without content, 0 limitations. A partial reading is never accepted.
 */
export const ACCEPTANCES_FILE = fileURLToPath(new URL('../../docs/anatomy/e9-acceptances.json', import.meta.url));
export interface Acceptance { sampleId: string; cellId: string; scope: 'offline'; entrySha256: string; engineBuildHash: string; decidedBy: string; decidedOn: string; ref: string; limits: string[] }
/** R2 B-4: a real calendar date, not just the YYYY-MM-DD shape (2026-13-45 and 2025-02-30 are refused). */
export function realDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(v); if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}
const ACCEPTANCE_KEYS = ['sampleId', 'cellId', 'scope', 'entrySha256', 'engineBuildHash', 'decidedBy', 'decidedOn', 'ref', 'limits'] as const;
/**
 * Strict validation (fail closed): unknown or missing fields, wrong types, a non-hex digest/engine, a non-ISO date, an
 * empty limits list, a cellId outside the grid, an exact duplicate, or two different digests for the same sample on the
 * same engine all REJECT the whole file. Records of samples that are not on this branch (e.g. the NORMAS-LEG history of
 * #305/#309) are kept and simply never match: the file is append-only and composed by union.
 */
export function validateAcceptances(raw: unknown, gridIds: ReadonlySet<string>): Acceptance[] {
  const fail = (m: string): never => { throw new Error(`e9-acceptances.json: ${m}`); };
  const root = raw as { acceptances?: unknown };
  if (!root || typeof root !== 'object' || !Array.isArray(root.acceptances)) fail('missing "acceptances" array');
  const seen = new Map<string, string>(); const exact = new Set<string>();
  return (root.acceptances as unknown[]).map((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) fail(`record ${i} is not an object`);
    const o = r as Record<string, unknown>;
    const extra = Object.keys(o).filter((k) => !(ACCEPTANCE_KEYS as readonly string[]).includes(k) && k !== 'revalidates');
    if (extra.length) fail(`record ${i} has unknown field(s) ${extra.join(', ')}`);
    for (const k of ['sampleId', 'cellId', 'decidedBy', 'ref'] as const) if (typeof o[k] !== 'string' || !(o[k] as string).trim()) fail(`record ${i}: ${k} must be a non-empty string`);
    if (o.scope !== 'offline') fail(`record ${i}: scope must be "offline"`);
    for (const k of ['entrySha256', 'engineBuildHash'] as const) if (typeof o[k] !== 'string' || !/^[0-9a-f]{64}$/u.test(o[k] as string)) fail(`record ${i}: ${k} must be 64 lowercase hex`);
    if (typeof o.decidedOn !== 'string' || !realDate(o.decidedOn)) fail(`record ${i}: decidedOn must be a real YYYY-MM-DD date`);
    if (!Array.isArray(o.limits) || !o.limits.length || o.limits.some((x) => typeof x !== 'string' || !x.trim())) fail(`record ${i}: limits must be a non-empty list of strings`);
    if (o.revalidates !== undefined && typeof o.revalidates !== 'string') fail(`record ${i}: revalidates must be a string`);
    if (!gridIds.has(o.cellId as string)) fail(`record ${i}: cellId "${String(o.cellId)}" is not a grid cell`);
    const key = `${String(o.sampleId)}|${String(o.engineBuildHash)}`; const full = `${key}|${String(o.cellId)}|${String(o.entrySha256)}`;
    if (exact.has(full)) fail(`record ${i}: duplicate of an earlier record (${String(o.sampleId)} on ${String(o.engineBuildHash).slice(0, 8)})`);
    if (seen.has(key) && seen.get(key) !== `${String(o.cellId)}|${String(o.entrySha256)}`) fail(`record ${i}: conflicts with an earlier record for ${String(o.sampleId)} on the same engine`);
    seen.set(key, `${String(o.cellId)}|${String(o.entrySha256)}`); exact.add(full);
    return o as unknown as Acceptance;
  });
}
export const loadAcceptances = (gridIds: ReadonlySet<string>): Acceptance[] =>
  (existsSync(ACCEPTANCES_FILE) ? validateAcceptances(JSON.parse(readFileSync(ACCEPTANCES_FILE, 'utf8')), gridIds) : []);
/**
 * R2 (review B-1/B-2): completeness of the act's OWN material annexes, checked ONE BY ONE (never `some()`, never a mere
 * count). Each own annex the text requires (Anexo I, II, Único…, also lists "Anexos I e II" and ranges "I a III") must be
 * associated with exactly one live Anexo segment carrying the SAME label (from the segment's own heading "ANEXO I" or its
 * file name "Anexo_I…"; both present and different → ambiguous), and that segment must be READ: decoded payload whose
 * sha256 equals a successful-read record (state 'read') of the inline-attachment reader for that idArquivoBinario. The
 * three levels are distinct: present (segment exists) → decoded (valid base64, non-empty) → read (reader evidence).
 * Ambiguous or duplicated associations, unlabeled own mentions ("em anexo", "o Anexo deste Ato") and any external
 * annex (Corat: "será publicado na Internet") are GAPS. Nothing is invented: if the official metadata do not allow a
 * safe association, the gap stays and acceptance stays blocked.
 */
export type AnnexReadEvidence = ReadonlyMap<number, string>; // idArquivoBinario → sha256 of the decoded bytes that were READ
type Seg = { idTipoSegmento: number; tachado?: boolean; textoIntegra?: string | null; arquivoBinario?: { idArquivoBinario?: number; nomeArquivoBinario?: string; arquivoBinario?: unknown } | null };
type RfbJson = { tiposSegmento?: { idTipoSegmento: number; nomeTipoSegmento: string }[]; ementas?: Seg[]; outrosSegmentos?: Seg[];
  epigrafe?: { tipoAto?: { nomeTipoAto?: string }; numeroAto?: string; dataAto?: string } };
const ROMAN: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100 };
const romanValue = (r: string) => { let n = 0; for (let k = 0; k < r.length; k++) { const v = ROMAN[r[k]!]!; const w = ROMAN[r[k + 1]!] ?? 0; n += v < w ? -v : v; } return n; };
const toRoman = (n: number) => [['C', 100], ['XC', 90], ['L', 50], ['XL', 40], ['X', 10], ['IX', 9], ['V', 5], ['IV', 4], ['I', 1]].reduce((acc, [r, v]) => { let out = acc; while (n >= (v as number)) { out += r; n -= v as number; } return out; }, '');
/**
 * R3 (review B2-1): the label is a COMPLETE identity. Canonical form: "UNICO", or the base number (roman or digits) plus
 * an optional single-letter suffix ("1", "1-A", "3-B"). I ≠ I-A ≠ I-B. Anything else ("I-AB", "I.1", "I-1") is NOT
 * converted or truncated: it returns null and the caller records an unsupported label (gap).
 */
export function annexLabel(raw: string): string | null {
  const t = normalizeLabelSeparators(raw).normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().trim().replace(/_/gu, '-');
  if (t === 'UNICO') return 'UNICO';
  // R4 B3-2: a lone L or C (or D/M) is read as a LETTER label, never as roman 50/100: unsupported → gap
  if (/^[LCDM]$/u.test(t)) return null;
  const m = /^([IVXLC]{1,7}|\d{1,3})(?:-([A-Z]))?$/u.exec(t);
  if (!m) return null;
  const base = /^\d+$/u.test(m[1]!) ? String(Number(m[1])) : toRoman(romanValue(m[1]!)) === m[1] ? String(romanValue(m[1]!)) : null;
  return base === null ? null : m[2] ? `${base}-${m[2]}` : base;
}
/**
 * R4 (review R3 B3-1): ONE normalization for mentions AND headings, so both sides read the same identity:
 * "I–A", "I—A", "I - A", "I -A", "I- A", "I-a", "I – a" → "I-A". Applied before any token is read.
 */
const LABEL_SEP = String.raw`[\p{Pd}−﹣－/]`;
export function normalizeLabelSeparators(raw: string): string {
  // R5 B4-1: format characters (zero width, soft hyphen…) never split or hide a suffix
  const t = raw.replace(/\p{Cf}/gu, '');
  return t
    // "I(A)" → "I-A"
    .replace(/\b([IVXLC]+|\d{1,3})\s*\(\s*([A-Za-z]{1,3})\s*\)/gu, (_m, b: string, x: string) => `${b}-${x.toUpperCase()}`)
    // any dash-like separator (Pd, minus, small/full-width hyphen-minus) or "/" between base and letters → "-"
    .replace(new RegExp(String.raw`\b([IVXLC]+|\d{1,3})\s*${LABEL_SEP}\s*([A-Za-z]{1,3})(?![\p{L}\p{N}])`, 'gu'), (_m, b: string, x: string) => `${b}-${x.toUpperCase()}`)
    // R5 B4-2: a dangling separator ("I-", "I –", "I/") is not "I": marked unsupported
    .replace(new RegExp(String.raw`\b([IVXLC]+|\d{1,3})\s*${LABEL_SEP}(?=\s*(?:[^\p{L}\p{N}\s]|\s+[a-zà-ú]|$))`, 'gu'), (_m, b: string) => `${b}-?`);
}
/** Human form of a canonical label for messages: "UNICO" → "Único", "1-A" → "I-A". */
export const labelText = (l: string) => (l === 'UNICO' ? 'Único' : l.replace(/^(\d+)/u, (d) => toRoman(Number(d))));
const fold = (x: string) => x.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
// R4 B3-2: a single capital letter is a token too ("Anexo I, A e B", "Anexo C"), so it is never silently dropped
const TOKEN = String.raw`(?:[ÚU](?:nico|NICO)|[IVXLC]+|\d+|[A-Z])(?:[-.][A-Z0-9?]+)*(?![\p{L}\p{N}?-])`;
const NORM_KIND = String.raw`(?:Lei(?:\s+Complementar)?|Decreto(?:-Lei)?|Instru[çc][ãa]o\s+Normativa|IN|Portaria(?:\s+Conjunta)?|Resolu[çc][ãa]o|Conv[êe]nio|Ajuste|Ato\s+Declarat[óo]rio(?:\s+(?:Executivo|Interpretativo))?|ADE|ADI|Solu[çc][ãa]o\s+de\s+Consulta|Medida\s+Provis[óo]ria|Regulamento|Parecer|Norma|Tabela|NCM|TIPI|RIR|RIPI|RICMS|Protocolo|Emenda)`;
const OWN_AFTER = /^\s+(?:deste|desta|a\s+este|a\s+esta|ao\s+presente|à\s+presente|do\s+presente|da\s+presente)\b/iu;
const REF_AFTER = new RegExp(String.raw`^(?:,?\s*(?:inciso|item|tabela|quadro|parte)\b[^,;.]{0,40})?,?\s+(?:d[ao]s?|à|ao)\s+((?:referid[ao]|citad[ao]|mencionad[ao]|mesm[ao])\s+)?(${NORM_KIND})\b([^;]{0,80})`, 'iu');
export interface AnnexMention { labels: string[]; unsupported: string[]; kind: 'own' | 'other' | 'ambiguous'; text: string }
/**
 * Classifies every annex mention. own: "deste/desta/ao presente…", "em anexo", or a citation of THIS act by kind +
 * number (+ year when given) — R2 B-2 self-citation; other: a citation of ANOTHER identified norm; ambiguous: anything
 * else, including "da referida/citada Portaria" without a proven resolution (counts as own: never accept on a guess).
 */
export function annexMentions(rawText: string, act?: { kind?: string; number?: string; year?: string }): AnnexMention[] {
  const text = normalizeLabelSeparators(rawText);
  const out: AnnexMention[] = [];
  // case-sensitive tokens (roman numerals in capitals) so common words are never read as labels
  const re = new RegExp(String.raw`\b([Aa][Nn][Ee][Xx][Oo][Ss]?)\b((?:\s+${TOKEN}(?:\s*(?:,|e|a|ao)(?=\s+${TOKEN}))?)*)`, 'gu');
  const pos: { start: number; end: number }[] = [];
  for (const m of text.matchAll(re)) {
    pos.push({ start: m.index!, end: m.index! + m[0].length });
    const tokens = [...(m[2] ?? '').matchAll(new RegExp(TOKEN, 'gu'))].map((x) => x[0]);
    const unsupported = tokens.filter((x) => annexLabel(x) === null);
    const listed = tokens.map((x) => annexLabel(x)).filter((x): x is string => !!x);
    const isRange = /\s+(?:a|ao)\s+/u.test(m[2] ?? '') && tokens.length === 2;
    let labels = listed;
    if (isRange) {
      if (listed.length === 2 && /^\d+$/u.test(listed[0]!) && /^\d+$/u.test(listed[1]!)) labels = Array.from({ length: Math.max(0, Number(listed[1]) - Number(listed[0]) + 1) }, (_x, k) => String(Number(listed[0]) + k));
      else { labels = []; unsupported.push(`range ${tokens.join(' a ')}`); }
    }
    const before = text.slice(Math.max(0, m.index! - 12), m.index!); const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 200);
    const ctx = `${m[0]}${after.slice(0, 80)}`;
    if (OWN_AFTER.test(after) || /\bem\s+$/iu.test(before)) { out.push({ labels, unsupported, kind: 'own', text: ctx }); continue; }
    const ref = REF_AFTER.exec(after);
    if (!ref) { out.push({ labels, unsupported, kind: 'ambiguous', text: ctx }); continue; }
    if (ref[1]) { out.push({ labels, unsupported, kind: 'ambiguous', text: ctx }); continue; } // "da referida Portaria": unresolved
    const kind = fold(ref[2]!).replace(/\s+/gu, ' '); const tail = ref[3] ?? '';
    const num = /\bn\s*[º°o.]*\s*([\d.]+)/iu.exec(tail)?.[1]?.replace(/\./gu, '');
    const year = /\bde\s+(?:\d{1,2}\s+de\s+\w+\s+de\s+)?(\d{4})\b/iu.exec(tail)?.[1];
    const actKind = act?.kind ? fold(act.kind) : null;
    const sameKind = !!actKind && (actKind.startsWith(kind) || kind.startsWith(actKind.split(' ')[0]!));
    if (sameKind && num && act?.number && num === act.number.replace(/\D/gu, '') && (!year || !act.year || year === act.year)) { out.push({ labels, unsupported, kind: 'own', text: ctx }); continue; }
    if (sameKind && !num) { out.push({ labels, unsupported, kind: 'ambiguous', text: ctx }); continue; }
    out.push({ labels, unsupported, kind: 'other', text: ctx });
  }
  // Coordination: "o Anexo I e o Anexo II desta Portaria" — an ambiguous mention joined ONLY by a coordinator to the
  // next mention inherits that mention's resolved kind (right to left, so chains resolve).
  for (let k = out.length - 2; k >= 0; k--) {
    const gap = text.slice(pos[k]!.end, pos[k + 1]!.start);
    if (out[k]!.kind === 'ambiguous' && out[k + 1]!.kind !== 'ambiguous' && /^\s*(?:,|e|ou)\s*(?:(?:o|a|os|as|do|da|dos|das|no|na)\s+)?$/iu.test(gap)) out[k]!.kind = out[k + 1]!.kind;
  }
  return out;
}
export interface AnnexAudit { required: { label: string | null; kind: string }[]; segments: { id: number | null; label: string | null; state: 'present' | 'decoded' | 'read'; duplicate: boolean }[]; gaps: string[] }
export function annexAudit(json: Buffer, read: AnnexReadEvidence = new Map()): AnnexAudit {
  const r = JSON.parse(json.toString('utf8')) as RfbJson;
  const name = new Map((r.tiposSegmento ?? []).map((t) => [t.idTipoSegmento, t.nomeTipoSegmento]));
  const live = [...(r.ementas ?? []), ...(r.outrosSegmentos ?? [])].filter((x) => x.tachado !== true);
  const strip = (h: string) => h.replace(/<[^>]+>/gu, ' ').replace(/&nbsp;/gu, ' ').replace(/\s+/gu, ' ').trim();
  const text = live.filter((x) => name.get(x.idTipoSegmento) !== 'Ementa' && name.get(x.idTipoSegmento) !== 'Anexo').map((x) => strip(x.textoIntegra ?? '')).join(' ');
  const e = r.epigrafe ?? {};
  const mentions = annexMentions(text, { kind: e.tipoAto?.nomeTipoAto, number: e.numeroAto, year: e.dataAto?.slice(0, 4) });
  const required: AnnexAudit['required'] = [];
  for (const m of mentions.filter((x) => x.kind !== 'other')) {
    for (const u of m.unsupported) required.push({ label: `?${u}`, kind: m.kind });
    if (!m.labels.length && !m.unsupported.length) required.push({ label: null, kind: m.kind });
    for (const l of m.labels) if (!required.some((q) => q.label === l)) required.push({ label: l, kind: m.kind });
  }
  const segments: AnnexAudit['segments'] = []; const digests = new Map<string, number>();
  const anexos = live.filter((x) => name.get(x.idTipoSegmento) === 'Anexo' || (x.arquivoBinario && typeof x.arquivoBinario === 'object'));
  const decodedSha: (string | null)[] = anexos.map((x) => {
    const p = x.arquivoBinario?.arquivoBinario;
    if (typeof p !== 'string' || !p.length) return null;
    const c = p.replace(/\s+/gu, ''); if (c.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(c)) return null;
    const b = Buffer.from(c, 'base64'); return b.byteLength ? sha(b) : null;
  });
  for (const d of decodedSha) if (d) digests.set(d, (digests.get(d) ?? 0) + 1);
  anexos.forEach((x, k) => {
    // R3 B2-1: the whole token is the label; an unparseable token marks the segment UNUSABLE (never truncated).
    const head = /^ANEXO\s+(\S+)/iu.exec(normalizeLabelSeparators(strip(x.textoIntegra ?? '')))?.[1]?.replace(/[.:;,]+$/u, '');
    const file = /anexo[\s_-]*([ÚúUu]nico|[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*)(?=[^A-Za-z0-9_-]|$)/iu.exec(x.arquivoBinario?.nomeArquivoBinario ?? '')?.[1];
    const UNUSABLE = '\u0000unusable';
    const lh = head ? (annexLabel(head) ?? UNUSABLE) : null; const lf = file ? (annexLabel(file) ?? UNUSABLE) : null;
    const label = (lh && lf && lh !== lf) || lh === UNUSABLE || lf === UNUSABLE ? null : (lh ?? lf);
    const id = typeof x.arquivoBinario?.idArquivoBinario === 'number' ? x.arquivoBinario.idArquivoBinario : null;
    const d = decodedSha[k];
    const state = d && id !== null && read.get(id) === d ? 'read' : d ? 'decoded' : 'present';
    segments.push({ id, label, state, duplicate: !!d && (digests.get(d) ?? 0) > 1 });
  });
  const gaps: string[] = [];
  for (const q of required) {
    if (q.label === null) { gaps.push(`${q.kind} annex mention without a label: association not provable`); continue; }
    if (q.label.startsWith('?')) { gaps.push(`${q.kind} annex label "${q.label.slice(1)}" not supported: association not provable`); continue; }
    const hits = segments.filter((s) => s.label === q.label);
    const L = labelText(q.label);
    if (!hits.length) { gaps.push(`Anexo ${L} (${q.kind}) absent from the representation`); continue; }
    if (hits.length > 1) { gaps.push(`Anexo ${L}: ${hits.length} candidate segments (ambiguous)`); continue; }
    const h = hits[0]!;
    if (h.duplicate) gaps.push(`Anexo ${L}: content duplicated in another annex segment`);
    else if (h.state !== 'read') gaps.push(`Anexo ${L}: ${h.state}, not read`);
  }
  return { required, segments, gaps };
}
/** Gap message for the sample (null when every required own annex is individually present AND read). */
export function annexGap(json: Buffer, read: AnnexReadEvidence = new Map()): string | null {
  const a = annexAudit(json, read);
  return a.gaps.length ? `own annex completeness: ${a.gaps.join('; ')}` : null;
}
const BODY_PARTS = ['article', 'caput', 'paragraph', 'inciso', 'alinea', 'item', 'group'];
export const lotEntrySha256 = (e: unknown) => sha(canonJson(e));
type LotAct = { idAto: number; epigrafe: string; canonicalChars: number; sha256: string; bytes: number; promoted: boolean; outputHash: string; status?: string; partTypes?: Record<string, number>;
  inlineAttachments?: { read?: { id: number; sha256: string; referenceContext?: string }[] };
  unidentifiedChars?: number; attachmentsWithoutContent?: number; limitations?: Record<string, number> };
/** Why an RFB lot reading is not complete (empty = complete). */
export const incompleteness = (a: LotAct, readAttachments = 0): string[] => { const awc = Math.max(0, (a.attachmentsWithoutContent ?? 0) - readAttachments); return [
  ...(a.status !== 'complete' ? [`status ${String(a.status)}`] : []), ...((a.unidentifiedChars ?? 0) > 0 ? [`${a.unidentifiedChars} unidentified chars`] : []),
  ...(awc > 0 ? [`${awc} attachment(s) without content`] : []),
  ...(Object.keys(a.limitations ?? {}).length ? [`limitations ${Object.keys(a.limitations ?? {}).join(', ')}`] : [])]; };
/**
 * R4 (B2-2, items 1–3): ONE assessment of an RFB sample's reading completeness, shared by the matrix and its tests.
 * - Read evidence = the lot's inlineAttachments.read[] (producer: the #300 inline-attachment reader), id → sha256.
 *   Only `id` and `sha256` are used: COMPLETENESS IS INDEPENDENT OF THE OPERATIVE CONTEXT (referenceContext is a
 *   separate axis, decided elsewhere; a fully read annex may still be prohibited/undetermined in force — COORD R4).
 * - attachmentsWithoutContent of the main preparation is NETTED by the annexes the audit proves READ (same id, same
 *   sha256 of the decoded bytes); never by a mere count of evidence records.
 * - Pointers are not stored in the lot: they are recomputed deterministically from the preserved bytes (item 4).
 */
export function rfbReadingAssessment(a: LotAct, json: Buffer): { complete: boolean; bodyAbsent: boolean; readAttachments: number; gaps: string[] } {
  const ev: AnnexReadEvidence = new Map((a.inlineAttachments?.read ?? []).map((x) => [x.id, x.sha256]));
  const audit = annexAudit(json, ev);
  const readAttachments = audit.segments.filter((x) => x.state === 'read').length;
  const awc = Math.max(0, (a.attachmentsWithoutContent ?? 0) - readAttachments);
  const bodyAbsent = awc > 0 && !Object.keys(a.partTypes ?? {}).some((t) => BODY_PARTS.includes(t));
  const gaps = [...incompleteness(a, readAttachments), ...(audit.gaps.length ? [`own annex completeness: ${audit.gaps.join('; ')}`] : [])];
  return { complete: !bodyAbsent && gaps.length === 0, bodyAbsent, readAttachments, gaps };
}

// ---------------------------------------------------------------------------------------------------------------------
// The single grid. Layout names are exact strings; a sample must carry the same string to match.
export const LAYOUT = Object.freeze({
  RFB_JSON: 'JSON multivigente (API normasinternet2)',
  PLANALTO_HTML: 'HTML compilado do Planalto (ccivil_03)',
  NORMASLEG_HTML: 'HTML do normas.leg.br (exportado do Word)',
  CONFAZ_HTML: 'HTML da página do CONFAZ (Plone)',
  DOU_HTML: 'HTML da página do ato no in.gov.br',
  DOU_PDF_PAGE: 'PDF da página do jornal (INPDFViewer)',
  SP_PORTAL_HTML: 'HTML SharePoint, região "Conteúdo da Página"',
  DOESP_JSON: 'JSON API v2 (HTML em content)',
});
export interface GridCell {
  id: string; source: string; type: string; layout: string; size: Size | 'n/a';
  /** n/a size or a non-required cell needs a verifiable justification. */
  applicability: { required: true } | { required: false; justification: string; evidence: string };
  sizeJustification?: string; route: string; manualItems?: string[];
}
const slug = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '');
const bySize = (source: string, type: string, layout: string, route: string, manualItems: Record<string, string[]> = {}): GridCell[] =>
  SIZES.map((size) => ({ id: `${slug(source)}--${slug(type)}--${slug(size)}`, source, type, layout, size, applicability: { required: true }, route,
    ...(manualItems[size] ? { manualItems: manualItems[size] } : {}) }));
/** Governance record (not a function parameter): the grid v1 was APPROVED by the COORD as the planning/demonstration
 * grid (#116 c.6708512598 §2). Approval does not accept any cell, does not change project weights and does not close E9. */
export const GRID_APPROVAL = Object.freeze({ approved: true as const, ref: 'tribusca-control#116 c.6708512598 §2', version: 'v1',
  scope: 'grade de planejamento e demonstração fonte × tipo × layout × porte; 61 células aplicáveis; N/A só com justificativa e decisão registrada' });
export const GRID_STATUS = `aprovada (${GRID_APPROVAL.ref}) — não aceita células, não fecha E9`;
export const GRID: readonly GridCell[] = Object.freeze([
  ...['Instrução Normativa', 'Portaria', 'Ato Declaratório Interpretativo', 'Ato Declaratório Executivo', 'Solução de Consulta', 'Resolução']
    .flatMap((t) => bySize('RFB', t, LAYOUT.RFB_JSON, t === 'Instrução Normativa' ? 'API RFB (coletado)' : 'API RFB — P2-c (autorizada, c.6701950134)')),
  ...bySize('Planalto', 'Lei', LAYOUT.PLANALTO_HTML, 'arquivo manual (a origem recusa este ambiente)', { grande: ['M1', 'M2'] }),
  ...bySize('normas.leg.br', 'Lei', LAYOUT.NORMASLEG_HTML, 'normas.leg.br (acessível; sem perfil de leitura próprio — L-LEG-01)'),
  // M3 and M4 are two Convênios ICMS; each is a SAMPLE whose measured size decides the cell it may cover — neither closes
  // a cell by being received, and one never stands for the other (no OR between items).
  ...bySize('CONFAZ', 'Convênio ICMS', LAYOUT.CONFAZ_HTML, 'arquivo manual (M3, M4)'),
  // M5 was listed as "porte pequeno"; its measured size decides (Ajuste SINIEF 07/05 is long). The list label never closes a cell.
  ...bySize('CONFAZ', 'Ajuste SINIEF', LAYOUT.CONFAZ_HTML, 'arquivo manual (M5 recebido; demais portes a selecionar)'),
  ...bySize('CONFAZ', 'Protocolo ICMS', LAYOUT.CONFAZ_HTML, 'arquivo manual (a selecionar)'),
  ...['Instrução Normativa', 'Decreto', 'Portaria', 'Resolução', 'Despacho'].flatMap((t) => bySize('DOU', t, LAYOUT.DOU_HTML, t === 'Instrução Normativa' ? 'arquivo manual (M9 em HTML)' : 'arquivo manual (a selecionar)')),
  { id: 'dou--pagina-do-jornal--na', source: 'DOU', type: 'Página do jornal (cabeçalho e rodapé)', layout: LAYOUT.DOU_PDF_PAGE, size: 'n/a', applicability: { required: true },
    sizeJustification: 'uma página do jornal não tem porte de ato; a célula prova cabeçalho/rodapé e não a completude do ato', route: 'M9: páginas 57 e 58 em PDF recebidas e identificadas; leitura da página não validada (ordem de colunas exige preparação própria)', manualItems: ['M9'] },
  ...bySize('SEFAZ-SP-PORTAL', 'Decreto consolidado (RICMS/2000), artigo', LAYOUT.SP_PORTAL_HTML, 'coletor oficial (coletado)'),
  ...['Decreto', 'Resolução', 'Portaria CAT'].flatMap((t) => bySize('DOE-SP', t, LAYOUT.DOESP_JSON, 'P2-d (autorizada só depois da validação de M9)')),
]);

// ---------------------------------------------------------------------------------------------------------------------
export interface Sample {
  id: string; source: string; type: string; layout: string; chars: number | null; size: Size | null; sha256: string; bytes: number;
  stages: { captured: boolean; identified: boolean; read: boolean; validated: boolean; accepted: boolean };
  /** R2 B-3: true = complete reading (no partial status, no unidentified text, every material annex read); false = partial; null = not assessed for this source. Independent of `validated` (invariants + baseline). */
  readingComplete?: boolean | null;
  profile: string | null; diagnostic: { profile: string; chars: number } | null; outputHash: string | null; evidence: string[]; notes: string[];
  /** Only for snapshots decoded under the approved local fallback (charset-policy.ts); never a declared charset. */
  decoding?: { encoding: string; encodingSource: string; confidence: string; declaredCharset: null; independentCheck: { passage: string; sentenceEqual: boolean }[] };
}
export class SampleIntegrityError extends Error {}

/** Bytes are checked against the recorded provenance BEFORE any use; a divergence refuses the whole matrix. */
export function verifiedBytes(path: string, expected: { sha256: string; bytes: number }, id: string): Uint8Array {
  const b = new Uint8Array(readFileSync(path));
  if (b.byteLength !== expected.bytes || sha(b) !== expected.sha256) throw new SampleIntegrityError(`${id}: bytes differ from the recorded provenance (${b.byteLength} bytes, ${sha(b).slice(0, 12)}…)`);
  return b;
}
interface Read { chars: number; outputHash: string; invariants: string[] }
/** Conservative invariants every validated sample must keep (protection, not interpretation). */
function readWith(source: 'DOU' | 'CONFAZ' | 'SEFAZ-SP-PORTAL', id: string, html: string, extra: object = {}): Read {
  const r = analyzeAnatomy({ publicationVersionId: id, referenceDate: '2026-11-07', ruleSet: { id: 'official-coverage-matrix', version: '2' },
    input: { source, representationId: id, html, ...extra }, catalog: { edition: 'none', codes: [] } });
  const broken: string[] = [];
  if (r.parts.some((p) => p.legalStatus !== 'unknown')) broken.push('legalStatus must stay unknown');
  if (r.parts.some((p) => p.type === 'quoted_text' && p.context === 'operative_candidate')) broken.push('quoted text must never be operative');
  if (r.parts.some((p) => p.type === 'unidentified') && r.status === 'complete') broken.push('unidentified content cannot be complete');
  return { chars: r.canonicalText.length, outputHash: r.outputHash, invariants: broken };
}
type BaselineEntry = { id: string; sha256: string; profile: string; outputHash: string; chars: number };
const loadBaseline = (): BaselineEntry[] => (existsSync(SAMPLES_BASELINE) ? (JSON.parse(readFileSync(SAMPLES_BASELINE, 'utf8')) as { samples: BaselineEntry[] }).samples : []);

export function collectSamples(baseline: BaselineEntry[] = loadBaseline(), acceptances: Acceptance[] = loadAcceptances(new Set(GRID.map((c) => c.id)))): Sample[] {
  const out: Sample[] = [];
  const locked = (id: string, s: string, profile: string, rd: Read) => {
    const b = baseline.find((x) => x.id === id);
    return rd.invariants.length === 0 && !!b && b.sha256 === s && b.profile === profile && b.outputHash === rd.outputHash;
  };
  // RFB — the reproducible lot: bytes checked against the snapshot meta AND the lot baseline; the lot test re-runs it.
  const lot = JSON.parse(readFileSync(LOT_BASELINE, 'utf8')) as { acts: LotAct[] };
  for (const dir of ['rfb-normasinternet2', 'rfb-normasinternet2-coleta02', 'rfb-p2c']) {
    const d = join(ROOT, dir); if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((x) => /^\d+\.meta\.json$/u.test(x)).sort()) {
      const m = JSON.parse(readFileSync(join(d, f), 'utf8')) as { id: string; sha256: string; bytes: number; identification?: { epigrafe?: string }; p2c?: { type: string } };
      m.id = f.slice(0, -'.meta.json'.length); // the file name is the identity (older metas carry no id field)
      verifiedBytes(join(d, `${m.id}.json`), m, `rfb:${m.id}`);
      const a = lot.acts.find((x) => String(x.idAto) === m.id);
      const epi = m.identification?.epigrafe ?? a?.epigrafe ?? '';
      const type = m.p2c?.type ?? (/^Instru[çc][ãa]o Normativa/iu.test(epi) ? 'Instrução Normativa' : epi);
      const inLot = !!a && a.sha256 === m.sha256;
      // The body lives in an attachment the representation does not carry (e.g. a Solução de Consulta PDF): the measured
      // text is not the act, so its size is UNDETERMINED and the sample never covers a size cell.
      const assess = a ? rfbReadingAssessment(a, readFileSync(join(d, `${m.id}.json`))) : null;
      const bodyAbsent = !!assess?.bodyAbsent;
      const gaps = assess?.gaps ?? [];
      const size = a && !bodyAbsent ? sizeOf(a.canonicalChars) : null;
      const sample: Sample = { id: `rfb:${m.id}`, source: 'RFB', type, layout: LAYOUT.RFB_JSON, chars: a && !bodyAbsent ? a.canonicalChars : null, size, sha256: m.sha256, bytes: m.bytes,
        stages: { captured: true, identified: !!epi, read: inLot, validated: inLot && !bodyAbsent, accepted: false }, profile: inLot ? 'RFB' : null, diagnostic: null, outputHash: a?.outputHash ?? null,
        evidence: inLot ? ['docs/anatomy/official-lot-rfb.json', 'test/anatomy.official-lot-rfb.unit.test.ts (re-runs the lot; fails on drift)'] : [],
        notes: !inLot ? ['not yet in the reproducible lot']
          : [...(bodyAbsent ? ['body in an attachment absent from the representation: size UNDETERMINED, never covers a size cell'] : []),
            ...(gaps.length ? [`partial reading — never accepted as complete: ${gaps.join('; ')}`] : [])] };
      // Acceptance: a record must name THIS sample, the grid cell it really falls in, its current lot digest and the
      // current engine; the reading must be complete and carry every material annex.
      sample.readingComplete = inLot ? !bodyAbsent && gaps.length === 0 : null;
      const cell = GRID.find((c) => matches(c, sample))?.id;
      sample.stages.accepted = inLot && !bodyAbsent && gaps.length === 0 && !!cell && acceptances.some((x) => x.sampleId === sample.id && x.cellId === cell
        && x.scope === 'offline' && x.entrySha256 === lotEntrySha256(a) && x.engineBuildHash === ANATOMY_ENGINE_BUILD_HASH);
      if (sample.stages.accepted) sample.evidence.push('docs/anatomy/e9-acceptances.json');
      out.push(sample);
    }
  }
  // Sefaz-SP consolidated legislation portal: read only through its proven preparation (typed source).
  const sp = join(ROOT, 'doesp-ricms');
  for (const f of readdirSync(sp).filter((x) => x.endsWith('.meta.json')).sort()) {
    const m = JSON.parse(readFileSync(join(sp, f), 'utf8')) as { id: string; url: string; sha256: string; bytes: number };
    const bytes = verifiedBytes(join(sp, `${m.id}.html`), m, m.id);
    const prep = prepareSefazSpPortalPage({ resourceId: m.id, url: m.url, bytes });
    const rd = readWith('SEFAZ-SP-PORTAL', m.id, prep.html, { sefazSpPortal: prep });
    const ok = locked(m.id, m.sha256, 'SEFAZ-SP-PORTAL', rd);
    out.push({ id: m.id, source: 'SEFAZ-SP-PORTAL', type: 'Decreto consolidado (RICMS/2000), artigo', layout: LAYOUT.SP_PORTAL_HTML, chars: rd.chars, size: sizeOf(rd.chars), sha256: m.sha256, bytes: m.bytes,
      stages: { captured: true, identified: true, read: true, validated: ok, accepted: false }, profile: 'SEFAZ-SP-PORTAL', diagnostic: null, outputHash: rd.outputHash,
      evidence: ok ? ['docs/anatomy/official-samples-baseline.json', 'test/anatomy.official-coverage.unit.test.ts'] : [], notes: rd.invariants });
  }
  // normas.leg.br: captured and identified; NO reader profile of its own → not read, not validated. The DOU-profile
  // reading is kept as a diagnostic only (it never changes the source identity nor closes a cell).
  const lg = join(ROOT, 'leg-normas');
  for (const f of readdirSync(lg).filter((x) => /-(original|atualizada)\.meta\.json$/u.test(x)).sort()) {
    const m = JSON.parse(readFileSync(join(lg, f), 'utf8')) as { id: string; sha256: string; bytes: number; titleCheck: { found: boolean } };
    const bytes = verifiedBytes(join(lg, `${m.id}.html`), m, m.id);
    const diag = readWith('DOU', m.id, new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    out.push({ id: m.id, source: 'normas.leg.br', type: 'Lei', layout: LAYOUT.NORMASLEG_HTML, chars: null, size: null, sha256: m.sha256, bytes: m.bytes,
      stages: { captured: true, identified: m.titleCheck.found, read: false, validated: false, accepted: false }, profile: null,
      diagnostic: { profile: 'DOU (diagnóstico)', chars: diag.chars }, outputHash: null, evidence: [], notes: ['sem perfil de leitura próprio (L-LEG-01); porte não atribuído sem leitura própria'] });
  }
  // Files saved by hand and ingested (official-manual-ingest.ts): bytes and declared encoding are checked first.
  if (existsSync(MANUAL_DIR)) for (const f of readdirSync(MANUAL_DIR).filter((x) => /^M\d+\.meta\.json$/u.test(x)).sort()) {
    const m = JSON.parse(readFileSync(join(MANUAL_DIR, f), 'utf8')) as ManualMeta;
    const bytes = verifiedBytes(join(MANUAL_DIR, m.fileName), m, m.item);
    const html = decodeDeclared(bytes, m.declaredCharset);
    const profile = m.source === 'CONFAZ' ? 'CONFAZ' : m.source === 'DOU' ? 'DOU' : null;
    const layout = m.source === 'CONFAZ' ? LAYOUT.CONFAZ_HTML : m.source === 'DOU' ? LAYOUT.DOU_HTML : LAYOUT.PLANALTO_HTML;
    if (!profile) { out.push({ id: m.item, source: m.source, type: m.type, layout, chars: null, size: null, sha256: m.sha256, bytes: m.bytes,
      stages: { captured: true, identified: true, read: false, validated: false, accepted: false }, profile: null, diagnostic: null, outputHash: null, evidence: [], notes: ['sem perfil de leitura próprio'] }); continue; }
    const rd = readWith(profile, m.item, html);
    const ok = locked(m.item, m.sha256, profile, rd);
    out.push({ id: m.item, source: m.source, type: m.type, layout, chars: rd.chars, size: sizeOf(rd.chars), sha256: m.sha256, bytes: m.bytes,
      stages: { captured: true, identified: true, read: true, validated: ok, accepted: false }, profile, diagnostic: null, outputHash: rd.outputHash,
      evidence: ok ? ['docs/anatomy/official-samples-baseline.json', 'test/anatomy.official-coverage.unit.test.ts'] : [], notes: rd.invariants });
  }
  // HTTP response bytes captured by another session and delivered by git (official-http-ingest.ts): provenance of their
  // own; encoding never inferred; the DOU PDF page is header/footer evidence, not a validated act anatomy.
  if (existsSync(HTTP_DIR)) for (const f of readdirSync(HTTP_DIR).filter((x) => /^M\d+(-p\d+)?\.meta\.json$/u.test(x)).sort()) {
    const m = JSON.parse(readFileSync(join(HTTP_DIR, f), 'utf8')) as HttpMeta;
    const bytes = verifiedBytes(join(HTTP_DIR, m.fileName), m, `http:${m.item}`);
    const id = `http:${m.item}`;
    const base = { id, source: m.source, type: m.type, sha256: m.sha256, bytes: m.bytes, diagnostic: null, evidence: [] as string[] };
    if (m.representation === 'pdf') { out.push({ ...base, layout: LAYOUT.DOU_PDF_PAGE, chars: null, size: null, stages: { captured: true, identified: true, read: false, validated: false, accepted: false },
      profile: null, outputHash: null, notes: [m.reach] }); continue; }
    const layout = m.source === 'CONFAZ' ? LAYOUT.CONFAZ_HTML : LAYOUT.PLANALTO_HTML;
    if (!m.readable || m.source !== 'CONFAZ') {
      let decoding: Sample['decoding'];
      if (m.source === 'Planalto' && APPROVED_FALLBACK[m.sha256]) {
        const d = decodeWithPolicy(bytes, { httpCharset: null });
        const leg = m.item === 'M1' ? 'lei-10637-2002-atualizada' : 'lei-10833-2003-atualizada';
        const indep = readFileSync(join(ROOT, 'leg-normas', `${leg}.html`), 'utf8');
        decoding = { encoding: d.encoding, encodingSource: d.encodingSource, confidence: d.confidence, declaredCharset: null,
          independentCheck: compareWithIndependent(d.text, indep, PASSAGES[m.item] ?? []).map((c) => ({ passage: c.passage, sentenceEqual: c.sentenceEqual })) };
      }
      out.push({ ...base, layout, chars: null, size: null, stages: { captured: true, identified: true, read: false, validated: false, accepted: false },
        profile: null, outputHash: null, notes: [decoding ? 'charset: fallback local aprovado (tentative); leitura habilitada para preparação, sem perfil Planalto — não lido nem validado' : (m.readableNote ?? 'sem perfil de leitura próprio')],
        ...(decoding ? { decoding } : {}) }); continue; }
    const rd = readWith('CONFAZ', id, decodeDeclared(bytes, m.declaredCharset));
    const ok = locked(id, m.sha256, 'CONFAZ', rd);
    out.push({ ...base, layout, chars: rd.chars, size: sizeOf(rd.chars), stages: { captured: true, identified: true, read: true, validated: ok, accepted: false }, profile: 'CONFAZ',
      outputHash: rd.outputHash, evidence: ok ? ['docs/anatomy/official-samples-baseline.json', 'test/anatomy.official-coverage.unit.test.ts'] : [], notes: rd.invariants });
  }
  return out;
}

/** The regression lock for non-RFB samples read with their own profile (regenerated only with --write). */
export function samplesBaseline(samples: Sample[]): { samples: BaselineEntry[] } {
  return { samples: samples.filter((s) => s.profile && s.outputHash && s.source !== 'RFB' && s.notes.length === 0)
    .map((s) => ({ id: s.id, sha256: s.sha256, profile: s.profile!, outputHash: s.outputHash!, chars: s.chars! })) };
}

export const matches = (c: GridCell, s: Sample) => s.source === c.source && s.type === c.type && s.layout === c.layout && (c.size === 'n/a' || s.size === c.size);
export function buildMatrix(samples = collectSamples(), grid: readonly GridCell[] = GRID, gridApproved: boolean = GRID_APPROVAL.approved) {
  const cells = grid.map((c) => {
    const hits = samples.filter((s) => matches(c, s));
    const validated = hits.filter((s) => s.stages.validated).map((s) => s.id);
    const vs = hits.filter((s) => s.stages.validated);
    // R2 B-3: layout coverage (status) is unchanged; completeness is reported beside it, never folded into the count.
    const complete = !vs.length ? null : vs.some((s) => s.readingComplete === true) ? true : vs.every((s) => s.readingComplete === null || s.readingComplete === undefined) ? null : false;
    return { ...c, status: validated.length ? 'covered' as const : 'pending' as const, validatedSamples: validated, complete,
      partialSamples: vs.filter((s) => s.readingComplete === false).map((s) => s.id), accepted: hits.some((s) => s.stages.accepted),
      unvalidatedSamples: hits.filter((s) => !s.stages.validated).map((s) => ({ id: s.id, stages: s.stages })) };
  });
  const required = cells.filter((c) => c.applicability.required);
  const pending = required.filter((c) => c.status === 'pending').map((c) => c.id);
  const unmatched = samples.filter((s) => !grid.some((c) => matches(c, s)) && s.size !== null).map((s) => s.id);
  return { criterion: { approval: 'tribusca-control#116 c.6514510003; E9: STATUS-MATRIX-02 §9 (sem fração); R2 #303 c.6701945748',
    size: 'pequeno < 10.000; médio 10.000–49.999; grande ≥ 50.000 caracteres do texto canônico do motor', stages: 'captured → identified → read (perfil próprio) → validated (invariantes + baseline em teste de CI) → accepted (revisão)' },
    grid: { status: GRID_STATUS, approved: gridApproved, approval: GRID_APPROVAL, cells: grid.length, required: required.length },
    samples, cells, requiredPending: pending, coveredRequired: required.length - pending.length, samplesOutsideGrid: unmatched,
    e9MatrixComplete: gridApproved && pending.length === 0 };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--write')) {
    const first = collectSamples([]);
    writeFileSync(SAMPLES_BASELINE, `${JSON.stringify(samplesBaseline(first), null, 2)}\n`);
  }
  const m = buildMatrix();
  if (process.argv.includes('--write')) writeFileSync(MATRIX_FILE, `${JSON.stringify(m, null, 2)}\n`);
  for (const c of m.cells.filter((x) => x.status === 'covered' || x.unvalidatedSamples.length)) console.log(`${c.status === 'covered' ? '✅' : '…'} ${c.id} | validated: ${c.validatedSamples.join(', ') || '—'} | not validated: ${c.unvalidatedSamples.map((u) => u.id).join(', ') || '—'}`);
  console.log(`grid ${m.grid.cells} cells (${m.grid.required} required); covered ${m.coveredRequired}; pending ${m.requiredPending.length}; complete: ${m.e9MatrixComplete}`);
}
