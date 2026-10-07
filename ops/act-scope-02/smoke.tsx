import { Client } from "pg";
// ACT-SCOPE-02 / issue 87. Real normal worker collection, no alternate engine.
const MODE=Bun.env.ACT_SCOPE_02_MODE||"verify";
if(!["preflight","enqueue","verify"].includes(MODE)) throw Error("MODE_REFUSED");
const RUN="dca14937-8c41-477e-91f1-9b99f091692e";
const POLICY="cada0d81-95bd-4d18-bd03-66067cc9893c";
const SOURCE="3ee07ee7-e492-48d3-98b3-7aee9cc29093";
const c=new Client({connectionString:Bun.env.DATABASE_ADMIN_URL});
await c.connect();
try {
 await c.query(MODE==="enqueue"?"BEGIN":"BEGIN READ ONLY");
 await c.query("SET LOCAL statement_timeout='30s'");
 await c.query("SET LOCAL lock_timeout='5s'");
 const p=await c.query("SELECT id,version,revision,status FROM collection_filter_policies WHERE id=$1",[POLICY]);
 if(p.rows.length!==1||p.rows[0].version!==1||p.rows[0].revision!==5||p.rows[0].status!=="APPROVED")throw Error("APPROVED_POLICY_DRIFT");
 const source=await c.query("SELECT id,code,connector_key,is_active FROM sources WHERE id=$1",[SOURCE]);
 if(source.rows.length!==1||source.rows[0].code!=="dou"||source.rows[0].connector_key!=="dou"||!source.rows[0].is_active)throw Error("SOURCE_DRIFT");
 if(MODE==="enqueue") {
   // Match createCollectionRun semantics; serialize with scheduler inserts.
   // No source/config/checkpoint/policy/worker changes and exactly one known run.
   await c.query("LOCK TABLE collection_runs IN SHARE ROW EXCLUSIVE MODE");
   const existing=await c.query("SELECT id,source_id,trigger_type FROM collection_runs WHERE id=$1",[RUN]);
   if(existing.rows.length) {
     if(existing.rows[0].source_id!==SOURCE||existing.rows[0].trigger_type!=="MANUAL")throw Error("RUN_ID_CONFLICT");
   } else {
     const active=await c.query("SELECT count(*)::int AS n FROM collection_runs WHERE source_id=$1 AND status IN ('PENDING','RUNNING')",[SOURCE]);
     if(active.rows[0].n!==0)throw Error("SOURCE_HAS_ACTIVE_RUN");
     await c.query("INSERT INTO collection_runs(id,source_id,scheduled_for,trigger_type,status) VALUES($1,$2,now(),'MANUAL','PENDING')",[RUN,SOURCE]);
   }
 }
 const run=await c.query("SELECT id,status,trigger_type,created_at,started_at,finished_at FROM collection_runs WHERE id=$1",[RUN]);
 const stats=await c.query("SELECT source_code,policy_id,policy_version,policy_revision,found_count,discard_count FROM collection_filter_discard_run_stats WHERE collection_run_id=$1",[RUN]);
 const items=await c.query("SELECT status,count(*)::int AS n,count(publication_id)::int AS publication_links FROM collection_items WHERE collection_run_id=$1 GROUP BY status ORDER BY status",[RUN]);
 const evidence=await c.query(`
 SELECT
  (SELECT count(*) FROM collection_items i JOIN publications p ON p.id=i.publication_id WHERE i.collection_run_id=$1 AND i.status IN ('PROCESSED_NEW','PROCESSED_EXISTING'))::int AS keep_persisted,
  (SELECT count(*) FROM collection_items i WHERE i.collection_run_id=$1 AND i.status='FILTERED_OUT' AND i.publication_id IS NOT NULL)::int AS filtered_publication_links,
  (SELECT count(*) FROM collection_filter_discards d WHERE d.collection_run_id=$1)::int AS discards,
  (SELECT count(*) FROM collection_filter_discards d WHERE d.collection_run_id=$1 AND d.policy_id=$2 AND d.policy_version=1 AND d.policy_revision=5 AND d.reason_code IS NOT NULL AND d.expires_at=d.discarded_at+interval '3 months')::int AS valid_discard_metadata,
  (SELECT count(*) FROM collection_filter_discards d WHERE d.collection_run_id=$1 AND NOT EXISTS(SELECT 1 FROM publication_origins o WHERE o.source_id=d.source_id AND o.external_id IS NOT NULL AND o.external_id=d.source_item_key) AND NOT EXISTS(SELECT 1 FROM publication_origins o WHERE o.official_url=d.official_url))::int AS discard_absent_from_origins,
  (SELECT count(*) FROM collection_filter_discards WHERE source_code IN ('doe-sp','doe-sp-legado'))::int AS doe_sp_discards,
  (SELECT count(*) FROM collection_filter_discard_run_stats WHERE source_code IN ('doe-sp','doe-sp-legado'))::int AS doe_sp_stats,
  (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='collection_filter_discards' AND column_name ~ '(content|summary|body|text)')::int AS forbidden_content_columns,
  (SELECT count(*) FROM collection_filter_discards WHERE expires_at<=now())::int AS expired_remaining
 `,[RUN,POLICY]);
 const reasons=await c.query("SELECT reason_code,decisive_term,policy_version,policy_revision,count(*)::int AS n FROM collection_filter_discards WHERE collection_run_id=$1 GROUP BY reason_code,decisive_term,policy_version,policy_revision ORDER BY n DESC LIMIT 10",[RUN]);
 const result={mode:MODE,run:run.rows,stats:stats.rows,items:items.rows,evidence:evidence.rows,reasons:reasons.rows};
 await c.query(MODE==="enqueue"?"COMMIT":"ROLLBACK");
 console.log("ACT_SCOPE_02_SMOKE="+JSON.stringify(result));
}catch(e){await c.query("ROLLBACK").catch(()=>{});console.error("ACT_SCOPE_02_SMOKE_REFUSED="+String(e?.message||e));process.exitCode=1}finally{await c.end()}
