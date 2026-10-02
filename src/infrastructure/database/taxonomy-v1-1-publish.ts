import 'dotenv/config';

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createBaselinePool } from './taxonomy-baseline-cli-common.js';
import { publishTaxonomyV11 } from '../../modules/taxonomy/release/taxonomy-successor-v1-1.database.js';

const ARTIFACT_REPOSITORY = 'fabiojuniort-cyber/radar-fiscal-backend';
const ARTIFACT_PATH = 'docs/taxonomy/TAXONOMY_V1_1_RELEASE_POLICY.json';

function gitSha(): string {
  const cli = process.argv
    .slice(2)
    .find((value) => value.startsWith('--git-sha='))
    ?.slice('--git-sha='.length);

  const value =
    cli ??
    process.env.RAILWAY_GIT_COMMIT_SHA ??
    process.env.GITHUB_SHA ??
    '';

  if (!/^[a-f0-9]{40}$/.test(value)) {
    throw new Error(
      'A 40-character lowercase git SHA is required via --git-sha, RAILWAY_GIT_COMMIT_SHA or GITHUB_SHA.',
    );
  }

  return value;
}

const artifact = await readFile(resolve(process.cwd(), ARTIFACT_PATH));
const artifactSha256 = createHash('sha256')
  .update(artifact)
  .digest('hex');

const pool = createBaselinePool({ requireAdmin: true });

try {
  const result = await publishTaxonomyV11(pool, {
    artifactRepository: ARTIFACT_REPOSITORY,
    artifactPath: ARTIFACT_PATH,
    artifactGitSha: gitSha(),
    artifactSha256,
    actor: 'taxonomy-v1.1-publish-command',
  });

  console.log(
    'TAXONOMY_V1_1_PUBLISH=' + JSON.stringify(result),
  );
} finally {
  await pool.end();
}
