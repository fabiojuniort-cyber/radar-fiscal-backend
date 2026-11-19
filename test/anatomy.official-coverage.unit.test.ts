import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { buildMatrix, collectSamples, GRID, LAYOUT, MATRIX_FILE, SAMPLES_BASELINE, samplesBaseline, sizeOf, verifiedBytes, SampleIntegrityError, type Sample } from '../ops/anatomy/official-coverage-matrix.js';
import { decodeDeclared, ingestManual, UnsupportedEncodingError } from '../ops/anatomy/official-manual-ingest.js';
import { HttpIngestError, ingestHttpPackage, PACKAGE } from '../ops/anatomy/official-http-ingest.js';
import { APPROVED_FALLBACK, CharsetRefused, decodeWithPolicy } from '../ops/anatomy/charset-policy.js';

// E9 / P2–P3 (R2 of #303, c.6701945748): one grid; every axis required; stages kept apart; inputs checked.

const real = collectSamples();
test('E9 matrix and samples baseline are regenerated identical to the committed files', () => {
  assert.deepEqual(samplesBaseline(collectSamples([])), JSON.parse(readFileSync(SAMPLES_BASELINE, 'utf8')), 'run: npx tsx ops/anatomy/official-coverage-matrix.ts --write');
  assert.deepEqual(buildMatrix(real), JSON.parse(readFileSync(MATRIX_FILE, 'utf8')), 'run: npx tsx ops/anatomy/official-coverage-matrix.ts --write');
});

