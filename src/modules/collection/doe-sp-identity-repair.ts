import { sql, type Kysely } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';
import { publicationPageUrl } from './doe-sp.client.js';
import { doeSpNormativeIdentity, type DoeSpInclusionCategory } from './doe-sp.rules.js';
import { normalizePublication } from './publication.normalizer.js';

/*
 * DOE-SP-40 repair B (tribusca-control Issue #1). Before the fix in
 * doeSpNormativeIdentity, a title printed as "LEI Nº 17. 839" (stray space
 * after the thousands separator) was read as number 17, so two different laws
 * of the same day shared one STRONG identity ("17/2023"): the second capture
 * became "version 2" of the first law.
 *
 * This repair splits such a publication in one SERIALIZABLE transaction:
 * - each DOE-SP origin is paired with the version it produced: the official
 *   URL of the origin is the page of the version's DOE slug (the slug is the
 *   whole path, e.g. `executivo/leis/lei-n-...`);
 * - the official title of each origin is read again from the source (never
 *   guessed) and the identity is recomputed with the fixed rules and the real
 *   normalizer;
 * - the origin of the first version stays on the publication (identity and
 *   title corrected); every other origin moves, with its version (renumbered
 *   1, current), its collection_items and its run link, to a new publication.
 * Without `confirm` everything runs and is checked, then rolled back.
 */

export interface DoeSpOfficialAct {
  title: string;
  slug: string;
  publicationType?: string;
}

export interface DoeSpIdentityRepairInput {
  publicationId: string;
  /** Reads the act from the official source by DOE publication id. */
  fetchAct: (externalId: string) => Promise<DoeSpOfficialAct>;
  confirm: boolean;
}

export interface DoeSpIdentityRepairReport {
  mode: 'DRY' | 'COMMITTED';
  publicationId: string;
  before: { actNumber: string | null; origins: number; versions: number };
  kept: { publicationId: string; externalId: string; actNumber: string; versionId: string };
  created: Array<{ publicationId: string; externalId: string; actNumber: string; versionId: string; itemsMoved: number; runLinksMoved: number }>;
  postConditions: 'PASS';
}

export class DoeSpIdentityRepairError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'DoeSpIdentityRepairError';
  }
}

class DryRunRollback extends Error {
  constructor(readonly report: DoeSpIdentityRepairReport) { super('dry run'); }
}

const DISPOSITION: Record<string, 'NEW_PUBLICATION' | 'EXISTING_PUBLICATION' | 'NEW_VERSION'> = {
  PROCESSED_NEW: 'NEW_PUBLICATION',
  PROCESSED_EXISTING: 'EXISTING_PUBLICATION',
  NEW_VERSION: 'NEW_VERSION',
};

function fail(code: string, message: string): never {
  throw new DoeSpIdentityRepairError(code, message);
}

function metadata(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}


