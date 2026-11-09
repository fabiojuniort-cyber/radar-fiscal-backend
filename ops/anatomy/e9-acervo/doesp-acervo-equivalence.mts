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
const a = summary(read(`doesp:${expectedId}`, prepared.html));
const sanitized = sanitizeLegalPresentationHtml(raw);
const b = sanitized === undefined ? null : summary(read(`acervo-equiv:${expectedId}`, sanitized));

const differences: string[] = [];
if (!b) differences.push('the Acervo keeps NO presentation for this act (empty or above the 2 MiB ceiling)');
else for (const k of ['status', 'chars', 'textSha256', 'partTypes', 'contexts', 'limitations', 'unidentifiedChars'] as const)
  if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) differences.push(k);

console.log(JSON.stringify({ engineBuildHash: ANATOMY_ENGINE_BUILD_HASH, input: { file, sha256, bytes: bytes.length, expectedId },
  preparationVersion: prepared.preparationVersion, provisional: prepared.provisional, rawMarkup,
  officialJson: a, acervoEquivalent: b, differences,
  verdict: differences.length === 0 ? 'equivalent for this sample' : 'the Acervo representation loses what the reader uses for this sample' }, null, 1));
