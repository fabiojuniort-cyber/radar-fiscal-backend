import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../infrastructure/database/database.types.js';
import { withUserContext } from '../../infrastructure/database/tenant-context.js';
import { evaluateHistoricalCollectionCandidate, type HistoricalCollectionCandidate, type DirectRuleInput } from './collection-filter.direct.js';
import { loadApprovedCollectionFilterRuntime } from './collection-filter.runtime.js';
import { normalizeCollectionFilterType } from './collection-filter.engine.js';

interface ScopeRow {
  publication_id: string;
  scope_updated_at: Date;
  has_company: boolean;
  has_other_source: boolean;
  out_of_scope: boolean;
  hidden_legacy: boolean;
}
interface SpecialRow {
  publication_id:string;updated_at:Date;source_code:string|null;
  has_company:boolean;has_other_source:boolean;
  hidden_legacy:boolean;suspect_doe:boolean;
}

export interface OutOfScopePreview {
  count: number;
  outOfScope: number;
  hiddenLegacy: number;
  suspectDoe: number;
  ruleDiscards: number;
  byRule: Array<{section:string;canonicalType:string;mode:string;count:number}>;
  blockedCompany: number;
  blockedOtherSource: number;
  token: string;
  samples: Array<{id:string;title:string;bucket:string}>;
}

type Bucket='OUT_OF_SCOPE'|'HIDDEN'|'RULE'|'SUSPECT_DOE';
type RuleRow={source_code:string;section:string;canonical_type:string;
  mode:DirectRuleInput['mode']};
type Match={bucket:Bucket;rule?:RuleRow;source?:string;protected?:'COMPANY'|'OTHER'};
const ORDER:Record<Bucket,number>={OUT_OF_SCOPE:0,RULE:1,HIDDEN:2,SUSPECT_DOE:3};

// One published decision policy: direct historical candidate selection reuses
// EXACTLY the compiled TypeScript filter engine (including strong/weak terms).
// Scope wins over rule, rule wins over legacy hidden; count each ID once.
/** Enumerate the entire active DOU policy once per preview. Never impose
 * a rule-count cap. The SQL evidence adapter is paginated by section and by
 * <=200 type keys (its own safety limit is 1000 keys); the SAME compiled
 * runtime engine makes every conditional KEEP/DISCARD decision.
 *
 * The pagination cap is on archive size, NOT configured policy size, and
 * fails loudly rather than silently truncating results.
 */
