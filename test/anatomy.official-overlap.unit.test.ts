import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * ANAT-OFFICIAL-01: no act of the official selection may be an entry of the reserved corpus (BLOCK_CORPUS_INPUTS_AND_GOLD).
 * Reads ONLY the inventory fields of corpus-manifest.json (id, source, label, sourceId), never inputs, gold or the reserve.
 */
const inventory = (JSON.parse(readFileSync(new URL('./fixtures/anatomy/corpus-manifest.json', import.meta.url), 'utf8')) as
  { entries: { id: string; source: string; label: string; sourceId: string }[] }).entries.map(({ id, source, label, sourceId }) => ({ id, source, label, sourceId }));
const selection = (JSON.parse(readFileSync(new URL('../ops/anatomy/official-manifest.json', import.meta.url), 'utf8')) as
  { acts: { id: string; source: string; act: string; url: string | null }[] }).acts;

/** "Convênio ICMS 52/91" and "Conv. ICMS 52/1991" → "icms 52/91"; numbers keep their dots stripped. */
const key = (raw: string) => {
  const s = raw.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const m = /(convenio|conv\.|ajuste sinief|protocolo|instrucao normativa|in|ade|portaria|decreto|resolucao|lei complementar|lei)[^0-9]*([0-9.]+)\s*\/\s*(\d{2,4})/u.exec(s);
  if (!m) return null;
  const kind = ({ convenio: 'conv', 'conv.': 'conv', 'instrucao normativa': 'in' } as Record<string, string>)[m[1]!] ?? m[1]!;
  return `${kind} ${m[2]!.replace(/\./gu, '')}/${m[3]!.slice(-2)}`;
};

test('the official selection does not reuse any corpus entry (inventory comparison only)', () => {
  const corpusKeys = new Map(inventory.map((e) => [key(e.label), e]).filter(([k]) => k) as [string, (typeof inventory)[number]][]);
  const conflicts = selection.flatMap((a) => { const k = key(a.act); const hit = k ? corpusKeys.get(k) : undefined; return hit ? [`${a.id} = corpus ${hit.id} (${hit.label})`] : []; });
  assert.deepEqual(conflicts, []);
  for (const a of selection) assert.ok(!inventory.some((e) => a.url && e.sourceId && a.url.includes(e.sourceId)), `${a.id} URL names a corpus sourceId`);
});

test('the comparison key recognises the known corpus conflicts (52/91, 100/97)', () => {
  assert.equal(key('Convênio ICMS 52/91'), 'conv 52/91');
  assert.equal(key('Conv. ICMS 52/1991'), 'conv 52/91');
  const corpus = new Set(inventory.map((e) => key(e.label)));
  assert.ok(corpus.has('conv 52/91') && corpus.has('conv 100/97'), 'inventory still lists 52/91 and 100/97');
  assert.equal(key('Instrução Normativa RFB 2.342/2026'), 'in 2342/26');
});
