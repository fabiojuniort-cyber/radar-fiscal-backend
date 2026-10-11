import { Client } from "pg";
// ACT-SCOPE-02 / issue 87. Real normal worker collection, no alternate engine.
const MODE="verify";

const RUN=Bun.env.ACT_SCOPE_02_VERIFY_RUN_ID||"";
if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(RUN)) throw Error("EXACT_RUN_ID_REQUIRED");
const POLICY="cada0d81-95bd-4d18-bd03-66067cc9893c";
const SOURCE="3ee07ee7-e492-48d3-98b3-7aee9cc29093";
const SLOT="2026-10-07T17:00:00.000Z";
const c=new Client({connectionString:Bun.env.DATABASE_ADMIN_URL});
await c.connect();
try {
 await c.query("BEGIN READ ONLY");
 await c.query("SET LOCAL statement_timeout='30s'");
 await c.query("SET LOCAL lock_timeout='5s'");
 const p=await c.query("SELECT id,version,revision,status FROM collection_filter_policies WHERE status='APPROVED' ORDER BY version DESC LIMIT 1");
 if(p.rows.length!==1||p.rows[0].id!==POLICY||p.rows[0].version!==1||p.rows[0].revision!==5||p.rows[0].status!=="APPROVED")throw Error("APPROVED_POLICY_DRIFT");
 const source=await c.query("SELECT id,code,connector_key,is_active,schedule_cron,schedule_timezone FROM sources WHERE id=$1",[SOURCE]);
 if(source.rows.length!==1||source.rows[0].code!=="dou"||source.rows[0].connector_key!=="dou"||!source.rows[0].is_active)throw Error("SOURCE_DRIFT");
 const run=await c.query("SELECT id,source_id,status,trigger_type,created_at,started_at,finished_at FROM collection_runs WHERE id=$1",[RUN]);
 const stats=await c.query("SELECT source_code,policy_id,policy_version,policy_revision,found_count,discard_count FROM collection_filter_discard_run_stats WHERE collection_run_id=$1",[RUN]);
 const items=await c.query("SELECT status,count(*)::int AS n,count(publication_id)::int AS publication_links FROM collection_items WHERE collection_run_id=$1 GROUP BY status ORDER BY status",[RUN]);
 const evidence=await c.query(`
 SELECT
  (SELECT count(*) FROM collection_items i JOIN publications p ON p.id=i.publication_id WHERE i.collection_run_id=$1 AND i.status IN ('PROCESSED_NEW','PROCESSED_EXISTING'))::int AS keep_persisted,
  (SELECT count(*) FROM collection_items i WHERE i.collection_run_id=$1 AND i.status='FILTERED_OUT' AND i.publication_id IS NOT NULL)::int AS filtered_publication_links,
  (SELECT count(*) FROM collection_filter_discards d WHERE d.collection_run_id=$1)::int AS discards,
  (SELECT count(*) FROM collection_filter_discards d WHERE d.collection_run_id=$1 AND d.policy_id=$2 AND d.policy_version=1 AND d.policy_revision=5 AND d.reason_code IS NOT NULL AND d.expires_at=d.discarded_at+interval '3 months')::int AS valid_discard_metadata,
  (SELECT count(*) FROM collection_filter_discards d WHERE d.collection_run_id=$1 AND NOT EXISTS(SELECT 1 FROM publication_origins o WHERE o.source_id=d.source_id AND o.external_id IS NOT NULL AND o.external_id=d.source_item_key))::int AS discard_absent_from_origins,
  (SELECT count(*) FROM collection_filter_discards WHERE source_code IN ('doe-sp','doe-sp-legado'))::int AS doe_sp_discards,
  (SELECT count(*) FROM collection_filter_discard_run_stats WHERE source_code IN ('doe-sp','doe-sp-legado'))::int AS doe_sp_stats,
  (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='collection_filter_discards' AND column_name ~ '(content|summary|body|text)')::int AS forbidden_content_columns,
  (SELECT count(*) FROM collection_filter_discards WHERE expires_at<=now())::int AS expired_remaining
 `,[RUN,POLICY]);
 const reasons=await c.query("SELECT reason_code,decisive_term,policy_version,policy_revision,count(*)::int AS n FROM collection_filter_discards WHERE collection_run_id=$1 GROUP BY reason_code,decisive_term,policy_version,policy_revision ORDER BY n DESC LIMIT 10",[RUN]);
 const e=evidence.rows[0]; const s=stats.rows[0]; const filtered=items.rows.find(i=>i.status==="FILTERED_OUT")?.n||0;
 const passed=run.rows[0]?.source_id===SOURCE && ["SUCCESS","PARTIAL_SUCCESS"].includes(run.rows[0]?.status)
  && stats.rows.length===1 && s.source_code==="dou" && s.policy_id===POLICY && s.policy_version===1 && s.policy_revision===5
  && e.keep_persisted>0 && e.discards>0 && e.filtered_publication_links===0
  && e.valid_discard_metadata===e.discards && e.discard_absent_from_origins===e.discards
  && e.doe_sp_discards===0 && e.doe_sp_stats===0 && e.forbidden_content_columns===0 && e.expired_remaining===0
  && Number(s.discard_count)===e.discards && filtered===e.discards;
 const attempts=await c.query("SELECT attempt_no,status,CASE WHEN error_code ~ '^[A-Z0-9_:-]+$' THEN error_code ELSE 'REDACTED_OR_NULL' END AS error_code,http_status,retryable,retry_after_seconds FROM collection_attempts WHERE collection_run_id=$1 ORDER BY attempt_no",[RUN]);
 const result={attempts:attempts.rows,result:passed?"PASS":"PENDING_OR_FAILED",mode:MODE,run:run.rows,stats:stats.rows,items:items.rows,evidence:evidence.rows,reasons:reasons.rows};
 if(!passed) process.exitCode=2;
 await c.query("ROLLBACK");
 console.log("ACT_SCOPE_02_SMOKE="+JSON.stringify(result));
}catch(e){await c.query("ROLLBACK").catch(()=>{});console.error("ACT_SCOPE_02_SMOKE_REFUSED="+(/^[A-Z_]+$/.test(e?.message||"")?e.message:"OPERATION_FAILED"));process.exitCode=1}finally{await c.end()}
