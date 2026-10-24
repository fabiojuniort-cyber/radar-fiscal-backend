import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { withTenantContext, TenantAccessDeniedError } from '../../infrastructure/database/tenant-context.js';

export async function auditHistoryRoutes(app:FastifyInstance):Promise<void> {
 app.get('/api/v1/company-audit-history',{preHandler:app.authenticate},async(request,reply)=>{
  if(!request.auth)return reply.status(401).send({error:'unauthorized'});
  const header=request.headers['x-tenant-id'];
  if(typeof header!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(header))return reply.status(400).send({error:'tenant_required'});
  try {
   const items=await withTenantContext(app.db,request.auth.userId,header,async trx=>{
    const result=await sql<{
      id:string;action:string;occurred_at:Date;company_name:string|null;deleted:boolean;
    }>`
     SELECT a.id,a.action,a.occurred_at,c.legal_name AS company_name,
       EXISTS(SELECT 1 FROM audit_log d WHERE d.tenant_id=a.tenant_id
         AND d.entity_type='company' AND d.entity_id=a.entity_id
         AND d.action='COMPANY_PURGED' AND d.audit_policy_version=1) AS deleted
     FROM audit_log a
     LEFT JOIN companies c ON c.id::text=a.entity_id AND c.tenant_id=${header}::uuid
     WHERE a.tenant_id=${header}::uuid AND a.entity_type='company'
       AND a.action IN ('COMPANY_CREATED','COMPANY_UPDATED','COMPANY_PURGED')
     ORDER BY a.occurred_at DESC,a.id DESC LIMIT 50
    `.execute(trx);
    return result.rows.map(row=>({
      id:row.id,action:row.action,occurredAt:new Date(row.occurred_at).toISOString(),
      companyState:row.company_name!==null?'PRESENT':row.deleted?'DELETED':'UNAVAILABLE',
      companyName:row.company_name,
    }));
   });
   return reply.send({items});
  }catch(error){
   if(error instanceof TenantAccessDeniedError)return reply.status(403).send({error:'tenant_access_denied'});
   throw error;
  }
 });
}
