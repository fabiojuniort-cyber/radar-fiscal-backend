import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Pool } from 'pg';

import { env } from '../../config/env.js';

const AUTH02_MIGRATION = '019_public_signup.sql';
const REQUIRED_FOUNDATION = Array.from(
  { length: 14 },
  (_, index) => String(index + 1).padStart(3, '0'),
);

function checksum(content: string): string {
  return createHash('sha256')
    .update(content, 'utf8')
    .digest('hex');
}

function isApplyRequested(): boolean {
  return process.argv.includes('--apply');
}

async function run(): Promise<void> {
  const migrationPath = resolve(
    process.cwd(),
    'migrations',
    AUTH02_MIGRATION,
  );
  const content = await readFile(
    migrationPath,
    'utf8',
  );
  const expectedChecksum = checksum(content);

  const pool = new Pool({
    connectionString:
      env.DATABASE_ADMIN_URL ??
      env.DATABASE_URL,
    max: 1,
    idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis:
      env.DB_CONNECTION_TIMEOUT_MS,
  });

  try {
    const migrationsTable =
      await pool.query<{
        exists: boolean;
      }>(`
        SELECT to_regclass(
          'public.schema_migrations'
        ) IS NOT NULL AS exists
      `);

    if (!migrationsTable.rows[0]?.exists) {
      throw new Error(
        'schema_migrations does not exist; refusing AUTH-02 isolated migration.',
      );
    }

    const applied = await pool.query<{
      filename: string;
      checksum: string;
    }>(`
      SELECT filename, checksum
      FROM schema_migrations
      ORDER BY filename
    `);

    const appliedByFilename = new Map(
      applied.rows.map((row) => [
        row.filename,
        row.checksum,
      ]),
    );

    const missingFoundation =
      REQUIRED_FOUNDATION.filter(
        (prefix) =>
          !Array.from(
            appliedByFilename.keys(),
          ).some((filename) =>
            filename.startsWith(
              `${prefix}_`,
            ),
          ),
      );

    if (missingFoundation.length > 0) {
      throw new Error(
        `Required foundation migrations 001-014 are incomplete: missing ${missingFoundation.join(', ')}.`,
      );
    }

    const appliedChecksum =
      appliedByFilename.get(
        AUTH02_MIGRATION,
      );

    if (appliedChecksum) {
      if (
        appliedChecksum !==
        expectedChecksum
      ) {
        throw new Error(
          `AUTH-02 migration checksum mismatch for ${AUTH02_MIGRATION}.`,
        );
      }

      console.log(
        `AUTH-02 migration already applied with matching checksum: ${AUTH02_MIGRATION}`,
      );
      return;
    }

    const taxonomyApplied = [
      '015_',
      '016_',
      '017_',
      '018_',
    ].filter((prefix) =>
      Array.from(
        appliedByFilename.keys(),
      ).some((filename) =>
        filename.startsWith(prefix),
      ),
    );

    console.log(
      `AUTH-02 migration preflight OK. Taxonomy migrations 015-018 currently observed: ${taxonomyApplied.length}/4.`,
    );

    if (!isApplyRequested()) {
      console.log(
        'AUTH-02 isolated migration not applied because --apply was not provided.',
      );
      return;
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(content);
      await client.query(
        `
          INSERT INTO schema_migrations (
            filename,
            checksum
          )
          VALUES ($1, $2)
        `,
        [
          AUTH02_MIGRATION,
          expectedChecksum,
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const verified = await pool.query<{
      checksum: string;
    }>(
      `
        SELECT checksum
        FROM schema_migrations
        WHERE filename = $1
      `,
      [AUTH02_MIGRATION],
    );

    if (
      verified.rows[0]?.checksum !==
      expectedChecksum
    ) {
      throw new Error(
        'AUTH-02 migration verification failed after commit.',
      );
    }

    console.log(
      `AUTH-02 isolated migration applied and verified: ${AUTH02_MIGRATION}`,
    );
  } finally {
    await pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    'AUTH-02 isolated migration failed.',
    error instanceof Error
      ? {
          name: error.name,
          message: error.message,
        }
      : {
          name: 'UnknownError',
        },
  );
  process.exit(1);
});
