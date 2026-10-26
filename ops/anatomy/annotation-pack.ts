import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareDouRepresentation } from '../../src/modules/anatomy/dou-preparation.js';
import { ANATOMY_GOLD_VERSION, type AnatomyGold } from '../../src/modules/anatomy/gold.js';
import { readAnatomyInput } from '../../src/modules/anatomy/readers.js';

/**
 * Development-only annotation pack.
 *   --skeletons      write empty gold skeletons to test/fixtures/anatomy/gold/<id>.json (never overwrites)
 *   --out <dir>      export <id>.canonical.txt for annotators to a directory OUTSIDE the repository
 * The pack contains only canonical text, never parts, entities or eligibility produced by the engine.
 */
const root = new URL('../../', import.meta.url);
const repoRoot = fileURLToPath(root);
export const GOLD_DIR = new URL('test/fixtures/anatomy/gold/', root);
const frozen = JSON.parse(readFileSync(new URL('test/fixtures/anatomy/canonical/development.json', root), 'utf8')) as
  { entries: { id: string; source: 'CONFAZ' | 'DOU'; preparation: string; preparationId: string | null; inputs: { path: string }[]; canonicalTextSha256: string; canonicalTextUtf16Length: number }[] };

export function goldSkeleton(entry: (typeof frozen.entries)[number]): AnatomyGold {
  return { goldVersion: ANATOMY_GOLD_VERSION, id: entry.id, partition: 'development', preparation: entry.preparation,
    canonicalTextSha256: entry.canonicalTextSha256, canonicalTextUtf16Length: entry.canonicalTextUtf16Length,
    status: 'not_started', annotator: null, annotatedAt: null, parts: [], entities: [], relations: [], gaps: [],
    review: { reviewer: null, status: 'not_requested', reviewedAt: null, approvedContentSha256: null, notes: '' } };
}

export function developmentCanonicalText(entryId: string): string {
  const entry = frozen.entries.find((e) => e.id === entryId);
  if (!entry) throw new Error(`${entryId} is not a frozen development entry`);
  const files = entry.inputs.map((i) => ({ resourceId: i.path, bytes: new Uint8Array(readFileSync(new URL(i.path, root))) }));
  const html = entry.source === 'DOU' ? prepareDouRepresentation(files).html : Buffer.from(files[0]!.bytes).toString('utf8');
  return readAnatomyInput({ source: entry.source, representationId: entry.preparationId ?? entry.inputs[0]!.path, html }).canonicalText;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--skeletons')) {
    mkdirSync(GOLD_DIR, { recursive: true });
    for (const e of frozen.entries) {
      const path = new URL(`${e.id}.json`, GOLD_DIR);
      if (existsSync(path)) { console.log(`kept ${e.id}`); continue; }
      writeFileSync(path, JSON.stringify(goldSkeleton(e), null, 2) + '\n'); console.log(`skeleton ${e.id}`);
    }
  }
  const at = process.argv.indexOf('--out');
  if (at >= 0) {
    const out = resolve(process.argv[at + 1] ?? '');
    if (!process.argv[at + 1] || out.toLowerCase().startsWith(resolve(repoRoot).toLowerCase())) throw new Error('--out must be a directory outside the repository');
    mkdirSync(out, { recursive: true });
    for (const e of frozen.entries) writeFileSync(join(out, `${e.id}.canonical.txt`), developmentCanonicalText(e.id), 'utf8');
    console.log(`exported ${frozen.entries.length} development canonical texts to ${out}`);
  }
}
