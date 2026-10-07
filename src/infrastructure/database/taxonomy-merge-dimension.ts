import 'dotenv/config';

import { Pool } from 'pg';

import { withCuratorTransaction, type CuratorActor } from '../../modules/taxonomy/curation/curation.draft.js';
import { mergeDimension, type MergeStep } from '../../modules/taxonomy/curation/curation.merge-dimension.js';
import { resolveCuratorDatabaseUrl } from './curator-url.js';

/**
 * Folds one dimension into another in the open DRAFT (creates one when none
 * is open) and retires the source:
 *
 *   node dist/infrastructure/database/taxonomy-merge-dimension.js \
 *     --from=treatment --into=theme [--group-map=cobranca_especial:cobranca_pagamento] [--confirm]
 *
 * Without --confirm everything runs and is rolled back (dry run). Also
 * prints how much the source items are used (classifier tags, curator tags,
 * company profiles) when DATABASE_ADMIN_URL can read those tables. Nothing
 * is published: the curator reviews the DRAFT before publishing.
 */

const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.split('=')[1]?.trim() ?? '';
const confirm = process.argv.includes('--confirm');
const from = arg('from');
const into = arg('into');
const groupMap = Object.fromEntries(
  arg('group-map')
    .split(',')
    .filter(Boolean)
    .map((pair) => pair.split(':').map((part) => part.trim()) as [string, string]),
);
if (!from || !into || from === into) {
  console.error('Usage: taxonomy-merge-dimension --from=treatment --into=theme [--group-map=a:b] [--confirm]');
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
  userId: 'ops:taxonomy-merge-dimension',
  justification: `Dimensão "${from}" unificada em "${into}" (itens repetidos entre as duas)`,
};

/** How much the source items are used today (read-only, best effort). */
async function usage(codes: string[]): Promise<unknown> {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url || codes.length === 0) return 'skipped';
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const tags = await pool.query<{ code: string; publications: number }>(
      `
        SELECT c.code, count(DISTINCT r.publication_version_id)::int AS publications
        FROM publication_taxonomy_assertions a
        JOIN publication_taxonomy_runs r ON r.id = a.run_id
        JOIN taxonomy_release_concepts rc ON rc.id = a.release_concept_id
        JOIN taxonomy_concepts c ON c.id = rc.concept_id
        WHERE c.code = ANY($1::text[]) AND a.assertion_status IN ('PROPOSED', 'CONFIRMED')
        GROUP BY c.code ORDER BY c.code
      `,
      [codes],
    );
    const curator = await pool.query<{ code: string; action: string; count: number }>(
      `
        SELECT c.code, t.action, count(*)::int AS count
        FROM publication_taxonomy_curator_tags t
        JOIN taxonomy_release_concepts rc ON rc.id = t.release_concept_id
        JOIN taxonomy_concepts c ON c.id = rc.concept_id
        WHERE c.code = ANY($1::text[])
        GROUP BY c.code, t.action ORDER BY c.code
      `,
      [codes],
    );
    const profiles = await pool.query<{ code: string; companies: number }>(
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
    return { classifierTags: tags.rows, curatorTags: curator.rows, profiles: profiles.rows };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    await pool.end();
  }
}

class Rollback extends Error {}

const pool = new Pool({ connectionString, max: 1 });
let result:
  | {
      draftVersion: string;
      draftCreated: boolean;
      steps: MergeStep[];
      retired: string[];
      transferredOfficialCodeType: string | null;
    }
  | undefined;
try {
  await withCuratorTransaction(pool, async (client) => {
    result = await mergeDimension(client, actor, from, into, groupMap);
    if (!confirm) throw new Rollback();
  });
} catch (error) {
  if (!(error instanceof Rollback)) throw error;
} finally {
  await pool.end();
}

console.log(
  'TAXONOMY_MERGE_DIMENSION=' +
    JSON.stringify({
      saved: confirm,
      from,
      into,
      draftVersion: result?.draftVersion,
      draftCreated: result?.draftCreated,
      merged: result?.steps.filter((step) => step.action === 'MERGE').length,
      restored: result?.steps.filter((step) => step.action === 'RESTORE').length,
      created: result?.steps.filter((step) => step.action === 'CREATE').length,
      transferredOfficialCodeType: result?.transferredOfficialCodeType ?? null,
      steps: result?.steps,
      retired: result?.retired,
      usage: await usage(result?.steps.map((step) => step.from) ?? []),
    }),
);
