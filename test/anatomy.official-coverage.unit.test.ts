import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { buildMatrix, collectSamples, GRID, LAYOUT, MATRIX_FILE, NORMAS_LEG_BASELINE, normasLegBaseline, SAMPLES_BASELINE, samplesBaseline, sizeOf, verifiedBytes, SampleIntegrityError, type NormasLegEntry, type Sample } from '../ops/anatomy/official-coverage-matrix.js';
import { decodeDeclared, ingestManual, UnsupportedEncodingError } from '../ops/anatomy/official-manual-ingest.js';
import { HttpIngestError, ingestHttpPackage, PACKAGE } from '../ops/anatomy/official-http-ingest.js';
import { APPROVED_FALLBACK, CharsetRefused, decodeWithPolicy } from '../ops/anatomy/charset-policy.js';

// E9 / P2–P3 (R2 of #303, c.6701945748): one grid; every axis required; stages kept apart; inputs checked.

const real = collectSamples();
test('E9 matrix and samples baseline are regenerated identical to the committed files', () => {
  assert.deepEqual(samplesBaseline(collectSamples([])), JSON.parse(readFileSync(SAMPLES_BASELINE, 'utf8')), 'run: npx tsx ops/anatomy/official-coverage-matrix.ts --write');
  assert.deepEqual(normasLegBaseline(), JSON.parse(readFileSync(NORMAS_LEG_BASELINE, 'utf8')), 'run: npx tsx ops/anatomy/official-coverage-matrix.ts --write');
  assert.deepEqual(buildMatrix(real), JSON.parse(readFileSync(MATRIX_FILE, 'utf8')), 'run: npx tsx ops/anatomy/official-coverage-matrix.ts --write');
});

test('E9 current state: 11 cells covered, E9 incomplete; nothing promoted or accepted; normas.leg.br keeps its own identity and is not validated', () => {
  const m = buildMatrix(real);
  assert.deepEqual(m.cells.filter((c) => c.status === 'covered').map((c) => c.id).sort(), ['confaz--ajuste-sinief--grande', 'confaz--convenio-icms--grande', 'rfb--instrucao-normativa--grande',
    'rfb--ato-declaratorio-interpretativo--pequeno', 'rfb--instrucao-normativa--medio', 'normas-leg-br--lei--grande', 'rfb--instrucao-normativa--pequeno', 'rfb--portaria--pequeno', 'rfb--resolucao--pequeno', 'sefaz-sp-portal--decreto-consolidado-ricms-2000-artigo--medio', 'sefaz-sp-portal--decreto-consolidado-ricms-2000-artigo--pequeno'].sort());
  assert.equal(m.e9MatrixComplete, false);
  assert.ok(m.requiredPending.includes('planalto--lei--grande'), 'the Planalto layout gap stays visible');
  assert.ok(!m.requiredPending.includes('normas-leg-br--lei--grande'), '#305 c.6710099648: the grande cell closes through the NORMAS-LEG baseline');
  assert.ok(['normas-leg-br--lei--pequeno', 'normas-leg-br--lei--medio'].every((c) => !m.cells.find((x) => x.id === c) || m.requiredPending.includes(c)), 'pequeno/médio stay pending');
  assert.ok(real.every((s) => !s.stages.accepted), 'collection acceptance is not anatomy acceptance');
  const leg = real.filter((s) => s.id.startsWith('lei-'));
  assert.equal(leg.length, 4); assert.ok(leg.every((s) => s.source === 'normas.leg.br' && !s.stages.accepted));
  assert.deepEqual(leg.map((s) => [s.id, s.stages.validated]).sort(), [['lei-10637-2002-atualizada', true], ['lei-10637-2002-original', false], ['lei-10833-2003-atualizada', true], ['lei-10833-2003-original', false]]);
  // #305 c.6709334910: only the two "atualizada" versions are read, by NORMAS-LEG through the preparation; originals are not.
  for (const s of leg) {
    const upd = s.id.endsWith('-atualizada');
    assert.deepEqual([s.stages.read, s.profile, s.diagnostic?.profile ?? null], upd ? [true, 'NORMAS-LEG', null] : [false, null, 'DOU (diagnóstico)'], s.id);
    const meta = JSON.parse(readFileSync(`ops/anatomy/official-identification/leg-normas/${s.id}.meta.json`, 'utf8')) as { sha256: string; bytes: number };
    assert.deepEqual([s.sha256, s.bytes], [meta.sha256, meta.bytes], `${s.id}: identity preserved`);
  }
  assert.equal(real.find((s) => s.id === 'M5')!.size, 'grande', 'the measured size decides, not the list label (M5 was listed as "pequeno")');
  assert.deepEqual([sizeOf(9_999), sizeOf(10_000), sizeOf(49_999), sizeOf(50_000)], ['pequeno', 'médio', 'médio', 'grande']);
  // HTTP captures of the other session: Planalto not decoded (no declared charset), DOU PDF page identified but not validated
  for (const id of ['http:M1', 'http:M2']) { const x = real.find((s) => s.id === id)!; assert.deepEqual([x.source, x.stages.identified, x.stages.read], ['Planalto', true, false]); }
  const m9 = real.find((s) => s.id === 'http:M9')!;
  assert.deepEqual([m9.source, m9.layout, m9.stages.identified, m9.stages.validated], ['DOU', LAYOUT.DOU_PDF_PAGE, true, false]); assert.match(m9.notes[0]!, /CONTINUA/u);
  const p58 = real.find((s) => s.id === 'http:M9-p58')!;
  assert.deepEqual([p58.source, p58.layout, p58.stages.identified, p58.stages.validated], ['DOU', LAYOUT.DOU_PDF_PAGE, true, false]);
  assert.match(p58.notes[0]!, /NÃO se presume ato completo/u, 'two pages are never presumed to complete the act');
  assert.ok(m.requiredPending.includes('dou--pagina-do-jornal--na') && m.requiredPending.includes('dou--instrucao-normativa--medio'), 'M9 PDF does not stand for the HTML act cell');
});

