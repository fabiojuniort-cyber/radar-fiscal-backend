import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

function readNcmEnrichmentFlag(value?: 'true' | 'false'): string {
  const childEnv = {
    ...process.env,
    DATABASE_URL: 'postgresql://runtime:test@localhost:5432/runtime_flags',
    NODE_ENV: 'test',
  };

  if (value === undefined) {
    delete childEnv.PUBLICATION_NCM_ENRICHMENT_ENABLED;
  } else {
    childEnv.PUBLICATION_NCM_ENRICHMENT_ENABLED = value;
  }

  return execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      "import { collectionRuntimeEnv } from './src/config/collection-runtime-env.ts'; process.stdout.write(String(collectionRuntimeEnv.PUBLICATION_NCM_ENRICHMENT_ENABLED));",
    ],
    {
      cwd: process.cwd(),
      env: childEnv,
      encoding: 'utf8',
    },
  );
}

test('automatic NCM enrichment stays enabled by default', () => {
  assert.equal(readNcmEnrichmentFlag(), 'true');
});

test('automatic NCM enrichment can be paused explicitly', () => {
  assert.equal(readNcmEnrichmentFlag('false'), 'false');
});
