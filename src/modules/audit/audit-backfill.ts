import type { Pool } from 'pg';

export type BackfillSummary={processed:number;remaining:number;batches:number;elapsedMs:number;completed:boolean};
export async function planAuditBackfill(pool:Pool) {
 const r=await pool.query<{pending:string;unregistered:string}>(`
  SELECT count(*)::text pending,
    count(*) FILTER(WHERE public.audit_event_policy(action,entity_type) IS NULL)::text unregistered
  FROM audit_log WHERE audit_policy_version=0`);
 return {pending:Number(r.rows[0]!.pending),unregistered:Number(r.rows[0]!.unregistered)};
}
export async function applyAuditBackfill(pool:Pool, options:{batchSize?:number;maxBatches?:number}={}):Promise<BackfillSummary> {
 const size=options.batchSize??5000, max=options.maxBatches??Number.MAX_SAFE_INTEGER;
 if(!Number.isInteger(size)||size<1||size>10000||!Number.isInteger(max)||max<1)throw Error('invalid_backfill_options');
 const start=performance.now();let processed=0,batches=0,remaining=(await planAuditBackfill(pool)).pending;
 while(remaining>0 && batches<max) {
   // One call = one committed batch; row markers and checkpoint commit atomically.
   const r=await pool.query<{processed:number;remaining:string}>('SELECT * FROM public.audit_backfill_batch($1)',[size]);
   processed+=r.rows[0]!.processed;remaining=Number(r.rows[0]!.remaining);batches++;
   if(r.rows[0]!.processed===0 && remaining>0)throw Error('audit_backfill_no_progress');
 }
 return {processed,remaining,batches,elapsedMs:performance.now()-start,completed:remaining===0};
}
