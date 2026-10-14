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
      officialUrl:(item as CollectionFilterPublication&{officialUrl?:string}).officialUrl??null,
      publishedOn:(item as CollectionFilterPublication&{publishedOn?:string}).publishedOn??null,
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
  const exported=JSON.parse(bytes) as CollectionFilterPolicyInput&{policies?:Array<{id:string;status:string;revision:number}>;documents?:Record<string,CollectionFilterPolicyInput>};
  const approved=exported.policies?.filter(p=>p.status==='APPROVED');
  if(approved&&approved.length!==1)throw new Error('snapshot_requires_exactly_one_approved_policy');
  const policy=approved?exported.documents?.[approved[0]!.id]:exported;
  if(!policy||!Array.isArray(policy.rules)||!Array.isArray(policy.terms))throw new Error('invalid_offline_policy_snapshot');
  const corpusFile=args[2];
  const corpusBytes=corpusFile?readFileSync(corpusFile,'utf8'):null;
  const corpus=corpusBytes?JSON.parse(corpusBytes) as {basis:string;publications:CollectionFilterPublication[]}:null;
  if(corpus&&(!Array.isArray(corpus.publications)||corpus.publications.length<2000||
    !['dou','doe-sp'].every(s=>corpus.publications.some(p=>p.sourceCode===s))))throw new Error('real_corpus_requires_2000_titles_and_both_sources');
  const report={baselineCommit:'b134e363de6d29c589420278547278a7ceacdbef',
    corpus:corpus?.basis??'10 synthetic CI fixtures; no production access',
    policyBasis:policyFile??fixture.provenance,policySha256:createHash('sha256').update(bytes).digest('hex'),
    policyRevision:approved?.[0]?.revision??null,
    corpusSha256:corpusBytes?createHash('sha256').update(corpusBytes).digest('hex'):null,
    scopeLimit:'Title-only comparison: absent complete bodies conservatively KEEP conditional modes; no company/origin evidence, no physical deletion forecast.',
    currentProductionRevisionImpact:policyFile&&corpus?'PROVIDED_SNAPSHOT_VS_OFFICIAL_TITLE_CORPUS':'NOT_PROVEN: current policy snapshot and official corpus required',
    ...compareActNameImpact(policy,corpus?.publications??fixture.publications)};
  const keepToDiscard=report.changed.filter(r=>r.before==='KEEP'&&r.after==='DISCARD');
  const {all,...summary}=report;
  const bySource=Object.fromEntries(['dou','doe-sp'].map(source=>[source,{publications:all.filter(r=>r.source===source).length,keepToDiscard:keepToDiscard.filter(r=>r.source===source).length,discardToKeep:report.changed.filter(r=>r.source===source&&r.before==='DISCARD'&&r.after==='KEEP').length}]));
  writeFileSync(output,JSON.stringify({...summary,bySource,keepToDiscardList:keepToDiscard,...(!corpus?{all}:{})},null,2)+'\n');
  process.stdout.write(JSON.stringify({output,publications:report.publications,
    keepToDiscard:report.keepToDiscard,discardToKeep:report.discardToKeep,policyBasis:report.policyBasis})+'\n');
}
