#!/usr/bin/env node
// Operator-only. --plan does not initialize checkpoints or mutate rows.
import {Pool} from 'pg';
import {planAuditBackfill,applyAuditBackfill} from '../../dist/modules/audit/audit-backfill.js';
const args=process.argv.slice(2);
const value=key=>{const at=args.indexOf(key);return at<0?undefined:args[at+1]};
const known=new Set(['--plan','--apply','--ack-irreversible-r7','--batch-size','--max-batches']);
for(let i=0;i<args.length;i++){
 if(!known.has(args[i]))throw Error('invalid_argument');
 if(args[i]==='--batch-size'||args[i]==='--max-batches')i++;
}
if(args.includes('--plan')===args.includes('--apply'))throw Error('choose_plan_or_apply');
if(args.includes('--apply')&&!args.includes('--ack-irreversible-r7'))throw Error('irreversible_ack_required');
if(!process.env.DATABASE_ADMIN_URL)throw Error('operator_connection_required');
const pool=new Pool({connectionString:process.env.DATABASE_ADMIN_URL,max:1});
try {
 if(args.includes('--plan'))console.log(JSON.stringify({mode:'plan',...await planAuditBackfill(pool)}));
 else console.log(JSON.stringify({mode:'apply',...await applyAuditBackfill(pool,{
   ...(value('--batch-size')?{batchSize:Number(value('--batch-size'))}:{}),
   ...(value('--max-batches')?{maxBatches:Number(value('--max-batches'))}:{})
 })}));
} catch { console.error('audit_backfill_failed');process.exitCode=1; }
finally{await pool.end();}
