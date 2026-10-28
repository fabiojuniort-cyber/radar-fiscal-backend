import {loadReleaseView,type ReleaseView,type SqlRunner} from '../taxonomy/curation/curation.read.js';
import type {ProposedLink} from '../taxonomy/curation/curation.f2-links.plan.js';

/** App-local, bounded cache of immutable published data only. Never stores tenant/profile data.
 * Caller still checks the latest PUBLISHED id in every transaction under the publication lock.
 */
export function publishedAssistantReader(maxEntries=4){
 const cache=new Map<string,{view:ReleaseView;links:ProposedLink[]}>();
 return async(run:SqlRunner,id:string)=>{
  const hit=cache.get(id);if(hit)return hit;
  const view=await loadReleaseView(run,id);
  if(!view||view.release.status!=='PUBLISHED')return null;
  const rows=await run<{approval:{ruleVersion:string;links:ProposedLink[]}|null}>("SELECT manifest->'f2Operational' AS approval FROM taxonomy_releases WHERE id=$1 AND status='PUBLISHED'",[id]);
  const approval=rows[0]?.approval;
  const links=approval&&['onb03-t07-t08-v1','onb03-t07-t08-v2','onb03-t07-t08-v3'].includes(approval.ruleVersion)&&Array.isArray(approval.links)?approval.links:[];
  const snapshot={view,links};cache.set(id,snapshot);
  while(cache.size>maxEntries)cache.delete(cache.keys().next().value!);
  return snapshot;
 };
}
