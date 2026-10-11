import { sql, type Kysely } from 'kysely';
import type { DB } from '../../infrastructure/database/database.types.js';
import { loadApprovedCollectionFilterRuntime } from './collection-filter.runtime.js';
import {
  evaluateCollectionFilter, normalizeCollectionFilterType,
  normalizeCollectionFilterText, type CompiledCollectionFilterPolicy,
} from './collection-filter.engine.js';

interface Candidate {
  publication_id:string;
  title:string;
  act_type:string|null;
  section:string;
  content_text:string|null;
  relevant_excerpt:string|null;
  evidence_complete:boolean;
  has_material:boolean;
  type_conflict:boolean;
  provenance_conflict:boolean;
  has_company:boolean;
  has_other_source:boolean;
  content_hash:string|null;
}
const MAX_DELETES=200, MAX_BATCHES=10, MAX_TIME_MS=15000;
const PAGE_LIMIT=100;

/** The compiled policy normalizes sourceCode to DOU (uppercase).
 * Never compare its source code to the raw database value 'dou'.
 */
export function selectL17AutomaticRules(policy:CompiledCollectionFilterPolicy){
  return [...policy.rules.values()].filter(r=>
    r.sourceCode===normalizeCollectionFilterText('dou') && r.mode==='EXCLUDE_ALWAYS');
}

/**
 * Coalesce every active EXCLUDE_ALWAYS rule into bounded SQL prefilter chunks.
 * There is no hard rule-count limit and no dependence on the first 1000 rules.
 * Groups rotate daily under the 15s budget, so later groups cannot starve.
 */
export function partitionL17AutomaticRules(policy:CompiledCollectionFilterPolicy) {
  const src=normalizeCollectionFilterText('dou');
  const rules=selectL17AutomaticRules(policy);
  const bySection=new Map<string,{keys:Set<string>;rules:Map<string,typeof rules[number]>}>();
  for(const rule of rules){
    const section=normalizeCollectionFilterType(rule.section??'');
    const canonical=normalizeCollectionFilterType(rule.canonicalType);
    const group=bySection.get(section)??{keys:new Set<string>(),rules:new Map()};
    group.keys.add(canonical);
    group.rules.set(canonical,rule);
    bySection.set(section,group);
  }
  for(const [key,target] of policy.aliases.entries()){
    const [code,section,alias]=key.split('\0');
    if(code!==src||!section||!alias)continue;
    const group=bySection.get(section);
    if(group?.rules.has(target))group.keys.add(alias);
  }
  const partitions:Array<{section:string;types:string[];
    rules:Map<string,typeof rules[number]>}>=[];
  for(const [section,group] of [...bySection.entries()].sort((a,b)=>a[0].localeCompare(b[0]))){
    const all=[...group.keys].sort();
    for(let i=0;i<all.length;i+=160)
      partitions.push({section,types:all.slice(i,i+160),rules:group.rules});
  }
  return {rules,partitions};
}

