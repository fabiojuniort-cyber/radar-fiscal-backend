import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {Kysely, PostgresDialect} from 'kysely';
import {Pool} from 'pg';

import type {DB} from '../src/infrastructure/database/database.types.js';
import {pruneCollectionItems} from '../src/modules/operations/collection-items-retention.js';

test('L-10: dry-run, 29/30/31-day cutoff, bounded batches, FK safety and idempotence',async()=>{
  const url=process.env.DATABASE_ADMIN_URL;
  assert.ok(url,'DATABASE_ADMIN_URL required: use isolated PostgreSQL test database');
  const db=new Kysely<DB>({dialect:new PostgresDialect({pool:new Pool({connectionString:url,max:1})})});
  const now=new Date('2026-10-10T15:00:00.000Z');
  const days=(n:number)=>new Date(now.getTime()-n*86_400_000);
  const sourceId=randomUUID(),runId=randomUUID(),attemptId=randomUUID();
  const ids=[randomUUID(),randomUUID(),randomUUID(),randomUUID()];
  try {
    await db.insertInto('sources').values({
      id:sourceId,code:'l10-'+sourceId,name:'L10 retention fixture',
      jurisdiction_level:'FEDERAL',base_url:'https://example.test',
      connector_key:'l10-fixture',
    }).execute();
    await db.insertInto('collection_runs').values({
      id:runId,source_id:sourceId,scheduled_for:days(35),trigger_type:'MANUAL',
      status:'SUCCESS',started_at:days(35),finished_at:days(35),
    }).execute();
    await db.insertInto('collection_attempts').values({
      id:attemptId,collection_run_id:runId,attempt_no:1,
      status:'SUCCESS',started_at:days(35),finished_at:days(35),
    }).execute();
    await db.insertInto('collection_items').values([
      {id:ids[0]!,collection_run_id:runId,first_attempt_id:attemptId,
        source_item_key:'older-31',status:'PROCESSED_EXISTING',created_at:days(31)},
      {id:ids[1]!,collection_run_id:runId,first_attempt_id:attemptId,
        source_item_key:'exact-30',status:'PROCESSED_NEW',created_at:days(30)},
      {id:ids[2]!,collection_run_id:runId,first_attempt_id:attemptId,
        source_item_key:'newer-29',status:'DISCOVERED',created_at:days(29)},
      {id:ids[3]!,collection_run_id:runId,first_attempt_id:attemptId,
        source_item_key:'older-32',status:'FAILED',created_at:days(32)},
    ]).execute();

    const dry=await pruneCollectionItems(db,{now,batchSize:1,maxBatches:1});
    assert.equal(dry.mode,'DRY_RUN');
    assert.equal(dry.candidateItems,1);
    assert.equal(dry.deletedItems,0);
    assert.equal(dry.remainingEligible,2);
    assert.equal(dry.stoppedByMaxBatches,true);
    assert.equal((await db.selectFrom('collection_items').select('id').where('collection_run_id','=',runId).execute()).length,4);

    const applied=await pruneCollectionItems(db,{now,apply:true,batchSize:1,maxBatches:2});
    assert.equal(applied.mode,'APPLY');
    assert.equal(applied.deletedItems,2);
    assert.equal(applied.remainingEligible,0);
    const remaining=await db.selectFrom('collection_items').select('id')
      .where('collection_run_id','=',runId).execute();
    assert.deepEqual(new Set(remaining.map(x=>x.id)),new Set([ids[1],ids[2]]));

    // Removing ephemeral collection_items must not remove operational evidence.
    assert.equal((await db.selectFrom('collection_runs').select('id').where('id','=',runId).execute()).length,1);
    assert.equal((await db.selectFrom('collection_attempts').select('id').where('id','=',attemptId).execute()).length,1);
    const again=await pruneCollectionItems(db,{now,apply:true,batchSize:2,maxBatches:2});
    assert.equal(again.deletedItems,0,'idempotent on rerun');
    assert.equal(again.remainingEligible,0);
    await assert.rejects(
      pruneCollectionItems(db,{now,batchSize:0}),RangeError);
    await assert.rejects(
      pruneCollectionItems(db,{now,maxBatches:-1}),RangeError);
  } finally {
    await db.deleteFrom('collection_items').where('collection_run_id','=',runId).execute();
    await db.deleteFrom('collection_attempts').where('collection_run_id','=',runId).execute();
    await db.deleteFrom('collection_runs').where('id','=',runId).execute();
    await db.deleteFrom('sources').where('id','=',sourceId).execute();
    await db.destroy();
  }
});
