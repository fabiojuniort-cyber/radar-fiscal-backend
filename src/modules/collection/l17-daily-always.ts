import { sql, type Kysely } from 'kysely';
import type { DB } from '../../infrastructure/database/database.types.js';
import { loadApprovedCollectionFilterRuntime } from './collection-filter.runtime.js';
import {
  normalizeCollectionFilterType,
  normalizeCollectionFilterText, type CompiledCollectionFilterPolicy,
} from './collection-filter.engine.js';

import { evaluateHistoricalCollectionCandidate, type HistoricalCollectionCandidate } from './collection-filter.direct.js';

const MAX_TIME_MS=15000;
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

/** Daily F3 inspection only. Physical deletion requires the admin preview
 * and explicit confirmation flow; no background job can grant it itself. */
export async function runL17ExcludeAlways(
  db:Kysely<DB>,logger:{
    info:(data:Record<string,unknown>,message:string)=>void;
    error:(data:Record<string,unknown>,message:string)=>void;
  },
):Promise<void>{
  const began=Date.now();
  let examined=0,eligible=0,protectedCount=0;
  try{
    const sources=await sql<{id:string;code:string}>`
      SELECT DISTINCT ON (lower(code)) id,lower(code) AS code FROM public.sources
      WHERE lower(code) IN ('dou','doe-sp') ORDER BY lower(code),id
    `.execute(db);
    for(const source of sources.rows){
      const runtime=await loadApprovedCollectionFilterRuntime(db,source.id,{readOnly:true});
      if(!runtime)continue;
      let cursor:string|null=null;
      while(Date.now()-began<MAX_TIME_MS){
        const page=await sql<HistoricalCollectionCandidate>`
          SELECT * FROM public.collection_filter_f3_candidates(
            ${cursor}::uuid,${PAGE_LIMIT},${source.code})
        `.execute(db);
        for(const row of page.rows){
          examined++;
          const decision=evaluateHistoricalCollectionCandidate(runtime.policy,row);
          if(decision.decision!=='DISCARD'||decision.mode!=='EXCLUDE_ALWAYS')continue;
          if(row.has_company||row.has_other_source)protectedCount++;
          else eligible++;
        }
        if(page.rows.length<PAGE_LIMIT)break;
        cursor=page.rows[page.rows.length-1]!.publication_id;
      }
    }
    logger.info({examined,eligible,protectedCount,deletedPublications:0,
      confirmationRequired:true,truncated:Date.now()-began>=MAX_TIME_MS,
      elapsedMs:Date.now()-began},'L17 F3 preview only; explicit admin confirmation required');
  }catch(error){
    logger.error({examined,eligible,protectedCount,deletedPublications:0,
      error:error instanceof Error?error.message:'unknown'},'L17 F3 preview failed');
  }
}