const okStages = { captured: true, identified: true, read: true, validated: true, accepted: false };
const sample = (over: Partial<Sample>): Sample => ({ id: 'x', source: 'CONFAZ', type: 'Convênio ICMS', layout: LAYOUT.CONFAZ_HTML, chars: 20_000, size: 'médio', sha256: '0'.repeat(64), bytes: 1,
  stages: okStages, profile: 'CONFAZ', diagnostic: null, outputHash: 'h', evidence: [], notes: [], ...over });
const full = (): Sample[] => GRID.map((c, i) => sample({ id: `s${i}`, source: c.source, type: c.type, layout: c.layout, size: c.size === 'n/a' ? 'médio' : c.size }));

test('E9 single grid: complete only when the grid is approved AND every required cell has a validated sample; one absent category blocks it', () => {
  assert.equal(buildMatrix(full(), GRID, false).e9MatrixComplete, false, 'unapproved grid never completes E9');
  assert.equal(buildMatrix(full(), GRID, true).e9MatrixComplete, true);
  const noPortaria = full().filter((s) => !(s.source === 'RFB' && s.type === 'Portaria' && s.size === 'grande'));
  const m = buildMatrix(noPortaria, GRID, true);
  assert.equal(m.e9MatrixComplete, false); assert.deepEqual(m.requiredPending, ['rfb--portaria--grande']);
});

test('E9 predicates: a sample valid on every axis but ONE never covers the cell (source, type, layout, size, validation)', () => {
  const cell = GRID.find((c) => c.id === 'confaz--convenio-icms--medio')!;
  const ok = sample({});
  const hit = (s: Sample) => buildMatrix([s], [cell], true).e9MatrixComplete;
  assert.equal(hit(ok), true);
  for (const [axis, bad] of [['source', { source: 'DOU' }], ['type', { type: 'Ajuste SINIEF' }], ['layout', { layout: LAYOUT.DOU_HTML }], ['size', { size: 'grande' as const }],
    ['stage', { stages: { ...okStages, validated: false } }]] as const) assert.equal(hit(sample(bad as Partial<Sample>)), false, `divergent ${axis} must not cover`);
});

