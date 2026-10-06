import { equal, ok } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../src/infrastructure/database/publication-exclusion-dry-run.ts', import.meta.url));
const marker = 'DO_NOT_ECHO_PRIVATE_CONNECTION';

test('CLI rejects every execution/unknown argument before opening a connection', () => {
  for (const arg of ['--apply', '--execute', '--confirm=true', '--delete=false', '--suppress', '--restore', '--unknown']) {
    const run = spawnSync(process.execPath, ['--import', 'tsx', cli, arg], {
      cwd: root,
      env: { PATH: process.env.PATH ?? '', PUBLICATION_EXCLUSION_DRY_RUN_DATABASE_URL: marker },
      encoding: 'utf8', timeout: 10_000,
    });
    equal(run.status, 2, arg + ': ' + run.stderr);
    equal(run.stdout, '');
    ok(run.stderr.includes('PUBLICATION_EXCLUSION_DRY_RUN_REFUSED'));
    ok(!run.stderr.includes(marker));
  }
});

test('CLI has no generic database URL fallback and does not echo credentials', () => {
  const run = spawnSync(process.execPath, ['--import', 'tsx', cli, '--dry-run'], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '', DATABASE_URL: marker, DATABASE_ADMIN_URL: marker },
    encoding: 'utf8', timeout: 10_000,
  });
  equal(run.status, 1);
  equal(run.stdout, '');
  ok(run.stderr.includes('dedicated database configuration is required'));
  ok(!run.stderr.includes(marker));
});
