import 'dotenv/config';

import { Pool } from 'pg';

import {
  publishDraft,
  withCuratorTransaction,
  type CuratorActor,
  type PublishResult,
} from '../../modules/taxonomy/curation/curation.draft.js';
import { resolveCuratorDatabaseUrl } from './curator-url.js';

/**
 * Publishes the open taxonomy DRAFT when the curator asked for it outside
 * the curation screen (same validation and audit as the screen):
 *
 *   node dist/infrastructure/database/taxonomy-publish-draft.js \
 *     --notes="what changed" [--confirm]
 *
 * Without --confirm it validates and rolls back (dry run).
 */

const notes = process.argv.find((value) => value.startsWith('--notes='))?.slice('--notes='.length).trim();
const confirm = process.argv.includes('--confirm');
if (!notes || notes.length < 3) {
  console.error('Usage: taxonomy-publish-draft --notes="what changed" [--confirm]');
  process.exit(1);
}

const connectionString = resolveCuratorDatabaseUrl({
  DATABASE_URL: process.env.DATABASE_URL ?? '',
  DATABASE_CURATOR_URL: process.env.DATABASE_CURATOR_URL,
  DB_CURATOR_RUNTIME_PASSWORD: process.env.DB_CURATOR_RUNTIME_PASSWORD,
});
if (!connectionString) {
  console.error('DATABASE_CURATOR_URL (or DATABASE_URL + DB_CURATOR_RUNTIME_PASSWORD) is required.');
  process.exit(1);
}

const actor: CuratorActor = {
  userId: 'ops:taxonomy-publish-draft',
  justification: 'Publicação pedida pelo curador',
};

class Rollback extends Error {}

const pool = new Pool({ connectionString, max: 1 });
let result: PublishResult | undefined;
try {
  await withCuratorTransaction(pool, async (client) => {
    result = await publishDraft(client, actor, {
      changeNotes: notes,
      gitSha: process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
    });
    if (!confirm) throw new Rollback();
  });
} catch (error) {
  if (!(error instanceof Rollback)) throw error;
} finally {
  await pool.end();
}

console.log(
  'TAXONOMY_PUBLISH_DRAFT=' +
    JSON.stringify({
      published: confirm,
      version: result?.release.version,
      added: result?.diff.addedConcepts.length,
      removed: result?.diff.removedConcepts.length,
      changed: result?.diff.changedConcepts.length,
    }),
);
