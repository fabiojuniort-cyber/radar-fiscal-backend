import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ANATOMY_ENGINE_BUILD_HASH } from '../src/modules/anatomy/build-identity.js';
import {
  assertNfcShadowRuntime, buildNfcShadow, hasNfcBoundaryBefore, NFC_SHADOW_LIMITS, NFC_SHADOW_TABLE_SHA256, NfcShadowError,
  originalToShadow, shadowToOriginal, type NfcShadowMap,
} from '../src/modules/anatomy/nfc-shadow.js';
import { NFC_NO_BOUNDARY_BEFORE } from '../src/modules/anatomy/nfc-shadow-table.js';

// ANAT-UNICODE-01b/B1 (issue #116). SYNTHETIC strings and the official Unicode 17.0 NormalizationTest.txt only.
// Runs on Node 24 (ICU 78, Unicode 17.0): the component refuses any other runtime Unicode version.
const ucd = (f: string) => readFileSync(new URL(`../ops/anatomy/ucd/17.0.0/${f}`, import.meta.url), 'utf8');
const codeOf = (fn: () => unknown) => { try { fn(); } catch (e) { assert.ok(e instanceof NfcShadowError, String(e)); return e.code; } return 'no-error'; };
const hex = (s: string) => [...s].map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`).join(' ');

test('B1: runtime and data identity — Unicode 17.0 table, fail closed on another runtime', () => {
  assert.equal(process.versions.unicode, '17.0', 'run on Node 24 (Unicode 17.0)');
  assert.equal(codeOf(() => assertNfcShadowRuntime('16.0')), 'unsupported_runtime');
  assert.equal(codeOf(() => assertNfcShadowRuntime('')), 'unsupported_runtime');
  assert.equal(codeOf(() => assertNfcShadowRuntime('17.1')), 'unsupported_runtime');
  assertNfcShadowRuntime();
  assert.equal(createHash('sha256').update(JSON.stringify(NFC_NO_BOUNDARY_BEFORE)).digest('hex'), NFC_SHADOW_TABLE_SHA256);
  const manifest = JSON.parse(readFileSync(new URL('../docs/anatomy/nfc-shadow-manifest.json', import.meta.url), 'utf8'));
  for (const f of ['UnicodeData.txt', 'DerivedNormalizationProps.txt', 'NormalizationTest.txt']) {
    assert.equal(createHash('sha256').update(readFileSync(new URL(`../ops/anatomy/ucd/17.0.0/${f}`, import.meta.url))).digest('hex'), manifest.inputs[f], f);
  }
  const fileSha = (f: string) => createHash('sha256').update(readFileSync(new URL(`../${f}`, import.meta.url))).digest('hex');
  assert.equal(fileSha('src/modules/anatomy/nfc-shadow.ts'), manifest.moduleSha256, 'manifest matches the module');
  assert.equal(fileSha('ops/anatomy/nfc-shadow-table.mjs'), manifest.generatorSha256, 'manifest matches the generator');
  assert.equal(manifest.tableSha256, NFC_SHADOW_TABLE_SHA256);
  assert.match(ucd('NormalizationTest.txt').slice(0, 80), /NormalizationTest-17\.0\.0/);
  assert.match(ucd('DerivedNormalizationProps.txt').slice(0, 80), /DerivedNormalizationProps-17\.0\.0/);
});

test('B1: the component stays outside the engine path and outside the engine identity', () => {
  for (const f of ['readers.ts', 'entities.ts', 'engine.ts', 'evaluation-adapter.ts', 'consumer.ts', 'profile-rules.ts']) {
    assert.ok(!/nfc-shadow/u.test(readFileSync(new URL(`../src/modules/anatomy/${f}`, import.meta.url), 'utf8')), f);
  }
  assert.ok(!/nfc-shadow/u.test(readFileSync(new URL('../ops/anatomy/build-identity.mjs', import.meta.url), 'utf8')));
  assert.equal(ANATOMY_ENGINE_BUILD_HASH, 'bbcd7a7cc41c98129468fd7d3ceaa46fad7f21b2d60966e48a1b7f676f4ba001', 'engineHash of the accepted UNICODE-01a');
});

/** Structural invariants of any usable map. */
function checkMap(m: NfcShadowMap, label: string) {
  assert.equal(m.shadow, m.original.normalize('NFC'), `${label}: shadow is NFC of the original`);
  const n = m.origStart.length - 1;
  assert.equal(m.origStart[0], 0); assert.equal(m.shadowStart[0], 0);
  assert.equal(m.origStart[n], m.original.length); assert.equal(m.shadowStart[n], m.shadow.length);
  for (let k = 0; k < n; k++) {
    assert.ok(m.origStart[k]! < m.origStart[k + 1]! && m.shadowStart[k]! < m.shadowStart[k + 1]!, `${label}: strictly monotone, non-empty segments`);
    assert.equal(m.original.slice(m.origStart[k], m.origStart[k + 1]).normalize('NFC'), m.shadow.slice(m.shadowStart[k], m.shadowStart[k + 1]));
  }
}

test('B1: official conformance — NormalizationTest.txt 17.0.0, every part, NFC column', (t) => {
  const lines = ucd('NormalizationTest.txt').split('\n');
  const listed = new Set<number>(); let part = ''; let checked = 0;
  const str = (field: string) => String.fromCodePoint(...field.trim().split(/\s+/u).map((h) => parseInt(h, 16)));
  for (const line of lines) {
    if (line.startsWith('@Part')) { part = line.slice(0, 6); continue; }
    if (!line || line.startsWith('#')) continue;
    const cols = line.split(';').slice(0, 5).map(str);
    const [c1, c2, c3, c4, c5] = cols as [string, string, string, string, string];
    if (part === '@Part1') listed.add(c1.codePointAt(0)!);
    // NFC: c2 == toNFC(c1) == toNFC(c2) == toNFC(c3); c4 == toNFC(c4) == toNFC(c5).
    for (const [src, want] of [[c1, c2], [c2, c2], [c3, c2], [c4, c4], [c5, c4]] as const) {
      const m = buildNfcShadow(src);
      assert.ok(m.usable, `${part} ${hex(src)}`);
      assert.equal(m.shadow, want, `${part} ${hex(src)}`);
      checked++;
    }
    checkMap(buildNfcShadow(c1), `${part} ${hex(c1)}`);
  }
  assert.ok(checked > 90_000, `${checked} conformance checks`);
  // Part 1 complement: every other code point is unchanged by NFC (surrogates excluded, as in the test file).
  let unchanged = 0;
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if ((cp >= 0xd800 && cp <= 0xdfff) || listed.has(cp)) continue;
    const s = String.fromCodePoint(cp);
    if (buildNfcShadow(s).shadow !== s) assert.fail(`U+${cp.toString(16)} changed`);
    unchanged++;
  }
  assert.ok(unchanged > 1_000_000);
  t.diagnostic(`conformance: ${checked} NFC checks; ${unchanged} other code points unchanged`);
});

test('B1: table agrees with the runtime — no code point marked as boundary changes or composes leftwards', () => {
  // A boundary code point must be NFC-stable alone, and must not compose with a preceding starter or mark.
  const left = ['a', 'e', 'A', '\u1100', '\uac00', '\u0301', 'o\u0308', '\u0915'];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) { assert.ok(hasNfcBoundaryBefore(cp)); continue; }
    if (!hasNfcBoundaryBefore(cp)) continue;
    const c = String.fromCodePoint(cp);
    assert.equal(c.normalize('NFC'), c, `U+${cp.toString(16)} boundary but not NFC-stable`);
    for (const l of left) assert.equal((l + c).normalize('NFC'), l.normalize('NFC') + c, `U+${cp.toString(16)} after ${hex(l)}`);
  }
});

// The ten examples of the proposal (issue #116, 6282160251), recomputed on Unicode 17.0 with the real component.
const examples: { name: string; text: string; find: string; shadowSpan: [number, number]; original: [number, number]; slice: string; widened: boolean }[] = [
  { name: 'composition', text: 'Cla\u0301usula primeira', find: 'Cláusula', shadowSpan: [0, 8], original: [0, 9], slice: 'Cla\u0301usula', widened: false },
  { name: 'exception', text: 'NCM 8471, exclui\u0301da a NCM 8471.30.12', find: 'excluída', shadowSpan: [10, 18], original: [10, 19], slice: 'exclui\u0301da', widened: false },
  { name: 'reordering', text: 'a\u0301\u0323x', find: 'x', shadowSpan: [2, 3], original: [3, 4], slice: 'x', widened: false },
  { name: 'match inside a reordered segment', text: 'e\u0301\u0323', find: '\u1eb9', shadowSpan: [0, 1], original: [0, 3], slice: 'e\u0301\u0323', widened: true },
  { name: 'Hangul L+V+T', text: '\u1100\u1161\u11a8 NCM', find: '\uac01', shadowSpan: [0, 1], original: [0, 3], slice: '\u1100\u1161\u11a8', widened: false },
  { name: 'Hangul LV+T', text: '\uac00\u11a8', find: '\uac01', shadowSpan: [0, 1], original: [0, 2], slice: '\uac00\u11a8', widened: false },
  { name: 'initial mark', text: '\u0301abc NCM 8471', find: 'NCM 8471', shadowSpan: [5, 13], original: [5, 13], slice: 'NCM 8471', widened: false },
  { name: 'singleton', text: '\u212b NCM 8471', find: '\u00c5', shadowSpan: [0, 1], original: [0, 1], slice: '\u212b', widened: false },
  { name: 'emoji ZWJ', text: '\u{1F469}\u200d\u{1F4BB} e\u0301 NCM 8471', find: 'NCM 8471', shadowSpan: [8, 16], original: [9, 17], slice: 'NCM 8471', widened: false },
  { name: 'surrogate pair', text: '\u{1D538}e\u0301 8471', find: '8471', shadowSpan: [4, 8], original: [5, 9], slice: '8471', widened: false },
];

test('B1: map examples — shadow match, mapped original span, original slice, widening diagnostic', () => {
  for (const ex of examples) {
    const m = buildNfcShadow(ex.text);
    assert.ok(m.usable && !m.identity === (ex.text !== ex.text.normalize('NFC')), ex.name);
    checkMap(m, ex.name);
    const at = m.shadow.indexOf(ex.find);
    assert.deepEqual([at, at + ex.find.length], ex.shadowSpan, `${ex.name}: shadow span`);
    const r = shadowToOriginal(m, { start: at, end: at + ex.find.length });
    assert.deepEqual([r.span.start, r.span.end], ex.original, `${ex.name}: original span`);
    assert.equal(ex.text.slice(r.span.start, r.span.end), ex.slice, `${ex.name}: original slice`);
    assert.equal(!r.exact, ex.widened, `${ex.name}: widened`);
    if (!r.exact) assert.deepEqual(r.widening, { requested: { start: at, end: at + ex.find.length }, mapped: r.span, reason: 'inside_normalization_segment' });
    // Round trip: an exact original span maps back onto the same shadow span.
    if (r.exact) assert.deepEqual(originalToShadow(m, r.span), { span: { start: at, end: at + ex.find.length }, exact: true });
  }
});

test('B1: forced boundaries — only NFC boundaries are supported; otherwise the map is unusable', () => {
  const unsupported: [string, string, number][] = [
    ['Hangul L | V (<b>\u1100</b>\u1161)', '\u1100\u1161', 1], ['Hangul LV | T', '\uac00\u11a8', 1],
    ['accent across nodes (<b>e</b>&#769;)', 'e\u0301', 1], ['reordering across nodes', 'a\u0301\u0323', 2],
    ['singleton composition partner (Maybe) after a node', 'o\u0308', 1],
  ];
  for (const [name, text, at] of unsupported) {
    const m = buildNfcShadow(text, { forcedBoundaries: [at] });
    assert.equal(m.usable, false, name); assert.equal(m.identity, false, name);
    assert.deepEqual(m.diagnostics.filter((d) => d.code === 'forced_boundary_inside_segment').map((d) => d.offset), [at], name);
    // Splitting there also breaks the concatenation invariant, which is reported as well.
    assert.ok(m.diagnostics.every((d) => d.code === 'forced_boundary_inside_segment' || d.code === 'nfc_concatenation_mismatch'), name);
    // Separately normalised nodes differ from the joint NFC: exactly why the boundary is refused.
    assert.notEqual(text.slice(0, at).normalize('NFC') + text.slice(at).normalize('NFC'), text.normalize('NFC'), name);
    assert.equal(codeOf(() => shadowToOriginal(m, { start: 0, end: 1 })), 'invalid_span', `${name}: unusable map refuses mapping`);
  }
  // NFC-safe forced boundaries keep the map usable and are segment starts.
  const ok = buildNfcShadow('Cla\u0301usula NCM 8471', { forcedBoundaries: [3 + 2, 14] });
  assert.ok(ok.usable); checkMap(ok, 'safe boundaries');
  for (const b of [5, 14]) assert.ok([...ok.origStart].includes(b));
  // Invalid boundary lists are refused, never clipped.
  for (const fb of [[0], [3], [2, 1], [1, 1], [1.5], [Number.NaN], [-1]]) assert.equal(codeOf(() => buildNfcShadow('abc', { forcedBoundaries: fb })), 'invalid_boundaries', JSON.stringify(fb));
  assert.equal(codeOf(() => buildNfcShadow('\u{1D538}x', { forcedBoundaries: [1] })), 'invalid_boundaries', 'splits a surrogate pair');
});

test('B1: span validation — half-open integer spans, no clipping, identity map validated too', () => {
  for (const text of ['abc NCM', 'Cla\u0301usula']) {
    const m = buildNfcShadow(text);
    for (const map of [shadowToOriginal, originalToShadow]) {
      for (const span of [{ start: -1, end: 1 }, { start: 2, end: 1 }, { start: 0, end: 99 }, { start: 0.5, end: 1 }, { start: Number.NaN, end: 1 }, null as never]) {
        assert.equal(codeOf(() => map(m, span)), 'invalid_span', `${text} ${JSON.stringify(span)}`);
      }
    }
  }
  const id = buildNfcShadow('abc');
  assert.ok(id.identity);
  assert.deepEqual(shadowToOriginal(id, { start: 1, end: 2 }), { span: { start: 1, end: 2 }, exact: true });
  // Surrogate pairs: a span cutting a pair is refused on either side.
  const astral = buildNfcShadow('x\u{1D538}y');
  assert.equal(codeOf(() => shadowToOriginal(astral, { start: 0, end: 2 })), 'invalid_span');
  assert.equal(codeOf(() => originalToShadow(astral, { start: 2, end: 3 })), 'invalid_span');
  // Empty intervals: defined at a segment boundary (maps to that boundary), refused inside a segment.
  const m = buildNfcShadow('Cla\u0301usula');
  assert.deepEqual(originalToShadow(m, { start: 4, end: 4 }), { span: { start: 3, end: 3 }, exact: true });
  assert.equal(codeOf(() => originalToShadow(m, { start: 3, end: 3 })), 'invalid_span');
  // Lone surrogates are kept as their own segment, neither replaced nor dropped.
  const lone = buildNfcShadow('a\ud800b\udc00');
  assert.equal(lone.shadow, 'a\ud800b\udc00'); assert.ok(lone.identity);
  assert.deepEqual(shadowToOriginal(lone, { start: 1, end: 2 }).span, { start: 1, end: 2 });
  // Limits.
  assert.equal(codeOf(() => buildNfcShadow('a'.repeat(NFC_SHADOW_LIMITS.maxInputUtf16 + 1))), 'input_too_large');
});

/** mulberry32: small deterministic PRNG; the seed and the pool below define the fuzz. */
function mulberry32(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const FUZZ = Object.freeze({ seed: 0x5eed0b01, strings: 60_000, maxLength: 14 });

test('B1: reproducible fuzz — invariants, mapping and forced boundaries (seed 0x5EED0B01)', (t) => {
  // Pool: ASCII, precomposed Latin, marks of several combining classes, Hangul L/V/T/LV/LVT, singletons and NFC_QC=No,
  // emoji/ZWJ, astral letters, lone surrogates, plus every code point of NormalizationTest 17.0 source columns
  // (covers compositions and contexts added up to Unicode 17, e.g. Tulu-Tigalari, Kirat Rai, Gurung Khema).
  const fixed = [...'aeoucACN 0123.,', 'é', '\u00c5', '\u0301', '\u0323', '\u0302', '\u0308', '\u0327', '\u0345', '\u05b0', '\u0e48', '\u1100', '\u1161',
    '\u11a8', '\uac00', '\uac01', '\u212b', '\u2126', '\u0340', '\u0958', '\u0f73', '\u{1F469}', '\u200d', '\u{1F4BB}', '\u{1D538}', '\ud800', '\udc00'];
  const fromTest = new Set<string>();
  for (const line of ucd('NormalizationTest.txt').split('\n')) {
    if (!line || line.startsWith('#') || line.startsWith('@')) continue;
    for (const h of line.split(';')[0]!.trim().split(/\s+/u)) fromTest.add(String.fromCodePoint(parseInt(h, 16)));
  }
  const pool = [...fixed, ...fromTest];
  const rnd = mulberry32(FUZZ.seed); const pick = () => pool[Math.floor(rnd() * pool.length)]!;
  let usableForced = 0; let refusedForced = 0; let widened = 0;
  for (let i = 0; i < FUZZ.strings; i++) {
    let text = ''; const len = Math.floor(rnd() * FUZZ.maxLength);
    for (let k = 0; k < len; k++) text += pick();
    const m = buildNfcShadow(text);
    assert.ok(m.usable, hex(text)); checkMap(m, hex(text));
    if (m.shadow.length) {
      const a = Math.floor(rnd() * m.shadow.length); const b = a + 1 + Math.floor(rnd() * (m.shadow.length - a));
      let r;
      try { r = shadowToOriginal(m, { start: a, end: b }); } catch (e) { assert.ok(e instanceof NfcShadowError && e.code === 'invalid_span'); continue; } // span cut a pair
      if (!r.exact) widened++;
      const back = originalToShadow(m, r.span);
      assert.ok(back.exact && back.span.start <= a && back.span.end >= b, `covers ${hex(text)} [${a},${b})`);
      assert.ok(r.span.start >= 0 && r.span.end <= text.length && r.span.start < r.span.end);
    }
    // Random forced boundaries at code point offsets.
    const offsets: number[] = []; for (let u = 1; u < text.length; u++) if (!(text.charCodeAt(u - 1) >= 0xd800 && text.charCodeAt(u - 1) <= 0xdbff && text.charCodeAt(u) >= 0xdc00 && text.charCodeAt(u) <= 0xdfff) && rnd() < 0.3) offsets.push(u);
    const f = buildNfcShadow(text, { forcedBoundaries: offsets });
    if (f.usable) { usableForced++; checkMap(f, `forced ${hex(text)}`); for (const o of offsets) assert.ok([...f.origStart].includes(o)); }
    else {
      refusedForced++;
      assert.ok(f.diagnostics.some((d) => d.code === 'forced_boundary_inside_segment'));
      for (const d of f.diagnostics) if (d.code === 'forced_boundary_inside_segment') assert.equal(hasNfcBoundaryBefore(text.codePointAt(d.offset!)!), false);
    }
  }
  t.diagnostic(`fuzz: pool ${pool.length}, ${FUZZ.strings} strings, widened ${widened}, forced usable ${usableForced}, refused ${refusedForced}`);
  assert.ok(widened > 0 && usableForced > 0 && refusedForced > 0, `widened ${widened}, forced usable ${usableForced}, refused ${refusedForced}`);
});

test('B1: cost — linear construction on the size limit (measured, not assumed)', (t) => {
  const unit = 'Cla\u0301usula NCM 8471.30.12, exclui\u0301da \uac00\u11a8 \u{1D538} ';
  const big = unit.repeat(Math.floor(NFC_SHADOW_LIMITS.maxInputUtf16 / unit.length));
  const half = big.slice(0, big.length / 2 - ((big.length / 2) % unit.length));
  const time = (s: string) => { const t = process.hrtime.bigint(); const m = buildNfcShadow(s); assert.ok(m.usable); return Number(process.hrtime.bigint() - t) / 1e6; };
  time(half); const t1 = time(half); const t2 = time(big);
  t.diagnostic(`cost: ${half.length} units ${t1.toFixed(0)} ms; ${big.length} units ${t2.toFixed(0)} ms`);
  assert.ok(t2 < 5000, `full size built in ${t2.toFixed(0)} ms`);
  assert.ok(t2 < t1 * 4, `roughly linear: half ${t1.toFixed(0)} ms, full ${t2.toFixed(0)} ms`);
  const m = buildNfcShadow(big);
  const t0 = process.hrtime.bigint(); for (let i = 0; i < 10_000; i++) { const k = (i * 97) % (m.shadowStart.length - 2); shadowToOriginal(m, { start: m.shadowStart[k]!, end: m.shadowStart[k + 2]! }); }
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 1000, '10 000 mappings (binary search)');
});
