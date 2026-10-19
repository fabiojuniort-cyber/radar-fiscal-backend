import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { developmentCanonicalText, GOLD_DIR } from '../ops/anatomy/annotation-pack.js';
import { buildGold } from '../ops/anatomy/gold-build.js';
import { codeBreakdown } from '../ops/anatomy/gold-stats.js';
import { chunkDir, goldChunks, reassembleCanonical, reassembleGold, REVIEW_IDS } from '../ops/anatomy/gold-chunks.js';
import { sha256 } from '../src/modules/anatomy/contract.js';
import { ANATOMY_GOLD_VERSION, goldContentSha256, validateAnatomyGold, type AnatomyGold } from '../src/modules/anatomy/gold.js';

const text = 'Art. 1º NCM 0101.21.00 😀.';
function base(over: Partial<AnatomyGold> = {}): AnatomyGold {
  return { goldVersion: ANATOMY_GOLD_VERSION, id: '99', partition: 'development', preparation: 'synthetic/1', canonicalTextSha256: sha256(text),
    canonicalTextUtf16Length: text.length, status: 'prepared', annotator: 'exec', annotatedAt: '2026-10-17',
    parts: [{ id: 'd', parentId: null, order: 0, type: 'document', span: { start: 0, end: text.length }, context: 'unknown', contextReason: 'document', table: null },
      { id: 'a1', parentId: 'd', order: 0, type: 'article', span: { start: 0, end: text.length }, context: 'operative_candidate', contextReason: 'article_marker', table: null }],
    entities: [{ id: 'e1', partId: 'a1', span: { start: 12, end: 22 }, literal: '0101.21.00', domain: 'NCM', note: '' }],
    relations: [], gaps: [], review: { reviewer: null, status: 'requested', reviewedAt: null, approvedContentSha256: null, notes: '' }, ...over };
}
const rejects = (g: unknown, re: RegExp, t: string | undefined = text) => assert.throws(() => validateAnatomyGold(g, t), re);

test('synthetic gold validates against its exact canonical text', () => {
  assert.equal(validateAnatomyGold(base(), text).id, '99');
});

test('gold invariants fail closed', () => {
  rejects(base({ canonicalTextSha256: sha256('other') }), /frozen hash/);
  rejects(base({ entities: [{ id: 'e1', partId: 'a1', span: { start: 12, end: 22 }, literal: '0101.21.01', domain: 'NCM', note: '' }] }), /literal differs/);
  const emoji = text.indexOf('😀') + 1;
  rejects(base({ parts: [base().parts[0]!, { ...base().parts[1]!, span: { start: 0, end: emoji } }], entities: [] }), /surrogate/);
  rejects(base({ parts: [base().parts[0]!, { ...base().parts[1]!, order: 1 }] }), /contiguous/);
  rejects(base({ parts: [base().parts[1]!, base().parts[0]!] }), /follow its parent|document root/);
  const approve = (reviewer: string, g = base()): AnatomyGold['review'] => ({ reviewer, status: 'approved', reviewedAt: '2026-10-17', approvedContentSha256: goldContentSha256(g), notes: '' });
  rejects(base({ status: 'reviewed', review: approve('exec') }), /other than the annotator/);
  rejects(base({ review: { ...approve('astra'), status: 'requested' } }), /only set by an approved review/);
  // Inconsistent approval states reproduced by the GOLD-01 reviewer (GPT/Codex, 17/10/2026).
  rejects(base({ status: 'prepared', review: approve('exec') }), /must go together/);
  rejects(base({ status: 'prepared', review: approve('astra') }), /must go together/);
  rejects(base({ status: 'reviewed', review: { ...approve('astra'), reviewer: null } }), /identified reviewer/);
  rejects(base({ status: 'reviewed', review: { ...approve('astra'), reviewedAt: null } }), /review date/);
  rejects(base({ status: 'reviewed', annotator: null, review: approve('astra', base({ annotator: null })) }), /identified annotator/);
  rejects(base({ status: 'reviewed', review: { reviewer: 'astra', status: 'requested', reviewedAt: null, approvedContentSha256: null, notes: '' } }), /must go together/);
  rejects(base({ relations: [{ id: 'r', kind: 'range', operatorSpan: null, memberEntityIds: ['nope'], targetEntityIds: [], scopeSpan: null, condition: null }] }), /unknown entity/);
  rejects({ ...base(), partition: 'reserved-final' }, /partition|invalid/i);
});

