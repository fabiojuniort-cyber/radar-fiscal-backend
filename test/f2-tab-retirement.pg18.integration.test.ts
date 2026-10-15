import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {Pool} from 'pg';
import {F2_TAB_DRAFT_ID,retireDraftMemberships} from '../src/infrastructure/database/taxonomy-f2-tab-retire-draft.js';

test('F2-TAB-01 isolated PostgreSQL18: 5 retirements are reversible, idempotent and preserve published release + tag rows',async()=>{
 if(!process.env.DATABASE_ADMIN_URL)throw Error('isolated DATABASE_ADMIN_URL required');
 const pool=new Pool({connectionString:process.env.DATABASE_ADMIN_URL,max:1});
 const db=await pool.connect();
 try {
  await db.query('BEGIN');
  const version=await db.query<{version:string}>('SHOW server_version');
  assert.match(version.rows[0]!.version,/^18\./);
  const prior=await db.query<{n:number}>(`SELECT count(*)::int n FROM taxonomy_releases WHERE version='v1.6.0'`);
  assert.equal(prior.rows[0]!.n,0,'PG18 fixture must not reuse a real v1.6.0');
  const published=await db.query<{id:string}>(`
   INSERT INTO taxonomy_releases(version_major,version_minor,version_patch,status,
     approved_at,published_at,artifact_repository,artifact_path,artifact_git_sha,artifact_sha256,
     created_by_actor)
   VALUES(1,6,0,'PUBLISHED',now(),now(),'isolated-pg18','f2-tab-fixture',
     $1,$2,'f2-tab-test') RETURNING id`,['a'.repeat(40),'b'.repeat(64)]);
  const publishedId=published.rows[0]!.id;
  await db.query(`INSERT INTO taxonomy_releases(id,version_major,version_minor,version_patch,
   status,previous_release_id,created_by_actor)
   VALUES($1::uuid,1,7,0,'DRAFT',$2::uuid,'f2-tab-test')`,[F2_TAB_DRAFT_ID,publishedId]);
  let taggedReleaseConceptId='';
  for(const code of ['treatment','act_type','platform','tax_species','sphere']){
   const dim=await db.query<{id:string}>(`
    INSERT INTO taxonomy_dimensions(code) VALUES($1)
    ON CONFLICT(code) DO UPDATE SET code=EXCLUDED.code RETURNING id`,[code]);
   const dimId=dim.rows[0]!.id;
   const revision=await db.query<{id:string}>(`
    INSERT INTO taxonomy_dimension_revisions(dimension_id,revision_no,name)
    SELECT $1::uuid,COALESCE(max(revision_no),0)+1,$2
    FROM taxonomy_dimension_revisions WHERE dimension_id=$1::uuid RETURNING id`,[dimId,code]);
   const revId=revision.rows[0]!.id;
   const concept=await db.query<{id:string}>(`
    INSERT INTO taxonomy_concepts(code,dimension_id) VALUES($1,$2::uuid)
    RETURNING id`,[code+'.f2_tab_test',dimId]);
   const conceptId=concept.rows[0]!.id;
   const cr=await db.query<{id:string}>(`
    INSERT INTO taxonomy_concept_revisions(concept_id,revision_no,label,definition)
    VALUES($1::uuid,1,$2,$2) RETURNING id`,[conceptId,code]);
   for(const id of [publishedId,F2_TAB_DRAFT_ID]){
    await db.query(`
     INSERT INTO taxonomy_release_dimensions(release_id,dimension_id,dimension_revision_id)
     VALUES($1::uuid,$2::uuid,$3::uuid)`,[id,dimId,revId]);
    const rc=await db.query<{id:string}>(`
     INSERT INTO taxonomy_release_concepts(release_id,concept_id,concept_revision_id)
     VALUES($1::uuid,$2::uuid,$3::uuid) RETURNING id`,[id,conceptId,cr.rows[0]!.id]);
    if(id===publishedId&&code==='treatment')taggedReleaseConceptId=rc.rows[0]!.id;
   }
  }
  await db.query(`
    INSERT INTO publication_taxonomy_curator_tags(publication_version_id,taxonomy_release_id,
    release_concept_id,action,actor_id,rationale)
    VALUES($1::uuid,$2::uuid,$3::uuid,'ADD','f2-tab-test','historical proof')`,
   [randomUUID(),publishedId,taggedReleaseConceptId]);

  async function readback(){
   const release=await db.query<{status:string;n:number}>(`
    SELECT r.status,count(rc.id)::int n
    FROM taxonomy_releases r JOIN taxonomy_release_concepts rc ON rc.release_id=r.id
    WHERE r.id=$1::uuid GROUP BY r.status`,[publishedId]);
   const history=await db.query<{manual:number;automatic:number}>(`
    SELECT (SELECT count(*)::int FROM publication_taxonomy_curator_tags) manual,
           (SELECT count(*)::int FROM publication_taxonomy_assertions) automatic`);
   const statuses=await db.query<{code:string;membership_status:string;included:number}>(`
    SELECT d.code,rd.membership_status,
     (SELECT count(*)::int FROM taxonomy_release_concepts rc
      JOIN taxonomy_concepts c ON c.id=rc.concept_id
      WHERE rc.release_id=rd.release_id AND c.dimension_id=d.id
        AND rc.membership_status='INCLUDED') included
    FROM taxonomy_release_dimensions rd
    JOIN taxonomy_dimensions d ON d.id=rd.dimension_id
    WHERE rd.release_id=$1::uuid ORDER BY d.code`,[F2_TAB_DRAFT_ID]);
   return {published:release.rows,history:history.rows[0],statuses:statuses.rows};
  }
  const before=await readback();
  const first=await retireDraftMemberships(db,F2_TAB_DRAFT_ID);
  assert.equal(first.dimensionsRetired,5);
  assert.equal(first.conceptsRetired,5);
  const after=await readback();
  assert.deepEqual(after.published,before.published);
  assert.deepEqual(after.history,before.history);
  assert.equal(after.statuses.length,5);
  assert.ok(after.statuses.every(x=>x.membership_status==='RETIRED'&&x.included===0));
  const second=await retireDraftMemberships(db,F2_TAB_DRAFT_ID);
  assert.deepEqual(second,{conceptsRetired:0,dimensionsRetired:0});
  assert.deepEqual(await readback(),after);
  await db.query('ROLLBACK'); // no fixture survives CI; production untouched
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}
 finally{db.release();await pool.end();}
});
