import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {compareActNameImpact} from '../ops/f3-nome-01/impact.js';

test('frozen old/new comparison lists both directions without changing the same policy',()=>{
  const input=JSON.parse(readFileSync(new URL('./fixtures/f3-nome-01-impact.json',import.meta.url),'utf8'));
  const before=JSON.stringify(input.policy);
  const report=compareActNameImpact(input.policy,input.publications);
  assert.equal(report.publications,10);assert.ok(report.keepToDiscard>0);assert.ok(report.discardToKeep>0);
  assert.equal(JSON.stringify(input.policy),before);
  assert.ok(report.changed.every(row=>row.actName&&row.before!==row.after));
});