test('E9 M3/M4: each Convênio is one sample; it covers only the cell of its own measured size, and one never stands for the other', () => {
  const conv = GRID.filter((c) => c.source === 'CONFAZ' && c.type === 'Convênio ICMS');
  const m = buildMatrix([sample({ id: 'M3', size: 'médio' })], conv, true);
  assert.deepEqual(m.cells.filter((c) => c.status === 'covered').map((c) => c.id), ['confaz--convenio-icms--medio']);
  assert.deepEqual(m.requiredPending, ['confaz--convenio-icms--pequeno', 'confaz--convenio-icms--grande']);
});

test('E9 integrity: bytes that differ from the recorded provenance are refused before any use', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cov-')); const f = join(dir, 'a.html'); writeFileSync(f, 'abc');
  const good = { sha256: createHash('sha256').update('abc').digest('hex'), bytes: 3 };
  assert.equal(verifiedBytes(f, good, 'a').byteLength, 3);
  assert.throws(() => verifiedBytes(f, { ...good, bytes: 4 }, 'a'), SampleIntegrityError);
  writeFileSync(f, 'abd'); assert.throws(() => verifiedBytes(f, good, 'a'), SampleIntegrityError);
});

test('E9 encoding: the declared encoding is respected; unsupported or invalid encodings are refused, never guessed', () => {
  assert.equal(decodeDeclared(new Uint8Array([0x63, 0xe9]), 'windows-1252'), 'cé');
  assert.equal(decodeDeclared(new Uint8Array([0x63, 0xe9]), 'ISO-8859-1'), 'cé');
  assert.throws(() => decodeDeclared(new Uint8Array([0x63, 0xe9]), 'utf-8'), TypeError, 'invalid UTF-8 is not repaired');
  assert.throws(() => decodeDeclared(new Uint8Array([0x63]), 'shift_jis'), UnsupportedEncodingError);
  assert.throws(() => decodeDeclared(new Uint8Array([0x63]), null), UnsupportedEncodingError);
});

const html = (body: string, charset = 'utf-8', savedFrom = '') => `<!DOCTYPE html>${savedFrom ? `<!-- saved from url=(0066)${savedFrom} -->` : ''}<html><head><meta charset="${charset}"><title>x</title></head><body>${body}</body></html>`;
const URL5 = 'https://www.confaz.fazenda.gov.br/legislacao/ajustes/2005/AJ007_05';
const AJUSTE = html('<h1>AJUSTE SINIEF 7/05</h1><p>Cláusula primeira. Texto sintético.</p>', 'utf-8', URL5);

test('E9 P2 ingest: stored byte for byte as a browser reproduction; unknown save time recorded as an upper bound; exclusive; no overwrite, no orphan', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manual-')); const out = join(dir, 'out'); const f = join(dir, 'in.html'); writeFileSync(f, AJUSTE);
  const r = ingestManual({ item: 'M5', file: f, url: URL5, receivedAt: '2026-11-07T03:57:36Z' }, out, () => '2026-11-07T04:00:00.000Z');
  assert.equal(r.status, 'accepted'); if (r.status !== 'accepted') return;
  assert.equal(r.meta.sha256, createHash('sha256').update(AJUSTE).digest('hex')); assert.equal(readFileSync(join(out, 'M5.html'), 'utf8'), AJUSTE);
  assert.equal(r.meta.savedAt, null); assert.match(r.meta.savedAtNote!, /limite superior/u); assert.equal(r.meta.browserSavedFromUrl, URL5);
  assert.equal(r.meta.original, false); assert.equal(r.meta.promoted, false);
  assert.match((ingestManual({ item: 'M5', file: f, url: URL5 }, out) as { reason: string }).reason, /already ingested/u, 'never overwritten');
  // orphan: bytes without meta (e.g. an interrupted earlier run) is a partial state → refused, not overwritten
  const out2 = join(dir, 'out2'); writeFileSync(join(dir, 'x'), ''); ingestManual({ item: 'M5', file: join(dir, 'nope'), url: URL5 }, out2);
  writeFileSync(join(out2, 'M5.html'), 'previous bytes');
  const orphan = ingestManual({ item: 'M5', file: f, url: URL5 }, out2);
  assert.equal(orphan.status, 'refused'); assert.match((orphan as { reason: string }).reason, /partial state/u);
  assert.equal(readFileSync(join(out2, 'M5.html'), 'utf8'), 'previous bytes'); assert.equal(existsSync(join(out2, 'M5.meta.json')), false);
});

