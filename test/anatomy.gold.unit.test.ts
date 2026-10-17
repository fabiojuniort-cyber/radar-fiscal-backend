import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { developmentCanonicalText, GOLD_DIR } from '../ops/anatomy/annotation-pack.js';
import { buildGold } from '../ops/anatomy/gold-build.js';
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

test('committed development gold is reproducible from its human-written specs', () => {
  for (const id of ['01', '02', '03', '05', '07', '10', '11']) {
    assert.deepEqual(buildGold(id), JSON.parse(readFileSync(new URL(`${id}.json`, GOLD_DIR), 'utf8')), id);
  }
});

test('committed development gold matches the frozen canonical text and is not marked reviewed', () => {
  const files = readdirSync(GOLD_DIR).filter((f) => f.endsWith('.json')).sort();
  assert.deepEqual(files, ['01.json', '02.json', '03.json', '05.json', '07.json', '10.json', '11.json']);
  for (const f of files) {
    const gold = validateAnatomyGold(JSON.parse(readFileSync(new URL(f, GOLD_DIR), 'utf8')), developmentCanonicalText(f.slice(0, 2)));
    assert.equal(gold.status === 'reviewed', false, 'no gold is reviewed in this package');
  }
});
