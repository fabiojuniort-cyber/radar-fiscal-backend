import 'dotenv/config';
import {Pool,type PoolClient} from 'pg';
import {resolveCuratorDatabaseUrl} from './curator-url.js';
import {assertCuratorSession,withCuratorTransaction} from '../../modules/taxonomy/curation/curation.draft.js';
import {readF2Stage,buildF2DraftPlan} from '../../modules/taxonomy/curation/curation.f2-draft-import.js';
import {loadReleaseView,pgRunner} from '../../modules/taxonomy/curation/curation.read.js';
import {
 F2_GROUP_REPAIR_DRAFT_ID,buildF2GroupRepairPlan,applyF2GroupRepair,
} from '../../modules/taxonomy/curation/curation.f2-group-repair.js';

function abort(code:string):never{throw new Error(code);}
function parse(args:string[]){
 const entries=new Map<string,string>();
 for(const arg of args){
   const m=/^--(mode|confirm-draft-id|confirm-plan-sha256)=([^\s]+)$/.exec(arg);
   if(!m||entries.has(m[1]!))abort('F2_GROUP_INVALID_ARGUMENT');
   entries.set(m[1]!,m[2]!);
 }
 const mode=entries.get('mode');
 if(mode!=='plan'&&mode!=='apply')abort('F2_GROUP_EXPLICIT_MODE_REQUIRED');
 if(mode==='apply'&&(entries.get('confirm-draft-id')!==F2_GROUP_REPAIR_DRAFT_ID||
     !/^[0-9a-f]{64}$/.test(entries.get('confirm-plan-sha256')??'')))
   abort('F2_GROUP_CONFIRMATION_REQUIRED');
 return {mode,confirmSha:entries.get('confirm-plan-sha256')??''};
}
async function historical(client:PoolClient){
 const q=await client.query<{published:number;automatic:number;manual:number}>(`
 SELECT
  (SELECT count(*)::int FROM taxonomy_release_concepts rc
   JOIN taxonomy_releases r ON r.id=rc.release_id WHERE r.status='PUBLISHED') AS published,
  (SELECT count(*)::int FROM publication_taxonomy_assertions) AS automatic,
  (SELECT count(*)::int FROM publication_taxonomy_curator_tags) AS manual`);
 return q.rows[0]!;
}
async function snapshot(client:PoolClient){
 const batch=buildF2DraftPlan(await readF2Stage(client));
 const view=await loadReleaseView(pgRunner(client),F2_GROUP_REPAIR_DRAFT_ID,{includeRetired:true});
 if(!view)abort('F2_GROUP_DRAFT_MISSING');
 return buildF2GroupRepairPlan({draftId:F2_GROUP_REPAIR_DRAFT_ID,plan:batch,view});
}
function preview(p:Awaited<ReturnType<typeof snapshot>>){
 return {
  draftId:p.draftId,lotBatchId:p.lotBatchId,contentSha256:p.contentSha256,
  published:false,stats:p.stats,unresolvedCount:p.unresolved.length,
  unresolvedExamples:p.unresolved.slice(0,10),
  slugCollisionExamples:p.targets.filter(t=>t.collision).slice(0,10)
   .map(t=>({groupCode:t.groupCode,label:t.label})),
  planSha256:p.planSha256,
 };
}
async function run(){
 const opts=parse(process.argv.slice(2));
 const url=resolveCuratorDatabaseUrl({
  DATABASE_URL:process.env.DATABASE_URL??'',DATABASE_CURATOR_URL:process.env.DATABASE_CURATOR_URL,
  DB_CURATOR_RUNTIME_PASSWORD:process.env.DB_CURATOR_RUNTIME_PASSWORD});
 if(!url)abort('F2_GROUP_CURATOR_CONNECTION_REQUIRED');
 const pool=new Pool({connectionString:url,max:1,connectionTimeoutMillis:10000});
 try{
   if(opts.mode==='plan'){
     const client=await pool.connect();let tx=false;
     try{
       await assertCuratorSession(client);
       await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');tx=true;
       await client.query('SET LOCAL ROLE radar_taxonomy_curator');
       const plan=await snapshot(client);
       await client.query('COMMIT');tx=false;
       console.log('F2_GROUP_REPAIR_PLAN='+JSON.stringify(preview(plan)));
     }finally{if(tx)await client.query('ROLLBACK').catch(()=>{});client.release();}
     return;
   }
   const result=await withCuratorTransaction(pool,async client=>{
     const original=await snapshot(client);
     if(original.planSha256!==opts.confirmSha)abort('F2_GROUP_PLAN_CHANGED');
     const before=await historical(client);
     const changes=await applyF2GroupRepair(client,
       {userId:'ops:f2-tab-02',justification:'Correção aprovada de grupos F2 no rascunho, sem publicação'},
       original,opts.confirmSha);
     const after=await snapshot(client);
     const history=await historical(client);
     if(JSON.stringify(before)!==JSON.stringify(history))abort('F2_GROUP_HISTORIC_CHANGED');
     if(after.unresolved.length||after.stats.newGroups||after.stats.changedConceptLinks||
        after.stats.missingSegmentLinks)abort('F2_GROUP_READBACK_FAILED');
     return {...changes,readback:'PASS',historicalPreserved:true,
       after:preview(after)};
   });
   console.log('F2_GROUP_REPAIR_RESULT='+JSON.stringify(result));
 }finally{await pool.end();}
}
run().catch(e=>{
 const msg=e instanceof Error?e.message:'';
 console.error(/^F2_GROUP_[A-Z_]+$/.test(msg)?msg:'F2_GROUP_BLOCK');
 process.exitCode=1;
});