test('E9 P2 ingest refusals: title, host, saved-from-url mismatch, encoding, reserved act, unknown item, PDF, missing file — all recorded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manual-')); const out = join(dir, 'out');
  const f = join(dir, 'in.html'); writeFileSync(f, AJUSTE);
  const sj = join(dir, 'sj.html'); writeFileSync(sj, html('<h1>AJUSTE SINIEF 7/05</h1>', 'shift_jis'));
  const bad8 = join(dir, 'bad8.html'); writeFileSync(bad8, Buffer.concat([Buffer.from(html('<h1>AJUSTE SINIEF 7/05</h1>')), Buffer.from([0xc3, 0x28])]));
  const pdf = join(dir, 'in.pdf'); writeFileSync(pdf, '%PDF-1.7\n...');
  const cases: [string, Parameters<typeof ingestManual>[0], RegExp][] = [
    ['title', { item: 'M3', file: f, url: 'https://www.confaz.fazenda.gov.br/legislacao/convenios/2018/CV142_18' }, /saved from url|expected title/u],
    ['host', { item: 'M5', file: f, url: 'https://example.com/AJ007_05' }, /not the official host/u],
    ['saved-from', { item: 'M5', file: f, url: 'https://www.confaz.fazenda.gov.br/legislacao/ajustes/2005/AJ_007_05' }, /saved from url/u],
    ['encoding', { item: 'M5', file: sj, url: URL5 }, /not supported/u],
    ['invalid utf-8', { item: 'M5', file: bad8, url: URL5 }, /not valid/u],
    ['reserved', { item: 'M5', file: f, url: 'https://www.confaz.fazenda.gov.br/legislacao/convenios/1991/CV052_91?ref=52/91' }, /reserved/u],
    ['unknown', { item: 'M99', file: f, url: URL5 }, /unknown item/u],
    ['pdf', { item: 'M5', file: pdf, url: URL5 }, /PDF/u],
    ['missing', { item: 'M5', file: join(dir, 'nope.html'), url: URL5 }, /not found/u],
  ];
  for (const [name, input, reason] of cases) {
    const r = ingestManual(input, out); assert.equal(r.status, 'refused', name);
    if (r.status === 'refused') assert.match(r.reason, reason, name);
  }
  assert.equal(readFileSync(join(out, 'refusals.jsonl'), 'utf8').trim().split('\n').length, cases.length);
  assert.equal(existsSync(join(out, 'M5.meta.json')), false);
});

