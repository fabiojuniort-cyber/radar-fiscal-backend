import {createHash} from 'node:crypto';
import {sql,type Transaction,type Kysely} from 'kysely';
import {withUserContext} from '../../infrastructure/database/tenant-context.js';
import {InventoryCache} from './collection-filter.inventory-cache.js';
import type {DB} from '../../infrastructure/database/database.types.js';
import {collectionFilterActName,evaluateCollectionFilter,normalizeCollectionFilterType,
  type CompiledCollectionFilterPolicy} from './collection-filter.engine.js';
import {loadApprovedCollectionFilterRuntime} from './collection-filter.runtime.js';

export interface ActNameEvidence {
  publication_id:string;title:string;source_code:string;section:string;
  first_collected_at?:Date|null;last_seen_at?:Date|null;
  published_on?:string|null;primary_official_url?:string|null;
}

/** Pure reducer: one real publication per source/section/name, never sample extrapolation. */
export function groupCollectionFilterActNames(items:Iterable<ActNameEvidence>,policy:CompiledCollectionFilterPolicy) {
  const groups=new Map<string,{
    id:string;source_code:string;section:string;normalized_type:string;sample_raw_type:string;
    act_name:string;queue_basis:'ARCHIVE_ACT_NAME';occurrence_count:number;
    first_seen_at:Date|null;last_seen_at:Date|null;sample_publication_ids:string[];
    status:'OPEN';resolved_at:null;requires_review:boolean;
    examples:Array<{id:string;title:string;publishedOn:string|null;officialUrl:string|null}>;
  }>();
  const seen=new Set<string>();
  for(const item of items){
    const identity=JSON.stringify([item.source_code,item.section,item.publication_id]);
    if(seen.has(identity))continue;
    seen.add(identity);
    const name=collectionFilterActName(item.title);
    const normalized=normalizeCollectionFilterType(name)||'NOME NAO IDENTIFICADO';
    const key=JSON.stringify([item.source_code,item.section,normalized]);
    let group=groups.get(key);
    if(!group){
      const hash=createHash('sha256').update('F3-NOME-01:'+key).digest('hex');
      const id=hash.slice(0,8)+'-'+hash.slice(8,12)+'-4'+hash.slice(13,16)+'-a'+hash.slice(17,20)+'-'+hash.slice(20,32);
      const decision=evaluateCollectionFilter(policy,{sourceCode:item.source_code,
        section:item.section,title:item.title,evidenceComplete:false});
      group={id,source_code:item.source_code,section:item.section,normalized_type:normalized,
        sample_raw_type:name||'Nome não identificado',act_name:name,
        queue_basis:'ARCHIVE_ACT_NAME',occurrence_count:0,first_seen_at:null,last_seen_at:null,
        sample_publication_ids:[],examples:[],status:'OPEN',resolved_at:null,
        requires_review:decision.requiresNewTypeReview};
      groups.set(key,group);
    }
    group.occurrence_count++;
    if(item.first_collected_at&&(!group.first_seen_at||item.first_collected_at<group.first_seen_at))
      group.first_seen_at=item.first_collected_at;
    if(item.last_seen_at&&(!group.last_seen_at||item.last_seen_at>group.last_seen_at))
      group.last_seen_at=item.last_seen_at;
    if(group.examples.length<3){
      group.sample_publication_ids.push(item.publication_id);
      group.examples.push({id:item.publication_id,title:item.title,
        publishedOn:item.published_on??null,officialUrl:item.primary_official_url??null});
    }
  }
  return [...groups.values()].sort((a,b)=>b.occurrence_count-a.occurrence_count
    ||a.source_code.localeCompare(b.source_code)||a.section.localeCompare(b.section)
    ||a.normalized_type.localeCompare(b.normalized_type));
}

/** Read projection, not a migration/repair: the legacy queue and saved rules remain untouched. */
export async function loadCollectionFilterActNameInventory(trx:Transaction<DB>) {
  const source=await trx.selectFrom('sources').select('id')
    .where('code','=','dou').executeTakeFirst();
  if(!source)return [];
  const runtime=await loadApprovedCollectionFilterRuntime(trx,source.id,{readOnly:true});
  if(!runtime)return [];
  const rows:ActNameEvidence[]=[];
  for(const sourceCode of ['dou','doe-sp']){
    let after:string|null=null;
    for(let pageNo=0;pageNo<10000;pageNo++){
      const page=await sql<ActNameEvidence>`
        SELECT e.publication_id,e.title,e.source_code,e.section,
          p.first_collected_at,p.last_seen_at,p.published_on::text,p.primary_official_url
        FROM public.collection_filter_f3_candidates(${after}::uuid,500,${sourceCode}) e
        LEFT JOIN public.publications p ON p.id=e.publication_id
        ORDER BY e.publication_id
      `.execute(trx);
      rows.push(...page.rows);
      if(page.rows.length<500)break;
      after=page.rows[page.rows.length-1]!.publication_id;
      if(pageNo===9999)throw new Error('act_name_inventory_paging_cap');
    }
  }
  return groupCollectionFilterActNames(rows,runtime.policy);
}

export type ActNameInventoryItem=ReturnType<typeof groupCollectionFilterActNames>[number];
const caches=new WeakMap<Kysely<DB>,{cache:InventoryCache<ActNameInventoryItem>;timer:ReturnType<typeof setInterval>}>();

/** No archive SQL on the HTTP path. Background transactions retain the requesting admin context. */
export function readCollectionFilterActNameInventory(db:Kysely<DB>,userId:string) {
  let entry=caches.get(db);
  if(!entry){
    const key=()=>withUserContext(db,userId,async trx=>{
      await sql`SET LOCAL statement_timeout='2000ms'`.execute(trx);
      const result=await sql<{key:string}>`
        SELECT jsonb_build_array(
          (SELECT jsonb_build_array(id,revision) FROM collection_filter_policies
            WHERE status='APPROVED' ORDER BY version DESC LIMIT 1),
          (SELECT jsonb_agg(jsonb_build_array(s.code,r.id,r.updated_at) ORDER BY s.code)
            FROM sources s LEFT JOIN LATERAL (
              SELECT id,updated_at FROM collection_runs WHERE source_id=s.id
              ORDER BY updated_at DESC,id DESC LIMIT 1
            ) r ON true WHERE s.code IN ('dou','doe-sp')),
          public.publication_scope_epoch()
        )::text AS key`.execute(trx);
      return result.rows[0]!.key;
    });
    const cache=new InventoryCache(key,()=>db.transaction().setIsolationLevel('repeatable read').execute(async trx=>{
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      await sql`SELECT set_config('app.user_id',${userId},true)`.execute(trx);
      await sql`SET LOCAL statement_timeout='120000ms'`.execute(trx);
      return loadCollectionFilterActNameInventory(trx);
    }));
    const timer=setInterval(()=>cache.read(),15_000);timer.unref();
    entry={cache,timer};caches.set(db,entry);
  }
  return entry.cache.read();
}
export async function closeCollectionFilterActNameInventory(db:Kysely<DB>) {
  const entry=caches.get(db);if(!entry)return;
  clearInterval(entry.timer);await entry.cache.close();caches.delete(db);
}
