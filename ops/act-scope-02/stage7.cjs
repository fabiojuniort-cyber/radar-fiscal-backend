'use strict';
// Versioned ACT-SCOPE-02 operator artifact. No canonical writes or DELETE.
const { Client } = require('pg');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const POLICY = 'cada0d81-95bd-4d18-bd03-66067cc9893c';
const SIM = '2dfb162f-5901-4170-addd-f25627bd7da0';
const KEY = 'ACT_SCOPE_02_HISTORICAL_V1R5';
const sha = x => createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
const refuse = code => { throw Error(code); };
const mode = process.env.MODE || 'prepare';
const local = process.env.TARGET === 'isolated';
const dir = local ? '/data/act-scope-02/stage7-rehearsal' : '/data/act-scope-02/stage7';
const manifestFile = path.join(dir, 'manifest.json');
const c = new Client(local ? {host:process.env.LOCAL_SOCKET,port:5439,user:'postgres',database:'scope_restore_test'} : {connectionString:process.env.PROD_DATABASE_ADMIN_URL});
const log = (kind, value) => console.log('ACT_SCOPE_02_STAGE7_' + kind + '=' + JSON.stringify(value));
const uuid = (purpose, digest, id) => {
  const h = sha(KEY + ':' + purpose + ':' + digest + ':' + id);
  const variant = ((parseInt(h.slice(16,18),16)&63)|128).toString(16);
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-${variant}${h.slice(18,20)}-${h.slice(20,32)}`;
};
async function transaction(fn, readonly=false) {
  await c.query(readonly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
  try { await c.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='120s'"); const r=await fn(); await c.query('COMMIT'); return r; }
  catch(e) { await c.query('ROLLBACK').catch(()=>{}); throw e; }
}
async function guard() {
  const p=(await c.query("SELECT id,version,revision FROM collection_filter_policies WHERE status='APPROVED' ORDER BY version DESC LIMIT 1")).rows[0];
  if(p?.id!==POLICY||p.version!==1||p.revision!==5) refuse('POLICY_DRIFT');
  const s=(await c.query("SELECT policy_id,policy_revision,status,scope,snapshot_at,processed_count FROM collection_filter_simulations WHERE id=$1",[SIM])).rows[0];
  if(s?.policy_id!==POLICY||s.policy_revision!==5||s.status!=='COMPLETED'||s.scope!=='FULL_ARCHIVE'||Number(s.processed_count)!==99498||!s.snapshot_at) refuse('SIMULATION_DRIFT');
  if((await c.query('SELECT count(*)::int AS n FROM collection_filter_simulation_feedback WHERE simulation_id=$1 AND marked_error',[SIM])).rows[0].n) refuse('SIMULATION_MARKED_ERRORS');
  return s;
}
// Conservative material stability check, not a second filtering engine.
// The simulation did not retain a body/version hash. Any post-snapshot update,
// changed descriptor, version or origin is excluded rather than assumed safe.
const candidateSql = `SELECT i.publication_id AS id,i.reason_code AS reason,st.current_event_id AS expected,
 COALESCE(st.scope,'IN_SCOPE') AS scope,
 (i.source_code='dou' AND NOT p.is_hidden AND p.updated_at <= s.snapshot_at
 AND p.title IS NOT DISTINCT FROM i.title AND p.published_on IS NOT DISTINCT FROM i.published_on
 AND p.primary_official_url IS NOT DISTINCT FROM i.official_url
 AND EXISTS(SELECT 1 FROM publication_origins o JOIN sources src ON src.id=o.source_id WHERE o.publication_id=p.id AND src.code='dou')
 AND NOT EXISTS(SELECT 1 FROM publication_origins o JOIN sources src ON src.id=o.source_id WHERE o.publication_id=p.id AND (src.code<>'dou' OR o.last_seen_at>s.snapshot_at OR o.first_seen_at>s.snapshot_at))
 AND EXISTS(SELECT 1 FROM publication_versions v WHERE v.publication_id=p.id AND v.is_current AND v.captured_at<=s.snapshot_at)
 AND NOT EXISTS(SELECT 1 FROM publication_versions v WHERE v.publication_id=p.id AND v.captured_at>s.snapshot_at)
 AND NOT EXISTS(SELECT 1 FROM publication_files f JOIN publication_versions v ON v.id=f.publication_version_id WHERE v.publication_id=p.id)) AS stable,
 md5(row_to_json(p)::text) AS p_hash,
 (SELECT md5(COALESCE(string_agg(md5(row_to_json(v)::text),'|' ORDER BY v.id),'')) FROM publication_versions v WHERE v.publication_id=p.id) AS v_hash,
 (SELECT md5(COALESCE(string_agg(md5(row_to_json(o)::text),'|' ORDER BY o.id),'')) FROM publication_origins o WHERE o.publication_id=p.id) AS o_hash
 FROM collection_filter_simulation_items i JOIN collection_filter_simulations s ON s.id=i.simulation_id
 JOIN publications p ON p.id=i.publication_id LEFT JOIN publication_scope_state st ON st.publication_id=p.id
 WHERE i.simulation_id=$1 AND i.decision='DISCARD' AND ($2::uuid[] IS NULL OR p.id=ANY($2::uuid[])) ORDER BY p.id`;
const fingerprint = r => sha([r.id,r.reason,r.p_hash,r.v_hash,r.o_hash]);
async function baseline(ids) {
  return (await c.query(`SELECT
  (SELECT md5(COALESCE(string_agg(row_to_json(s)::text,'|' ORDER BY s.publication_id),'')) FROM publication_scope_state s WHERE NOT s.publication_id=ANY($1::uuid[])) AS outside_hash,
  (SELECT count(*)::int FROM publications WHERE id=ANY($1::uuid[])) AS publications,
  (SELECT count(*)::int FROM publication_versions WHERE publication_id=ANY($1::uuid[])) AS versions,
  (SELECT count(*)::int FROM publication_origins WHERE publication_id=ANY($1::uuid[])) AS origins,
  (SELECT count(*)::int FROM publication_files f JOIN publication_versions v ON v.id=f.publication_version_id WHERE v.publication_id=ANY($1::uuid[])) AS files,
  (SELECT md5(COALESCE(string_agg(row_to_json(f)::text,'|' ORDER BY f.publication_id,f.source_code),'')) FROM publication_source_feed f WHERE f.publication_id=ANY($1::uuid[])) AS feed_hash,
  (SELECT count(*)::int FROM publication_source_feed WHERE publication_id=ANY($1::uuid[])) AS feed,
  (SELECT count(*)::int FROM publication_scope_state WHERE scope='OUT_OF_SCOPE') AS global_out,
  publication_scope_epoch()::text AS epoch`,[ids])).rows[0];
}
async function normalVisibility(ids) {
  return transaction(async()=>{
    await c.query('SET LOCAL ROLE radar_app');
    return (await c.query('SELECT count(*)::int AS n FROM publications WHERE id=ANY($1::uuid[])',[ids])).rows[0].n;
  },true);
}
async function prepare() {
  const m = await transaction(async()=>{
    const s=await guard(); const rows=(await c.query(candidateSql,[SIM,null])).rows;
    if(rows.length!==73924) refuse('DISCARD_SET_DRIFT');
    const eligible=rows.filter(r=>r.scope==='IN_SCOPE'&&r.stable);
    if(!eligible.length) refuse('NO_STABLE_CANDIDATES');
    const candidates=eligible.map(r=>({id:r.id,reason:r.reason,expected:r.expected,evidence:fingerprint(r)}));
    const core={policy:POLICY,simulation:SIM,snapshot:s.snapshot_at.toISOString(),candidates};
    return {...core,digest:sha(core),baseline:await baseline(candidates.map(r=>r.id)),counts:{simDiscard:rows.length,alreadyOut:rows.filter(r=>r.scope==='OUT_OF_SCOPE').length,stableIn:eligible.length,driftedIn:rows.filter(r=>r.scope==='IN_SCOPE'&&!r.stable).length}};
  },true);
  if(await normalVisibility(m.candidates.map(r=>r.id))!==m.candidates.length) refuse('BASELINE_NORMAL_VISIBILITY');
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  if(fs.existsSync(manifestFile)) refuse('MANIFEST_ALREADY_EXISTS');
  fs.writeFileSync(manifestFile,JSON.stringify(m),{mode:0o600,flag:'wx'});
  log('PREPARED',{digest:m.digest,counts:m.counts,baseline:m.baseline,target:local?'isolated':'production'});
}
function readManifest() {
  const m=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
  if(sha({policy:m.policy,simulation:m.simulation,snapshot:m.snapshot,candidates:m.candidates})!==m.digest||m.policy!==POLICY||m.simulation!==SIM) refuse('MANIFEST_INVALID');
  if(!m.candidates.length||new Set(m.candidates.map(r=>r.id)).size!==m.candidates.length) refuse('MANIFEST_IDS_INVALID');
  if(process.env.APPROVED_MANIFEST_SHA!==m.digest||Number(process.env.APPROVED_COUNT)!==m.candidates.length) refuse('REVIEWED_MANIFEST_REQUIRED');
  return m;
}
async function productionGates() {
  if(local) return;
  if(!process.env.LEASE_UNTIL||Date.now()>=Date.parse(process.env.LEASE_UNTIL)||!Number.isFinite(Date.parse(process.env.LEASE_UNTIL))) refuse('LEASE_EXPIRED');
  const evidence=JSON.parse(fs.readFileSync(process.env.BACKUP_EVIDENCE||'', 'utf8'));
  if(evidence.result!=='PASS'||!evidence.allPublicTableCountsEqual||evidence.dumpSha256!==process.env.BACKUP_SHA) refuse('BACKUP_PROOF_REQUIRED');
  if(!/^[0-9a-f]{40}$/.test(process.env.CANDIDATE_SHA||'')||process.env.REVIEWED_SHA!==process.env.CANDIDATE_SHA) refuse('EXACT_ARTIFACT_REVIEW_REQUIRED');
  const rehearsal=JSON.parse(fs.readFileSync('/data/act-scope-02/stage7-rehearsal/pass.json','utf8'));
  if(rehearsal.result!=='PASS'||rehearsal.candidateSha!==process.env.CANDIDATE_SHA) refuse('EXACT_REHEARSAL_REQUIRED');
  const r=(await c.query(`SELECT cr.status,st.found_count,st.discard_count,
   (SELECT count(*)::int FROM collection_items i JOIN publications p ON p.id=i.publication_id WHERE i.collection_run_id=cr.id AND i.status IN ('PROCESSED_NEW','PROCESSED_EXISTING')) AS kept,
   (SELECT count(*)::int FROM collection_filter_discards d WHERE d.collection_run_id=cr.id AND d.policy_id=$2 AND d.policy_revision=5 AND d.expires_at=d.discarded_at+interval '3 months' AND NOT EXISTS(SELECT 1 FROM publication_origins o WHERE o.source_id=d.source_id AND o.external_id=d.source_item_key)) AS valid_discards,
   (SELECT count(*)::int FROM collection_items i WHERE i.collection_run_id=cr.id AND i.status='FILTERED_OUT' AND i.publication_id IS NOT NULL) AS bad_links
   FROM collection_runs cr JOIN collection_filter_discard_run_stats st ON st.collection_run_id=cr.id
   JOIN sources src ON src.id=cr.source_id WHERE cr.id=$1 AND src.code='dou' AND st.policy_id=$2 AND st.policy_version=1 AND st.policy_revision=5`,[process.env.SMOKE_RUN_ID,POLICY])).rows[0];
  if(!r||!['SUCCESS','PARTIAL_SUCCESS'].includes(r.status)||r.kept<1||Number(r.discard_count)<1||r.valid_discards!==Number(r.discard_count)||r.bad_links!==0) refuse('REAL_SMOKE_REQUIRED');
}
async function transition(m,action) {
  let count=0;
  for(let start=0;start<m.candidates.length;start+=200) {
    const chunk=m.candidates.slice(start,start+200);
    count+=await transaction(async()=>{
      await c.query('SELECT id FROM publications WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[chunk.map(r=>r.id)]);
      if(action==='SUPPRESS') {
        await guard();
        const actual=(await c.query(candidateSql,[SIM,chunk.map(r=>r.id)])).rows;
        if(actual.length!==chunk.length||actual.some((r,i)=>!r.stable||r.scope!=='IN_SCOPE'||r.expected!==chunk[i].expected||fingerprint(r)!==chunk[i].evidence)) refuse('MATERIAL_OR_SCOPE_DRIFT');
      }
      let n=0;
      for(const item of chunk) {
        let expected=item.expected;
        if(action==='RESTORE') {
          const e=(await c.query(`SELECT e.id FROM publication_scope_state s JOIN publication_scope_events e ON e.id=s.current_event_id WHERE s.publication_id=$1 AND s.scope='OUT_OF_SCOPE' AND e.action='SUPPRESS' AND e.policy_key=$2 AND e.manifest_sha256::text=$3 AND e.operation_id=$4`,[item.id,KEY,m.digest,uuid('SUPPRESS',m.digest,item.id)])).rows[0];
          if(!e) continue; expected=e.id;
        }
        const r=(await c.query('SELECT * FROM apply_publication_scope_transition($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[item.id,action,uuid(action,m.digest,item.id),expected,KEY,action==='SUPPRESS'?item.reason:'RESTORE_'+item.reason,'collection-filter-v1-r5',item.evidence,m.digest,'ACT_SCOPE_02_EXECUTOR'])).rows[0];
        if(r.resulting_scope!==(action==='SUPPRESS'?'OUT_OF_SCOPE':'IN_SCOPE')) refuse('TRANSITION_UNCONFIRMED');
        if(r.applied) n++;
      } return n;
    });
    if(start%2000===0) log('PROGRESS',{action,processed:Math.min(start+200,m.candidates.length),applied:count});
  } return count;
}
async function verify(m,suppressed) {
  const ids=m.candidates.map(r=>r.id);const b=await transaction(()=>baseline(ids),true);
  const inScope=(await c.query('SELECT count(*)::int AS n FROM unnest($1::uuid[]) i(id) WHERE publication_scope_is_in_scope(i.id)',[ids])).rows[0].n;
  const visible=await normalVisibility(ids);
  if(['publications','versions','origins','files','outside_hash'].some(k=>b[k]!==m.baseline[k])) refuse('PRESERVATION_DRIFT');
  if(suppressed ? inScope!==0||visible!==0||b.feed!==0 : inScope!==ids.length||visible!==ids.length||b.feed_hash!==m.baseline.feed_hash) refuse('VISIBILITY_UNCONFIRMED');
  if(BigInt(b.epoch)<=BigInt(m.baseline.epoch)) refuse('CACHE_EPOCH_NOT_ADVANCED');
  log(suppressed?'SUPPRESSED':'RESTORED',{count:ids.length,normalVisible:visible,baseline:b});
}
(async()=>{
  if(!process.env.RAILWAY_PROJECT_ID||!['prepare','roundtrip','restore'].includes(mode)) refuse('RAILWAY_MODE_REQUIRED');
  if(local&&(!process.env.LOCAL_SOCKET?.startsWith('/data/act-scope-02/')||!fs.statSync(process.env.LOCAL_SOCKET).isDirectory())) refuse('ISOLATED_SOCKET_REQUIRED');
  await c.connect();
  if(mode==='prepare') return await prepare();
  const m=readManifest();
  if(mode==='restore') {log('RECOVERY',{applied:await transition(m,'RESTORE')});return await verify(m,false);}
  await productionGates();
  await transaction(async()=>{await guard();const b=await baseline(m.candidates.map(r=>r.id));if(JSON.stringify(b)!==JSON.stringify(m.baseline)) refuse('BASELINE_DRIFT');},true);
  let suppressed=false;
  try { suppressed=true;const applied=await transition(m,'SUPPRESS');if(applied!==m.candidates.length) refuse('SUPPRESS_COUNT');await verify(m,true); }
  finally {if(suppressed) log('COMPENSATION',{applied:await transition(m,'RESTORE')});}
  await verify(m,false);
  const proof={result:'PASS',candidateSha:process.env.CANDIDATE_SHA,digest:m.digest,count:m.candidates.length,target:local?'isolated':'production',timestamp:new Date().toISOString()};
  fs.writeFileSync(path.join(dir,'pass.json'),JSON.stringify(proof),{mode:0o600});log('PASS',proof);
})().catch(e=>{console.error('ACT_SCOPE_02_STAGE7_REFUSED='+(/^[A-Z_]+$/.test(e.message)?e.message:'OPERATION_FAILED'));process.exitCode=1;}).finally(()=>c.end());