test('E9 current state: 13 cells covered (10 + 3 P2-c direct captures; SC Cosit has no body, size undetermined), E9 incomplete; nothing promoted; E9-A1: 4/61 cells accepted (5 RFB samples); normas.leg.br keeps its own identity and is not validated', () => {
  const m = buildMatrix(real);
  assert.deepEqual(m.cells.filter((c) => c.status === 'covered').map((c) => c.id).sort(), ['confaz--ajuste-sinief--grande', 'confaz--convenio-icms--grande', 'rfb--instrucao-normativa--grande',
    'rfb--ato-declaratorio-interpretativo--pequeno', 'rfb--instrucao-normativa--medio', 'rfb--instrucao-normativa--pequeno', 'rfb--portaria--pequeno', 'rfb--resolucao--pequeno',
    'rfb--portaria--medio', 'rfb--ato-declaratorio-executivo--pequeno', 'rfb--ato-declaratorio-executivo--medio', 'sefaz-sp-portal--decreto-consolidado-ricms-2000-artigo--medio', 'sefaz-sp-portal--decreto-consolidado-ricms-2000-artigo--pequeno'].sort());
  assert.equal(m.e9MatrixComplete, false);
  assert.ok(m.requiredPending.includes('planalto--lei--grande'), 'the Planalto layout gap stays visible');
  assert.ok(m.requiredPending.includes('normas-leg-br--lei--grande'), 'normas.leg.br obtained, not read/validated');
  assert.deepEqual(real.filter((s) => s.stages.accepted).map((s) => s.id).sort(), ['rfb:108391', 'rfb:115131', 'rfb:133898', 'rfb:142967', 'rfb:148693'], 'only the COORD-accepted samples (e9-acceptances.json: Portaria 635/2025 + E9-A1 #116 c.6990971154); collection acceptance is not anatomy acceptance');
  assert.deepEqual(m.cells.filter((c) => c.accepted).map((c) => c.id).sort(), ['rfb--instrucao-normativa--grande', 'rfb--instrucao-normativa--pequeno', 'rfb--portaria--medio', 'rfb--portaria--pequeno'], 'E9-A1: 4/61 cells accepted');
  assert.equal(real.find((s) => s.id === 'rfb:127905')!.stages.accepted, false, 'partial reading: never accepted');
  assert.equal(real.find((s) => s.id === 'rfb:104314')!.stages.accepted, false, 'partial reading: never accepted');
  const leg = real.filter((s) => s.id.startsWith('lei-'));
  assert.equal(leg.length, 4); assert.ok(leg.every((s) => s.source === 'normas.leg.br' && !s.stages.read && !s.stages.validated && s.diagnostic?.profile.startsWith('DOU')));
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

// E9 (tribusca-control#116, COORD decision B on c.6783692588): RFB acceptance is DATA, strictly validated, pinned to the
// sample, its REAL grid cell, its lot digest and the engine; only complete readings that carry every material annex.
const accTest = async () => {
  const m = await import('../ops/anatomy/official-coverage-matrix.js');
  const { ANATOMY_ENGINE_BUILD_HASH: E } = await import('../src/modules/anatomy/build-identity.js');
  const { readFileSync } = await import('node:fs');
  const lot = JSON.parse(readFileSync(new URL('../docs/anatomy/official-lot-rfb.json', import.meta.url), 'utf8')) as { acts: { idAto: number }[] };
  const entry = (id: number) => lot.acts.find((x) => x.idAto === id)!;
  const ids = new Set(m.GRID.map((c) => c.id));
  const rec = (id: number, cellId: string, over: Record<string, unknown> = {}) => ({ sampleId: `rfb:${id}`, cellId, scope: 'offline', entrySha256: m.lotEntrySha256(entry(id)),
    engineBuildHash: E, decidedBy: 't', decidedOn: '2026-11-11', ref: 't', limits: ['t'], ...over });
  const accepted = (recs: unknown[], id: number) => m.collectSamples(undefined, m.validateAcceptances({ acceptances: recs }, ids)).find((s) => s.id === `rfb:${id}`)!.stages.accepted;
  return { m, E, ids, rec, accepted, readFileSync };
};

test('E9 acceptance B1: the record must name the REAL grid cell; pins on digest, engine and sample are all required', async () => {
  const { rec, accepted } = await accTest();
  assert.equal(accepted([rec(148693, 'rfb--portaria--medio')], 148693), true, 'exact sample + real cell + digest + engine → accepted');
  assert.equal(accepted([rec(148693, 'rfb--portaria--pequeno')], 148693), false, 'another (valid) grid cell never counts');
  assert.equal(accepted([rec(148693, 'rfb--portaria--medio', { entrySha256: '0'.repeat(64) })], 148693), false, 'lot digest drift voids it');
  assert.equal(accepted([rec(148693, 'rfb--portaria--medio', { engineBuildHash: 'f'.repeat(64) })], 148693), false, 'another engine voids it');
  assert.equal(accepted([rec(148693, 'rfb--portaria--medio', { sampleId: 'rfb:142967' })], 148693), false, 'a record for another sample never counts');
});

test('E9 acceptance B2: strict validation rejects the whole file (fail closed): unknown cell, shapes, duplicates, conflicts', async () => {
  const { m, rec, ids } = await accTest();
  const ok = rec(148693, 'rfb--portaria--medio');
  const bad: [string, unknown, RegExp][] = [
    ['cellId x (not a grid cell)', { acceptances: [{ ...ok, cellId: 'x' }] }, /not a grid cell/u],
    ['no acceptances array', {}, /missing "acceptances"/u],
    ['unknown field', { acceptances: [{ ...ok, accepted: true }] }, /unknown field/u],
    ['scope', { acceptances: [{ ...ok, scope: 'online' }] }, /scope/u],
    ['digest not hex', { acceptances: [{ ...ok, entrySha256: 'XYZ' }] }, /entrySha256/u],
    ['engine short', { acceptances: [{ ...ok, engineBuildHash: '0e009431' }] }, /engineBuildHash/u],
    ['date', { acceptances: [{ ...ok, decidedOn: '11/11/2026' }] }, /decidedOn/u],
    ['empty limits', { acceptances: [{ ...ok, limits: [] }] }, /limits/u],
    ['empty decidedBy', { acceptances: [{ ...ok, decidedBy: ' ' }] }, /decidedBy/u],
    ['exact duplicate', { acceptances: [ok, { ...ok }] }, /duplicate/u],
    ['two digests, same sample and engine', { acceptances: [ok, { ...ok, entrySha256: '1'.repeat(64) }] }, /conflicts/u],
    ['two cells, same sample and engine', { acceptances: [ok, { ...ok, cellId: 'rfb--portaria--grande' }] }, /conflicts/u],
  ];
  for (const [why, raw, re] of bad) assert.throws(() => m.validateAcceptances(raw, ids), re, why);
  // the same sample on ANOTHER engine is history (append-only), not a conflict
  assert.equal(m.validateAcceptances({ acceptances: [ok, { ...ok, engineBuildHash: 'a'.repeat(64), entrySha256: '2'.repeat(64) }] }, ids).length, 2);
});

test('E9 acceptance B3: partial readings, absent material annexes and a body in an absent attachment are never accepted', async () => {
  const { m, rec, accepted, readFileSync } = await accTest();
  const p2c = (id: number) => readFileSync(new URL(`../ops/anatomy/official-identification/rfb-p2c/${id}.json`, import.meta.url));
  assert.equal(accepted([rec(148629, 'rfb--ato-declaratorio-executivo--pequeno')], 148629), false, 'ADE Cofis: partial reading + table annex not read');
  assert.equal(accepted([rec(148516, 'rfb--ato-declaratorio-executivo--medio')], 148516), false, 'ADE Corat: partial reading + external Anexo Único');
  assert.match(m.annexGap(p2c(148516)) ?? '', /Anexo Único \(own\) absent from the representation/u, 'Art. 17 "Anexo Único deste Ato…"; the JSON has none');
  assert.equal(m.annexGap(p2c(148693)), null, 'the Portaria cites no annex');
  // SC Cosit: the body is the PDF 83325 (absent) → size undetermined, never validated, never covers SC × pequeno
  const sc = m.collectSamples().find((s) => s.id === 'rfb:148681')!;
  assert.deepEqual([sc.size, sc.chars, sc.stages.read, sc.stages.validated, sc.stages.accepted], [null, null, true, false, false]);
  assert.match(sc.notes.join(' '), /size UNDETERMINED/u);
  assert.equal(accepted([rec(148681, 'rfb--solucao-de-consulta--pequeno')], 148681), false, 'even with exact pins');
  assert.equal(m.buildMatrix().cells.find((c) => c.id === 'rfb--solucao-de-consulta--pequeno')!.status, 'pending', 'SC × pequeno is NOT covered by an ementa-only reading');
});

test('E9 acceptance B4: the committed file is the append-only union with #305/#309, the Portaria records and the E9-A1 records', async () => {
  const { m, E, readFileSync } = await accTest();
  const file = JSON.parse(readFileSync(new URL('../docs/anatomy/e9-acceptances.json', import.meta.url), 'utf8')) as { acceptances: { sampleId: string; engineBuildHash: string; cellId: string; entrySha256: string; revalidates?: string }[] };
  // composition gate (tribusca-control#116, after c.6965245285): append-only — the 2026-11-11 Portaria record at 0e009431 is
  // PRESERVED and a revalidation record pins the composed engine; only the record on the current engine makes it accepted
  assert.equal(file.acceptances.length, 18, '12 NORMAS-LEG records of #309 @ 0cfc46c preserved + Portaria @ 0e009431 preserved + Portaria revalidated + 4 E9-A1');
  assert.deepEqual(file.acceptances.slice(0, 12).map((r) => r.sampleId.replace(/-2002|-2003/u, '')).filter((x, i, a) => a.indexOf(x) === i), ['lei-10637-atualizada', 'lei-10833-atualizada']);
  assert.deepEqual(file.acceptances[12], { ...file.acceptances[12], sampleId: 'rfb:148693', cellId: 'rfb--portaria--medio',
    entrySha256: '7d894b61a3c20f546455baa3282bb032d853dc953059e93696cc39e9924e01ae', engineBuildHash: '0e009431a059493805384b89be2b37d3132545ffb7bc04c630270126bf2ca194' }, 'the original record is untouched');
  assert.deepEqual(file.acceptances[13], { ...file.acceptances[13], sampleId: 'rfb:148693', cellId: 'rfb--portaria--medio', engineBuildHash: E }, 'the revalidation pins the current engine');
  assert.match(file.acceptances[13].revalidates ?? '', /^rfb:148693 @ 0e009431/u);
  // E9-A1 (tribusca-control#116, after the independent review c.6990971154): 4 records appended on the current engine
  const a1: [string, string, string][] = [
    ['rfb:108391', 'rfb--instrucao-normativa--pequeno', '370dbe3a7ba06c1e40a3bb2c664c2b9ef1da366dcfef1ae2c277ebb320a3f680'],
    ['rfb:133898', 'rfb--instrucao-normativa--pequeno', 'b2e3e81ea87e286c1bc7f2b6109f2c03549dce0beacecfb48ed5115851a449d7'],
    ['rfb:115131', 'rfb--instrucao-normativa--grande', 'e1720a89b8dc84f8177f7b90403b50fdba0f9f7a5a5ac53db76751c51dc0976e'],
    ['rfb:142967', 'rfb--portaria--pequeno', '9e1376e226813c02e187ad5759b445884f2744c56ee7ad27b692c713cbe310d7']];
  a1.forEach(([sampleId, cellId, entrySha256], i) => assert.deepEqual(file.acceptances[14 + i], { ...file.acceptances[14 + i], sampleId, cellId, entrySha256, engineBuildHash: E, scope: 'offline' }, `E9-A1 record ${sampleId}`));
  const real = m.collectSamples();
  assert.deepEqual(real.filter((s) => s.stages.accepted).map((s) => s.id).sort(), ['rfb:108391', 'rfb:115131', 'rfb:133898', 'rfb:142967', 'rfb:148693']);
  assert.deepEqual(m.buildMatrix(real).cells.filter((c) => c.accepted).map((c) => c.id).sort(), ['rfb--instrucao-normativa--grande', 'rfb--instrucao-normativa--pequeno', 'rfb--portaria--medio', 'rfb--portaria--pequeno']);
});

// ---- R2 (independent review c.6784793278): B-1 per-annex completeness, B-2 self-citation, B-3 completeness flag, B-4 dates ----
const mkAct = (texts: string[], annexes: Record<string, unknown>[] = [], epi = { tipoAto: { nomeTipoAto: 'Portaria' }, numeroAto: '635', dataAto: '2025-12-31' }) =>
  Buffer.from(JSON.stringify({ idAto: 1, epigrafe: epi, tiposSegmento: [{ idTipoSegmento: 1, nomeTipoSegmento: 'Ementa' }, { idTipoSegmento: 3, nomeTipoSegmento: 'Artigo' }, { idTipoSegmento: 9, nomeTipoSegmento: 'Anexo' }],
    ementas: [{ idTipoSegmento: 1, textoIntegra: 'Aprova os Anexos I a IX desta Portaria.' }],
    outrosSegmentos: [...texts.map((t) => ({ idTipoSegmento: 3, textoIntegra: `<p>${t}</p>` })), ...annexes] }));
const b64 = (s: string) => Buffer.from(s).toString('base64');
const shaOf = (s: string) => createHash('sha256').update(Buffer.from(s)).digest('hex');
const anx = (id: number, head: string, body: string, file = `${id}.html`) => ({ idTipoSegmento: 9, textoIntegra: `<p>${head}</p>`, arquivoBinario: { idArquivoBinario: id, nomeArquivoBinario: file, arquivoBinario: b64(body) } });
const T1 = '<table><tr><td>Anexo I</td></tr></table>'; const T2 = '<table><tr><td>Anexo II</td></tr></table>';
const BOTH = ['Art. 1º Ficam aprovados o Anexo I e o Anexo II desta Portaria.'];
const readAll = new Map([[11, shaOf(T1)], [12, shaOf(T2)]]);

test('R2 B-1 (1–4): own annexes are checked ONE BY ONE — present, decoded and READ are distinct; duplicates and bad payloads never satisfy', async () => {
  const m = await import('../ops/anatomy/official-coverage-matrix.js');
  // reviewer counter-case: two required, one embedded → gap (before R2: null)
  assert.match(m.annexGap(mkAct(BOTH, [anx(11, 'ANEXO I', T1)]), readAll) ?? '', /Anexo II \(own\) absent/u, '1. I and II required, only I present');
  assert.match(m.annexGap(mkAct(BOTH, [anx(12, 'ANEXO II', T2)]), readAll) ?? '', /Anexo I \(own\) absent/u, '2. I and II required, only II present');
  assert.match(m.annexGap(mkAct(BOTH, [anx(11, 'ANEXO I', T1), anx(12, 'ANEXO II', T1)]), new Map([[11, shaOf(T1)], [12, shaOf(T1)]])) ?? '', /content duplicated/u, '3. two required, one content duplicated');
  assert.match(m.annexGap(mkAct(BOTH, [{ ...anx(11, 'ANEXO I', T1), arquivoBinario: { idArquivoBinario: 11, arquivoBinario: 'eA==' } }, anx(12, 'ANEXO II', T2)]), readAll) ?? '', /Anexo I: decoded, not read/u, "4a. reviewer 'eA==' (decodes, never read)");
  assert.match(m.annexGap(mkAct(BOTH, [{ ...anx(11, 'ANEXO I', T1), arquivoBinario: { idArquivoBinario: 11, arquivoBinario: '%%%' } }, anx(12, 'ANEXO II', T2)]), readAll) ?? '', /Anexo I: present, not read/u, '4b. invalid base64');
  assert.match(m.annexGap(mkAct(BOTH, [anx(11, 'ANEXO I', T1), anx(12, 'ANEXO II', T2)])) ?? '', /Anexo I: decoded, not read; Anexo II: decoded, not read/u, '4c. decoded but no read evidence');
  assert.match(m.annexGap(mkAct(BOTH, [anx(11, 'ANEXO I', T1), anx(12, 'ANEXO II', T2)]), new Map([[11, shaOf('other bytes')], [12, shaOf(T2)]])) ?? '', /Anexo I: decoded, not read/u, '4d. read evidence for different bytes');
  // a count match is not an association: two segments, but labelled I and III
  assert.match(m.annexGap(mkAct(BOTH, [anx(11, 'ANEXO I', T1), anx(13, 'ANEXO III', T2)]), new Map([[11, shaOf(T1)], [13, shaOf(T2)]])) ?? '', /Anexo II \(own\) absent/u, 'count equal, labels differ');
  // label from file name; heading and file name disagree → ambiguous (no label)
  assert.equal(m.annexGap(mkAct(BOTH, [anx(11, '', T1, 'Anexo_I.html'), anx(12, '', T2, 'anexo-II.html')]), readAll), null, 'labels from file names');
  assert.match(m.annexGap(mkAct(BOTH, [anx(11, 'ANEXO I', T1, 'Anexo_II.html'), anx(12, 'ANEXO II', T2)]), readAll) ?? '', /Anexo I \(own\) absent/u, 'heading/file disagree → unusable');
  // complete: both individually present AND read
  assert.equal(m.annexGap(mkAct(BOTH, [anx(11, 'ANEXO I', T1), anx(12, 'ANEXO II', T2)]), readAll), null, 'I and II both read');
  // lists and ranges
  assert.deepEqual(m.annexAudit(mkAct(['Art. 1º Aprovam-se os Anexos I a III desta Portaria.'])).required.map((q) => q.label), ['1', '2', '3']);
  assert.deepEqual(m.annexAudit(mkAct(['Art. 1º Aprovam-se os Anexos I, II e IV desta Portaria.'])).required.map((q) => q.label), ['1', '2', '4']);
});

test('R2 B-1/B-2 (5–8): other-norm citation, self-citation, ambiguity and the external ADE Corat annex', async () => {
  const m = await import('../ops/anatomy/official-coverage-matrix.js');
  const { readFileSync } = await import('node:fs');
  assert.equal(m.annexGap(mkAct(['Art. 1º Conforme o Anexo I da Instrução Normativa RFB nº 2.121, de 2022.'])), null, '5. annex of another norm: not this act');
  assert.match(m.annexGap(mkAct(['Art. 1º Fica aprovado o Anexo I da Portaria RFB nº 635, de 2025.'])) ?? '', /Anexo I \(own\) absent/u, '6. self-citation (same kind, number, year) is OWN');
  assert.equal(m.annexGap(mkAct(['Art. 1º Conforme o Anexo I da Portaria RFB nº 636, de 2025.'])), null, '6b. another Portaria number is other');
  assert.match(m.annexGap(mkAct(['Art. 1º Conforme o Anexo Único da referida Portaria.'])) ?? '', /Anexo Único \(ambiguous\) absent/u, '7. "referida Portaria": ambiguous → gap');
  assert.match(m.annexGap(mkAct(['Art. 1º Na forma do anexo.'])) ?? '', /without a label/u, '7b. unlabeled mention → association not provable');
  const corat = readFileSync(new URL('../ops/anatomy/official-identification/rfb-p2c/148516.json', import.meta.url));
  assert.match(m.annexGap(corat) ?? '', /Anexo Único \(own\) absent from the representation/u, '8. ADE Corat: external Anexo Único');
});

test('R2 (9) + B-3: only complete samples are eligible (Portaria 635 + E9-A1); partial readings are flagged complete:false without changing coverage', async () => {
  const m = await import('../ops/anatomy/official-coverage-matrix.js');
  const real = m.collectSamples(); const mx = m.buildMatrix(real);
  assert.deepEqual(real.filter((s) => s.stages.accepted).map((s) => s.id).sort(), ['rfb:108391', 'rfb:115131', 'rfb:133898', 'rfb:142967', 'rfb:148693'], '9. Portaria 635 + E9-A1: complete, digest + engine pinned');
  const by = (id: string) => real.find((s) => s.id === id)!;
  assert.deepEqual([by('rfb:148693').readingComplete, by('rfb:148629').readingComplete, by('rfb:148516').readingComplete, by('rfb:148681').readingComplete], [true, false, false, false]);
  const cell = (id: string) => mx.cells.find((c) => c.id === id)!;
  assert.deepEqual([cell('rfb--portaria--medio').status, cell('rfb--portaria--medio').complete], ['covered', true]);
  assert.deepEqual([cell('rfb--ato-declaratorio-executivo--pequeno').status, cell('rfb--ato-declaratorio-executivo--pequeno').complete, cell('rfb--ato-declaratorio-executivo--pequeno').partialSamples],
    ['covered', false, ['rfb:148629']], 'covered (layout) but complete:false, explicit');
  assert.equal(mx.coveredRequired, 13, 'coverage count unchanged by the completeness flag');
});

test('R2 B-4: decidedOn must be a REAL date', async () => {
  const m = await import('../ops/anatomy/official-coverage-matrix.js');
  for (const bad of ['2026-13-45', '2025-02-30', '2026-00-10', '2026-11-31']) assert.equal(m.realDate(bad), false, bad);
  for (const ok of ['2026-11-11', '2024-02-29']) assert.equal(m.realDate(ok), true, ok);
  const { ANATOMY_ENGINE_BUILD_HASH: E } = await import('../src/modules/anatomy/build-identity.js');
  const rec = { sampleId: 'rfb:148693', cellId: 'rfb--portaria--medio', scope: 'offline', entrySha256: '0'.repeat(64), engineBuildHash: E, decidedBy: 't', decidedOn: '2026-13-45', ref: 't', limits: ['t'] };
  assert.throws(() => m.validateAcceptances({ acceptances: [rec] }, new Set(m.GRID.map((c) => c.id))), /real YYYY-MM-DD/u);
});

// ---- R3 (independent review R2 c.6785660153, B2-1): the annex label is a COMPLETE identity (I ≠ I-A, III ≠ III-B). ----
test('R3 B2-1: suffixed labels — no truncation, no presumption; unsupported or conflicting labels are gaps', async () => {
  const m = await import('../ops/anatomy/official-coverage-matrix.js');
  const A = (id: number, head: string, body: string, file?: string) => anx(id, head, body, file ?? `${id}.html`);
  const TA = '<table><tr><td>I-A</td></tr></table>'; const TB = '<table><tr><td>I-B</td></tr></table>'; const T3 = '<table><tr><td>III</td></tr></table>';
  const rd = (pairs: [number, string][]) => new Map(pairs.map(([id, b]) => [id, shaOf(b)]));
  const gap = (texts: string[], segs: Record<string, unknown>[], read: Map<number, string>) => m.annexGap(mkAct(texts, segs), read);
  // reviewer reproduction: I-A required, only I read → must be a gap (r4: null)
  assert.match(gap(['Art. 1º Fica aprovado o Anexo I-A desta Portaria.'], [A(11, 'ANEXO I', T1)], rd([[11, T1]])) ?? '', /Anexo I-A \(own\) absent/u, 'I-A required, only I present');
  assert.match(gap(['Art. 1º Fica aprovado o Anexo I desta Portaria.'], [A(21, 'ANEXO I-A', TA)], rd([[21, TA]])) ?? '', /Anexo I \(own\) absent/u, 'I required, only I-A present');
  assert.equal(gap(['Art. 1º Fica aprovado o Anexo I-A desta Portaria.'], [A(21, 'ANEXO I-A', TA)], rd([[21, TA]])), null, 'I-A required and I-A read → complete');
  assert.match(gap(['Art. 1º Ficam aprovados os Anexos I-A e I-B desta Portaria.'], [A(21, 'ANEXO I-A', TA)], rd([[21, TA]])) ?? '', /Anexo I-B \(own\) absent/u, 'I-A and I-B required, only I-A');
  assert.match(gap(['Art. 1º Fica aprovado o Anexo III-B desta Portaria.'], [A(31, 'ANEXO III', T3)], rd([[31, T3]])) ?? '', /Anexo III-B \(own\) absent/u, 'III-B required, only III');
  assert.match(gap(['Art. 1º Fica aprovado o Anexo I-AB desta Portaria.'], [A(11, 'ANEXO I', T1)], rd([[11, T1]])) ?? '', /label "I-AB" not supported/u, 'unknown suffix → gap, never truncated to I');
  assert.match(gap(['Art. 1º Fica aprovado o Anexo I.1 desta Portaria.'], [A(11, 'ANEXO I', T1)], rd([[11, T1]])) ?? '', /not supported/u, 'dotted sub-label → gap');
  assert.match(gap(['Art. 1º Fica aprovado o Anexo I-A desta Portaria.'], [A(21, 'ANEXO I-A', TA, 'Anexo_I-B.html')], rd([[21, TA]])) ?? '', /Anexo I-A \(own\) absent/u, 'heading I-A vs file I-B → unusable');
  assert.match(gap(['Art. 1º Fica aprovado o Anexo I-A desta Portaria.'], [A(21, 'ANEXO I-AB', TA)], rd([[21, TA]])) ?? '', /Anexo I-A \(own\) absent/u, 'unsupported segment heading never satisfies');
  assert.equal(gap(['Art. 1º Fica aprovado o Anexo I-A desta Portaria.'], [A(21, '', TA, 'Anexo_I-A.html')], rd([[21, TA]])), null, 'label from the file name with suffix');
  // earlier forms unchanged
  assert.deepEqual(m.annexAudit(mkAct(['Art. 1º Aprovam-se os Anexos I a III desta Portaria.'])).required.map((q) => q.label), ['1', '2', '3']);
  assert.deepEqual(m.annexAudit(mkAct(['Art. 1º Aprovam-se os Anexos I, II e IV desta Portaria.'])).required.map((q) => q.label), ['1', '2', '4']);
  assert.match(m.annexAudit(mkAct(['Art. 1º Aprovam-se os Anexos I-A a I-C desta Portaria.'])).gaps.join(';'), /range .* not supported/u, 'suffixed range → gap');
  assert.equal(gap(['Art. 1º O Anexo Único deste Ato.'], [A(41, 'ANEXO ÚNICO', T1)], rd([[41, T1]])), null, 'Anexo Único still works');
});

// ---- R4 (independent review R3 c.6795489308): B3-1 separator/case variants, B3-2 stray letters ----
test('R4 B3-1/B3-2: every suffix spelling is a suffix (never truncated to I); stray letters and lone L/C are gaps', async () => {
  const m = await import('../ops/anatomy/official-coverage-matrix.js');
  const onlyI = [anx(11, 'ANEXO I', T1)]; const readI = new Map([[11, shaOf(T1)]]);
  for (const v of ['I–A', 'I—A', 'I - A', 'I -A', 'I- A', 'I-a', 'I – a']) {
    const g = m.annexGap(mkAct([`Art. 1º Fica aprovado o Anexo ${v} desta Portaria.`], onlyI), readI);
    assert.match(g ?? '', /Anexo I-A \(own\) absent/u, `"${v}" must require I-A`);
  }
  // segment heading variants map to the same identity; mention and heading symmetrical
  const TA = '<table><tr><td>IA</td></tr></table>';
  for (const h of ['ANEXO I–A', 'ANEXO I - A', 'ANEXO I-a'])
    assert.equal(m.annexGap(mkAct(['Art. 1º Fica aprovado o Anexo I-A desta Portaria.'], [anx(21, h, TA)]), new Map([[21, shaOf(TA)]])), null, `heading "${h}" is I-A`);
  // unknown "label + separator + letters" → gap, never I
  for (const v of ['I-AB', 'I – AB', 'I-1', 'I.A'])
    assert.match(m.annexGap(mkAct([`Art. 1º Fica aprovado o Anexo ${v} desta Portaria.`], onlyI), readI) ?? '', /not supported|absent/u, v);
  // B3-2: stray letters in a list and lone L/C are ambiguous gaps
  assert.match(m.annexGap(mkAct(['Art. 1º Ficam aprovados o Anexo I, A e B desta Portaria.'], onlyI), readI) ?? '', /not supported/u, 'I, A e B');
  assert.match(m.annexGap(mkAct(['Art. 1º Fica aprovado o Anexo C desta Portaria.'], [anx(31, 'ANEXO C', T1)]), new Map([[31, shaOf(T1)]])) ?? '', /not supported/u, 'Anexo C is a letter label, not roman 100');
  assert.match(m.annexGap(mkAct(['Art. 1º Fica aprovado o Anexo L desta Portaria.'], [])) ?? '', /not supported/u, 'Anexo L');
  // unchanged: V and X are still roman (5, 10)
  assert.deepEqual(m.annexAudit(mkAct(['Art. 1º Aprovam-se os Anexos V e X desta Portaria.'])).required.map((q) => q.label), ['5', '10']);
});

test('R4 B2-2 (items 1–3): positive path end-to-end on a SYNTHETIC act; netting only by proven reads; completeness ≠ operative context', async () => {
  const m = await import('../ops/anatomy/official-coverage-matrix.js');
  // synthetic act: "Anexo I desta Portaria" + one embedded "ANEXO I"; main preparation reports 1 attachment without content
  const json = mkAct(['Art. 1º Fica aprovado o Anexo I desta Portaria.'], [anx(11, 'ANEXO I', T1)]);
  const lotEntry = (read: { id: number; sha256: string; referenceContext?: string }[]) => ({ idAto: 1, epigrafe: 'x', canonicalChars: 100, sha256: 's', bytes: 1, promoted: false, outputHash: 'h',
    status: 'complete', unidentifiedChars: 0, attachmentsWithoutContent: 1, limitations: {}, partTypes: { article: 1, caput: 1 }, inlineAttachments: { read } });
  // 1. positive path: the annex is required, present, decoded and READ (same id + sha) → complete, attachment netted
  const ok = m.rfbReadingAssessment(lotEntry([{ id: 11, sha256: shaOf(T1), referenceContext: 'operative_candidate' }]) as never, json);
  assert.deepEqual([ok.complete, ok.readAttachments, ok.gaps], [true, 1, []]);
  // 2. netting is per proven read, never per evidence count: evidence for another id or other bytes nets nothing
  for (const ev of [[{ id: 99, sha256: shaOf(T1) }], [{ id: 11, sha256: shaOf('other') }], []]) {
    const r = m.rfbReadingAssessment(lotEntry(ev) as never, json);
    assert.equal(r.complete, false); assert.match(r.gaps.join(';'), /1 attachment\(s\) without content/u);
  }
  // 3. completeness is independent of the operative context: a fully read annex that is prohibited still completes the READING
  const proh = m.rfbReadingAssessment(lotEntry([{ id: 11, sha256: shaOf(T1), referenceContext: 'prohibited' }]) as never, json);
  assert.equal(proh.complete, true, 'reading complete; force/function decided elsewhere (no acceptance implied)');
  // the real lot of this branch has no producer: every real sample keeps its earlier assessment (fail closed)
  const real = m.collectSamples();
  assert.deepEqual(real.filter((s) => s.stages.accepted).map((s) => s.id).sort(), ['rfb:108391', 'rfb:115131', 'rfb:133898', 'rfb:142967', 'rfb:148693']);
  assert.equal(real.find((s) => s.id === 'rfb:148629')!.readingComplete, false);
});

// ---- R5 (independent review R4 c.6796232552): B4-1 Unicode / slash / parenthesis separators and format chars; B4-2 dangling dash ----
test('R5 B4-1/B4-2: no spelling of a suffix truncates to I; a dangling separator is ambiguous', async () => {
  const m = await import('../ops/anatomy/official-coverage-matrix.js');
  const onlyI = [anx(11, 'ANEXO I', T1)]; const readI = new Map([[11, shaOf(T1)]]);
  const req = (v: string) => m.annexGap(mkAct([`Art. 1º Fica aprovado o Anexo ${v} desta Portaria.`], onlyI), readI) ?? '';
  for (const v of ['I−A', 'I﹣A', 'I－A', 'I/A', 'I(A)', 'I​-A', 'I-​A', 'I‑A', 'I‐A', 'I‒A', 'I⸺A'])
    assert.match(req(v), /Anexo I-A \(own\) absent|not supported/u, `${JSON.stringify(v)} must never be satisfied by Anexo I`);
  // the normalized forms are the same identity on both sides (mention and heading)
  const TA = '<table><tr><td>IA</td></tr></table>';
  for (const [mention, head] of [['I−A', 'ANEXO I-A'], ['I-A', 'ANEXO I－A'], ['I​-A', 'ANEXO I-A']] as const)
    assert.equal(m.annexGap(mkAct([`Art. 1º Fica aprovado o Anexo ${mention} desta Portaria.`], [anx(21, head, TA)]), new Map([[21, shaOf(TA)]])), null, `${JSON.stringify(mention)} × ${JSON.stringify(head)}`);
  // B4-2: a dangling separator is not "I"
  for (const v of ['I-', 'I –', 'I/'])
    assert.match(req(v), /not supported/u, `${JSON.stringify(v)} is ambiguous`);
  // unchanged positives
  assert.equal(m.annexGap(mkAct(['Art. 1º Fica aprovado o Anexo I desta Portaria.'], onlyI), readI), null, 'plain I still complete');
  assert.deepEqual(m.annexAudit(mkAct(['Art. 1º Aprovam-se os Anexos I a III desta Portaria.'])).required.map((q) => q.label), ['1', '2', '3']);
});
