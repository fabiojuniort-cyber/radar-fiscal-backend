import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';

const image='postgres:18-bookworm@sha256:5c4783a8cc3f0074912164f94dfa1be4e043438f0f707cf968d7af9a0d31a2c8';
const cases=[['control','b2150ab5ef34e9f9646e219d522e47738d9c04f5'],['integration','2c41fbab8169b7efca6bd2e80c963d57a50585b6']];
const root=process.cwd(),tmp=process.env.RUNNER_TEMP,output=path.join(root,'f2-r7-evidence');
if(process.env.CI!=='true'||process.env.GITHUB_ACTIONS!=='true'||process.env.GITHUB_RUN_ATTEMPT!=='1'||!tmp||process.platform!=='linux')throw Error('ci_lab_guard');
if(process.version!=='v24.22.2')throw Error('node_version_guard');
fs.mkdirSync(output,{recursive:false}); // Existing evidence refuses a second attempt.
const nonce=crypto.randomBytes(12).toString('hex');
const env={...process.env,CI:'true',NODE_ENV:'test',DATABASE_ADMIN_URL:'postgresql://postgres:postgres@localhost:5432/radar_fiscal_test',DATABASE_URL:'postgresql://radar_app_runtime:ci-runtime-password-with-at-least-32-chars@localhost:5432/radar_fiscal_test',DB_RUNTIME_PASSWORD:'ci-runtime-password-with-at-least-32-chars',DB_CURATOR_RUNTIME_PASSWORD:'ci-curator-password-with-at-least-32-chars',JWT_ACCESS_SECRET:'ci-jwt-secret-with-at-least-32-characters',AUTH_REFRESH_COOKIE_NAME:'radar_refresh_token',PUBLIC_API_ALLOWED_ORIGINS:'https://public.example',DB_POOL_MAX:'1',F2_R7_LAB_NONCE:nonce};
// Never inherit a production connection or arbitrary PG client override.
for(const k of ['PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGSERVICE','PGSERVICEFILE','PGOPTIONS','NODE_OPTIONS'])delete env[k];
const secrets=[env.DB_RUNTIME_PASSWORD,env.DB_CURATOR_RUNTIME_PASSWORD,env.JWT_ACCESS_SECRET];
function clean(s){s=s.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/g,'[LAB_DSN_REDACTED]');for(const v of secrets)s=s.split(v).join('[LAB_VALUE_REDACTED]');return s;}
function execute(command,args,{cwd=root,file,environment=env,allowFailure=false}={}){
 return new Promise((resolve,reject)=>{
  let text='';const child=spawn(command,args,{cwd,env:environment,stdio:['ignore','pipe','pipe']});
  const collect=b=>{text+=b.toString();};child.stdout.on('data',collect);child.stderr.on('data',collect);
  child.once('error',reject);child.once('close',code=>{const safe=clean(text);if(file)fs.writeFileSync(file,safe);if(code!==0&&!allowFailure)reject(Error('command_failed:'+command+':'+code));else resolve({code,text:safe});});
 });
}
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
function patchR7(dir){
 const f=path.join(dir,'test/onb02-r7-audit.integration.test.ts'),before=fs.readFileSync(f,'utf8');
 const pattern="return new Pool({connectionString:url,max:2,options:'-c jit=off -c statement_timeout=45000 -c lock_timeout=5000'});";
 if(before.split(pattern).length!==2)throw Error('instrumentation_anchor_changed');
 const replacement="return instrumentPool(new Pool({connectionString:url,max:2,options:'-c jit=off -c statement_timeout=45000 -c lock_timeout=5000 -c session_preload_libraries=auto_explain -c auto_explain.log_min_duration=250 -c auto_explain.log_parameter_max_length=0 -c auto_explain.log_analyze=on -c auto_explain.log_timing=off -c auto_explain.log_nested_statements=on -c auto_explain.log_buffers=on -c auto_explain.log_format=json -c track_io_timing=on'}));";
 const prefix="import {instrumentPool} from './support/f2-r7-observe.mjs';\n";
 const after=prefix+before.replace(pattern,replacement);
 if(after.slice(prefix.length).replace(replacement,pattern)!==before)throw Error('assertions_changed');
 fs.writeFileSync(f,after);fs.copyFileSync(path.join(root,'ops/f2-r7/observe.mjs'),path.join(dir,'test/support/f2-r7-observe.mjs'));
 return {original_test_sha256:hash(before),instrumented_test_sha256:hash(after),instrumentation_sha256:hash(fs.readFileSync(path.join(root,'ops/f2-r7/observe.mjs'))),reversible_patch_verified:true};
}
// Only structural plan fields leave the lab log; no query text, constants, Output,
// conditions or parameter values are exported.
const planKeys=new Set(['Node Type','Parent Relationship','Subplan Name','Relation Name','Schema','Alias','Index Name','Scan Direction','Join Type','Strategy','Partial Mode','Startup Cost','Total Cost','Plan Rows','Plan Width','Actual Startup Time','Actual Total Time','Actual Rows','Actual Loops','Rows Removed by Filter','Rows Removed by Join Filter','Inner Unique','Shared Hit Blocks','Shared Read Blocks','Shared Dirtied Blocks','Shared Written Blocks','Local Hit Blocks','Local Read Blocks','Temp Read Blocks','Temp Written Blocks','I/O Read Time','I/O Write Time','WAL Records','WAL FPI','WAL Bytes','Planning Time','Execution Time','Duration','Plans','Plan','Triggers','Trigger Name','Calls','Time','Hash Batches','Hash Buckets','Peak Memory Usage','Sort Method','Sort Space Used','Sort Space Type']);
function safePlan(x){if(Array.isArray(x))return x.map(safePlan);if(x&&typeof x==='object')return Object.fromEntries(Object.entries(x).filter(([k])=>planKeys.has(k)).map(([k,v])=>[k,safePlan(v)]));return x;}
function plansFromLog(text){
 const out=[];let pos=0;
 while(out.length<2000){const marker=text.indexOf('plan:',pos);if(marker<0)break;let start=text.indexOf('{',marker);if(start<0)break;let depth=0,quoted=false,escaped=false,end=-1;
  for(let i=start;i<text.length;i++){const c=text[i];if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}else if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0){end=i+1;break;}}
  if(end<0)break;try{out.push(safePlan(JSON.parse(text.slice(start,end))));}catch{}pos=end;
 }
 return {plans:out,capped:out.length===2000,note:'Cancelled statement may have no completed plan. No historical plan inferred.'};
}
const commands=[
 ['npm',['ci']],['npm',['run','build']],['npm',['run','db:prepare']],['node',['ops/onb02/audit-backfill.mjs','--apply','--ack-irreversible-r7']],
 ...['public-signup','onboarding-integrity','onb02-company-purge-graph','onb02-r6-purge','onb02-r71-backfill','onb02-r74-historical-events','onb02-r73-tax10-cli','onb02-r72-backfill'].map(n=>['npx',['tsx','--test','test/'+n+'.integration.test.ts']])
];
let finalCode=0;const summary=[];let activeContainer=null,observer=null;
async function stopObserver(){if(observer){const p=observer;observer=null;if(p.exitCode===null&&p.signalCode===null){const closed=new Promise(r=>p.once('close',r));p.kill('SIGTERM');const kill=setTimeout(()=>p.kill('SIGKILL'),5000);await closed;clearTimeout(kill);}}}
async function teardown(){await stopObserver();if(activeContainer){await execute('docker',['rm','-f',activeContainer],{allowFailure:true});activeContainer=null;}}
process.on('SIGTERM',()=>{void teardown().finally(()=>process.exit(143));});
try{
 await execute('docker',['pull',image],{file:path.join(output,'image-pull.txt')});
 fs.writeFileSync(path.join(output,'host.json'),JSON.stringify({node:process.version,platform:os.platform(),release:os.release(),cpus:os.cpus().map(x=>({model:x.model,speed:x.speed})),memory:os.totalmem(),image,order:cases,attempt:1,harness:process.env.GITHUB_SHA,overhead:'Session GUC verification, metadata snapshots, auto_explain with timing off, track_io_timing and bounded observer are enabled identically. No uninstrumented baseline claimed.'},null,2));
 for(const [label,sha] of cases){
  const dir=path.join(tmp,'f2-r7-'+nonce+'-'+label),out=path.join(output,label);fs.mkdirSync(out);
  const result={label,source:sha,attempt:1,status:'NOT_RUN',steps:[]};const t0=performance.now();
  try{
   if(!path.resolve(dir).startsWith(path.resolve(tmp)+path.sep)||fs.existsSync(dir))throw Error('workspace_guard');
   await execute('git',['worktree','add','--detach',dir,sha]);
   const tree=await execute('git',['rev-parse','HEAD^{tree}'],{cwd:dir});result.tree=tree.text.trim();
   activeContainer='f2-r7-'+nonce+'-'+label;
   await execute('docker',['run','--rm','-d','--name',activeContainer,'--label','f2-r7-lab='+nonce,'-e','POSTGRES_DB=radar_fiscal_test','-e','POSTGRES_USER=postgres','-e','POSTGRES_PASSWORD=postgres','-p','127.0.0.1:5432:5432',image]);
   let ready=false;for(let i=0;i<30;i++){const r=await execute('docker',['exec',activeContainer,'pg_isready','-U','postgres','-d','radar_fiscal_test'],{allowFailure:true});if(r.code===0){ready=true;break;}await new Promise(r=>setTimeout(r,1000));}if(!ready)throw Error('database_not_ready');
   // Fixed endpoint, fresh labelled container; refuse host/database drift before DDL.
   const version=await execute('docker',['exec',activeContainer,'psql','-U','postgres','-d','radar_fiscal_test','-Atc',"SELECT current_database()||'|'||current_setting('server_version')"]);if(!version.text.startsWith('radar_fiscal_test|18.6'))throw Error('postgres_version_guard');
   for(let i=0;i<commands.length;i++){
    const [cmd,args]=commands[i],t=performance.now();
    const r=await execute(cmd,args,{cwd:dir,file:path.join(out,'step-'+String(i).padStart(2,'0')+'.txt'),allowFailure:true});result.steps.push({cmd:[cmd,...args],code:r.code,elapsed_ms:performance.now()-t});
    if(r.code!==0)throw Error('predecessor_failed:'+i);
    if(i===3){const sql="SELECT CASE WHEN EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tenant_onboarding_profiles' AND column_name='company_name' AND is_nullable='YES') AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='trg_establishment_company_root') THEN 'PASS' ELSE 'BLOCK' END";const v=await execute('docker',['exec',activeContainer,'psql','-U','postgres','-d','radar_fiscal_test','-Atc',sql]);if(v.text.trim()!=='PASS')throw Error('migration_verification_failed');}
   }
   result.instrumentation=patchR7(dir);
   const obs=fs.openSync(path.join(out,'observer.jsonl'),'w');observer=spawn('node',['test/support/f2-r7-observe.mjs','--observer'],{cwd:dir,env,stdio:['ignore',obs,obs]});fs.closeSync(obs);
   const t=performance.now();const r=await execute('timeout',['--signal=TERM','--kill-after=10s','300s','npx','tsx','--test','test/onb02-r7-audit.integration.test.ts'],{cwd:dir,file:path.join(out,'r7.txt'),allowFailure:true});result.r7={code:r.code,elapsed_ms:performance.now()-t};
   result.status=r.code===0?'PASS_INSTRUMENTED':'FAIL_INSTRUMENTED';if(r.code!==0)finalCode=1;
   // Preserve the succeeding semantic gate too; a failed R7 does not run it.
   if(r.code===0){const v=await execute('bash',['ops/onb02/ci-evidence-pg18.sh'],{cwd:dir,file:path.join(out,'semantic.txt'),allowFailure:true});result.semantic_code=v.code;if(v.code!==0){result.status='FAIL_SEMANTIC';finalCode=1;}}
  }catch(e){result.status=result.status==='NOT_RUN'?'BLOCKED_PREPARATION':result.status;result.error=e.message;finalCode=1;}
  finally{
   await stopObserver();
   if(activeContainer){const l=await execute('docker',['logs',activeContainer],{allowFailure:true});fs.writeFileSync(path.join(out,'plans.json'),JSON.stringify(plansFromLog(l.text),null,2));fs.writeFileSync(path.join(out,'postgres-errors.txt'),l.text.split('\n').filter(x=>/ERROR:  (synthetic_batch_interruption|canceling statement due to (statement|lock) timeout)/.test(x)).join('\n'));}
   await teardown();
   result.elapsed_ms=performance.now()-t0;summary.push(result);fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify(summary,null,2));
   // No retry or second source invocation after this case.
  }
 }
}finally{await teardown();}
console.log(JSON.stringify(summary));process.exitCode=finalCode;

