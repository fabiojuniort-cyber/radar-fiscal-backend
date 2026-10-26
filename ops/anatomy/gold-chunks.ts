import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../../src/modules/anatomy/contract.js';
import { goldContentSha256, type AnatomyGold } from '../../src/modules/anatomy/gold.js';
import { developmentCanonicalText } from './annotation-pack.js';

/**
 * Review-only split of a large gold file into readable chunks. The committed gold file stays the single source
 * of truth; chunks are regenerated from it and a test requires that they reassemble it exactly.
 * Usage: tsx ops/anatomy/gold-chunks.ts <id|all> [--write]   (without --write it verifies)
 */
const root = new URL('../../', import.meta.url);
const sha = (v: string): string => createHash('sha256').update(v, 'utf8').digest('hex');
const CHUNK = 250;
const TEXT_CHUNK = 40_000;
export const REVIEW_IDS = ['01', '02', '03', '05', '07', '10', '11'] as const;
const GOLD_CHUNKED: readonly string[] = ['01', '10'];
export const chunkDir = (id: string) => new URL(`docs/anatomy/gold-review/${id}/`, root);

export function goldChunks(id: string): Map<string, string> {
  const fileText = readFileSync(new URL(`test/fixtures/anatomy/gold/${id}.json`, root), 'utf8').replace(/\r\n/g, '\n');
  const gold = JSON.parse(fileText) as AnatomyGold;
  const { parts, entities, relations, ...header } = gold;
  const files = new Map<string, string>(); const chunks: { file: string; section: string; from: number; to: number; sha256: string }[] = [];
  const put = (file: string, section: string, from: number, to: number, value: unknown) => {
    const body = JSON.stringify(value, null, 1) + '\n'; files.set(file, body); chunks.push({ file, section, from, to, sha256: sha(body) });
  };
  if (GOLD_CHUNKED.includes(id)) {
    put('00-header.json', 'header', 0, 0, header);
    for (const [section, list] of [['parts', parts], ['entities', entities], ['relations', relations]] as const) {
      for (let i = 0, n = 1; i < list.length; i += CHUNK, n++) put(`${section}-${String(n).padStart(3, '0')}.json`, section, i, Math.min(i + CHUNK, list.length), list.slice(i, i + CHUNK));
    }
  }
  // Canonical text in UTF-16 windows cut at line breaks, stored as JSON strings so no checkout can alter it.
  const text = developmentCanonicalText(id);
  for (let start = 0, n = 1; start < text.length; n++) {
    let end = Math.min(start + TEXT_CHUNK, text.length);
    if (end < text.length) { const nl = text.lastIndexOf('\n', end); if (nl > start) end = nl + 1; }
    put(`canonical-${String(n).padStart(3, '0')}.json`, 'canonicalText', start, end, { from: start, to: end, text: text.slice(start, end) });
    start = end;
  }
  const manifest = { id, purpose: 'Leitura em partes para revisão; o gold completo e o texto canônico congelado continuam sendo a fonte.',
    goldFile: `test/fixtures/anatomy/gold/${id}.json`, goldFileSha256Lf: sha(fileText), goldCanonicalJsonSha256: sha(canonicalJson(gold)),
    goldContentSha256: goldContentSha256(gold), canonicalTextSha256: gold.canonicalTextSha256, canonicalTextUtf16Length: gold.canonicalTextUtf16Length,
    reassembly: GOLD_CHUNKED.includes(id)
      ? 'gold = { ...header, parts: concat(parts-*), entities: concat(entities-*), relations: concat(relations-*) }; canonicalText = concat(canonical-*.text); file-name order; ranges [from, to) (UTF-16 for canonical text).'
      : 'canonicalText = concat(canonical-*.text), file-name order; ranges [from, to) in UTF-16. The gold file is small enough to read whole.',
    chunks };
  files.set('manifest.json', JSON.stringify(manifest, null, 1) + '\n');
  return files;
}

/** Reassemble the gold from the committed chunks (used by the test and available to reviewers). */
export function reassembleGold(id: string): AnatomyGold {
  const dir = chunkDir(id); const read = (f: string) => JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
  const names = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'manifest.json').sort();
  const cat = (section: string) => names.filter((f) => f.startsWith(`${section}-`)).flatMap((f) => read(f));
  return { ...read('00-header.json'), parts: cat('parts'), entities: cat('entities'), relations: cat('relations') } as AnatomyGold;
}

export function reassembleCanonical(id: string): string {
  const dir = chunkDir(id);
  return readdirSync(dir).filter((f) => f.startsWith('canonical-')).sort().map((f) => (JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as { text: string }).text).join('');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const id of process.argv[2] === "all" ? REVIEW_IDS : [process.argv[2]!]) {
  const files = goldChunks(id); const dir = chunkDir(id);
  if (process.argv.includes('--write')) {
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
    for (const [f, body] of files) writeFileSync(new URL(f, dir), body);
    console.log(`${id}: ${files.size - 1} chunks written`);
  } else {
    for (const [f, body] of files) if (readFileSync(new URL(f, dir), 'utf8').replace(/\r\n/g, '\n') !== body) throw new Error(`${id}: chunk ${f} is stale; regenerate with --write`);
    console.log(`${id}: chunks verified`);
  }
}
}
