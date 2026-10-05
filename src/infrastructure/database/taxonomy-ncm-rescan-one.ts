import 'dotenv/config';

import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';

import {
  assertCurrentNcmCatalog,
  catalogMatches,
  extractNcmCandidates,
  persistSuccessfulScan,
  selectText,
} from '../../modules/taxonomy/ncm/publication-ncm.detector.js';
import type { DB } from './database.types.js';

/**
 * Re-detects the NCMs of ONE publication (its current version) and reports
 * them against the wording in force:
 *
 *   node dist/infrastructure/database/taxonomy-ncm-rescan-one.js \
 *     --publication=<uuid> [--confirm]
 *
 * Prints the codes of the wording in force found in the current NCM
 * catalog, those missing from the catalog and those that appear only in
 * previous wordings (ignored). With --confirm the scan is saved and replaces
 * what older detector versions found for this version.
 */

const arg = (name: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const publicationId = arg('publication');
const confirm = process.argv.includes('--confirm');
const databaseUrl = process.env.DATABASE_URL ?? process.env.DATABASE_ADMIN_URL;

if (!publicationId || !/^[0-9a-f-]{36}$/i.test(publicationId)) {
  console.error('Usage: taxonomy-ncm-rescan-one --publication=<uuid> [--confirm]');
  process.exit(1);
}
if (!databaseUrl) {
  console.error('DATABASE_URL (or DATABASE_ADMIN_URL) is required.');
  process.exit(1);
}

const format = (code: string) => `${code.slice(0, 4)}.${code.slice(4, 6)}.${code.slice(6)}`;

const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl, max: 2 }) }),
});

try {
  await assertCurrentNcmCatalog(db);
  const current = await sql<{
    publication_version_id: string;
    content_text: string | null;
    relevant_excerpt: string | null;
    presentation_html: string | null;
  }>`
    SELECT pv.id AS publication_version_id, pv.content_text, pv.relevant_excerpt,
      pv.source_metadata -> 'presentation' ->> 'html' AS presentation_html
    FROM publication_versions pv
    WHERE pv.publication_id = ${publicationId}::uuid AND pv.is_current = true
  `.execute(db);
  const row = current.rows[0];
  if (!row) throw new Error('PUBLICATION_NOT_FOUND');

  const { text, sourceField, currentWordingOnly } = selectText(row);
  const candidates = extractNcmCandidates(text);
  const everywhere = extractNcmCandidates(row.content_text ?? '');
  const inForce = new Set(candidates.map((candidate) => candidate.code));
  const matched = await db.transaction().execute(async (trx) => {
    const found = await catalogMatches(trx, [...inForce]);
    if (confirm) await persistSuccessfulScan(trx, row, sourceField, candidates, currentWordingOnly);
    return found;
  });

  const sorted = (codes: Iterable<string>) => [...codes].sort().map(format);
  console.log(
    'TAXONOMY_NCM_RESCAN_ONE=' +
      JSON.stringify({
        publicationVersionId: row.publication_version_id,
        currentWordingOnly,
        persisted: confirm,
        inForceCount: inForce.size,
        matchedCount: matched.size,
        matched: sorted(matched.keys()),
        notInCurrentCatalog: sorted([...inForce].filter((code) => !matched.has(code))),
        previousWordingOnly: sorted(
          new Set(everywhere.map((candidate) => candidate.code).filter((code) => !inForce.has(code))),
        ),
      }),
  );
} finally {
  await db.destroy();
}