/** Builds a stored (uncompressed) ZIP in memory, for tests only. */
function zipOf(files: Record<string, Buffer>): Buffer {
  const parts: Buffer[] = []; const central: Buffer[] = []; let off = 0;
  for (const [name, data] of Object.entries(files)) {
    const n = Buffer.from(name, 'utf8'); const crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, n, data); central.push(ch, n); off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central); const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(central.length / 2, 8); eocd.writeUInt16LE(central.length / 2, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

test('E9 HTTP package ingest: the ZIP FILE is hashed, entries are read from it (CRC), each matches the manifest; foreign host refused; charset never inferred; no overwrite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pkg-')); const out = join(dir, 'out');
  const conv = Buffer.from('<html><head><meta charset="utf-8"></head><body><h1>CONVÊNIO ICMS 142/18</h1><p>Cláusula primeira.</p></body></html>');
  const lei = Buffer.from([...Buffer.from('<html><body><p>LEI N'), 0xba, ...Buffer.from(' 10.637, DE 30 DE DEZEMBRO DE 2002</p></body></html>')]);
  const entry = (id: string, file: string, b: Buffer, url: string) => ({ id, sha256: createHash('sha256').update(b).digest('hex').toUpperCase(), bytes: b.length, url, retrieved_utc: '2026-11-07T03:52:05Z', origin: 'HTTP', coverage: 'HTML capture', file });
  const pkg = (manifest: object[], files: Record<string, Buffer>) => { const z = zipOf({ ...files, 'manifest.json': Buffer.from(JSON.stringify(manifest)) }); const f = join(dir, `p${Math.random()}.zip`); writeFileSync(f, z); return { f, sha: createHash('sha256').update(z).digest('hex') }; };
  const good = pkg([entry('M3', 'M3.html', conv, 'https://www.confaz.fazenda.gov.br/legislacao/convenios/2018/CV142_18'), entry('M1', 'M1.html', lei, 'https://www.planalto.gov.br/ccivil_03/leis/2002/l10637.htm')], { 'M3.html': conv, 'M1.html': lei });
  await assert.rejects(ingestHttpPackage(good.f, out), HttpIngestError, 'a ZIP whose file hash is not the delivered package is refused');
  // a loose copy next to the archive is never read: only bytes inside the hashed archive count
  writeFileSync(join(dir, 'M3.html'), 'tampered');
  const metas = await ingestHttpPackage(good.f, out, undefined, good.sha);
  assert.deepEqual(metas.map((m) => [m.item, m.declaredCharset, m.readable]), [['M3', 'utf-8', true], ['M1', null, false]]);
  assert.equal(readFileSync(join(out, 'M3.html')).equals(conv), true, 'bytes from the archive, unchanged');
  assert.match(metas[1]!.readableNote!, /não inferido/u); assert.match(String(metas[1]!.identification.method), /ASCII/u);
  await assert.rejects(ingestHttpPackage(good.f, out, undefined, good.sha), /already present/u, 'never overwritten');
  const corrupt = Buffer.from(readFileSync(good.f)); corrupt[40] = corrupt[40]! ^ 0xff; const cf = join(dir, 'corrupt.zip'); writeFileSync(cf, corrupt);
  await assert.rejects(ingestHttpPackage(cf, join(dir, 'o1'), undefined, createHash('sha256').update(corrupt).digest('hex')), /CRC-32|bad|mismatch/u, 'an altered entry fails its CRC');
  const badSize = pkg([{ ...entry('M3', 'M3.html', conv, 'https://www.confaz.fazenda.gov.br/x'), bytes: conv.length + 1 }], { 'M3.html': conv });
  await assert.rejects(ingestHttpPackage(badSize.f, join(dir, 'o2'), undefined, badSize.sha), /differ from the manifest/u);
  const host = pkg([entry('M3', 'M3.html', conv, 'https://example.com/CV142_18')], { 'M3.html': conv });
  await assert.rejects(ingestHttpPackage(host.f, join(dir, 'o3'), undefined, host.sha), /not the official host/u);
  assert.equal(PACKAGE.zipSha256.length, 64);
});

test('E9 P2-c historical ledger stays a record: 25 / 19 / 9 / 28 / 3 / 0 (never read as a budget)', () => {
  const ledger = JSON.parse(readFileSync(new URL('../ops/anatomy/official-identification/rfb-p2c/ledger-combined.json', import.meta.url), 'utf8'));
  assert.deepEqual([ledger.limit, ledger.sessions.session1.requests, ledger.sessions.session2.requests, ledger.combined, ledger.excess, ledger.available], [25, 19, 9, 28, 3, 0]);
});