export async function runL17ExcludeAlways(
  db:Kysely<DB>,logger:{
    info:(data:Record<string,unknown>,message:string)=>void;
    error:(data:Record<string,unknown>,message:string)=>void;
  },
):Promise<void>{
  const claim=await sql<{claimed:boolean}>`
    SELECT public.l17_claim_always_day() AS claimed
  `.execute(db);
  if(!claim.rows[0]?.claimed)return;
  const began=Date.now();
  let deletedPublications=0,batches=0,examined=0,groupsVisited=0;
  let totalRules=0,totalGroups=0;
  try{
    const source=await sql<{id:string}>`
      SELECT id FROM public.sources WHERE code='dou'
    `.execute(db);
    if(!source.rows[0])throw new Error('l17_dou_source_missing');
    const runtime=await loadApprovedCollectionFilterRuntime(db,source.rows[0].id);
    if(!runtime)throw new Error('l17_filter_runtime_missing');
    const plan=partitionL17AutomaticRules(runtime.policy);
    totalRules=plan.rules.length;totalGroups=plan.partitions.length;
    const start=totalGroups>0?Math.floor(Date.now()/86_400_000)%totalGroups:0;
    const groups=[...plan.partitions.slice(start),...plan.partitions.slice(0,start)];
    for(const group of groups){
      if(batches>=MAX_BATCHES||Date.now()-began>=MAX_TIME_MS)break;
      groupsVisited++;
      let cursor:string|null=null,visitedPages=0;
      while(batches<MAX_BATCHES&&Date.now()-began<MAX_TIME_MS&&visitedPages<30){
        visitedPages++;
        const tx=await db.transaction().execute(async trx=>{
          await sql`SET LOCAL lock_timeout = '750ms'`.execute(trx);
          await sql`SET LOCAL statement_timeout = '10000ms'`.execute(trx);
          const page=await sql<Candidate>`
            SELECT * FROM public.collection_filter_direct_candidates(
              ${cursor}::uuid,${20},${group.section},${group.types}::text[])
          `.execute(trx);
          if(!page.rows.length)return{next:null,empty:true,deleted:0,batches:0};
          const next=page.rows[page.rows.length-1]!.publication_id;
          const eligible=page.rows.filter(row=>{
            const d=evaluateCollectionFilter(runtime.policy,{
              sourceCode:'dou',section:row.section,actType:row.act_type,
              title:row.title,body:row.content_text,summary:row.relevant_excerpt,
              evidenceComplete:row.evidence_complete,
              materialAttachmentsUnexamined:row.has_material,
              typeConflict:row.type_conflict,provenanceConflict:row.provenance_conflict,
            });
            return d.decision==='DISCARD'&&d.reasonCode==='EXCLUDE_ALWAYS'
              &&d.mode==='EXCLUDE_ALWAYS'&&Boolean(d.canonicalType)
              &&group.rules.has(d.canonicalType!)
              &&!row.has_company&&!row.has_other_source&&Boolean(row.content_hash);
          });
          if(!eligible.length)return{next,empty:page.rows.length<20,deleted:0,batches:0};
          const scoped=await sql<{id:string}>`
            SELECT p.id FROM public.publications p
            WHERE p.id=ANY(${eligible.map(r=>r.publication_id)}::uuid[])
              AND NOT p.is_hidden AND public.publication_scope_is_in_scope(p.id)
          `.execute(trx);
          const available=new Set(scoped.rows.map(x=>x.id));
          const selected=eligible.filter(x=>available.has(x.publication_id));
          if(!selected.length)return{next,empty:page.rows.length<20,deleted:0,batches:0};
          const ids=selected.map(x=>x.publication_id);
          await sql`SELECT public.l17_lock_worker_always_targets(${ids}::uuid[])`.execute(trx);
          const fresh=await sql<Candidate>`
            SELECT * FROM public.collection_filter_direct_candidates(
              ${cursor}::uuid,${20},${group.section},${group.types}::text[])
          `.execute(trx);
          const current=new Map(fresh.rows.map(x=>[x.publication_id,x]));
          const safe=new Map<string,Candidate[]>();
          for(const initial of selected){
            const row=current.get(initial.publication_id);
            if(!row||row.has_company||row.has_other_source||!row.content_hash)continue;
            const d=evaluateCollectionFilter(runtime.policy,{
              sourceCode:'dou',section:row.section,actType:row.act_type,
              title:row.title,body:row.content_text,summary:row.relevant_excerpt,
              evidenceComplete:row.evidence_complete,
              materialAttachmentsUnexamined:row.has_material,
              typeConflict:row.type_conflict,provenanceConflict:row.provenance_conflict,
            });
            if(d.decision!=='DISCARD'||d.reasonCode!=='EXCLUDE_ALWAYS'
              ||d.mode!=='EXCLUDE_ALWAYS'||!d.canonicalType
              ||!group.rules.has(d.canonicalType))continue;
            const list=safe.get(d.canonicalType)??[];
            list.push(row);safe.set(d.canonicalType,list);
          }
          let deleted=0,used=0;
          for(const [type,rows]of safe){
            const rule=group.rules.get(type)!;
            const result=await sql<{deleted:number}>`
              SELECT public.l17_prune_always_batch(
                ${rows.map(r=>r.publication_id)}::uuid[],
                ${rows.map(r=>r.content_hash!)}::text[],
                ${runtime.policyId}::uuid,${runtime.policyRevision},
                ${rule.section??''},${rule.canonicalType}) AS deleted
            `.execute(trx);
            const n=Number(result.rows[0]?.deleted??-1);
            if(n!==rows.length)throw new Error('l17_always_batch_count_mismatch');
            deleted+=n;used++;
          }
          return{next,empty:page.rows.length<20,deleted,batches:used};
        });
        examined+=20;deletedPublications+=tx.deleted;batches+=tx.batches;
        if(tx.empty||!tx.next)break;
        cursor=tx.next;
        if(deletedPublications>=MAX_DELETES)break;
      }
    }
    await sql`SELECT public.l17_finish_always_day(
      ${deletedPublications},${batches},true)`.execute(db);
    logger.info({
      deletedPublications,batches,examined,totalRules,totalGroups,
      groupsVisited,deferredGroups:Math.max(0,totalGroups-groupsVisited),
      maxPerBatch:20,maxBatches:MAX_BATCHES,elapsedMs:Date.now()-began
    },'L17 daily EXCLUDE_ALWAYS cleanup completed');
  }catch(error){
    await sql`SELECT public.l17_finish_always_day(
      ${deletedPublications},${batches},false)`.execute(db).catch(()=>{});
    logger.error({deletedPublications,batches,totalRules,totalGroups,groupsVisited,
      error:error instanceof Error?error.message:'unknown'},
      'L17 daily EXCLUDE_ALWAYS cleanup failed');
  }
}
