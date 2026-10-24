import { sql, type Transaction } from 'kysely';
import type { DB } from '../../infrastructure/database/database.types.js';

// Configure deadlines before sending the top-level purge statement.
export async function purgeCompany(trx: Transaction<DB>, companyId: string): Promise<boolean> {
  await sql`SET LOCAL statement_timeout = '30s'`.execute(trx);
  await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
  const result = await sql<{ removed: boolean }>`
    SELECT public.app_purge_company(${companyId}::uuid) AS removed
  `.execute(trx);
  return result.rows[0]?.removed === true;
}
