import { sql, type Kysely } from 'kysely';
import type { DB } from '../../infrastructure/database/database.types.js';
import { withUserContext } from '../../infrastructure/database/tenant-context.js';

/**
 * Direct, serialised changes to the APPROVED policy only.
 * The SECURITY DEFINER function enforces PLATFORM_ADMIN, validates each
 * operation, increments the policy revision and writes its audit record.
 * Publication deletion is deliberately impossible through this path.
 */
export async function editActiveCollectionFilter(
  db: Kysely<DB>, userId: string,
  action: 'RULE_KEEP'|'RULE_DELETE'|'TERM_PUT'|'TERM_DELETE'|
          'ALIAS_PUT'|'ALIAS_DELETE'|'NEWTYPE_MERGE'|'NEWTYPE_KEEP',
  payload: Record<string, unknown>,
): Promise<{revision:number}> {
  return withUserContext(db,userId,async trx=>{
    const result=await sql<{policy_revision:number}>`
      SELECT * FROM public.collection_filter_direct_admin_edit(
        ${action},${JSON.stringify(payload)}::jsonb
      )`.execute(trx);
    return {revision:Number(result.rows[0]?.policy_revision)};
  });
}
