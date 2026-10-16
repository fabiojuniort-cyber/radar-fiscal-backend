import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {normalizeAliasText} from '../baseline/baseline.parser.js';
import {f2GroupSlugify,type F2DraftPlan} from './curation.f2-draft-import.js';
import {type ReleaseView} from './curation.read.js';
import {createGroup,type CuratorActor} from './curation.draft.js';

const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const norm=(s:string)=>normalizeAliasText(s);
type Target={label:string;parent:string;groupCode:string;groupId:string|null;segmentCode:string|null;conceptCodes:string[];collision:boolean};
export interface GroupRepairPlan{
 draftId:string;lotBatchId:string;contentSha256:string;published:false;
 targets:Target[];unresolved:{label:string;reason:'PARENT_MISSING'|'PARENT_AMBIGUOUS'|'SOURCE_CONCEPT_MISSING'|'CODE_CONFLICT';candidates?:number}[];
 stats:{sourceConcepts:number;groups:number;slugFusions:number;newGroups:number;changedConceptLinks:number;missingSegmentLinks:number;unchanged:number};
 planSha256:string;
}
type PlanInput={draftId:string;plan:F2DraftPlan;view:ReleaseView};
const isSegment=(c:ReleaseView['concepts'][number])=>c.dimensionCode==='sector' &&
 c.membershipStatus==='INCLUDED' && !c.officialCodes.some(x=>/^\d{7}$/.test(x));
function suffixCode(label:string){
 const prefix=f2GroupSlugify(label).slice(0,46).replace(/_+$/,'');
 return prefix+'_'+sha(norm(label)).slice(0,12);
}
/** Identity: prefer the existing group with the exact label; never merge
 * distinct labels merely because slugify truncated both to sixty characters.
 */
export function buildF2GroupRepairPlan({draftId,plan,view}:PlanInput):GroupRepairPlan {
 if(draftId!==view.release.id || view.release.status!=='DRAFT')
    throw Error('F2_GROUP_DRAFT_IDENTITY_MISMATCH');
 const originalGroups=view.groups.filter(g=>g.dimensionCode==='sector');
 const byGroupCode=new Map(originalGroups.map(g=>[g.code,g]));
 const originalsByLabel=new Map<string,typeof originalGroups[number]>();
 for(const group of originalGroups)originalsByLabel.set(norm(group.label),group);
 const sectorByCode=new Map(view.concepts.filter(c=>c.dimensionCode==='sector').map(c=>[c.code,c]));
 const parents=new Map<string,string[]>();
 for(const c of view.concepts.filter(isSegment)){
   const key=norm(c.label);
   parents.set(key,[...(parents.get(key)??[]),c.code]);
 }
 const targetsByLabel=new Map<string,Target>();
 const usedCodes=new Map(originalGroups.map(g=>[g.code,norm(g.label)]));
 const unresolved:GroupRepairPlan['unresolved']=[];
 let slugFusions=0,changedConceptLinks=0,missingSegmentLinks=0,unchanged=0;
 for(const item of plan.sector){
   const key=norm(item.group);
   let target=targetsByLabel.get(key);
   if(!target){
     const legacyCode=f2GroupSlugify(item.group);
     const existing=originalsByLabel.get(key);
     let code=existing?.code??legacyCode;
     let collision=false;
     const used=usedCodes.get(code);
     if(used && used!==key){
       collision=true;slugFusions++;
       code=suffixCode(item.group);
       if(usedCodes.has(code)&&usedCodes.get(code)!==key)
         unresolved.push({label:item.group,reason:'CODE_CONFLICT'});
     }
     usedCodes.set(code,key);
     const group=byGroupCode.get(code);
     const parentCandidates=parents.get(norm(item.parentSegment??''))??[];
     if(parentCandidates.length!==1)unresolved.push({
       label:item.group,reason:parentCandidates.length?'PARENT_AMBIGUOUS':'PARENT_MISSING',
       candidates:parentCandidates.length,
     });
     target={label:item.group,parent:item.parentSegment??'',groupCode:code,
       groupId:group?.id??null,segmentCode:parentCandidates.length===1?parentCandidates[0]!:null,
       conceptCodes:[],collision};
     targetsByLabel.set(key,target);
   }
   target.conceptCodes.push(item.code);
   const concept=sectorByCode.get(item.code);
   if(!concept || concept.membershipStatus!=='INCLUDED'){
     unresolved.push({label:item.group,reason:'SOURCE_CONCEPT_MISSING'});
     continue;
   }
   const current=concept.groupId?originalGroups.find(g=>g.id===concept.groupId):undefined;
   if(!current || current.code!==target.groupCode)changedConceptLinks++;
   else unchanged++;
 }
 for(const target of targetsByLabel.values()){
   const existing=byGroupCode.get(target.groupCode);
   if(existing && norm(existing.label)!==norm(target.label))
      unresolved.push({label:target.label,reason:'CODE_CONFLICT'});
   if(target.segmentCode &&
      !(existing?.segmentCodes??[]).includes(target.segmentCode))missingSegmentLinks++;
 }
 const targets=[...targetsByLabel.values()].sort((a,b)=>a.groupCode.localeCompare(b.groupCode));
 const bare={draftId,lotBatchId:plan.batchId,contentSha256:plan.contentSha256,
   published:false as const,targets,unresolved,
   stats:{sourceConcepts:plan.sector.length,groups:targets.length,slugFusions,
     newGroups:targets.filter(t=>!t.groupId).length,changedConceptLinks,missingSegmentLinks,unchanged}};
 return {...bare,planSha256:sha(JSON.stringify(bare))};
}
/** Applied under withCuratorTransaction, no writes to published releases.
 * No hard DELETE: inserts new draft groups/memberships and updates only
 * the existing draft concept group_id. Existing evidence is retained.
 */
