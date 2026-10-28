import { sql, type Transaction } from 'kysely';
import type { DB } from '../../infrastructure/database/database.types.js';

export class CompanyRootDeleteConfirmationError extends Error {}

/** Purge the CNPJ root explicitly confirmed by the account owner, including legacy
 * branch-as-company rows. Same tenant only; no data migration or broader DELETE grants.
 * Root lock is shared with registration; every graph uses the existing guarded function.
 * The caller's tenant transaction rolls back ALL graphs if any guard fails.
 */
export async function purgeCompany(trx: Transaction<DB>, companyId: string, includeLegacyRoot=false): Promise<boolean> {
  await sql`SET LOCAL statement_timeout = '30s'`.execute(trx);
  await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
  const target=await trx.selectFrom('companies').select(['tenant_id','head_office_cnpj']).where('id','=',companyId).executeTakeFirst();
  if(!target)return false;
  const root=target.head_office_cnpj.slice(0,8);
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${target.tenant_id+':'+root},0))`.execute(trx);
  const family=await trx.selectFrom('companies').select('id').where('tenant_id','=',target.tenant_id)
    .where(sql<boolean>`left(head_office_cnpj,8)=${root}`).orderBy('id').forUpdate().execute();
  if(!family.some(c=>c.id===companyId))return false;
  if(family.length>1&&!includeLegacyRoot)throw new CompanyRootDeleteConfirmationError();
  for(const company of family){
    const result=await sql<{removed:boolean}>`SELECT public.app_purge_company(${company.id}::uuid) AS removed`.execute(trx);
    if(result.rows[0]?.removed!==true)throw new Error('company_root_purge_incomplete');
  }
  return true;
}
