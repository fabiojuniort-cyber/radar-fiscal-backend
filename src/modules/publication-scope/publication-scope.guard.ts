import { sql, type Kysely, type Transaction } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';

export class PublicationOutOfScopeError extends Error {
  constructor() {
    super('PUBLICATION_OUT_OF_SCOPE');
    this.name = 'PublicationOutOfScopeError';
  }
}

type ScopeDb = Kysely<DB> | Transaction<DB>;

/**
 * Cheap read used by batch selection. It is not a concurrency boundary; every
 * write path must still use the locking guard below inside its transaction.
 */
export async function publicationIsInScope(
  db: ScopeDb,
  publicationId: string,
): Promise<boolean> {
  const result = await sql<{ in_scope: boolean }>`
    SELECT public.publication_scope_is_in_scope(${publicationId}::uuid) AS in_scope
  `.execute(db);

  return result.rows[0]?.in_scope === true;
}

/**
 * Serializes an enrichment commit with SUPPRESS/RESTORE for the publication.
 *
 * - If this SHARE lock wins first, suppression waits until this transaction
 *   commits; therefore derived evidence cannot commit after the suppression.
 * - If suppression wins first, this query resumes after it commits, observes
 *   OUT_OF_SCOPE and fails closed.
 */
export async function lockPublicationVersionInScope(
  trx: Transaction<DB>,
  publicationVersionId: string,
): Promise<string> {
  const result = await sql<{ publication_id: string }>`
    SELECT p.id AS publication_id
    FROM public.publication_versions pv
    JOIN public.publications p
      ON p.id = pv.publication_id
    WHERE pv.id = ${publicationVersionId}::uuid
      AND public.publication_scope_is_in_scope(p.id)
    FOR SHARE OF p
  `.execute(trx);

  const publicationId = result.rows[0]?.publication_id;
  if (!publicationId) {
    throw new PublicationOutOfScopeError();
  }

  return publicationId;
}

export function isPublicationOutOfScopeError(
  error: unknown,
): error is PublicationOutOfScopeError {
  return error instanceof PublicationOutOfScopeError ||
    (error instanceof Error && error.message === 'PUBLICATION_OUT_OF_SCOPE');
}