test('charset policy (#116 c.6708512598 §6): BOM and declared charset first; windows-1252 fallback ONLY for the two approved Planalto SHAs; tentative; never declared', () => {
  const real = collectSamples();
  for (const id of ['http:M1', 'http:M2']) {
    const x = real.find((s) => s.id === id)!;
    assert.deepEqual([x.decoding?.encoding, x.decoding?.encodingSource, x.decoding?.confidence, x.decoding?.declaredCharset, x.stages.read], ['windows-1252', 'approved_local_fallback', 'tentative', null, false]);
    assert.ok(x.decoding!.independentCheck.length > 0 && x.decoding!.independentCheck.every((c) => c.sentenceEqual), `${id}: accented passage equal to the independent official representation`);
  }
  const m1 = new Uint8Array(readFileSync(new URL('../ops/anatomy/official-identification/e9-http/M1.html', import.meta.url)));
  assert.equal(Object.keys(APPROVED_FALLBACK).length, 2);
  const altered = new Uint8Array(m1); altered[600] = altered[600]! ^ 0x01;
  assert.throws(() => decodeWithPolicy(altered, { httpCharset: null }), CharsetRefused, 'one changed byte leaves the policy');
  assert.throws(() => decodeWithPolicy(new TextEncoder().encode('<p>sem charset</p>'), { httpCharset: null }), CharsetRefused);
  assert.throws(() => decodeWithPolicy(m1, { httpCharset: 'iso-8859-1' }), CharsetRefused, 'an HTTP charset is used as declared, not the fallback');
  assert.equal(decodeWithPolicy(new TextEncoder().encode('<meta charset="utf-8"><p>é</p>'), { httpCharset: null }).encodingSource, 'declared');
  assert.equal(decodeWithPolicy(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]), { httpCharset: null }).encodingSource, 'bom');
});

test('#305 c.6710099648: the NORMAS-LEG lock — validated is derived; any drift of bytes, plan, text, sourceMap, parts, selections or counts un-validates', () => {
  const base = JSON.parse(readFileSync(NORMAS_LEG_BASELINE, 'utf8')) as { samples: NormasLegEntry[] };
  const validated = (b: NormasLegEntry[]) => collectSamples(undefined, b).filter((s) => s.id.endsWith('-atualizada')).map((s) => s.stages.validated);
  assert.deepEqual(validated(base.samples), [true, true]);
  assert.deepEqual(validated([]), [false, false], 'no baseline ⇒ not validated (no hard-coded validated=true)');
  const fields: (keyof NormasLegEntry)[] = ['sha256', 'planSha256', 'htmlSha256', 'textSha256', 'sourceMapSha256', 'partsSha256', 'selectionsSha256', 'urn', 'representationId', 'preparationVersion'];
  for (const k of fields) {
    const drift = base.samples.map((e, i) => (i === 0 ? { ...e, [k]: `${String(e[k])}x` } : e));
    assert.deepEqual(validated(drift), [false, true], `drift of ${k}`);
  }
  for (const c of ['notes', 'anchors', 'placeholders', 'ambiguous', 'editorialNoteParts', 'candidateSelections'] as const) {
    const drift = base.samples.map((e, i) => (i === 1 ? { ...e, counts: { ...e.counts, [c]: e.counts[c] + 1 } } : e));
    assert.deepEqual(validated(drift), [true, false], `drift of counts.${c}`);
  }
  assert.deepEqual(base.samples.map((e) => [e.counts.notes, e.counts.placeholders, e.counts.ambiguous]), [[106, 23, 30], [314, 40, 3]]);
  // Bytes drift is refused before any reading (integrity), never silently re-baselined.
  const meta = JSON.parse(readFileSync('ops/anatomy/official-identification/leg-normas/lei-10637-2002-atualizada.meta.json', 'utf8')) as { sha256: string; bytes: number };
  assert.throws(() => verifiedBytes('ops/anatomy/official-identification/leg-normas/lei-10637-2002-atualizada.html', { ...meta, sha256: '0'.repeat(64) }, 'x'), SampleIntegrityError);
});
