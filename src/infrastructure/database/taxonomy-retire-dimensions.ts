import 'dotenv/config';

import { Pool } from 'pg';

import { findOpenDraft, pgRunner } from '../../modules/taxonomy/curation/curation.read.js';
import {
  createDraft,
  retireDimension,
  withCuratorTransaction,
  type CuratorActor,
  type RetireDimensionResult,
} from '../../modules/taxonomy/curation/curation.draft.js';
import { resolveCuratorDatabaseUrl } from './curator-url.js';

/**
 * Retires whole dimensions in the open DRAFT (creates one when none is open):
 *
 *   node dist/infrastructure/database/taxonomy-retire-dimensions.js \
 *     --dimensions=act_type,sphere [--confirm]
 *
 * "Tipo de ato" and "Esfera" repeat what each act already carries from its
 * source (act type and jurisdiction, used by the Acervo filters) and do not
 * count in the affinity; as tags they only add noise. Without --confirm
 * everything runs and is rolled back (dry run). Nothing is published: the
 * curator reviews the DRAFT before publishing.
 */

const confirm = process.argv.includes('--confirm');
const dimensions = (process.argv.find((value) => value.startsWith('--dimensions='))?.split('=')[1] ?? '')
  .split(',')
  .map((code) => code.trim())
  .filter(Boolean);
if (dimensions.length === 0) {
  console.error('Usage: taxonomy-retire-dimensions --dimensions=act_type,sphere [--confirm]');
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
  userId: 'ops:taxonomy-retire-dimensions',
  justification: 'Dimensões redundantes com os metadados do ato (tipo de ato e esfera vêm da fonte)',
};

class Rollback extends Error {}

const pool = new Pool({ connectionString, max: 1 });
const result: {
  draftVersion?: string;
  draftCreated: boolean;
  retired: Record<string, RetireDimensionResult>;
} = {
  draftCreated: false,
  retired: {},
};
try {
  await withCuratorTransaction(pool, async (client) => {
    let draft = await findOpenDraft(pgRunner(client));
    if (!draft) {
      draft = (await createDraft(client, actor)).draft;
      result.draftCreated = true;
    }
    result.draftVersion = draft.version;
    for (const code of dimensions) {
      result.retired[code] = await retireDimension(client, actor, code);
    }
    if (!confirm) throw new Rollback();
  });
} catch (error) {
  if (!(error instanceof Rollback)) throw error;
} finally {
  await pool.end();
}

console.log(
  'TAXONOMY_RETIRE_DIMENSIONS=' +
    JSON.stringify({
      saved: confirm,
      draftVersion: result.draftVersion,
      draftCreated: result.draftCreated,
      retired: Object.fromEntries(
        Object.entries(result.retired).map(([code, item]) => [
          code,
          {
            count: item.retiredConcepts.length,
            items: item.retiredConcepts,
            removedGroups: item.removedGroups,
            removedRelationRules: item.removedRelationRules,
            removedRelations: item.removedRelations,
            removedOfficialMappings: item.removedOfficialMappings,
          },
        ]),
      ),
    }),
);
