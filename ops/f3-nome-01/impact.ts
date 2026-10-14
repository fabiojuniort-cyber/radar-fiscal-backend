import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import * as old from '../../test/f3-nome-baseline-engine.fixture.js';
import {collectionFilterActName,compileCollectionFilterPolicy,evaluateCollectionFilter,
  type CollectionFilterPolicyInput,type CollectionFilterPublication} from '../../src/modules/collection/collection-filter.engine.js';

export function compareActNameImpact(policy:CollectionFilterPolicyInput,publications:CollectionFilterPublication[]){
  const frozen=JSON.stringify(policy);
  const previous=old.compileCollectionFilterPolicy(policy);
  const next=compileCollectionFilterPolicy(policy);
  const rows=publications.map(item=>{
    const before=old.evaluateCollectionFilter(previous,item);
    const after=evaluateCollectionFilter(next,item);
    return {source:item.sourceCode,section:item.section??'',title:item.title,
      actName:collectionFilterActName(item.title),before:before.decision,after:after.decision,
      beforeReason:before.reasonCode,afterReason:after.reasonCode,
      beforeRule:before.canonicalType??null,afterRule:after.canonicalType??null};
  });
  if(JSON.stringify(policy)!==frozen)throw new Error('impact_must_not_modify_policy');
  return {publications:rows.length,keepToDiscard:rows.filter(x=>x.before==='KEEP'&&x.after==='DISCARD').length,
    discardToKeep:rows.filter(x=>x.before==='DISCARD'&&x.after==='KEEP').length,
    changed:rows.filter(x=>x.before!==x.after),all:rows};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  const policyFile=args[0];const output=args[1]??'docs/f3-nome-01-impact.json';
  const fixture=JSON.parse(readFileSync(new URL('../../test/fixtures/f3-nome-01-impact.json',import.meta.url),'utf8')) as {
    policy:CollectionFilterPolicyInput;publications:CollectionFilterPublication[];provenance:string};
  const bytes=policyFile?readFileSync(policyFile,'utf8'):JSON.stringify(fixture.policy);
  const policy=policyFile?JSON.parse(bytes) as CollectionFilterPolicyInput:fixture.policy;
  const report={baselineCommit:'b134e363de6d29c589420278547278a7ceacdbef',
    corpus:'10 synthetic CI fixtures; no production access',
    policyBasis:policyFile??fixture.provenance,policySha256:createHash('sha256').update(bytes).digest('hex'),
    currentProductionRevisionImpact:'NOT_PROVEN: no versioned current policy snapshot was supplied',
    ...compareActNameImpact(policy,fixture.publications)};
  writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  process.stdout.write(JSON.stringify({output,publications:report.publications,
    keepToDiscard:report.keepToDiscard,discardToKeep:report.discardToKeep,policyBasis:report.policyBasis})+'\n');
}