function isoDate(value: Date | string | null): string | undefined {
  if (value === null) return undefined;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

export async function repairDoeSpIdentityCollision(
  db: Kysely<DB>,
  input: DoeSpIdentityRepairInput,
): Promise<DoeSpIdentityRepairReport> {
  try {
    return await db.transaction().setIsolationLevel('serializable').execute(async (trx) => {
      await sql`SET LOCAL lock_timeout = '10s'`.execute(trx);
      await sql`SET LOCAL statement_timeout = '60s'`.execute(trx);

      const publication = await trx.selectFrom('publications').selectAll()
        .where('id', '=', input.publicationId).forUpdate().executeTakeFirst();
      if (!publication) fail('PUBLICATION_NOT_FOUND', input.publicationId);
      if (publication.identity_strength !== 'STRONG') fail('NOT_STRONG', 'only a STRONG identity can collide');

      const source = await trx.selectFrom('sources').select(['id'])
        .where('code', '=', 'doe-sp').where('connector_key', '=', 'doe-sp').executeTakeFirst();
      if (!source) fail('DOE_SP_SOURCE_NOT_FOUND', 'doe-sp');

      const origins = await trx.selectFrom('publication_origins').selectAll()
        .where('publication_id', '=', publication.id).orderBy('first_seen_at').orderBy('id').execute();
      const versions = await trx.selectFrom('publication_versions')
        .select(['id', 'version_no', 'is_current', 'captured_at', 'source_metadata'])
        .where('publication_id', '=', publication.id).orderBy('version_no').execute();
      if (origins.length < 2) fail('NO_COLLISION', `${origins.length} origin(s)`);
      if (origins.some((origin) => origin.source_id !== source.id || !origin.external_id)) {
        fail('FOREIGN_ORIGIN', 'every origin must be a DOE-SP origin with an external id');
      }
      if (versions.length !== origins.length) fail('SHAPE', `${origins.length} origins but ${versions.length} versions`);

      // Tenant links point at the publication, not at a version: they could not
      // be split safely (translations and files follow their version id).
      const companies = await trx.selectFrom('company_publications').select(sql<string>`count(*)`.as('n'))
        .where('publication_id', '=', publication.id).executeTakeFirstOrThrow();
      if (Number(companies.n) !== 0) fail('LINKED', `company_publications=${companies.n}`);

      // Pair each origin with its version: the origin URL is the page of the version's slug.
      const pairs = origins.map((origin) => {
        const matched = versions.filter((version) => {
          const slug = metadata(version.source_metadata).slug;
          return typeof slug === 'string' && publicationPageUrl(slug) === origin.official_url;
        });
        if (matched.length !== 1) fail('UNPAIRED', `origin ${origin.external_id} matches ${matched.length} version(s)`);
        return { origin, version: matched[0]! };
      });
      if (new Set(pairs.map((pair) => pair.version.id)).size !== pairs.length) fail('UNPAIRED', 'two origins share a version');

      // Official title from the source, identity recomputed with the fixed rules.
      const publishedOn = isoDate(publication.published_on);
      const computed = [];
      for (const pair of pairs) {
        const act = await input.fetchAct(pair.origin.external_id!);
        if (publicationPageUrl(act.slug) !== pair.origin.official_url) {
          fail('SLUG_MISMATCH', `source page ${publicationPageUrl(act.slug)} vs origin ${pair.origin.official_url}`);
        }
        const category = metadata(pair.version.source_metadata).captureCategory as DoeSpInclusionCategory | undefined;
        if (!category) fail('NO_CATEGORY', `version ${pair.version.id}`);
        const identity = doeSpNormativeIdentity({ title: act.title, ...(act.publicationType ? { typeName: act.publicationType } : {}), category });
        if (!identity) fail('NO_STRONG_IDENTITY', `origin ${pair.origin.external_id}`);
        const normalized = normalizePublication({
          sourceId: source.id,
          publication: {
            title: act.title,
            agency: identity.agency,
            sphere: publication.jurisdiction_level as 'STATE',
            ...(publication.uf ? { stateCode: publication.uf } : {}),
            actType: identity.actType,
            actNumber: identity.actNumber,
            ...(publishedOn ? { publishedAt: new Date(publishedOn + 'T00:00:00Z') } : {}),
            officialUrl: pair.origin.official_url,
            externalId: pair.origin.external_id!,
          },
        });
        if (normalized.identityStrength !== 'STRONG') fail('NO_STRONG_IDENTITY', `origin ${pair.origin.external_id}`);
        computed.push({ ...pair, title: act.title, identity, normalized });
      }
      if (new Set(computed.map((entry) => entry.normalized.identityHash)).size !== computed.length) {
        fail('STILL_COLLIDING', 'the corrected identities are not distinct');
      }
      if (computed.some((entry) => entry.normalized.identityHash === publication.identity_hash)) {
        fail('UNCHANGED', 'a corrected identity equals the current one (nothing to split)');
      }
      const taken = await trx.selectFrom('publications').select('id')
        .where('identity_hash', 'in', computed.map((entry) => entry.normalized.identityHash)).execute();
      if (taken.length) fail('IDENTITY_TAKEN', `${taken.length} publication(s) already hold a corrected identity`);

      const before = {
        publications: Number((await sql<{ n: string }>`SELECT count(*) AS n FROM publications`.execute(trx)).rows[0]!.n),
        versions: Number((await sql<{ n: string }>`SELECT count(*) AS n FROM publication_versions`.execute(trx)).rows[0]!.n),
        origins: Number((await sql<{ n: string }>`SELECT count(*) AS n FROM publication_origins`.execute(trx)).rows[0]!.n),
        items: Number((await sql<{ n: string }>`SELECT count(*) AS n FROM collection_items`.execute(trx)).rows[0]!.n),
      };

      // The first version's origin stays; the others move out.
      computed.sort((a, b) => a.version.version_no - b.version.version_no);
      const [keep, ...moves] = computed;
      const report: DoeSpIdentityRepairReport = {
        mode: input.confirm ? 'COMMITTED' : 'DRY',
        publicationId: publication.id,
        before: { actNumber: publication.act_number, origins: origins.length, versions: versions.length },
        kept: { publicationId: publication.id, externalId: keep!.origin.external_id!, actNumber: keep!.identity.actNumber, versionId: keep!.version.id },
        created: [],
        postConditions: 'PASS',
      };

      for (const move of moves) {
        const created = await trx.insertInto('publications').values({
          identity_hash: move.normalized.identityHash,
          identity_version: publication.identity_version,
          identity_strength: move.normalized.identityStrength,
          identity_basis: JSON.stringify(move.normalized.identityBasis),
          jurisdiction_level: publication.jurisdiction_level,
          uf: publication.uf,
          agency: move.normalized.agency ?? null,
          act_type: move.normalized.actType ?? null,
          act_number: move.normalized.actNumber ?? null,
          title: move.title,
          published_on: publication.published_on,
          effective_on: publication.effective_on,
          primary_official_url: move.origin.official_url,
          first_collected_at: move.origin.first_seen_at,
          last_seen_at: move.origin.last_seen_at,
        }).returning('id').executeTakeFirstOrThrow();

        await trx.updateTable('publication_origins').set({ publication_id: created.id })
          .where('id', '=', move.origin.id).execute();
        // Leave the current slot of the old publication before taking version 1 here.
        await trx.updateTable('publication_versions').set({ publication_id: created.id, version_no: 1, is_current: true })
          .where('id', '=', move.version.id).execute();
        // Collection history of the moved act follows it. Its first capture was
        // recorded as a "new version" of the other law; it was a new publication.
        const movedItems = await trx.selectFrom('collection_items').select(['id', 'collection_run_id', 'status'])
          .where('publication_id', '=', publication.id).where('external_id', '=', move.origin.external_id!)
          .orderBy('created_at').orderBy('id').execute();
        const runs = new Map<string, string>();
        for (const [index, item] of movedItems.entries()) {
          const status = index === 0 ? 'PROCESSED_NEW' : item.status;
          await trx.updateTable('collection_items').set({ publication_id: created.id, status, updated_at: new Date() })
            .where('id', '=', item.id).execute();
          if (!runs.has(item.collection_run_id)) runs.set(item.collection_run_id, status);
        }
        let runLinksMoved = 0;
        for (const [runId, status] of runs) {
          const link = await trx.selectFrom('collection_run_publications').selectAll()
            .where('collection_run_id', '=', runId).where('publication_id', '=', publication.id).executeTakeFirst();
          await trx.insertInto('collection_run_publications').values({
            collection_run_id: runId,
            publication_id: created.id,
            publication_version_id: move.version.id,
            disposition: DISPOSITION[status] ?? 'EXISTING_PUBLICATION',
            ...(link ? { detected_at: link.detected_at } : {}),
          }).execute();
          runLinksMoved += 1;
          if (link?.publication_version_id === move.version.id) {
            const remaining = await trx.selectFrom('collection_items').select('id')
              .where('collection_run_id', '=', runId).where('publication_id', '=', publication.id).executeTakeFirst();
            if (remaining) {
              await trx.updateTable('collection_run_publications').set({ publication_version_id: keep!.version.id })
                .where('collection_run_id', '=', runId).where('publication_id', '=', publication.id).execute();
            } else {
              await trx.deleteFrom('collection_run_publications')
                .where('collection_run_id', '=', runId).where('publication_id', '=', publication.id).execute();
            }
          }
        }
        report.created.push({
          publicationId: created.id,
          externalId: move.origin.external_id!,
          actNumber: move.identity.actNumber,
          versionId: move.version.id,
          itemsMoved: movedItems.length,
          runLinksMoved,
        });
      }

      // The publication keeps the first law: its version is current again.
      await trx.updateTable('publication_versions').set({ is_current: true })
        .where('id', '=', keep!.version.id).execute();
      await trx.updateTable('publications').set({
        identity_hash: keep!.normalized.identityHash,
        identity_basis: JSON.stringify(keep!.normalized.identityBasis),
        act_number: keep!.normalized.actNumber ?? null,
        agency: keep!.normalized.agency ?? null,
        act_type: keep!.normalized.actType ?? null,
        title: keep!.title,
        primary_official_url: keep!.origin.official_url,
        updated_at: new Date(),
      }).where('id', '=', publication.id).execute();

      // ---- post-conditions
      const after = {
        publications: Number((await sql<{ n: string }>`SELECT count(*) AS n FROM publications`.execute(trx)).rows[0]!.n),
        versions: Number((await sql<{ n: string }>`SELECT count(*) AS n FROM publication_versions`.execute(trx)).rows[0]!.n),
        origins: Number((await sql<{ n: string }>`SELECT count(*) AS n FROM publication_origins`.execute(trx)).rows[0]!.n),
        items: Number((await sql<{ n: string }>`SELECT count(*) AS n FROM collection_items`.execute(trx)).rows[0]!.n),
      };
      if (after.publications !== before.publications + moves.length || after.versions !== before.versions ||
        after.origins !== before.origins || after.items !== before.items) {
        fail('POST_COUNTS', JSON.stringify({ before, after }));
      }
      for (const id of [publication.id, ...report.created.map((entry) => entry.publicationId)]) {
        const shape = (await sql<{ origins: string; versions: string; current: string }>`
          SELECT
            (SELECT count(*) FROM publication_origins WHERE publication_id = ${id}) AS origins,
            (SELECT count(*) FROM publication_versions WHERE publication_id = ${id}) AS versions,
            (SELECT count(*) FROM publication_versions WHERE publication_id = ${id} AND is_current) AS current`.execute(trx)).rows[0]!;
        if (Number(shape.origins) !== 1 || Number(shape.versions) !== 1 || Number(shape.current) !== 1) {
          fail('POST_SHAPE', `${id}: ${JSON.stringify(shape)}`);
        }
      }

      if (!input.confirm) throw new DryRunRollback(report);
      return report;
    });
  } catch (error) {
    if (error instanceof DryRunRollback) return error.report;
    throw error;
  }
}
