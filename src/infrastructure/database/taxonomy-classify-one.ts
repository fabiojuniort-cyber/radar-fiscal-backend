import 'dotenv/config';

import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import { classifySinglePublication } from '../../modules/taxonomy/classification/classification.worker.js';
import {
  findLatestPublishedRelease,
  findOpenDraft,
  kyselyRunner,
} from '../../modules/taxonomy/curation/curation.read.js';
import type { DB } from './database.types.js';

/**
 * Classifies ONE publication on demand, whatever the global switch says:
 *
 *   node dist/infrastructure/database/taxonomy-classify-one.js \
 *     --publication=<uuid> [--release=published|draft] [--confirm]
 *
 * --release=published (default): the latest published release; with
 * --confirm the tags are saved and shown on the legislation page.
 * --release=draft: the open draft, preview only (a draft is never saved as
 * classification).
 */

const arg = (name: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const publicationId = arg('publication');
const releaseKind = arg('release') ?? 'published';
const confirm = process.argv.includes('--confirm');
const databaseUrl = process.env.DATABASE_URL ?? process.env.DATABASE_ADMIN_URL;

if (!publicationId || !/^[0-9a-f-]{36}$/i.test(publicationId) || !['published', 'draft'].includes(releaseKind)) {
  console.error('Usage: taxonomy-classify-one --publication=<uuid> [--release=published|draft] [--confirm]');
  process.exit(1);
}
if (!databaseUrl) {
  console.error('DATABASE_URL (or DATABASE_ADMIN_URL) is required.');
  process.exit(1);
}
if (releaseKind === 'draft' && confirm) {
  console.error('A draft release is preview only: run without --confirm.');
  process.exit(1);
}
if (confirm) {
  // TAX13/B4 P0: classifySinglePublication still consumes heuristic legal
  // wording. Publishing its result would incorrectly assert verified vigência.
  // Re-enable only after the classifier consumes the audited ledger directly,
  // with independent R2 approval, and no dependency on remote CSS.
  throw new Error('TAX13_CLASSIFICATION_CONFIRM_BLOCKED_PENDING_B4');
}

const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl, max: 2 }) }),
});

try {
  const run = kyselyRunner(db);
  const release = releaseKind === 'draft' ? await findOpenDraft(run) : await findLatestPublishedRelease(run);
  if (!release) throw new Error(releaseKind === 'draft' ? 'NO_OPEN_DRAFT' : 'NO_PUBLISHED_RELEASE');

  const result = await classifySinglePublication(db, {
    publicationId,
    releaseId: release.id,
    persist: confirm,
    codeGitSha: process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
  });
  console.log(
    'TAXONOMY_CLASSIFY_ONE=' +
      JSON.stringify({ release: release.version, releaseKind, ...result, tagCount: result.tags.length }),
  );
} finally {
  await db.destroy();
}