async function scopeCandidates(trx: Transaction<DB>) {
  const source=await sql<{id:string}>`
    SELECT id FROM public.sources WHERE code='dou' LIMIT 1
  `.execute(trx);
  if(!source.rows[0])throw new Error('l17_dou_source_missing');
  const runtime=await loadApprovedCollectionFilterRuntime(
    trx,source.rows[0].id,{readOnly:true});
  if(!runtime)throw new Error('l17_runtime_missing');
  const compiled=runtime.policy;
  const hash=createHash('sha256').update('L17:DOU:ALL_DECISIONS:v3')
    .update(runtime.policyId).update(String(runtime.policyRevision));
  const seen=new Map<string,Match>();
  const legacyHiddenPublicationIds=new Set<string>();
  const f3LegacyPublicationIds=new Set<string>();
  const active=new Map<string,RuleRow>();
  for(const rule of compiled.rules.values()){
    const src=rule.sourceCode.toLowerCase();
    if(!['dou','doe-sp'].includes(src)||rule.mode==='KEEP_ALWAYS')continue;
    const section=normalizeCollectionFilterType(rule.section??'');
    const canonical=normalizeCollectionFilterType(rule.canonicalType);
    active.set(src+'\0'+section+'\0'+canonical,{
      source_code:src,section:rule.section??'',
      canonical_type:rule.canonicalType,mode:rule.mode});
  }
  hash.update(JSON.stringify([...active.entries()].sort((a,b)=>a[0].localeCompare(b[0]))))
    .update(JSON.stringify([...compiled.aliases.entries()].sort((a,b)=>a[0].localeCompare(b[0]))));

  let cursor:string|null=null,pages=0;
  while(true){
    if(++pages>10000)throw new Error('l17_scope_paging_cap');
    const page=await sql<ScopeRow>`
      SELECT * FROM public.l17_cleanup_candidates(${cursor}::uuid,500)
    `.execute(trx);
    if(!page.rows.length)break;
    for(const row of page.rows){
      if(row.hidden_legacy)legacyHiddenPublicationIds.add(row.publication_id);
      // Legacy generated type flags are not F3 policy decisions. Only the
      // separately approved scope suppression enters this first stream;
      // non-F3 legacy cleanup is enumerated below with its source identity.
      if(!row.out_of_scope)continue;
      const blocked=row.has_company?'COMPANY':row.has_other_source?'OTHER':undefined;
      seen.set(row.publication_id,{
        bucket:row.out_of_scope?'OUT_OF_SCOPE':'HIDDEN',
        ...(blocked?{protected:blocked}:{})
      });
      hash.update(row.publication_id).update(new Date(row.scope_updated_at).toISOString())
        .update(row.out_of_scope?'S':'H').update(blocked??'-');
    }
    cursor=page.rows[page.rows.length-1]!.publication_id;
    if(page.rows.length<500)break;
  }
  const add=(id:string,rule:RuleRow,blocked?:'COMPANY'|'OTHER')=>{
    const previous=seen.get(id);
    if(previous){
      const next:Match=previous.bucket==='HIDDEN'
        ?{bucket:'RULE',rule,...(previous.protected?{protected:previous.protected}:{})}
        :{...previous};
      if(blocked)next.protected=blocked;
      seen.set(id,next);
    }else seen.set(id,{bucket:'RULE',rule,...(blocked?{protected:blocked}:{})});
  };
  for(const sourceCode of ['dou','doe-sp']){
    let after:string|null=null,visited=0;
    while(true){
      if(++visited>10000)throw new Error('l17_archive_paging_cap');
      const page=await sql<HistoricalCollectionCandidate>`
        SELECT * FROM public.collection_filter_f3_candidates(
          ${after}::uuid,500,${sourceCode})
      `.execute(trx);
      if(!page.rows.length)break;
      for(const item of page.rows){
        if(legacyHiddenPublicationIds.has(item.publication_id))
          f3LegacyPublicationIds.add(item.publication_id);
        const decision=evaluateHistoricalCollectionCandidate(compiled,item);
        if(decision.decision!=='DISCARD'||!decision.canonicalType)continue;
        const rule=active.get(sourceCode+'\0'+(decision.matchedSection??'')+'\0'+decision.canonicalType);
        if(!rule||decision.mode!==rule.mode)continue;
        hash.update(JSON.stringify([item.publication_id,item.content_hash,item.title,
          item.source_act_type,item.section,item.provenance_conflict,
          item.has_company,item.has_other_source,decision.reasonCode]));
        add(item.publication_id,rule,item.has_company?'COMPANY':
          item.has_other_source?'OTHER':undefined);
      }
      after=page.rows[page.rows.length-1]!.publication_id;
      if(page.rows.length<500)break;
    }
  }
  // L-18: read only non-DOU legacy 029 and visible DOE-SP mis-typed acts.
  // The existing DOU policy/rule/scope selection remains authoritative.
  let specialAfter:string|null=null, specialPages=0;
  while(true){
    if(++specialPages>10000)throw new Error('l18_special_paging_cap');
    const page=await sql<SpecialRow>`
      SELECT * FROM public.l18_special_cleanup_candidates(
        ${specialAfter}::uuid,500
      )
    `.execute(trx);
    if(!page.rows.length)break;
    for(const row of page.rows){
      // DOU/DOE-SP may enter the type purge only through the engine's RULE
      // decision above, even when migration 029 marks them as hidden.
      if(!row.hidden_legacy||f3LegacyPublicationIds.has(row.publication_id))continue;
      const previous=seen.get(row.publication_id);
      if(previous && previous.bucket!=='HIDDEN')continue;
      const blocked=row.has_company?'COMPANY':row.has_other_source?'OTHER':undefined;
      const bucket:Bucket=row.hidden_legacy?'HIDDEN':'SUSPECT_DOE';
      // Legacy non-DOU used to be marked OTHER merely because DOU was absent.
      // Re-evaluate the true cross-source count without overriding DOU guards.
      seen.set(row.publication_id,{
        bucket,...(row.source_code?{source:row.source_code}:{}),
        ...(blocked?{protected:blocked}:{}),
      });
      hash.update('L18').update(row.publication_id)
        .update(new Date(row.updated_at).toISOString())
        .update(row.source_code??'-').update(bucket).update(blocked??'-');
    }
    specialAfter=page.rows[page.rows.length-1]!.publication_id;
    if(page.rows.length<500)break;
  }
  const ids:string[]=[];
  const kinds=new Map<string,Match>();
  let outOfScope=0,ruleDiscards=0,hiddenLegacy=0,suspectDoe=0;
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
    else if(match.bucket==='SUSPECT_DOE')suspectDoe++;
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
    [id,m.bucket,m.protected??'-',m.source??'-',m.rule?.canonical_type??'-'])));
  const byRule=[...stats.values()];
  return{ids,kinds,count:ids.length,outOfScope,ruleDiscards,hiddenLegacy,suspectDoe,
    blockedCompany,blockedOtherSource,byRule,token:hash.digest('hex')};
}

