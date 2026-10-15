import 'dotenv/config';
import {createHash} from 'node:crypto';
import {Pool,type PoolClient} from 'pg';
import {resolveCuratorDatabaseUrl} from './curator-url.js';
import {assertCuratorSession,withCuratorTransaction} from '../../modules/taxonomy/curation/curation.draft.js';

/**
 * F2-TAB-01: membership-only retirement. Deliberately NO DELETE, TRUNCATE,
 * global identity update, publication tag mutation, or release publication.
 * The five structural filters in the Acervo are unrelated and remain intact.
 */
export const RETIRED_TAXONOMY_DIMENSIONS = [
  'treatment','act_type','platform','tax_species','sphere',
] as const;
export const F2_TAB_DRAFT_ID = '52791d3b-afdc-496f-8ada-c6cd5c819dff';

type DimensionCode=(typeof RETIRED_TAXONOMY_DIMENSIONS)[number];
type CountRow={dimension:string;dimension_status:string;included:number;retired:number;groups:number;relations:number;mappings:number;relation_rules:number};
export type RetirementPlan={draftId:string;version:string;status:string;dimensions:CountRow[];historical:{publishedConceptMemberships:number;automaticTags:number;manualTags:number};planSha256:string};

const countSql=`
SELECT d.code AS dimension,rd.membership_status AS dimension_status,
 count(DISTINCT rc.id) FILTER(WHERE rc.membership_status='INCLUDED')::int AS included,
 count(DISTINCT rc.id) FILTER(WHERE rc.membership_status='RETIRED')::int AS retired,
 (SELECT count(*)::int FROM taxonomy_release_groups g WHERE g.release_id=rd.release_id AND g.dimension_id=d.id) AS groups,
 (SELECT count(*)::int FROM taxonomy_concept_relations rel
   JOIN taxonomy_release_concepts a ON a.id=rel.source_release_concept_id
   JOIN taxonomy_release_concepts b ON b.id=rel.target_release_concept_id
   JOIN taxonomy_concepts ac ON ac.id=a.concept_id
   JOIN taxonomy_concepts bc ON bc.id=b.concept_id
   WHERE rel.release_id=rd.release_id AND (ac.dimension_id=d.id OR bc.dimension_id=d.id)) AS relations,
 (SELECT count(*)::int FROM taxonomy_official_mappings m
   JOIN taxonomy_release_concepts a ON a.id=m.release_concept_id
   JOIN taxonomy_concepts ac ON ac.id=a.concept_id
   WHERE m.release_id=rd.release_id AND ac.dimension_id=d.id) AS mappings,
 (SELECT count(*)::int FROM taxonomy_release_relation_rules rr WHERE rr.release_id=rd.release_id
   AND (rr.source_dimension_id=d.id OR rr.target_dimension_id=d.id)) AS relation_rules
FROM taxonomy_release_dimensions rd
JOIN taxonomy_dimensions d ON d.id=rd.dimension_id
LEFT JOIN taxonomy_release_concepts rc ON rc.release_id=rd.release_id
  AND rc.concept_id IN (SELECT id FROM taxonomy_concepts WHERE dimension_id=d.id)
WHERE rd.release_id=$1::uuid AND d.code=ANY($2::text[])
GROUP BY d.id,d.code,rd.release_id,rd.membership_status
ORDER BY d.code
`;

