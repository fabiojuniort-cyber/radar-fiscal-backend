// E9-ACERVO-01 §3 (tribusca-control#116): minimal DOE-SP test, offline. For ONE DOE-SP API v2 detail JSON (bytes as
// received), compare what the reader gets from (A) the official JSON — prepareDoeSpRepresentation, `content` unaltered —
// with (B) what the Acervo keeps — parseDoeSpDetail (connector) + sanitizeLegalPresentationHtml (production). Both are
// read with source DOE-SP. No network, no database. The verdict is only about this sample: it never proves the
// representation for other acts or layouts.
//
// Usage: npx tsx ops/anatomy/e9-acervo/doesp-acervo-equivalence.mts <repoRoot> <detail.json> <expectedGuid> [sha256]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const [repo, file, expectedId, expectedSha] = process.argv.slice(2);
if (!repo || !file || !expectedId) throw new Error('usage: <repoRoot> <detail.json> <expectedGuid> [sha256]');
const { prepareDoeSpRepresentation } = await import(join(repo, 'src/modules/anatomy/json-preparation.ts'));
const { analyzeAnatomy } = await import(join(repo, 'src/modules/anatomy/engine.ts'));
const { ANATOMY_ENGINE_BUILD_HASH } = await import(join(repo, 'src/modules/anatomy/build-identity.ts'));
const { parseDoeSpDetail } = await import(join(repo, 'src/modules/collection/doe-sp.parser.ts'));
const { sanitizeLegalPresentationHtml } = await import(join(repo, 'src/modules/collection/legal-presentation.ts'));

const bytes = readFileSync(file);
const sha256 = createHash('sha256').update(bytes).digest('hex');
if (expectedSha && expectedSha !== sha256) throw new Error(`bytes differ from the recorded SHA-256 (${sha256.slice(0, 12)}…)`);

// Markup the sanitizer is known (from its code) to drop; counted in the RAW content, so the loss is attributable.
const raw = parseDoeSpDetail(JSON.parse(bytes.toString('utf8')), expectedId).contentHtml as string;
const count = (re: RegExp) => (raw.match(re) ?? []).length;
const rawMarkup = {
  img: count(/<img\b/giu), strikeTags: count(/<(s|strike|del)\b/giu), lineThroughStyle: count(/line-through/giu),
  classAttributes: count(/\sclass\s*=/giu), styleAttributes: count(/\sstyle\s*=/giu), svg: count(/<svg\b/giu),
  scriptOrStyle: count(/<(script|style)\b/giu), tables: count(/<table\b/giu), spans: count(/\s(rowspan|colspan)\s*=/giu),
  bytes: Buffer.byteLength(raw, 'utf8'),
};

const read = (id: string, html: string) => analyzeAnatomy({ publicationVersionId: id, referenceDate: '2026-11-09',
  ruleSet: { id: 'e9-acervo-doesp', version: '1' }, input: { source: 'DOE-SP', representationId: id, html }, catalog: { edition: 'none', codes: [] } });
const tally = (xs: string[]) => Object.fromEntries([...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())].sort());
// R5.2: per-part view with ORIGINAL positions kept, so the two readings can be aligned after an offset remap.
const partsOf = (r: any) => r.parts.map((p: any) => ({ id: p.id, type: p.type, context: p.context, start: p.span.start, end: p.span.end,
  text: r.canonicalText.slice(p.span.start, p.span.end) }));
const summary = (r: any) => ({
  status: r.status, chars: r.canonicalText.length, textSha256: createHash('sha256').update(r.canonicalText).digest('hex'),
  partTypes: tally(r.parts.map((p: any) => p.type)), contexts: tally(r.parts.map((p: any) => p.context)),
  limitations: tally(r.limitations.map((l: any) => l.code)),
  unidentifiedChars: r.parts.filter((p: any) => p.type === 'unidentified').reduce((a: number, p: any) => a + p.span.end - p.span.start, 0),
  invariantBreaks: [
    ...(r.parts.some((p: any) => p.legalStatus !== 'unknown') ? ['legalStatus must stay unknown'] : []),
    ...(r.parts.some((p: any) => p.type === 'quoted_text' && p.context === 'operative_candidate') ? ['quoted text must never be operative'] : []),
  ],
});

const prepared = prepareDoeSpRepresentation({ resourceId: `doesp:${expectedId}`, bytes: new Uint8Array(bytes) }, expectedId);
const ra = read(`doesp:${expectedId}`, prepared.html);
const a = summary(ra);
const sanitized = sanitizeLegalPresentationHtml(raw);
const rb = sanitized === undefined ? null : read(`acervo-equiv:${expectedId}`, sanitized);
const b = rb === null ? null : summary(rb);

/**
 * R5.2 alignment. Find where the Acervo canonical text sits inside the official one: A = prefix + B + suffix. Report
 * what each side has beyond the shared text (exact characters, escaped), and whether those extras are whitespace only.
 * Then pair the parts in order and compare type, context and position AFTER remapping B by the offset (original
 * positions of both sides are kept in the output). Classify the difference as position-only, content loss, or a
 * limitation common to both readings.
 */