export async function applyF2GroupRepair(client:PoolClient,actor:CuratorActor,
 preview:GroupRepairPlan,confirmSha:string):Promise<Record<string,unknown>>{
 if(preview.planSha256!==confirmSha)throw Error('F2_GROUP_PLAN_HASH_MISMATCH');
 if(preview.unresolved.length)throw Error('F2_GROUP_UNRESOLVED_PARENTS');
 // Rechecked by caller under the same serialized curator transaction.
 let newGroups=0,linked=0,segments=0;
 const dim=await client.query<{id:string}>(`SELECT d.id FROM taxonomy_dimensions d
  JOIN taxonomy_release_dimensions rd ON rd.dimension_id=d.id
  WHERE rd.release_id=$1::uuid AND d.code='sector' AND rd.membership_status='INCLUDED'`,[preview.draftId]);
 if(dim.rows.length!==1)throw Error('F2_GROUP_SECTOR_DIMENSION_MISSING');
 for(const target of preview.targets){
   let groupId=target.groupId;
   if(!groupId){
     groupId=await createGroup(client,actor,'sector',{code:target.groupCode,label:target.label});
     newGroups++;
   }
   if(!target.segmentCode)throw Error('F2_GROUP_SEGMENT_MISSING');
   const parent=await client.query<{id:string}>(`
     SELECT rc.id FROM taxonomy_release_concepts rc
     JOIN taxonomy_concepts c ON c.id=rc.concept_id
     WHERE rc.release_id=$1::uuid AND c.code=$2 AND rc.membership_status='INCLUDED'`,
     [preview.draftId,target.segmentCode]);
   if(parent.rows.length!==1)throw Error('F2_GROUP_PARENT_CHANGED');
   const l=await client.query(`
     INSERT INTO taxonomy_release_group_segments(release_id,group_id,segment_release_concept_id)
     VALUES ($1::uuid,$2::uuid,$3::uuid)
     ON CONFLICT (group_id,segment_release_concept_id) DO NOTHING
   `,[preview.draftId,groupId,parent.rows[0]!.id]);
   segments+=l.rowCount??0;
   const updated=await client.query(`
     UPDATE taxonomy_release_concepts rc SET group_id=$2::uuid
     FROM taxonomy_concepts c
     WHERE rc.concept_id=c.id AND rc.release_id=$1::uuid
       AND rc.membership_status='INCLUDED'
       AND c.code=ANY($3::text[]) AND rc.group_id IS DISTINCT FROM $2::uuid
   `,[preview.draftId,groupId,target.conceptCodes]);
   linked+=updated.rowCount??0;
 }
 return {draftId:preview.draftId,published:false,newGroups,linked,segmentLinksAdded:segments,
  reusedExisting:newGroups===0&&linked===0&&segments===0};
}
