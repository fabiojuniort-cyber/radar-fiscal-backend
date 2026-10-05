import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

async function epoch(client: import('pg').PoolClient): Promise<bigint> {
  const result = await client.query<{ epoch: string }>(
    'SELECT public.publication_scope_epoch()::text AS epoch',
  );
  return BigInt(result.rows[0]!.epoch);
}

test(
  'publication scope epoch advances atomically with SUPPRESS/RESTORE and rolls back with the transaction',
  async () => {
    const adminUrl = process.env.DATABASE_ADMIN_URL;
    assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required');

    const pool = new Pool({ connectionString: adminUrl, max: 1 });
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const publicationId = randomUUID();
      await client.query(
        `
          INSERT INTO publications (
            id, identity_hash, identity_strength, identity_basis,
            jurisdiction_level, title
          ) VALUES ($1, $2, 'STRONG', '{}'::jsonb, 'FEDERAL', $3)
        `,
        [publicationId, HASH_A, 'Scope epoch integration fixture'],
      );

      const initialEpoch = await epoch(client);
      const suppressOperation = randomUUID();
      const suppress = await client.query<{ event_id: string }>(
        `
          SELECT event_id
          FROM public.apply_publication_scope_transition(
            $1::uuid, 'SUPPRESS', $2::uuid, NULL,
            'TEST_SCOPE_POLICY', 'TEST_SUPPRESS', 'test-v1',
            $3, NULL, 'INTEGRATION_TEST'
          )
        `,
        [publicationId, suppressOperation, HASH_B],
      );
      const suppressEventId = suppress.rows[0]!.event_id;

      assert.equal(await epoch(client), initialEpoch + 1n);
      const suppressed = await client.query<{ in_scope: boolean }>(
        'SELECT public.publication_scope_is_in_scope($1::uuid) AS in_scope',
        [publicationId],
      );
      assert.equal(suppressed.rows[0]?.in_scope, false);

      await client.query('SAVEPOINT before_restore');
      await client.query(
        `
          SELECT event_id
          FROM public.apply_publication_scope_transition(
            $1::uuid, 'RESTORE', $2::uuid, $3::uuid,
            'TEST_SCOPE_POLICY', 'TEST_RESTORE_ROLLBACK', 'test-v1',
            $4, NULL, 'INTEGRATION_TEST'
          )
        `,
        [publicationId, randomUUID(), suppressEventId, HASH_B],
      );
      assert.equal(await epoch(client), initialEpoch + 2n);

      await client.query('ROLLBACK TO SAVEPOINT before_restore');
      assert.equal(
        await epoch(client),
        initialEpoch + 1n,
        'rolled-back visibility transition must not invalidate committed cache keys',
      );
      const stillSuppressed = await client.query<{ in_scope: boolean }>(
        'SELECT public.publication_scope_is_in_scope($1::uuid) AS in_scope',
        [publicationId],
      );
      assert.equal(stillSuppressed.rows[0]?.in_scope, false);

      await client.query(
        `
          SELECT event_id
          FROM public.apply_publication_scope_transition(
            $1::uuid, 'RESTORE', $2::uuid, $3::uuid,
            'TEST_SCOPE_POLICY', 'TEST_RESTORE', 'test-v1',
            $4, NULL, 'INTEGRATION_TEST'
          )
        `,
        [publicationId, randomUUID(), suppressEventId, HASH_B],
      );
      assert.equal(await epoch(client), initialEpoch + 2n);

      const restored = await client.query<{ in_scope: boolean }>(
        'SELECT public.publication_scope_is_in_scope($1::uuid) AS in_scope',
        [publicationId],
      );
      assert.equal(restored.rows[0]?.in_scope, true);

      await client.query('ROLLBACK');
    } finally {
      client.release();
      await pool.end();
    }
  },
);
