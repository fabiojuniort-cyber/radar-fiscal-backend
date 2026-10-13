import 'dotenv/config';

import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import type { DB } from './database.types.js';
import { DOE_SP_SEARCH_API, DoeSpClient } from '../../modules/collection/doe-sp.client.js';
import { repairDoeSpIdentityCollision } from '../../modules/collection/doe-sp-identity-repair.js';
import { parseDoeSpDetail } from '../../modules/collection/doe-sp.parser.js';

/*
 * DOE-SP-40 repair B (tribusca-control Issue #1): splits a publication whose
 * STRONG identity was shared by two acts because of the truncated act number.
 *
 *   npm run db:repair-doe-sp-identity-collision -- --publication=<uuid>            (dry: checks, prints, rolls back)
 *   npm run db:repair-doe-sp-identity-collision -- --publication=<uuid> --confirm  (commits)
 *
 * Titles are read again from the official DOE-SP API (read-only, 1 request per
 * origin). Requires the fixed doeSpNormativeIdentity (same build).
 */

const args = process.argv.slice(2);
const publicationId = args.find((arg) => arg.startsWith('--publication='))?.slice('--publication='.length);
const confirm = args.includes('--confirm');
if (!publicationId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(publicationId)) {
  console.error('--publication=<uuid> is required.');
  process.exit(1);
}
const databaseUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_ADMIN_URL or DATABASE_URL is required.');
  process.exit(1);
}

const client = new DoeSpClient({ minRequestIntervalMs: 1_000 });
const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
try {
  const report = await repairDoeSpIdentityCollision(db, {
    publicationId,
    confirm,
    fetchAct: async (externalId) => {
      const response = await client.getJson(DOE_SP_SEARCH_API, 'v2/publications/' + externalId, {}, AbortSignal.timeout(60_000));
      const detail = parseDoeSpDetail(response.body, externalId);
      return { title: detail.title, slug: detail.slug, ...(detail.publicationType ? { publicationType: detail.publicationType } : {}) };
    },
  });
  console.log('DOE_SP_IDENTITY_REPAIR=' + JSON.stringify(report));
} catch (error) {
  console.error('DOE_SP_IDENTITY_REPAIR_FAILED=' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
} finally {
  await db.destroy();
}
