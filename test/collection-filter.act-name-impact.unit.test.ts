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

test('revision 225 vs 3958 official recent titles reproduces the complete real impact list',()=>{
  const base=new URL('../docs/f3-nome-02/',import.meta.url);
  const snapshot=JSON.parse(readFileSync(new URL('regras-producao.json',base),'utf8'));
  const corpus=JSON.parse(readFileSync(new URL('public-corpus.json',base),'utf8'));
  const expected=JSON.parse(readFileSync(new URL('impact-real.json',base),'utf8'));
  const approved=snapshot.policies.find((p:{status:string})=>p.status==='APPROVED');
  assert.equal(approved.revision,225);
  const policy=snapshot.documents[approved.id];
  const frozen=JSON.stringify(policy);
  assert.equal(corpus.publications.length,3958);
  assert.equal(new Set(corpus.publications.map((p:{officialUrl:string})=>p.officialUrl)).size,3958);
  assert.ok(corpus.publications.every((p:{officialUrl:string;evidenceComplete:boolean})=>
    /^https:\/\/(?:www\.in\.gov\.br|www\.doe\.sp\.gov\.br)\//.test(p.officialUrl)&&p.evidenceComplete===false));
  const report=compareActNameImpact(policy,corpus.publications);
  assert.equal(report.keepToDiscard,55);assert.equal(report.discardToKeep,256);
  assert.deepEqual(report.changed,expected.changed);
  assert.deepEqual(report.changed.filter(p=>p.before==='KEEP'),expected.keepToDiscardList);
  assert.equal(JSON.stringify(policy),frozen);
});
