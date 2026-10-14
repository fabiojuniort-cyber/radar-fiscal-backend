import { createHash, randomUUID } from 'node:crypto';
import {collectionFilterActName} from './collection-filter.act-name.js';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../infrastructure/database/database.types.js';
import { withUserContext } from '../../infrastructure/database/tenant-context.js';
import { evaluateHistoricalCollectionCandidate, type HistoricalCollectionCandidate, type DirectRuleInput } from './collection-filter.direct.js';
import { loadApprovedCollectionFilterRuntime } from './collection-filter.runtime.js';

export interface OutOfScopePreview {
  count: number;
  // Compatibility fields for previously deployed clients; never selectors.
  outOfScope: 0;
  hiddenLegacy: 0;
  suspectDoe: 0;
  ruleDiscards: number;
  policyRevision: number;
  byRule: Array<{sourceCode:string;section:string;canonicalType:string;actName:string;mode:string;count:number}>;
  blockedCompany: number;
  blockedOtherSource: number;
  token: string;
  samples: Array<{id:string;title:string;bucket:'RULE';sourceCode:string;section:string;canonicalType:string;actName:string}>;
}

type RuleRow={source_code:string;section:string;canonical_type:string;
  mode:DirectRuleInput['mode']};
type Match={bucket:'RULE';rule:RuleRow;actName:string;protected?:'COMPANY'|'OTHER'};

/** Every archive verdict comes from the same F3 engine used at capture.
 * Legacy scope/029/type-mismatch flags never add an ID or override KEEP.
 * Hash the approved revision and all discarded evidence/protections; confirm
 * recomputes the plan under the policy and target locks before deleting.
 */
