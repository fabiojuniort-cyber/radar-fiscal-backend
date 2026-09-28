import type { Pool } from 'pg';

/**
 * Drops a scratch database created by a test.
 *
 * pg's Pool#end() resolves before the server backends of its clients have
 * exited. Dropping right away WITH (FORCE) then terminates those backends and
 * the "terminating connection due to administrator command" error reaches a
 * client that is still closing, failing whichever test is running. Wait for
 * the backends to go first; FORCE only covers what outlives the wait.
 */
export async function dropScratchDatabase(admin: Pool, database: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [database],
    );
    if (rows[0]!.n === 0 || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
}

/** A scratch pool whose idle clients may be terminated by the teardown. */
export function ignoreIdleClientErrors(pool: Pool): Pool {
  pool.on('error', () => undefined);
  return pool;
}