test('approval is bound to the reviewed content hash; any later annotation change needs a new review', () => {
  const g = base();
  const review: AnatomyGold['review'] = { reviewer: 'astra', status: 'approved', reviewedAt: '2026-10-17', approvedContentSha256: goldContentSha256(g), notes: '' };
  assert.equal(validateAnatomyGold({ ...g, status: 'reviewed', review }, text).status, 'reviewed');
  // Review metadata itself is outside the bound content.
  assert.equal(goldContentSha256({ ...g, review }), goldContentSha256(g));
  const changed = { ...g, status: 'reviewed' as const, review, entities: [{ ...g.entities[0]!, note: 'edited after approval' }] };
  rejects(changed, /needs a new review/);
});

test('rebuilding from a spec keeps a valid approval and rejects it after any content change', () => {
  const submitted = goldContentSha256(buildGold('03'));
  const approval = { reviewer: 'GPT-ASTRA', status: 'approved' as const, reviewedAt: '2026-10-17', approvedContentSha256: submitted, notes: 'synthetic approval for this test only' };
  const approved = buildGold('03', (s) => ({ ...s, review: approval }));
  assert.equal(approved.status, 'reviewed');
  assert.equal(approved.review.approvedContentSha256, submitted);
  assert.deepEqual(buildGold('03', (s) => ({ ...s, review: approval })), approved, 'rebuild is deterministic and keeps the approval');
  assert.throws(() => buildGold('03', (s) => ({ ...s, review: approval, entities: s.entities!.map((e, i) => (i === 0 ? { ...e, note: `${e.note} (editado)` } : e)) })), /needs a new review/);
  assert.throws(() => buildGold('03', (s) => ({ ...s, review: approval, blocks: s.blocks.map((b) => (b.id === 'intro' ? { ...b, context: 'unknown' as const } : b)) })), /needs a new review/);
});

test('review packs are current: chunks reassemble the complete gold and the exact frozen canonical text', () => {
  for (const id of REVIEW_IDS) {
    for (const [file, body] of goldChunks(id)) assert.equal(readFileSync(new URL(file, chunkDir(id)), 'utf8').replace(/\r\n/g, '\n'), body, `${id}/${file}`);
    const full = JSON.parse(readFileSync(new URL(`${id}.json`, GOLD_DIR), 'utf8')) as AnatomyGold;
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', chunkDir(id)), 'utf8'));
    assert.equal(manifest.goldContentSha256, goldContentSha256(full), id);
    const text = reassembleCanonical(id);
    assert.equal(text, developmentCanonicalText(id), id);
    assert.equal(sha256(text), full.canonicalTextSha256, id);
    if (id === '01' || id === '10') assert.deepEqual(reassembleGold(id), full, id);
  }
});

test('committed development gold is reproducible from its human-written specs', () => {
  for (const id of ['01', '02', '03', '05', '07', '10', '11']) {
    assert.deepEqual(buildGold(id), JSON.parse(readFileSync(new URL(`${id}.json`, GOLD_DIR), 'utf8')), id);
  }
});

// Independent approvals (GPT/Codex, 2026-10-18), each bound to the exact content hash:
// R2 on c8ee0fe4fca3a76cd0e216bb6e3a088c9cad0c17 (PR #244 review 5563875392; tribusca-control#116 comment 6252319710): 02–11.
// R3 on 04d896e5f6ab6a7c95c9a813e4f41280f48650f3 (PR #244 review 5566220164; tribusca-control#116 comment 6258080394): 01.
const APPROVED: Record<string, string> = {
  '01': 'd6ba1bbf0bb1fe232df79337fcc87ed9576d024e92337d68e83acc833526b48a',
  '02': '256dfcb9624069abeca683e7943799659f4196ec7fc1f368adebb12b69b47b8a',
  '03': 'a4c9e445b71772064298afab7edc18fa7dc4a36804c7926a24a57806aed6b48b',
  '05': '44c6407dc014d399e977e15315b3d4e46d82a0c2d77b6dbe595ee43dcdf1c2e7',
  '07': '59867895a15ab35d4cec3612430da22d9896c7ebd7b7846d9a27daed69e1687d',
  '10': 'c4602fddaecf5ba89c77a38d1e9c23ef2d2b89205061910ebf2f21d10df43083',
  '11': '678bf7e0823ac148a55da75c5f5c681ebb3571d8fd298ea7e5bdbc5858c6ad79',
};

test('all seven development golds carry the documented independent approval of their exact content', () => {
  const files = readdirSync(GOLD_DIR).filter((f) => f.endsWith('.json')).sort();
  assert.deepEqual(files, ['01.json', '02.json', '03.json', '05.json', '07.json', '10.json', '11.json']);
  assert.deepEqual(Object.keys(APPROVED).sort(), files.map((f) => f.slice(0, 2)));
  for (const f of files) {
    const id = f.slice(0, 2);
    const gold = validateAnatomyGold(JSON.parse(readFileSync(new URL(f, GOLD_DIR), 'utf8')), developmentCanonicalText(id));
    assert.equal(gold.status, 'reviewed', id);
    assert.deepEqual([gold.annotator, gold.review.reviewer, gold.review.status, gold.review.reviewedAt, gold.review.approvedContentSha256],
      ['CLAUDE-EXEC', 'GPT/Codex', 'approved', '2026-10-18', APPROVED[id]], id);
    assert.equal(goldContentSha256(gold), APPROVED[id], `${id}: content still equals the approved hash`);
  }
});

