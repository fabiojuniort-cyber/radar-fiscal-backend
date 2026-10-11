import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../infrastructure/database/database.types.js';
import { withUserContext } from '../../infrastructure/database/tenant-context.js';
import { candidates, type DirectRuleInput } from './collection-filter.direct.js';

interface ScopeRow {
  publication_id: string;
  scope_updated_at: Date;
  has_company: boolean;
  has_other_source: boolean;
  out_of_scope: boolean;
  hidden_legacy: boolean;
}

export interface OutOfScopePreview {
  count: number;
  outOfScope: number;
  hiddenLegacy: number;
  ruleDiscards: number;
  byRule: Array<{section:string;canonicalType:string;mode:string;count:number}>;
  blockedCompany: number;
  blockedOtherSource: number;
  token: string;
}

type Bucket='OUT_OF_SCOPE'|'HIDDEN'|'RULE';
type RuleRow={source_code:string;section:string;canonical_type:string;
  mode:DirectRuleInput['mode']};
type Match={bucket:Bucket;rule?:RuleRow;protected?:'COMPANY'|'OTHER'};
const ORDER:Record<Bucket,number>={OUT_OF_SCOPE:0,RULE:1,HIDDEN:2};

// One published decision policy: direct historical candidate selection reuses
// EXACTLY the compiled TypeScript filter engine (including strong/weak terms).
// Scope wins over rule, rule wins over legacy hidden; count each ID once.
async function scopeCandidates(trx: Transaction<DB>) {
  const hash=createHash('sha256').update('L17:DOU:ALL_DECISIONS:v2');
  const seen=new Map<string,Match>();
  const rules=await sql<RuleRow>`
    SELECT r.source_code,r.section,r.canonical_type,r.mode
    FROM public.collection_filter_type_rules r
    JOIN public.collection_filter_policies p ON p.id=r.policy_id
    WHERE p.status='APPROVED' AND r.source_code='dou'
      AND r.mode IN ('EXCLUDE_ALWAYS','EXCLUDE_UNLESS_STRONG','KEEP_IF_TAX_TERM')
    ORDER BY r.section,r.canonical_type
  `.execute(trx);
  if(rules.rows.length>1000)throw new Error('l17_rule_cap');
  let cursor:string|null=null,pages=0;
  while(true){
    if(++pages>10000)throw new Error('l17_scope_paging_cap');
    const page=await sql<ScopeRow>`
      SELECT * FROM public.l17_cleanup_candidates(${cursor}::uuid,500)
    `.execute(trx);
    if(!page.rows.length)break;
    for(const row of page.rows){
      const blocked=row.has_company?'COMPANY':row.has_other_source?'OTHER':undefined;
      seen.set(row.publication_id,{
        bucket:row.out_of_scope?'OUT_OF_SCOPE':'HIDDEN',
        ...(blocked?{protected:blocked}:{})
      });
      hash.update(row.publication_id).update(new Date(row.scope_updated_at).toISOString())
        .update(row.out_of_scope?'S':'H')
        .update(blocked??'-');
    }
    cursor=page.rows[page.rows.length-1]!.publication_id;
    if(page.rows.length<500)break;
  }
  for(const rule of rules.rows){
    const result=await candidates(trx,{
      sourceCode:'dou',section:rule.section,
      canonicalType:rule.canonical_type,mode:rule.mode,
    });
    hash.update(JSON.stringify(rule)).update(result.token);
    const add=(id:string,blocked?:'COMPANY'|'OTHER')=>{
      const previous=seen.get(id);
      if(previous){
        // Fresh protection evidence always wins over stale eligibility.
        if(blocked)seen.set(id,{...previous,protected:blocked});
      }else {
        seen.set(id,{bucket:'RULE',rule,...(blocked?{protected:blocked}:{})});
      }
    };
    for(const id of result.ids)add(id);
    for(const id of result.blockedCompanyIds)add(id,'COMPANY');
    for(const id of result.blockedOtherSourceIds)add(id,'OTHER');
  }
  const ids:string[]=[];
  const kinds=new Map<string,Match>();
  let outOfScope=0,ruleDiscards=0,hiddenLegacy=0;
  let blockedCompany=0,blockedOtherSource=0;
  const stats=new Map<string,{section:string;canonicalType:string;mode:string;count:number}>();
  const list=[...seen.entries()].sort((a,b)=>
    ORDER[a[1].bucket]-ORDER[b[1].bucket]||a[0].localeCompare(b[0]));
  for(const [id,match] of list){
    if(match.protected==='COMPANY'){blockedCompany++;continue;}
    if(match.protected==='OTHER'){blockedOtherSource++;continue;}
    kinds.set(id,match);ids.push(id);
    if(match.bucket==='OUT_OF_SCOPE')outOfScope++;
    else if(match.bucket==='HIDDEN')hiddenLegacy++;
    else{
      ruleDiscards++;
      const rule=match.rule!;
      const key=[rule.section,rule.canonical_type,rule.mode].join('/');
      const row=stats.get(key)??{section:rule.section,
        canonicalType:rule.canonical_type,mode:rule.mode,count:0};
      row.count++;stats.set(key,row);
    }
  }
  hash.update(JSON.stringify([...list].map(([id,m])=>
    [id,m.bucket,m.protected??'-',m.rule?.canonical_type??'-'])));
  const byRule=[...stats.values()];
  return{ids,kinds,count:ids.length,outOfScope,ruleDiscards,hiddenLegacy,
    blockedCompany,blockedOtherSource,byRule,token:hash.digest('hex')};
}

