import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Pool } from 'pg';

import { env } from '../../config/env.js';

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations');
const MIGRATION_FILE_PATTERN = /^\d{3}_.+\.sql$/;

interface AppliedMigration {
  filename: string;
  checksum: string;
}

function checksum(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function loadAppliedMigrations(
  pool: Pool,
): Promise<Map<string, string>> {
  const result = await pool.query<AppliedMigration>(`
    SELECT filename, checksum
    FROM schema_migrations
    ORDER BY filename
  `);

  return new Map(
    result.rows.map((row) => [row.filename, row.checksum]),
  );
}

async function applyMigration(
  pool: Pool,
  filename: string,
  content: string,
  migrationChecksum: string,
): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(content);
    await client.query(
      `
        INSERT INTO schema_migrations (filename, checksum)
        VALUES ($1, $2)
      `,
      [filename, migrationChecksum],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function runMigrations(): Promise<void> {
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 1,
    idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
  });

  try {
    await ensureMigrationsTable(pool);

    const filenames = (await readdir(MIGRATIONS_DIR))
      .filter((filename) => MIGRATION_FILE_PATTERN.test(filename))
      .sort();

    if (filenames.length === 0) {
      throw new Error('No SQL migration files found.');
    }

    const applied = await loadAppliedMigrations(pool);

    for (const filename of filenames) {
      const migrationPath = resolve(MIGRATIONS_DIR, filename);
      const content = await readFile(migrationPath, 'utf8');
      const migrationChecksum = checksum(content);
      const appliedChecksum = applied.get(filename);

      if (appliedChecksum) {
        if (appliedChecksum !== migrationChecksum) {
          throw new Error(
            `Migration ${filename} was modified after being applied.`,
          );
        }

        console.log(`Migration already applied: ${filename}`);
        continue;
      }

      console.log(`Applying migration: ${filename}`);
      await applyMigration(
        pool,
        filename,
        content,
        migrationChecksum,
      );
      console.log(`Migration applied: ${filename}`);
    }

    console.log('Database migrations are up to date.');
  } finally {
    await pool.end();
  }
}

runMigrations().catch((error: unknown) => {
  console.error('Database migration failed.', error);
  process.exit(1);
});