// Direct checks of the cases corrected after the R1/R2 findings, so a later spec change cannot silently undo them.
const gold = (id: string) => JSON.parse(readFileSync(new URL(`${id}.json`, GOLD_DIR), 'utf8')) as AnatomyGold;
const literals = (g: AnatomyGold, literal: string) => g.entities.filter((e) => e.literal === literal);

test('measurement matrix counts match the approved gold (recognition is not positive selection)', () => {
  const b = codeBreakdown(gold('01'));
  assert.equal(b.total, 2002);
  assert.deepEqual(b.byContext, { operative_candidate: 655, historical: 1347 });
  assert.deepEqual(b.operative, { total: 655, byRole: { chapter: 3, range_member: 4, exception_target: 8, standalone: 640 },
    standaloneInCodeColumn: 591, standaloneInText: 49, rangeAndException: 2 });
  assert.deepEqual(b.structuralPositiveCandidates, { NCM: 640, NBM: 0 });
  assert.equal(b.nonCandidates, 1362);
  const b02 = codeBreakdown(gold('02'));
  assert.deepEqual([b02.total, b02.structuralPositiveCandidates, b02.nonCandidates], [1, { NCM: 0, NBM: 1 }, 1]);
  for (const id of ['03', '05', '07', '10', '11']) assert.equal(codeBreakdown(gold(id)).total, 0, `${id} has no nomenclature code`);
});

test('R1 correction: 02 keeps 3507.90.4 as NBM and annotates every convention number of a list', () => {
  const g = gold('02');
  assert.deepEqual(literals(g, '3507.90.4').map((e) => e.domain), ['NBM']);
  const text = developmentCanonicalText('02');
  const line7 = text.split('\n')[6]!;
  assert.ok(line7.startsWith('Alterado pelos Convs. ICMS 40/98, 97/99, 08/00'));
  const start = text.indexOf(line7); const end = start + line7.length;
  const inLine = g.entities.filter((e) => e.domain === 'CITATION' && e.span.start >= start && e.span.end <= end).map((e) => e.literal);
  assert.ok(inLine.includes('97/99') && inLine.includes('08/00') && inLine.includes('149/05'), 'list items are citations');
  assert.equal(inLine.length, (line7.match(/\d{1,3}\/\d{2}/g) ?? []).length, 'every number of the list is annotated');
});

test('R2 correction: 01 annotates dotted positions, the 84.56 A 84.65 range and its exclusion with both ends', () => {
  const g = gold('01'); const byId = new Map(g.entities.map((e) => [e.id, e]));
  for (const code of ['84.02', '85.14', '84.56', '84.65', '84.44', '84.47']) assert.ok(literals(g, code).length > 0, code);
  assert.ok(g.entities.some((e) => e.literal === '85.14' && e.domain === 'NCM'));
  const ranges = g.relations.filter((r) => r.kind === 'range' && r.memberEntityIds.map((i) => byId.get(i)!.literal).join(' A ') === '84.56 A 84.65');
  assert.ok(ranges.length >= 1, 'range 84.56 A 84.65');
  const exceptions = g.relations.filter((r) => r.kind === 'exception');
  const both = exceptions.find((r) => r.targetEntityIds.map((i) => byId.get(i)!.literal).join('+') === '84.56+84.65');
  assert.ok(both, 'one exception targets both ends of the excluded range');
  assert.ok(exceptions.some((r) => r.targetEntityIds.some((i) => byId.get(i)!.literal === '85.14')), '85.14 is excluded');
  for (const r of exceptions) assert.equal(new Set(exceptions.map((x) => x.operatorSpan!.start)).size, exceptions.length, 'one relation per operator');
  // Chapter references are informative two-digit codes; an item number after "deste capítulo" is not.
  assert.deepEqual(g.entities.filter((e) => /capítulo/.test(e.note)).map((e) => e.literal).sort(), ['53', '53', '84', '84', '84']);
  // The two historical occurrences of 8450.11.00 stay historical (contract cross-check).
  const parts = new Map(g.parts.map((p) => [p.id, p]));
  assert.deepEqual(literals(g, '8450.11.00').map((e) => parts.get(e.partId)!.context), ['historical', 'historical']);
});
