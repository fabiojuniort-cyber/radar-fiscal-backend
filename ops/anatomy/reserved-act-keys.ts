/**
 * ANAT-OFFICIAL-01 R1: derive RESERVED_ACT_KEYS from the corpus INVENTORY labels only (corpus-manifest.json: id and
 * label fields). Usage: npx tsx ops/anatomy/reserved-act-keys.ts [--write]. Without --write, exits 1 on drift.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { actKey } from '../../src/modules/anatomy/config/act-key.js';

export const TARGET = new URL('../../src/modules/anatomy/config/reserved-act-keys.ts', import.meta.url);
export function render(): string {
  const inv = (JSON.parse(readFileSync(new URL('../../test/fixtures/anatomy/corpus-manifest.json', import.meta.url), 'utf8')) as
    { entries: { id: string; label: string; sourceId: string }[] }).entries.map(({ id, label, sourceId }) => ({ id, label, sourceId }));
  const keys = [...new Set(inv.map((e) => actKey(e.label)).filter((k): k is string => !!k))].sort();
  const unkeyed = inv.filter((e) => !actKey(e.label)).map((e) => e.id);
  const sourceIds = [...new Set(inv.map((e) => String(e.sourceId)).filter((x) => x.length >= 5))].sort();
  return `/**\n * ANAT-OFFICIAL-01 R1: act identity keys (species number/yy) of every corpus entry, derived ONLY from the inventory\n * labels of test/fixtures/anatomy/corpus-manifest.json (no inputs, gold or reserve). Regenerate with\n * \`npx tsx ops/anatomy/reserved-act-keys.ts --write\`; test/anatomy.official-overlap.unit.test.ts fails on drift.\n * Entries whose label carries no readable act identity are listed by id: an official sample from the same source is\n * refused unless its act key differs from every keyed entry AND it was reviewed against these ids (fail closed).\n */\nexport const RESERVED_ACT_KEYS: readonly string[] = Object.freeze(${JSON.stringify(keys)});\nexport const UNKEYED_CORPUS_ENTRY_IDS: readonly string[] = Object.freeze(${JSON.stringify(unkeyed)});\n/** Portal identifiers of every corpus entry (inventory sourceId): an official URL naming one of them is refused. */\nexport const RESERVED_SOURCE_IDS: readonly string[] = Object.freeze(${JSON.stringify(sourceIds)});\n`;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--write')) { writeFileSync(TARGET, render()); console.log('reserved act keys written'); }
  else if (readFileSync(TARGET, 'utf8') !== render()) { console.error('reserved act keys drift'); process.exit(1); }
  else console.log('reserved act keys verified');
}