function align(A: string, B: string) {
  let pre = 0; while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0; while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const offset = A.indexOf(B);
  if (offset >= 0) {
    const before = A.slice(0, offset); const after = A.slice(offset + B.length);
    return { contained: true as const, offset, officialOnly: { before: JSON.stringify(before), beforeChars: before.length, after: JSON.stringify(after), afterChars: after.length },
      acervoOnly: { chars: 0 }, extrasWhitespaceOnly: /^\s*$/u.test(before + after) };
  }
  return { contained: false as const, offset: null, firstDifference: pre, commonSuffix: suf };
}
let alignment: Record<string, unknown> | null = null; let partComparison: Record<string, unknown>[] = []; const verdicts: string[] = [];
if (rb) {
  const al = align(ra.canonicalText, rb.canonicalText); alignment = al;
  const pa = partsOf(ra); const pb = partsOf(rb);
  const off = al.contained ? al.offset : 0;
  partComparison = pa.map((x: any, i: number) => {
    const y = pb[i];
    if (!y) return { index: i, official: x, acervo: null, match: false, why: 'no counterpart' };
    // Text of a part is compared trimmed of the edge whitespace that one side may own beyond the shared text.
    const sameText = x.text === y.text || x.text.trim() === y.text.trim();
    const remapped = { start: y.start + off, end: y.end + off };
    const samePos = remapped.start === x.start && remapped.end === x.end;
    const containedPos = remapped.start >= x.start && remapped.end <= x.end; // document/edge parts own the extra whitespace
    return { index: i, type: [x.type, y.type], context: [x.context, y.context], official: { start: x.start, end: x.end }, acervo: { start: y.start, end: y.end },
      acervoRemapped: remapped, sameType: x.type === y.type, sameContext: x.context === y.context, sameText, position: samePos ? 'equal after remap' : containedPos ? 'inside after remap (edge whitespace)' : 'differs',
      ...(x.type === 'unidentified' ? { unidentifiedText: [JSON.stringify(x.text), JSON.stringify(y.text)] } : {}) };
  });
  const unidentified = { official: pa.filter((x: any) => x.type === 'unidentified').map((x: any) => ({ start: x.start, end: x.end, chars: x.end - x.start, text: JSON.stringify(x.text) })),
    acervo: pb.filter((x: any) => x.type === 'unidentified').map((x: any) => ({ start: x.start, end: x.end, chars: x.end - x.start, text: JSON.stringify(x.text) })) };
  (alignment as any).unidentified = unidentified;
  const allPaired = pa.length === pb.length && partComparison.every((c: any) => c.sameType && c.sameContext && c.sameText && c.position !== 'differs');
  if (al.contained && al.extrasWhitespaceOnly && allPaired) verdicts.push('POSITION_ONLY: same parts, types, contexts and text; positions differ only by the edge whitespace the official side has beyond the Acervo text');
  else verdicts.push('CONTENT_OR_STRUCTURE_DIFFERS: see alignment and partComparison');
  const lostLimits = Object.keys(a.limitations).filter((k) => !(k in (b?.limitations ?? {})));
  if (lostLimits.length) verdicts.push(`LIMITATION_SIGNAL_LOST_IN_ACERVO: ${lostLimits.join(', ')}`);
  const common = Object.keys(a.limitations).filter((k) => k in (b?.limitations ?? {}));
  if (common.length || unidentified.official.length) verdicts.push(`COMMON_LIMITATION (both readings): ${[...common, `${unidentified.official.length} unidentified part(s), ${unidentified.official.reduce((n: number, u: any) => n + u.chars, 0)} chars official / ${unidentified.acervo.reduce((n: number, u: any) => n + u.chars, 0)} Acervo`].join('; ')}`);
} else verdicts.push('NO_ACERVO_PRESENTATION: the Acervo keeps no presentation for this act');
if (rawMarkup.strikeTags === 0 && rawMarkup.lineThroughStyle === 0) verdicts.push('TACHADO_NOT_TESTED: the official content has no <s>/<strike>/<del>/line-through');

const differences: string[] = [];
if (!b) differences.push('the Acervo keeps NO presentation for this act (empty or above the 2 MiB ceiling)');
else for (const k of ['status', 'chars', 'textSha256', 'partTypes', 'contexts', 'limitations', 'unidentifiedChars'] as const)
  if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) differences.push(k);

console.log(JSON.stringify({ engineBuildHash: ANATOMY_ENGINE_BUILD_HASH, input: { file, sha256, bytes: bytes.length, expectedId },
  preparationVersion: prepared.preparationVersion, provisional: prepared.provisional, rawMarkup,
  officialJson: a, acervoEquivalent: b, differences, alignment, partComparison, verdicts,
  verdict: differences.length === 0 ? 'equivalent for this sample' : 'the Acervo representation loses what the reader uses for this sample' }, null, 1));
