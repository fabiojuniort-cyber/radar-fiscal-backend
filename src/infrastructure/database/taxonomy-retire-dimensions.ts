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
 * Whole dimensions leave only the new DRAFT; published history is immutable.
 * Without --confirm everything runs and is rolled back (dry run). Nothing is
 * published: the curator reviews the DRAFT before publishing.
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
  justification: 'Retirada de dimensões aprovada para a taxonomia corrente',
};

async function usage(codes: string[]): Promise<unknown> {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url || codes.length === 0) return 'skipped';
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const companies = await pool.query<{ code: string; companies: number }>(
      `
        SELECT code, count(DISTINCT p.company_id)::int AS companies
        FROM company_tax_profiles p,
          jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(p.personalization->'taxonomy'->'conceptCodes') = 'array'
              THEN p.personalization->'taxonomy'->'conceptCodes' ELSE '[]'::jsonb END
          ) AS code
        WHERE code = ANY($1::text[])
        GROUP BY code ORDER BY code
      `,
      [codes],
    );
    const monitoring = await pool.query<{ code: string; profiles: number }>(
      `
        SELECT criterion.code, count(DISTINCT p.id)::int AS profiles
        FROM monitoring_profiles p
        CROSS JOIN LATERAL (
          SELECT jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(p.criteria->'taxonomy'->'anyOf') = 'array'
              THEN p.criteria->'taxonomy'->'anyOf' ELSE '[]'::jsonb END
          ) AS code
          UNION ALL
          SELECT jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(p.criteria->'taxonomy'->'allOf') = 'array'
              THEN p.criteria->'taxonomy'->'allOf' ELSE '[]'::jsonb END
          )
          UNION ALL
          SELECT jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(p.criteria->'taxonomy'->'noneOf') = 'array'
              THEN p.criteria->'taxonomy'->'noneOf' ELSE '[]'::jsonb END
          )
        ) criterion
        WHERE criterion.code = ANY($1::text[])
        GROUP BY criterion.code ORDER BY criterion.code
      `,
      [codes],
    );
    return {
      companyTaxProfiles: companies.rows,
      monitoringProfiles: monitoring.rows,
    };
  } finally {
    await pool.end();
  }
}

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
      usage: await usage(
        Object.values(result.retired).flatMap((item) => item.retiredConcepts),
      ),
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
