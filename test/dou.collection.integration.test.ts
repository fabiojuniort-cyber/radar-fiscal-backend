import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { DB } from '../src/infrastructure/database/database.types.js';
import { createCollectionRun, acquireNextCollectionRun } from '../src/modules/collection/collection-run.repository.js';
import { processAcquiredCollectionRun } from '../src/modules/collection/collection.engine.js';
import { ConnectorRegistry } from '../src/modules/collection/connector.registry.js';
import { DouConnector } from '../src/modules/collection/dou.connector.js';
import { readDouSourceState } from '../src/modules/collection/dou-source-state.repository.js';
import { runSchedulerTick } from '../src/modules/collection/scheduler.service.js';
import { fixtureFetch } from './dou.fixtures.js';
import { getSourceOperationalSnapshot } from '../src/modules/collection/collection-monitoring.repository.js';

test('real INLABS XML through scheduler, worker engine, PostgreSQL origins, versions and receipts', async (t) => {
  assert.ok(process.env.DATABASE_ADMIN_URL, 'DATABASE_ADMIN_URL is required');
  const pool = new Pool({connectionString:process.env.DATABASE_ADMIN_URL,max:4});
  const db = new Kysely<DB>({dialect:new PostgresDialect({pool})});
  const sourceId = randomUUID();
  let sequence = 0;
  let fetch = await fixtureFetch();
  let useCheckpoint = false;
  let conflict = false;
  const registry = new ConnectorRegistry();
  registry.register({key:'dou',version:'integration',collect:async context=>{const result = await new DouConnector({
    credentials:()=>({email:'test@example.invalid',password:'fixture'}), fetch,
    dates:['2026-09-18'],now:()=>new Date('2026-09-21T12:00:00Z'),
    ...(useCheckpoint ? {readState:(source:string,run:string)=>readDouSourceState(db,source,run)} : {}),
  }).collect(context);
    if(conflict) {const p=result.publications.find(p=>p.actNumber==='119/2026')!;p.actNumber='999999/2026';}
    return result;
  }});
  async function newRun() {
    return createCollectionRun(db,{sourceId,scheduledFor:new Date(Date.now()-60_000+sequence++),triggerType:'MANUAL'});
  }
  async function acquire(runId:string) {
    const acquired = await acquireNextCollectionRun(db,'dou-integration-worker');
    assert.ok(acquired); assert.equal(acquired.id,runId); return acquired;
  }
  async function run(runId?:string) {
    return processAcquiredCollectionRun(db,registry,await acquire(runId ?? await newRun()),{timeoutMs:5000,heartbeatIntervalMs:0});
  }
  try {
    await db.insertInto('sources').values({id:sourceId,code:`dou-${sourceId}`,name:'DOU integration',jurisdiction_level:'FEDERAL',base_url:'https://inlabs.in.gov.br',connector_key:'dou',max_attempts:1}).execute();
    await t.test('ten real matters persist, including three distinct dispatches sharing one certified page',async()=>{
      const first = await run(); assert.equal(first.status,'SUCCESS'); assert.equal(first.metrics.newPublications,10);
      const dispatches = await db.selectFrom('publication_origins').select(['publication_id','official_url','external_id']).where('source_id','=',sourceId).where('external_id','like','2026-09-18:DO1E:177-A:%').execute();
      assert.equal(dispatches.length,3); assert.equal(new Set(dispatches.map(p=>p.publication_id)).size,3);
      assert.equal(new Set(dispatches.map(p=>p.official_url)).size,1);
      const snapshot = await getSourceOperationalSnapshot(db,sourceId);
      assert.equal(snapshot.operationalState,'OPERATIONAL');
      assert.equal(snapshot.dou?.xmlCount,12); assert.equal(snapshot.dou?.assembledMatterCount,10);
      assert.equal(snapshot.dou?.confazMatterCount,0); assert.equal(snapshot.dou?.editions.length,4);
    });
    await t.test('replay is idempotent and one edited body creates exactly one version',async()=>{
      const replay = await run(); assert.equal(replay.status,'SUCCESS'); assert.equal(replay.metrics.existingPublications,10);
      fetch = await fixtureFetch(true);
      const edited = await run(); assert.equal(edited.status,'SUCCESS'); assert.equal(edited.metrics.newVersions,1); assert.equal(edited.metrics.existingPublications,9);
      const rows = await db.selectFrom('publication_versions as pv').innerJoin('publication_origins as po','po.publication_id','pv.publication_id').select(['pv.version_no','pv.is_current']).where('po.source_id','=',sourceId).execute();
      assert.equal(rows.length,11); assert.equal(rows.filter(r=>r.is_current).length,10);
    });
    await t.test('PAGE requires external ID; document URL uniqueness remains enforced',async()=>{
      const origin = await db.selectFrom('publication_origins').selectAll().where('source_id','=',sourceId).executeTakeFirstOrThrow();
      await assert.rejects(db.insertInto('publication_origins').values({source_id:sourceId,publication_id:origin.publication_id,official_url:origin.official_url,metadata:{officialUrlGranularity:'PAGE'}}).execute(),(e:any)=>e.code==='23514');
      const document = {source_id:sourceId,publication_id:origin.publication_id,official_url:'https://in.gov.br/test-document',metadata:{}};
      await db.insertInto('publication_origins').values({...document,external_id:'document-1'}).execute();
      await assert.rejects(db.insertInto('publication_origins').values({...document,external_id:'document-2'}).execute(),(e:any)=>e.code==='23505');
      await db.deleteFrom('publication_origins').where('source_id','=',sourceId).where('external_id','=','document-1').execute();
    });
    await t.test('same PAGE external ID cannot migrate to another normative identity',async()=>{
      conflict=true;
      const result=await run();
      assert.equal(result.status,'PARTIAL_SUCCESS'); assert.equal(result.metrics.itemErrors,1);
      const count=await db.selectFrom('publication_origins').select('id').where('source_id','=',sourceId).execute();
      assert.equal(count.length,10); conflict=false;
    });
    await t.test('scheduler is idempotent and completed run receipts avoid reprocessing',async()=>{
      useCheckpoint = true;
      // This legacy checkpoint scenario tests scheduler idempotency, not overlap.
      // Start it from a clean run queue; overlap behavior has its own regression test.
      await db.deleteFrom('collection_runs')
        .where('source_id','=',sourceId)
        .where('status','in',['PENDING','RUNNING'])
        .execute();
      await db.updateTable('sources').set({schedule_cron:'* * * * *',schedule_timezone:'America/Sao_Paulo'}).where('id','=',sourceId).execute();
      const now = new Date(); const first = await runSchedulerTick(db,now); const second = await runSchedulerTick(db,now);
      assert.equal(first.runIds.length,1); assert.deepEqual(second.runIds,first.runIds);
      const result = await run(first.runIds[0]); assert.equal(result.status,'SUCCESS_NO_RESULTS'); assert.equal(result.metrics.found,0);
      await db.updateTable('sources').set({schedule_cron:null}).where('id','=',sourceId).execute();
    });
    await t.test('checkpoint reload retains receipts for all six DOU variants',async()=>{
      const checkpointRun = await newRun();
      await db.updateTable('collection_runs')
        .set({status:'SUCCESS',finished_at:new Date(Date.now()+60_000)})
        .where('id','=',checkpointRun)
        .execute();
      const archives = Object.fromEntries(
        ['DO1','DO1E','DO2','DO2E','DO3','DO3E'].map((section,index)=>[
          `2026-09-18-${section}.zip`,
          String(index+1).repeat(64),
        ]),
      );
      await db.insertInto('collection_attempts').values({
        collection_run_id:checkpointRun,
        attempt_no:1,
        status:'SUCCESS',
        metadata:{douArchives:archives},
      }).execute();
      const current = await newRun();
      assert.deepEqual(
        (await readDouSourceState(db,sourceId,current)).archives,
        archives,
      );
      await db.deleteFrom('collection_runs')
        .where('id','in',[current,checkpointRun])
        .execute();
    });
    await t.test('attempt success in partial/failed/running runs cannot advance receipts; backfill is explicit',async()=>{
      const current = await newRun(); const before = await readDouSourceState(db,sourceId,current);
      assert.equal(Object.keys(before.archives).length,2);
      for (const status of ['PARTIAL_SUCCESS','PROCESSING_FAILED','RUNNING'] as const) {
        const bad = await newRun();
        await db.updateTable('collection_runs').set({status,finished_at:new Date()}).where('id','=',bad).execute();
        await db.insertInto('collection_attempts').values({collection_run_id:bad,attempt_no:1,status:'SUCCESS',metadata:{douArchives:{'2026-09-18-DO1.zip':'f'.repeat(64)}}}).execute();
        assert.deepEqual((await readDouSourceState(db,sourceId,current)).archives,before.archives);
        await db.deleteFrom('collection_runs').where('id','=',bad).execute();
      }
      await db.deleteFrom('collection_runs').where('id','=',current).execute();
      const backfill = await createCollectionRun(db,{sourceId,scheduledFor:new Date(),triggerType:'BACKFILL'});
      await assert.rejects(readDouSourceState(db,sourceId,backfill),{code:'DOU_BACKFILL_DATE_BATCH_REQUIRED'});
      await db.deleteFrom('collection_runs').where('id','=',backfill).execute();
    });
    await t.test('heartbeat continues while publication persistence waits on a database lock',async()=>{
      useCheckpoint = false;
      const runId = await newRun(); const acquired = await acquire(runId);
      const blocker = await pool.connect(); let processing:ReturnType<typeof processAcquiredCollectionRun>|undefined;
      try {
        await blocker.query('BEGIN'); await blocker.query('LOCK TABLE publication_origins IN ACCESS EXCLUSIVE MODE');
        processing = processAcquiredCollectionRun(db,registry,acquired,{timeoutMs:5000,heartbeatIntervalMs:20});
        let blocked = false;
        for(let i=0;i<50;i++) {
          const result = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%publication_origins%'");
          if(result.rowCount) {blocked=true;break;} await delay(20);
        }
        assert.ok(blocked,'persistence must actually reach the locked origins table');
        const before = await db.selectFrom('collection_runs').select('heartbeat_at').where('id','=',runId).executeTakeFirstOrThrow();
        let advanced = false;
        for(let i=0;i<50;i++) {
          await delay(20);
          const after = await db.selectFrom('collection_runs').select('heartbeat_at').where('id','=',runId).executeTakeFirstOrThrow();
          if(after.heartbeat_at && before.heartbeat_at && after.heartbeat_at>before.heartbeat_at) {advanced=true;break;}
        }
        assert.ok(advanced,'heartbeat must advance after connector completion, during persistence');
      } finally {await blocker.query('ROLLBACK');blocker.release(); if(processing) assert.equal((await processing).status,'SUCCESS');}
    });
  } finally {
    const ids = [...new Set((await db.selectFrom('publication_origins').select('publication_id').where('source_id','=',sourceId).execute()).map(r=>r.publication_id))];
    await db.deleteFrom('collection_runs').where('source_id','=',sourceId).execute();
    await db.deleteFrom('publication_origins').where('source_id','=',sourceId).execute();
    if(ids.length) await db.deleteFrom('publications').where('id','in',ids).execute();
    await db.deleteFrom('sources').where('id','=',sourceId).execute(); await db.destroy();
  }
});
