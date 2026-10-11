import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../infrastructure/database/database.types.js';
import { withUserContext } from '../../infrastructure/database/tenant-context.js';

interface ScopeRow {
  publication_id: string;
  scope_updated_at: Date;
  has_company: boolean;
  has_other_source: boolean;
}

export interface OutOfScopePreview {
  count: number;
  blockedCompany: number;
  blockedOtherSource: number;
  token: string;
}

async function scopeCandidates(trx: Transaction<DB>) {
  const hash = createHash('sha256').update('L15:DOU:OUT_OF_SCOPE:v1');
  const ids: string[] = [];
  let cursor: string | null = null, blockedCompany = 0, blockedOtherSource = 0;
  let pageNo = 0;
  while (true) {
    if (++pageNo > 10000) throw new Error('l15_paging_cap');
    const page = await sql<ScopeRow>`
      SELECT * FROM public.l15_out_of_scope_candidates(${cursor}::uuid,500)
    `.execute(trx);
    if (!page.rows.length) break;
    for (const row of page.rows) {
      hash.update(row.publication_id)
        .update(new Date(row.scope_updated_at).toISOString())
        .update(row.has_company ? 'C' : '-')
        .update(row.has_other_source ? 'O' : '-');
      if (row.has_company) blockedCompany++;
      else if (row.has_other_source) blockedOtherSource++;
      else ids.push(row.publication_id);
    }
    cursor = page.rows[page.rows.length - 1]!.publication_id;
    if (page.rows.length < 500) break;
  }
  hash.update(String(blockedCompany)).update(String(blockedOtherSource));
  return { ids, blockedCompany, blockedOtherSource,
    count: ids.length, token: hash.digest('hex') };
}

export async function previewOutOfScopePurge(db: Kysely<DB>, actor: string):
  Promise<OutOfScopePreview> {
  return withUserContext(db, actor, async trx => {
    const { count, blockedCompany, blockedOtherSource, token } =
      await scopeCandidates(trx);
    return { count, blockedCompany, blockedOtherSource, token };
  });
}

/** One user-confirmed step, MAX 500, each SQL 051 batch <=100.
 * No rule changes. The DB checks that every item is still OUT_OF_SCOPE,
 * DOU-only and without tenant links under row lock, and writes audit entries.
 */
export async function confirmOutOfScopePurge(
  db: Kysely<DB>, actor: string, expectedCount: number, previewToken: string,
) {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0 ||
      !/^[a-f0-9]{64}$/.test(previewToken)) {
    throw new RangeError('invalid_l15_confirmation');
  }
  return withUserContext(db, actor, async trx => {
    await sql`SET LOCAL statement_timeout = '11000ms'`.execute(trx);
    await sql`SET LOCAL lock_timeout = '2500ms'`.execute(trx);
    // Do not race a direct-rule purge. This lock alone is not the security
    // boundary; the SQL functions recheck eligibility under row locks.
    await sql`SELECT pg_advisory_xact_lock(
      hashtextextended('collection-filter-direct-rule',0)
    )`.execute(trx);
    const plan = await scopeCandidates(trx);
    if (plan.count !== expectedCount || plan.token !== previewToken) {
      return { changed: true, count: plan.count,
        blockedCompany: plan.blockedCompany,
        blockedOtherSource: plan.blockedOtherSource,
        token: plan.token, apagadas: 0, restantes: plan.count, deletedCount: 0 };
    }
    let apagadas = 0;
    const operation = randomUUID();
    for (let offset = 0; offset < Math.min(500, plan.ids.length); offset += 100) {
      const batch = plan.ids.slice(offset, offset + 100);
      const result = await sql<{ count: number }>`
        SELECT public.l15_out_of_scope_purge_batch(${batch}::uuid[],${operation}::uuid)
          AS count
      `.execute(trx);
      if (Number(result.rows[0]?.count) !== batch.length) {
        throw new Error('l15_batch_count_mismatch');
      }
      apagadas += batch.length;
    }
    // If 0 candidates, never invoke the purge function with an empty batch.
    const current = await scopeCandidates(trx);
    return { changed: false, apagadas, restantes: current.count,
      deletedCount: apagadas, blockedCompany: current.blockedCompany,
      blockedOtherSource: current.blockedOtherSource };
  });
}
