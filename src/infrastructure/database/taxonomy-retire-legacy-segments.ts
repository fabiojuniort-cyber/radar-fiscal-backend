import 'dotenv/config';

import { Pool } from 'pg';

import { withCuratorTransaction, type CuratorActor } from '../../modules/taxonomy/curation/curation.draft.js';
import {
  retireLegacySegments,
  type LegacySegmentResult,
} from '../../modules/taxonomy/curation/curation.legacy-segments.js';
import { resolveCuratorDatabaseUrl } from './curator-url.js';

/**
 * Moves groups linked to the old baseline sector items to the TriFaros
 * segments and retires the old items, in the open DRAFT (rules in
 * curation.legacy-segments.ts):
 *
 *   node dist/infrastructure/database/taxonomy-retire-legacy-segments.js [--confirm]
 *
 * Without --confirm everything runs and is rolled back (dry run). Nothing is
 * published: the curator reviews the DRAFT before publishing.
 */

const confirm = process.argv.includes('--confirm');

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
  userId: 'ops:taxonomy-retire-legacy-segments',
  justification: 'Segmentos antigos (baseline) substituídos pela tabela Segmento TriFaros',
};

class Rollback extends Error {}

const pool = new Pool({ connectionString, max: 1 });
let result: LegacySegmentResult | undefined;
try {
  await withCuratorTransaction(pool, async (client) => {
    result = await retireLegacySegments(client, actor);
    if (!confirm || result.missingTargets.length > 0) throw new Rollback();
  });
} catch (error) {
  if (!(error instanceof Rollback)) throw error;
} finally {
  await pool.end();
}

const saved = confirm && result !== undefined && result.missingTargets.length === 0;
console.log(
  'TAXONOMY_RETIRE_LEGACY_SEGMENTS=' +
    JSON.stringify({
      saved,
      draftVersion: result?.draftVersion,
      draftCreated: result?.draftCreated,
      groupsMoved: result?.groupUpdates.length,
      retired: result?.retire.length,
      missingTargets: result?.missingTargets,
      groups: result?.groupUpdates.map((item) => `${item.group}: ${item.from.join(',')} -> ${item.to.join(',')}`),
    }),
);
if (confirm && !saved) process.exitCode = 2;
