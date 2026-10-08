import 'dotenv/config';

import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';

import {
  assertCurrentNcmCatalog,
  catalogMatches,
  extractNcmCandidates,
  codesOutsideAttestedCurrent,
  persistSuccessfulScan,
  selectText,
} from '../../modules/taxonomy/ncm/publication-ncm.detector.js';
import { brazilLegalReferenceDate } from '../../modules/taxonomy/legal-scope/legal-scope-evidence.js';
import { readVerifiedLegalScope } from '../../modules/taxonomy/legal-scope/legal-scope.repository.js';
import type { DB } from './database.types.js';

/**
 * Re-detects the NCMs of ONE publication (its current version) and reports
 * them against only explicitly attested CURRENT fragments:
 *
 *   node dist/infrastructure/database/taxonomy-ncm-rescan-one.js \
 *     --publication=<uuid> [--confirm]
 *
 * Prints the NCMs in the attested CURRENT fragments separately from the
 * unverified candidates elsewhere in raw content (not presumed PREVIOUS).
 * --confirm requires legal proof and writes detector 1.3.0 without erasing
 * historical scans or overwriting previous classifications.
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

  const asOf = arg('as-of') ?? brazilLegalReferenceDate();
  const evidence = await readVerifiedLegalScope(db, {
    publicationVersionId: row.publication_version_id,
    sanitizedHtml: row.presentation_html ?? '',
    asOf,
  });
  // A dry-run may explain historical vs. current candidates, but only
  // content actually backed by the audited official-scope ledger can
  // be saved as the 1.3.0 detector SUCCESS seal. Never let an unverified
  // HTML style or a curator CLI flag supersede earlier NCM evidence.
  if (confirm && (!evidence.valid || evidence.currentSegments === 0)) {
    throw new Error('TAX13_OFFICIAL_LEGAL_SCOPE_REQUIRED: ' +
      (evidence.reason ?? 'NO_ATTESTED_CURRENT_FRAGMENT'));
  }
  // No "in force" assertion, even in a dry-run, without audited evidence.
  const trusted = evidence.valid && evidence.currentSegments > 0;
  const text = trusted ? evidence.currentText : '';
  const sourceField = trusted ? 'CONTENT_TEXT' as const : 'NONE' as const;
  const currentWordingOnly = trusted;
  const candidates = extractNcmCandidates(text);
  const heuristicPreview = !trusted
    ? extractNcmCandidates(selectText(row).text)
    : [];
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
        asOf,
        legalScopeVerified: evidence.valid,
        legalScopeReason: evidence.reason,
        legalScopeAttestationId: evidence.attestationId,
        unverifiedHeuristicPreview: sorted(heuristicPreview.map((item) => item.code)),
        currentWordingOnly,
        persisted: confirm,
        inForceCount: inForce.size,
        matchedCount: matched.size,
        matched: sorted(matched.keys()),
        notInCurrentCatalog: sorted([...inForce].filter((code) => !matched.has(code))),
        // These are NOT automatically "previous wording": provenance unknown.
        outsideAttestedCurrentUnverified: sorted(
          codesOutsideAttestedCurrent(row.content_text, text),
        ),
      }),
  );
} finally {
  await db.destroy();
}
