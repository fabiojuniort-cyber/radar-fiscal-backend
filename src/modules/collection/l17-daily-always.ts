import { sql, type Kysely } from 'kysely';
import type { DB } from '../../infrastructure/database/database.types.js';
import { loadApprovedCollectionFilterRuntime } from './collection-filter.runtime.js';
import {
  evaluateCollectionFilter, normalizeCollectionFilterType,
  normalizeCollectionFilterText,
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
  let deletedPublications=0,batches=0,examined=0;
  try{
    const source=await sql<{id:string}>`
      SELECT id FROM public.sources WHERE code='dou'
    `.execute(db);
    if(!source.rows[0])throw new Error('l17_dou_source_missing');
    const runtime=await loadApprovedCollectionFilterRuntime(db,source.rows[0].id);
    if(!runtime)throw new Error('l17_filter_runtime_missing');
    const rules=[...runtime.policy.rules.values()].filter(r=>
      r.sourceCode==='dou' && r.mode==='EXCLUDE_ALWAYS');
    for(const rule of rules){
      if(batches>=MAX_BATCHES||Date.now()-began>=MAX_TIME_MS)break;
      let cursor:string|null=null,visitedPages=0;
      const section=normalizeCollectionFilterType(rule.section??'');
      const canonical=normalizeCollectionFilterType(rule.canonicalType);
      const aliasKeys=[...runtime.policy.aliases.entries()]
        .filter(([key,target])=>{
          const [src,sec]=key.split('\0');
          return src===normalizeCollectionFilterText('dou') && sec===normalizeCollectionFilterText(rule.section??'')
            && target===canonical;
        }).map(([key])=>key.split('\0')[2]!).filter(Boolean);
      const typeKeys=[...new Set([canonical,...aliasKeys])];
      while(batches<MAX_BATCHES && Date.now()-began<MAX_TIME_MS && visitedPages<30){
        visitedPages++;
        const txResult=await db.transaction().execute(async trx=>{
          const page=await sql<Candidate>`
            SELECT * FROM public.collection_filter_direct_candidates(
              ${cursor}::uuid,${PAGE_LIMIT},${section},${typeKeys}::text[]
            )
          `.execute(trx);
          if(!page.rows.length)return {next:null,empty:true,deleted:0};
          const next=page.rows[page.rows.length-1]!.publication_id;
          const eligible=page.rows.filter(row=>{
            const decision=evaluateCollectionFilter(runtime.policy,{
              sourceCode:'dou',section:row.section,actType:row.act_type,
              title:row.title,body:row.content_text,summary:row.relevant_excerpt,
              evidenceComplete:row.evidence_complete,
              materialAttachmentsUnexamined:row.has_material,
              typeConflict:row.type_conflict,
              provenanceConflict:row.provenance_conflict,
            });
            return decision.decision==='DISCARD'
              && decision.reasonCode==='EXCLUDE_ALWAYS'
              && decision.mode==='EXCLUDE_ALWAYS'
              && decision.canonicalType===canonical
              && !row.has_company && !row.has_other_source
              && Boolean(row.content_hash);
          }).slice(0,20);
          if(!eligible.length)return {next,empty:page.rows.length<PAGE_LIMIT,deleted:0};
          const candidates=eligible.map(row=>row.publication_id);
          const scope=await sql<{id:string}>`
            SELECT p.id FROM public.publications p
            WHERE p.id=ANY(${candidates}::uuid[])
              AND NOT p.is_hidden
              AND public.publication_scope_is_in_scope(p.id)
          `.execute(trx);
          const ok=new Set(scope.rows.map(x=>x.id));
          const selected=eligible.filter(x=>ok.has(x.publication_id));
          if(!selected.length)return {next,empty:page.rows.length<PAGE_LIMIT,deleted:0};
          const ids=selected.map(x=>x.publication_id);
          await sql`SELECT public.l17_lock_worker_always_targets(${ids}::uuid[])`.execute(trx);
          // Repeat the exact candidate adapter after locking parents:
          // a material origin/version write cannot change the evidence now.
          const fresh=await sql<Candidate>`
            SELECT * FROM public.collection_filter_direct_candidates(
              ${cursor}::uuid,${PAGE_LIMIT},${section},${typeKeys}::text[]
            )
          `.execute(trx);
          const freshMap=new Map(fresh.rows.map(x=>[x.publication_id,x]));
          const locked=selected.map(x=>freshMap.get(x.publication_id)).filter(
            (x):x is Candidate=>Boolean(x)).filter(row=>{
              const decision=evaluateCollectionFilter(runtime.policy,{
                sourceCode:'dou',section:row.section,actType:row.act_type,
                title:row.title,body:row.content_text,summary:row.relevant_excerpt,
                evidenceComplete:row.evidence_complete,
                materialAttachmentsUnexamined:row.has_material,
                typeConflict:row.type_conflict,
                provenanceConflict:row.provenance_conflict,
              });
              return decision.decision==='DISCARD'
                && decision.reasonCode==='EXCLUDE_ALWAYS'
                && decision.mode==='EXCLUDE_ALWAYS'
                && decision.canonicalType===canonical
                && !row.has_company&&!row.has_other_source
                && Boolean(row.content_hash);
            });
          if(!locked.length)return {next,empty:page.rows.length<PAGE_LIMIT,deleted:0};
          const safeIds=locked.map(x=>x.publication_id);
          const hashes=locked.map(x=>x.content_hash!);
          const purge=await sql<{deleted:number}>`
            SELECT public.l17_prune_always_batch(
              ${safeIds}::uuid[],${hashes}::text[],
              ${runtime.policyId}::uuid,${runtime.policyRevision},
              ${rule.section??''},${rule.canonicalType}
            ) AS deleted
          `.execute(trx);
          const deleted=Number(purge.rows[0]?.deleted??-1);
          if(deleted!==safeIds.length)throw new Error('l17_always_batch_count_mismatch');
          return {next,empty:page.rows.length<PAGE_LIMIT,deleted};
        });
        examined+=PAGE_LIMIT;
        deletedPublications+=txResult.deleted;
        if(txResult.deleted>0)batches++;
        if(txResult.empty||!txResult.next)break;
        cursor=txResult.next;
        if(deletedPublications>=MAX_DELETES)break;
      }
    }
    await sql`SELECT public.l17_finish_always_day(
      ${deletedPublications},${batches},true
    )`.execute(db);
    logger.info({deletedPublications,batches,examined,
      maxPerBatch:20,maxBatches:MAX_BATCHES,elapsedMs:Date.now()-began},
    'L17 daily EXCLUDE_ALWAYS cleanup completed');
  }catch(error){
    await sql`SELECT public.l17_finish_always_day(
      ${deletedPublications},${batches},false
    )`.execute(db).catch(()=>{});
    logger.error({deletedPublications,batches,
      error:error instanceof Error?error.message:'unknown'},
      'L17 daily EXCLUDE_ALWAYS cleanup failed');
  }
}