async function historic(client:PoolClient){
 const r=await client.query<{published_concepts:number;automatic_tags:number;manual_tags:number}>(`
 SELECT
 (SELECT count(*)::int FROM taxonomy_release_concepts rc JOIN taxonomy_releases r ON r.id=rc.release_id
  WHERE r.status='PUBLISHED') AS published_concepts,
 (SELECT count(*)::int FROM publication_taxonomy_assertions) AS automatic_tags,
 (SELECT count(*)::int FROM publication_taxonomy_curator_tags) AS manual_tags
 `);
 const x=r.rows[0]!;
 return {publishedConceptMemberships:x.published_concepts,automaticTags:x.automatic_tags,manualTags:x.manual_tags};
}
async function snapshot(client:PoolClient):Promise<Omit<RetirementPlan,'planSha256'>>{
 const r=await client.query<{id:string;version:string;status:string}>(
  "SELECT id::text,version,status FROM taxonomy_releases WHERE id=$1::uuid",
  [F2_TAB_DRAFT_ID]);
 const release=r.rows[0];
 if(!release||release.version!=='v1.7.0'||release.status!=='DRAFT')
  throw Error('F2_TAB_DRAFT_MISMATCH');
 const rows=await client.query<CountRow>(countSql,[F2_TAB_DRAFT_ID,[...RETIRED_TAXONOMY_DIMENSIONS]]);
 if(rows.rows.length!==RETIRED_TAXONOMY_DIMENSIONS.length)
  throw Error('F2_TAB_DIMENSIONS_MISSING');
 return {draftId:release.id,version:release.version,status:release.status,
  dimensions:rows.rows,historical:await historic(client)};
}
export function makeRetirementPlan(state:Omit<RetirementPlan,'planSha256'>):RetirementPlan{
 // hash intentionally based on exact before-state for strict apply confirmation
 const planSha256=createHash('sha256').update(JSON.stringify(state)).digest('hex');
 return {...state,planSha256};
}
/** Pure coverage helper for isolated tests; must be true for idempotent second apply. */
export function plannedToRetire(plan:RetirementPlan):number{
 return plan.dimensions.reduce((n,d)=>n+(d.dimension_status==='INCLUDED'?1:0),0);
}
function assertNoHistoricChange(before:RetirementPlan['historical'],after:RetirementPlan['historical']){
 if(JSON.stringify(before)!==JSON.stringify(after)) throw Error('F2_TAB_HISTORIC_CHANGED');
}
async function apply(client:PoolClient,expected:string){
 const pre=makeRetirementPlan(await snapshot(client));
 if(pre.planSha256!==expected)throw Error('F2_TAB_PLAN_SHA_MISMATCH');
 const changed=plannedToRetire(pre);
 if(changed){
   // Keep relations, groups, mappings and evidence in their existing release:
   // never physically remove them, including the draft.
   await client.query(`
   UPDATE taxonomy_release_concepts rc SET membership_status='RETIRED'
    FROM taxonomy_concepts c JOIN taxonomy_dimensions d ON d.id=c.dimension_id
    WHERE rc.release_id=$1::uuid AND rc.concept_id=c.id AND d.code=ANY($2::text[])
      AND rc.membership_status='INCLUDED'`,[F2_TAB_DRAFT_ID,[...RETIRED_TAXONOMY_DIMENSIONS]]);
   await client.query(`
   UPDATE taxonomy_release_dimensions rd SET membership_status='RETIRED',profile_visible=FALSE
    FROM taxonomy_dimensions d
    WHERE rd.release_id=$1::uuid AND rd.dimension_id=d.id AND d.code=ANY($2::text[])
      AND rd.membership_status='INCLUDED'`,[F2_TAB_DRAFT_ID,[...RETIRED_TAXONOMY_DIMENSIONS]]);
 }
 const post=makeRetirementPlan(await snapshot(client));
 if(post.dimensions.some(d=>d.dimension_status!=='RETIRED'||d.included!==0))
  throw Error('F2_TAB_READBACK_FAILED');
 assertNoHistoricChange(pre.historical,post.historical);
 return {draftId:F2_TAB_DRAFT_ID,published:false,readback:'PASS',
  retiredDimensions:changed,reusedExisting:changed===0,
  historicalPreserved:true,pre,post};
}
async function main(){
 const mode=process.argv.find(x=>x.startsWith('--mode='))?.slice(7);
 if(mode!=='plan'&&mode!=='apply')throw Error('F2_TAB_INVALID_MODE');
 const connectionString=resolveCuratorDatabaseUrl({
  DATABASE_URL:process.env.DATABASE_URL??'',
  DATABASE_CURATOR_URL:process.env.DATABASE_CURATOR_URL,
  DB_CURATOR_RUNTIME_PASSWORD:process.env.DB_CURATOR_RUNTIME_PASSWORD});
 if(!connectionString)throw Error('F2_TAB_CURATOR_CREDENTIAL_MISSING');
 const pool=new Pool({connectionString,max:1});
 try {
  if(mode==='plan'){
   const client=await pool.connect();
   try{
    await assertCuratorSession(client);
    await client.query('BEGIN TRANSACTION READ ONLY');
    const plan=makeRetirementPlan(await snapshot(client));
    console.log('F2_TAB_PLAN='+JSON.stringify(plan));
    await client.query('ROLLBACK');
   }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
  }else{
   const expected=process.argv.find(x=>x.startsWith('--confirm-plan-sha256='))?.split('=')[1]??'';
   const confirmedDraft=process.argv.find(x=>x.startsWith('--confirm-draft-id='))?.split('=')[1]??'';
   if(!/^[a-f0-9]{64}$/.test(expected)||confirmedDraft!==F2_TAB_DRAFT_ID)
    throw Error('F2_TAB_CONFIRMATION_REQUIRED');
   const result=await withCuratorTransaction(pool,client=>apply(client,expected));
   console.log('F2_TAB_RESULT='+JSON.stringify(result));
  }
 }finally{await pool.end();}
}
if(process.argv[1]?.endsWith('taxonomy-f2-tab-retire-draft.js'))
 main().catch(e=>{const message=e instanceof Error?e.message:'';console.error(/^F2_TAB_[A-Z_]+$/.test(message)?message:'F2_TAB_BLOCK');process.exitCode=1;});
