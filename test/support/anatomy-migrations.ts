import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

/**
 * ANAT-ADMIN-01 integration packages: applies migrations with the project's REAL runner
 * (src/infrastructure/database/migrate.ts: one transaction per file, schema_migrations with checksums) against the
 * disposable database only. The runner reads `<cwd>/migrations`; `upTo` stages a copy of the files up to that prefix
 * in a temporary directory so a test can snapshot the catalog before a migration, then run the full directory (the
 * runner skips files already applied with the same checksum).
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RUNNER = join(ROOT, 'src/infrastructure/database/migrate.ts');
const TSX = pathToFileURL(join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href; // absolute: the cwd may be a staging dir

export async function runProjectMigrations(url: string, upTo?: string): Promise<string> {
  let cwd = ROOT; let staged: string | null = null;
  if (upTo) {
    staged = await mkdtemp(join(tmpdir(), 'anat-migrations-'));
    await cp(join(ROOT, 'migrations'), join(staged, 'migrations'), { recursive: true,
      filter: (src) => !/\d{3}_.+\.sql$/u.test(src) || src.split('/').pop()! <= upTo });
    cwd = staged;
  }
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', TSX, RUNNER], {
      cwd, timeout: 300_000, maxBuffer: 16 * 1024 * 1024,
      // Only what env.ts requires; the JWT secret is random and local to the child process.
      env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', DATABASE_URL: url, DATABASE_ADMIN_URL: url,
        JWT_ACCESS_SECRET: randomBytes(48).toString('hex'), LOG_LEVEL: 'silent' },
    });
    return stdout;
  } finally {
    if (staged) await rm(staged, { recursive: true, force: true });
  }
}

export async function projectMigrationFiles(): Promise<string[]> {
  return (await readdir(join(ROOT, 'migrations'))).filter((f) => /^\d{3}_.+\.sql$/u.test(f)).sort();
}