export async function previewOutOfScopePurge(db: Kysely<DB>, actor: string):
  Promise<OutOfScopePreview> {
  return withUserContext(db, actor, async trx => {
    const { count, outOfScope, ruleDiscards, byRule, hiddenLegacy, blockedCompany, blockedOtherSource, token } =
      await scopeCandidates(trx);
    return { count, outOfScope, ruleDiscards, byRule, hiddenLegacy, blockedCompany, blockedOtherSource, token };
  });
}

/** One user-confirmed step, MAX 500, each SQL 051 batch <=100.
 * No rule changes. The DB checks that every item is still OUT_OF_SCOPE,
 * DOU-only and without tenant links under row lock, and writes audit entries.
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
    const plan = await scopeCandidates(trx);
    if (plan.count !== expectedCount || plan.token !== previewToken) {
      return { changed: true, count: plan.count,
        outOfScope: plan.outOfScope, ruleDiscards:plan.ruleDiscards,byRule:plan.byRule,
        hiddenLegacy: plan.hiddenLegacy,
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
      const locked=await scopeCandidates(trx);
      if(locked.count!==plan.count||locked.token!==plan.token){
        return{changed:true,count:locked.count,token:locked.token,
          outOfScope:locked.outOfScope,ruleDiscards:locked.ruleDiscards,
          byRule:locked.byRule,hiddenLegacy:locked.hiddenLegacy,
          blockedCompany:locked.blockedCompany,
          blockedOtherSource:locked.blockedOtherSource,
          apagadas:0,restantes:locked.count,deletedCount:0};
      }
    }
    let apagadas=0;
    const operation=randomUUID();
    for(let offset=0;offset<selection.length;offset+=100){
      const part=selection.slice(offset,offset+100);
      const batches=new Map<string,{ids:string[];bucket:Bucket;rule?:RuleRow}>();
      for(const id of part){
        const meta=plan.kinds.get(id);
        if(!meta)throw new Error('l17_plan_identity_mismatch');
        const key=meta.bucket==='RULE'
          ?JSON.stringify([meta.bucket,meta.rule?.section,meta.rule?.canonical_type,meta.rule?.mode])
          :meta.bucket;
        const group=batches.get(key)??{ids:[],bucket:meta.bucket,
          ...(meta.rule?{rule:meta.rule}:{})};
        group.ids.push(id);batches.set(key,group);
      }
      for(const group of batches.values()){
        let result;
        if(group.bucket==='OUT_OF_SCOPE'){
          result=await sql<{count:number}>`
            SELECT public.l15_out_of_scope_purge_batch(
              ${group.ids}::uuid[],${operation}::uuid) AS count
          `.execute(trx);
        }else if(group.bucket==='HIDDEN'){
          result=await sql<{count:number}>`
            SELECT public.l17_cleanup_admin_batch(
              ${group.ids}::uuid[],${operation}::uuid) AS count
          `.execute(trx);
        }else{
          const rule=group.rule;
          if(!rule)throw new Error('l17_rule_metadata_missing');
          result=await sql<{count:number}>`
            SELECT public.collection_filter_direct_purge_batch(
              ${group.ids}::uuid[],'dou',${rule.section},
              ${rule.canonical_type},${rule.mode},${operation}::uuid) AS count
          `.execute(trx);
        }
        if(Number(result.rows[0]?.count)!==group.ids.length){
          throw new Error('l17_batch_count_mismatch');
        }
        apagadas+=group.ids.length;
      }
    }
    // If 0 candidates, never invoke the purge function with an empty batch.
    const current = await scopeCandidates(trx);
    return { changed: false, apagadas, restantes: current.count,
      outOfScope: current.outOfScope,ruleDiscards:current.ruleDiscards,byRule:current.byRule,
      hiddenLegacy: current.hiddenLegacy,
      deletedCount: apagadas, blockedCompany: current.blockedCompany,
      blockedOtherSource: current.blockedOtherSource };
  });
}