export async function loadF3ArchivePlan(trx: Transaction<DB>) {
  const source=await sql<{id:string}>`
    SELECT id FROM public.sources WHERE code='dou' LIMIT 1
  `.execute(trx);
  if(!source.rows[0])throw new Error('l17_dou_source_missing');
  const runtime=await loadApprovedCollectionFilterRuntime(
    trx,source.rows[0].id,{readOnly:true});
  if(!runtime)throw new Error('l17_runtime_missing');
  const compiled=runtime.policy;
  const hash=createHash('sha256').update('F3:ARCHIVE:ACT-NAME:v3')
    .update(runtime.policyId).update(String(runtime.policyRevision));
  const seen=new Map<string,Match>();
  for(const sourceCode of ['dou','doe-sp']){
    let after:string|null=null,pages=0;
    while(true){
      if(++pages>10000)throw new Error('l17_archive_paging_cap');
      const page=await sql<HistoricalCollectionCandidate>`
        SELECT * FROM public.collection_filter_f3_candidates(
          ${after}::uuid,500,${sourceCode})
      `.execute(trx);
      if(!page.rows.length)break;
      for(const item of page.rows){
        const decision=evaluateHistoricalCollectionCandidate(compiled,item);
        if(decision.decision!=='DISCARD'||!decision.canonicalType||!decision.mode)continue;
        const rule:RuleRow={source_code:sourceCode,
          section:decision.matchedSection??'',
          canonical_type:decision.canonicalType,mode:decision.mode};
        hash.update(JSON.stringify([item,decision]));
        const blocked=item.has_company?'COMPANY':item.has_other_source?'OTHER':undefined;
        // Multiple official origins are protected; each publication is counted once.
        const previous=seen.get(item.publication_id);
        const protection=previous?.protected??blocked;
        seen.set(item.publication_id,{bucket:'RULE',rule:previous?.rule??rule,
          actName:collectionFilterActName(item.title),
          ...(protection?{protected:protection}:{})});
      }
      after=page.rows[page.rows.length-1]!.publication_id;
      if(page.rows.length<500)break;
    }
  }
  const ids:string[]=[];
  const kinds=new Map<string,Match>();
  let blockedCompany=0,blockedOtherSource=0;
  const stats=new Map<string,{sourceCode:string;section:string;canonicalType:string;actName:string;mode:string;count:number}>();
  const list=[...seen.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
  for(const [id,match] of list){
    if(match.protected==='COMPANY'){blockedCompany++;continue;}
    if(match.protected==='OTHER'){blockedOtherSource++;continue;}
    kinds.set(id,match);ids.push(id);
    const rule=match.rule;
    const key=JSON.stringify([rule.source_code,rule.section,rule.canonical_type,rule.mode,match.actName]);
    const row=stats.get(key)??{sourceCode:rule.source_code,section:rule.section,
      canonicalType:rule.canonical_type,actName:match.actName,mode:rule.mode,count:0};
    row.count++;stats.set(key,row);
  }
  hash.update(JSON.stringify(list));
  return{ids,kinds,count:ids.length,outOfScope:0 as const,ruleDiscards:ids.length,
    hiddenLegacy:0 as const,suspectDoe:0 as const,
    policyRevision:runtime.policyRevision,
    blockedCompany,blockedOtherSource,byRule:[...stats.values()],token:hash.digest('hex')};
}

export async function previewOutOfScopePurge(db: Kysely<DB>, actor: string):
  Promise<OutOfScopePreview> {
  return withUserContext(db, actor, async trx => {
    const { ids, kinds, count, outOfScope, ruleDiscards, byRule, hiddenLegacy, suspectDoe, blockedCompany, blockedOtherSource, token, policyRevision } =
      await loadF3ArchivePlan(trx);
    const samples=ids.length ? (await sql<{id:string;title:string}>`SELECT * FROM public.collection_filter_purge_samples(${ids.slice(0,10)}::uuid[])`
      .execute(trx)).rows.map(row=>{const match=kinds.get(row.id)!;return {...row,bucket:match.bucket,sourceCode:match.rule.source_code,section:match.rule.section,canonicalType:match.rule.canonical_type,actName:match.actName};}) : [];
    return { count, outOfScope, ruleDiscards, byRule, hiddenLegacy, suspectDoe, blockedCompany, blockedOtherSource, token, policyRevision, samples };
  });
}

/** One user-confirmed step, MAX 500, each SQL 051 batch <=100.
 * No rule changes. F3 re-evaluates each candidate under row locks; SQL checks
 * the confirmed policy revision, official origins and company protections.
 */
export async function confirmOutOfScopePurge(
  db: Kysely<DB>, actor: string, expectedCount: number, previewToken: string,
) {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0 ||
      !/^[a-f0-9]{64}$/.test(previewToken)) {
    throw new RangeError('invalid_l15_confirmation');
  }
  return withUserContext(db, actor, async trx => {
    await sql`SET LOCAL statement_timeout = '11000ms'`.execute(trx);
    await sql`SET LOCAL lock_timeout = '2500ms'`.execute(trx);
    // Do not race a direct-rule purge. This lock alone is not the security
    // boundary; the SQL functions recheck eligibility under row locks.
    await sql`SELECT pg_advisory_xact_lock(
      hashtextextended('collection-filter-direct-rule',0)
    )`.execute(trx);
    const plan = await loadF3ArchivePlan(trx);
    if (plan.count !== expectedCount || plan.token !== previewToken) {
      return { changed: true, count: plan.count,
        outOfScope: plan.outOfScope, ruleDiscards:plan.ruleDiscards,byRule:plan.byRule,
        hiddenLegacy: plan.hiddenLegacy,suspectDoe:plan.suspectDoe,
        blockedCompany: plan.blockedCompany,
        blockedOtherSource: plan.blockedOtherSource,
        token: plan.token, apagadas: 0, restantes: plan.count, deletedCount: 0 };
    }
    // Lock the actual targets BEFORE re-evaluating conditional rule decisions.
    // A concurrent origin/parent/material change blocks on these locks.
    // If anything changed during waiting, return a new preview, no deletion.
    const selection=plan.ids.slice(0,500);
    if(selection.length){
      await sql`SELECT public.l17_lock_confirmation_targets(${selection}::uuid[])`.execute(trx);
      const locked=await loadF3ArchivePlan(trx);
      if(locked.count!==plan.count||locked.token!==plan.token){
        return{changed:true,count:locked.count,token:locked.token,
          outOfScope:locked.outOfScope,ruleDiscards:locked.ruleDiscards,
          byRule:locked.byRule,hiddenLegacy:locked.hiddenLegacy,suspectDoe:locked.suspectDoe,
          blockedCompany:locked.blockedCompany,
          blockedOtherSource:locked.blockedOtherSource,
          apagadas:0,restantes:locked.count,deletedCount:0};
      }
    }
    await sql`SELECT public.collection_filter_confirm_policy_lock()`.execute(trx);
    let apagadas=0;
    const operation=randomUUID();
    for(let offset=0;offset<selection.length;offset+=100){
      const part=selection.slice(offset,offset+100);
      const batches=new Map<string,{ids:string[];rule:RuleRow}>();
      for(const id of part){
        const meta=plan.kinds.get(id);
        if(!meta)throw new Error('l17_plan_identity_mismatch');
        const rule=meta.rule;
        const key=JSON.stringify([rule.source_code,rule.section,rule.canonical_type,rule.mode]);
        const group=batches.get(key)??{ids:[],rule};
        group.ids.push(id);batches.set(key,group);
      }
      for(const group of batches.values()){
        const rule=group.rule;
        const result=await sql<{count:number}>`
          SELECT public.collection_filter_direct_purge_batch(
            ${group.ids}::uuid[],${rule.source_code},${rule.section},
            ${rule.canonical_type},${rule.mode},${operation}::uuid) AS count
        `.execute(trx);
        if(Number(result.rows[0]?.count)!==group.ids.length){
          throw new Error('l17_batch_count_mismatch');
        }
        apagadas+=group.ids.length;
      }
    }
    // If 0 candidates, never invoke the purge function with an empty batch.
    const current = await loadF3ArchivePlan(trx);
    return { changed: false, apagadas, restantes: current.count,
      outOfScope: current.outOfScope,ruleDiscards:current.ruleDiscards,byRule:current.byRule,
      hiddenLegacy: current.hiddenLegacy,suspectDoe:current.suspectDoe,
      deletedCount: apagadas, blockedCompany: current.blockedCompany,
      blockedOtherSource: current.blockedOtherSource };
  });
}