export async function previewOutOfScopePurge(db: Kysely<DB>, actor: string):
  Promise<OutOfScopePreview> {
  return withUserContext(db, actor, async trx => {
    const { ids, kinds, count, outOfScope, ruleDiscards, byRule, hiddenLegacy, suspectDoe, blockedCompany, blockedOtherSource, token } =
      await scopeCandidates(trx);
    const samples=ids.length ? (await sql<{id:string;title:string}>`SELECT * FROM public.collection_filter_purge_samples(${ids.slice(0,10)}::uuid[])`
      .execute(trx)).rows.map(row=>({...row,bucket:kinds.get(row.id)!.bucket})) : [];
    return { count, outOfScope, ruleDiscards, byRule, hiddenLegacy, suspectDoe, blockedCompany, blockedOtherSource, token, samples };
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
      const locked=await scopeCandidates(trx);
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
      const batches=new Map<string,{ids:string[];bucket:Bucket;rule?:RuleRow;source?:string}>();
      for(const id of part){
        const meta=plan.kinds.get(id);
        if(!meta)throw new Error('l17_plan_identity_mismatch');
        const key=meta.bucket==='RULE'
          ?JSON.stringify([meta.bucket,meta.rule?.source_code,meta.rule?.section,meta.rule?.canonical_type,meta.rule?.mode])
          :JSON.stringify([meta.bucket,meta.source??'dou']);
        const group=batches.get(key)??{ids:[],bucket:meta.bucket,
          ...(meta.rule?{rule:meta.rule}:{}),...(meta.source?{source:meta.source}:{})};
        group.ids.push(id);batches.set(key,group);
      }
      for(const group of batches.values()){
        let result;
        if(group.bucket==='OUT_OF_SCOPE'){
          result=await sql<{count:number}>`
            SELECT public.l15_out_of_scope_purge_batch(
              ${group.ids}::uuid[],${operation}::uuid) AS count
          `.execute(trx);
        }else if(group.bucket==='HIDDEN'&&!group.source){
          result=await sql<{count:number}>`
            SELECT public.l17_cleanup_admin_batch(
              ${group.ids}::uuid[],${operation}::uuid) AS count
          `.execute(trx);
        }else if(group.bucket==='HIDDEN'||group.bucket==='SUSPECT_DOE'){
          if(!group.source)throw new Error('l18_special_source_missing');
          const section=group.bucket==='HIDDEN'?'L18_LEGACY_029':'L18_TYPE_MISMATCH';
          const type=group.bucket==='HIDDEN'?'HIDDEN_LEGACY':'EMENDA CONSTITUCIONAL';
          result=await sql<{count:number}>`
            SELECT public.collection_filter_direct_purge_batch(
              ${group.ids}::uuid[],${group.source},${section},
              ${type},'EXCLUDE_ALWAYS',${operation}::uuid) AS count
          `.execute(trx);
        }else{
          const rule=group.rule;
          if(!rule)throw new Error('l17_rule_metadata_missing');
          result=await sql<{count:number}>`
            SELECT public.collection_filter_direct_purge_batch(
              ${group.ids}::uuid[],${rule.source_code},${rule.section},
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
      hiddenLegacy: current.hiddenLegacy,suspectDoe:current.suspectDoe,
      deletedCount: apagadas, blockedCompany: current.blockedCompany,
      blockedOtherSource: current.blockedOtherSource };
  });
}
