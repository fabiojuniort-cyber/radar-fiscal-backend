import type {
  FastifyInstance,
  FastifyRequest,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, type RawBuilder } from 'kysely';
import { z } from 'zod';

import { aggregateCacheOptions } from '../../infrastructure/cache/aggregate-cache.js';
import { TtlCache } from '../../infrastructure/cache/ttl-cache.js';
import {
  TenantAccessDeniedError,
  withTenantContext,
} from '../../infrastructure/database/tenant-context.js';
import { buildSearchTsquery } from '../../modules/catalog/search-query.js';
import {
  CURATED_ENGINE_KEY,
  CURATED_ENGINE_VERSION,
} from '../../modules/taxonomy/classification/classification.curated.js';
import { derivePublicSourceStatus } from './public.route.js';

const SAO_PAULO_TZ = 'America/Sao_Paulo';

/** Above this many matches the Acervo reports "more than N" instead of counting. */
export const ARCHIVE_COUNT_CAP = 10_000;

const BRAZILIAN_UFS = [
  'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS',
  'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC',
  'SE', 'SP', 'TO',
];

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function saoPauloDateToday(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SAO_PAULO_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) {
    throw new Error('Unable to derive Sao Paulo current date.');
  }
  return `${year}-${month}-${day}`;
}

const archiveDateSchema = z
  .string()
  .trim()
  .refine(isCalendarDate, 'invalid_calendar_date');

const archiveQuerySchema = z
  .object({
    q: z.string().trim().min(2).max(200).optional(),
    // title: act type, number, agency and title (default); full: also the
    // full content.
    scope: z.enum(['title', 'full']).default('title'),
    uf: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/)
      .transform((value) => value.toUpperCase())
      .optional(),
    jurisdiction: z.enum(['FEDERAL', 'STATE']).optional(),
    source: z.string().trim().min(1).max(100).optional(),
    actType: z.string().trim().min(1).max(200).optional(),
    publishedOn: archiveDateSchema.optional(),
    publishedFrom: archiveDateSchema.optional(),
    publishedTo: archiveDateSchema.optional(),
    ncm: z.preprocess(
      (value) =>
        typeof value === 'string'
          ? value.replace(/\D/g, '')
          : value,
      z.string().regex(/^\d{8}$/).optional(),
    ),
    // TAX-11: taxonomy tag (concept code) of the latest published release.
    tag: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/)
      .optional(),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(25),
  })
  .superRefine((value, ctx) => {
    if (value.publishedOn && (value.publishedFrom || value.publishedTo)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'publishedOn_cannot_be_combined_with_range',
        path: ['publishedOn'],
      });
    }

    if (
      value.publishedFrom &&
      value.publishedTo &&
      value.publishedFrom > value.publishedTo
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'publishedFrom_must_not_be_after_publishedTo',
        path: ['publishedFrom'],
      });
    }

    const today = saoPauloDateToday();
    for (const [field, date] of [
      ['publishedOn', value.publishedOn],
      ['publishedFrom', value.publishedFrom],
      ['publishedTo', value.publishedTo],
    ] as const) {
      if (date && date > today) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'future_publication_date_not_allowed',
          path: [field],
        });
      }
    }
  });

type ArchiveQuery = z.infer<typeof archiveQuerySchema>;

function tenantIdFromRequest(
  request: FastifyRequest,
): string | null {
  const raw = request.headers['x-tenant-id'];
  if (typeof raw !== 'string') return null;
  return z.string().uuid().safeParse(raw).success ? raw : null;
}

// Hidden families and CONFAZ-typed acts are stored flags on publications
// (is_hidden / is_confaz, migrations/029_catalog_scale.sql), and
// publication_source_feed holds the source-filter membership.

const startOfTodaySql = sql<Date>`
  (date_trunc('day', now() AT TIME ZONE ${SAO_PAULO_TZ}) AT TIME ZONE ${SAO_PAULO_TZ})
`;

const startOfTomorrowSql = sql<Date>`
  ((date_trunc('day', now() AT TIME ZONE ${SAO_PAULO_TZ}) + interval '1 day') AT TIME ZONE ${SAO_PAULO_TZ})
`;

interface ArchivePlan {
  /** Joins the source feed as `f` only when that is the best driving index. */
  feedJoin: RawBuilder<unknown>;
  /** Visibility, source, UF, jurisdiction, act-type and date filters (no search). */
  filters: RawBuilder<boolean>;
  /** filters AND the per-row search condition, for the date-walk strategy. */
  where: RawBuilder<boolean>;
  order: RawBuilder<unknown>;
  /** Publications matching the search, for the match-first strategy. */
  searchIds: RawBuilder<unknown> | null;
}

function buildArchivePlan(
  input: ArchiveQuery,
  sourceCode: string | null,
  tsquery: string | null,
): ArchivePlan {
  const conditions: RawBuilder<boolean>[] = [];
  let feedJoin: RawBuilder<unknown>;
  let order: RawBuilder<unknown>;

  if (sourceCode && input.actType) {
    // When actType is present, drive the date walk from the dedicated
    // act-type index and probe source membership by the feed primary key.
    // This avoids scanning a very large source feed to find a selective type.
    feedJoin = sql``;
    conditions.push(sql<boolean>`NOT p.is_hidden`);
    conditions.push(sql<boolean>`
      EXISTS (
        SELECT 1
        FROM publication_source_feed sf
        WHERE sf.source_code = ${sourceCode}
          AND sf.publication_id = p.id
          AND NOT sf.is_hidden
      )
    `);
    order = sql`p.published_on DESC NULLS LAST, p.first_collected_at DESC, p.id`;
  } else if (sourceCode) {
    // One feed row per (semantic source code, publication): no duplicates
    // even when sources.code has case variants; "confaz" needs no sources row.
    feedJoin = sql`JOIN publication_source_feed f ON f.publication_id = p.id`;
    conditions.push(sql<boolean>`f.source_code = ${sourceCode}`);
    conditions.push(sql<boolean>`NOT f.is_hidden`);
    order = sql`f.published_on DESC NULLS LAST, f.first_collected_at DESC, f.publication_id`;
  } else {
    feedJoin = sql``;
    conditions.push(sql<boolean>`NOT p.is_hidden`);
    order = sql`p.published_on DESC NULLS LAST, p.first_collected_at DESC, p.id`;
  }

  if (input.uf) {
    conditions.push(sql<boolean>`p.uf = ${input.uf}`);
  }
  if (input.jurisdiction) {
    conditions.push(
      sql<boolean>`p.jurisdiction_level = ${input.jurisdiction}`,
    );
  }
  if (input.actType) {
    // The Acervo deliberately filters on the exact official value collected
    // in publications.act_type. Normalization belongs to a separate taxonomy
    // decision and must not silently rewrite the legal reference here.
    conditions.push(sql<boolean>`p.act_type = ${input.actType}`);
  }

  // source + actType deliberately avoids joining the feed, so publication
  // dates must come from p in that path. Source-only can use the feed's
  // indexed date directly. Both columns represent the same official date.
  const publishedColumn = sourceCode && !input.actType
    ? sql`f.published_on`
    : sql`p.published_on`;
  if (input.publishedOn) {
    conditions.push(
      sql<boolean>`${publishedColumn} = ${input.publishedOn}::date`,
    );
  } else {
    if (input.publishedFrom) {
      conditions.push(
        sql<boolean>`${publishedColumn} >= ${input.publishedFrom}::date`,
      );
    }
    if (input.publishedTo) {
      conditions.push(
        sql<boolean>`${publishedColumn} <= ${input.publishedTo}::date`,
      );
    }
  }

  if (input.ncm) {
    // Same meaning as the NCM-03 filter: a catalog-matched mention on the
    // current version.
    conditions.push(sql<boolean>`
      EXISTS (
        SELECT 1
        FROM publication_versions ncm_pv
        JOIN publication_ncm_mentions pnm_filter
          ON pnm_filter.publication_version_id = ncm_pv.id
        WHERE ncm_pv.publication_id = p.id
          AND ncm_pv.is_current = true
          AND pnm_filter.verification_status = 'CATALOG_MATCHED'
          AND pnm_filter.ncm_code = ${input.ncm}
      )
    `);
  }

  // TAX-11: effective tags on the current version for the latest PUBLISHED
  // release. The curator's latest decision for (version, concept identity)
  // wins across releases: REMOVE hides an automatic tag, ADD shows the tag
  // even without an automatic assertion. Without a decision, an automatic
  // assertion counts unless its latest review is REJECT.
  const tagIds = input.tag
    ? sql`
        SELECT tag_pv.publication_id
        FROM taxonomy_release_concepts tag_rc
        JOIN taxonomy_concepts tag_c ON tag_c.id = tag_rc.concept_id
        JOIN publication_taxonomy_assertions tag_a
          ON tag_a.release_concept_id = tag_rc.id
         AND tag_a.taxonomy_release_id = tag_rc.release_id
        JOIN publication_taxonomy_scans tag_s
          ON tag_s.run_id = tag_a.run_id
         AND tag_s.status = 'SUCCESS'
         AND tag_s.engine_key = ${CURATED_ENGINE_KEY}
         AND tag_s.engine_version = ${CURATED_ENGINE_VERSION}
        JOIN publication_versions tag_pv
          ON tag_pv.id = tag_s.publication_version_id
         AND tag_pv.is_current = true
        LEFT JOIN LATERAL (
          SELECT ct.action
          FROM publication_taxonomy_curator_tags ct
          JOIN taxonomy_release_concepts ct_rc ON ct_rc.id = ct.release_concept_id
          WHERE ct.publication_version_id = tag_pv.id
            AND ct_rc.concept_id = tag_c.id
          ORDER BY ct.created_at DESC, ct.id DESC
          LIMIT 1
        ) tag_decision ON true
        WHERE tag_c.code = ${input.tag}
          AND tag_rc.release_id = (
            SELECT id FROM taxonomy_releases
            WHERE status = 'PUBLISHED'
            ORDER BY version_major DESC, version_minor DESC, version_patch DESC
            LIMIT 1
          )
          AND (
            tag_decision.action = 'ADD'
            OR (
              tag_decision.action IS NULL
              AND COALESCE((
                SELECT r.decision
                FROM publication_taxonomy_reviews r
                WHERE r.assertion_id = tag_a.id
                ORDER BY r.created_at DESC, r.id DESC
                LIMIT 1
              ), 'CONFIRM') <> 'REJECT'
            )
          )
        UNION
        SELECT tag_pv.publication_id
        FROM (
          SELECT DISTINCT ON (ct.publication_version_id)
            ct.publication_version_id, ct.action, ct_rc.concept_id
          FROM publication_taxonomy_curator_tags ct
          JOIN taxonomy_release_concepts ct_rc ON ct_rc.id = ct.release_concept_id
          JOIN taxonomy_concepts ct_c ON ct_c.id = ct_rc.concept_id
          WHERE ct_c.code = ${input.tag}
          ORDER BY ct.publication_version_id, ct.created_at DESC, ct.id DESC
        ) latest_ct
        JOIN publication_versions tag_pv
          ON tag_pv.id = latest_ct.publication_version_id
         AND tag_pv.is_current = true
        WHERE latest_ct.action = 'ADD'
          AND EXISTS (
            SELECT 1
            FROM taxonomy_release_concepts cur_rc
            WHERE cur_rc.concept_id = latest_ct.concept_id
              AND cur_rc.membership_status = 'INCLUDED'
              AND cur_rc.release_id = (
                SELECT id FROM taxonomy_releases
                WHERE status = 'PUBLISHED'
                ORDER BY version_major DESC, version_minor DESC, version_patch DESC
                LIMIT 1
              )
          )
      `
    : null;

  if (tagIds) {
    conditions.push(sql<boolean>`p.id IN (${tagIds})`);
  }

  const filters = sql.join(conditions, sql` AND `) as RawBuilder<boolean>;
  // Without a text search, an NCM filter is the selective condition: fetch
  // its publications through the mention code index first.
  let searchIds: RawBuilder<unknown> | null = tagIds && !input.ncm
    ? tagIds
    : input.ncm
    ? sql`
        SELECT DISTINCT ncm_pv.publication_id
        FROM publication_ncm_mentions pnm
        JOIN publication_versions ncm_pv
          ON ncm_pv.id = pnm.publication_version_id
        WHERE pnm.ncm_code = ${input.ncm}
          AND pnm.verification_status = 'CATALOG_MATCHED'
          AND ncm_pv.is_current = true
      `
    : null;

  if (tsquery) {
    const query = sql`to_tsquery('public.pt_unaccent', ${tsquery})`;

    if (input.scope === 'full') {
      conditions.push(sql<boolean>`
        (
          p.title_vector @@ ${query}
          OR EXISTS (
            SELECT 1
            FROM publication_versions pv
            WHERE pv.publication_id = p.id
              AND pv.is_current
              AND pv.search_vector @@ ${query}
          )
        )
      `);
      searchIds = sql`
        SELECT t.id AS publication_id
        FROM publications t
        WHERE NOT t.is_hidden
          AND t.title_vector @@ ${query}
        UNION
        SELECT pv.publication_id
        FROM publication_versions pv
        WHERE pv.is_current
          AND pv.search_vector @@ ${query}
      `;
    } else {
      conditions.push(sql<boolean>`p.title_vector @@ ${query}`);
      searchIds = sql`
        SELECT t.id AS publication_id
        FROM publications t
        WHERE NOT t.is_hidden
          AND t.title_vector @@ ${query}
      `;
    }
  }

  return {
    feedJoin,
    filters,
    where: sql.join(conditions, sql` AND `) as RawBuilder<boolean>,
    order,
    searchIds,
  };
}

interface ArchiveRow {
  id: string;
  title: string;
  act_type: string | null;
  act_number: string | null;
  agency: string | null;
  jurisdiction_level: string;
  uf: string | null;
  published_on: Date | string | null;
  effective_on: Date | string | null;
  relevant_excerpt: string | null;
  official_url: string | null;
  source_code: string | null;
  source_name: string | null;
}

interface ArchiveFacets {
  ufs: string[];
  sources: Array<{ code: string; name: string }>;
  actTypes: string[];
}

interface PublicStatsV2 {
  totalPublications: number;
  totalSources: number;
  activeSources: number;
  importedToday: number;
  generatedAt: string;
}

interface PublicSourcesV2 {
  generatedAt: string;
  items: Array<{
    code: string;
    name: string;
    jurisdictionLevel: string;
    uf: string | null;
    isActive: boolean;
    status: ReturnType<typeof derivePublicSourceStatus>;
    lastRunStatus: string | null;
    lastSuccessAt: string | null;
    lastAttemptAt: string | null;
    importedToday: number;
    totalPublications: number;
  }>;
}

function toDateOnly(value: Date | string | null): string | null {
  if (!value) return null;
  return new Date(value).toISOString().slice(0, 10);
}

async function verifyTenantAccess(
  app: FastifyInstance,
  request: FastifyRequest,
  tenantId: string,
): Promise<boolean> {
  if (!request.auth) return false;

  try {
    const tenant = await withTenantContext(
      app.db,
      request.auth.userId,
      tenantId,
      async (trx) =>
        trx
          .selectFrom('tenants')
          .select('id')
          .where('id', '=', tenantId)
          .executeTakeFirst(),
    );
    return Boolean(tenant);
  } catch (error) {
    if (error instanceof TenantAccessDeniedError) return false;
    throw error;
  }
}

export async function catalogMonitoringRoutes(
  app: FastifyInstance,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // Catalog aggregates are global (not tenant-scoped) and change only when a
  // collection run lands, so they are served from an in-process cache.
  const cacheOptions = aggregateCacheOptions(app);
  const archiveCountCache = new TtlCache<number>({
    ...cacheOptions,
    maxEntries: 500,
  });
  const facetsCache = new TtlCache<ArchiveFacets>(cacheOptions);
  const statsCache = new TtlCache<PublicStatsV2>(cacheOptions);
  const sourcesCache = new TtlCache<PublicSourcesV2>(cacheOptions);
  const sourceCountsCache = new TtlCache<Map<string, number>>(cacheOptions);

  /** Visible publications per semantic source code (feed rows). */
  async function loadSourceCounts(): Promise<Map<string, number>> {
    const result = await sql<{ source_code: string; total: number }>`
      SELECT f.source_code, count(*)::int AS total
      FROM publication_source_feed f
      WHERE NOT f.is_hidden
      GROUP BY f.source_code
    `.execute(app.db);

    return new Map(
      result.rows.map((row) => [row.source_code, row.total]),
    );
  }

  async function loadStats(): Promise<PublicStatsV2> {
    const result = await sql<{
      total_publications: number;
      total_sources: number;
      active_sources: number;
      imported_today: number;
    }>`
      SELECT
        visible.total_publications,
        visible.imported_today,
        (
          SELECT count(*)::int
          FROM sources
        ) AS total_sources,
        (
          SELECT count(*)::int
          FROM sources
          WHERE is_active = true
        ) AS active_sources
      FROM (
        SELECT
          count(*)::int AS total_publications,
          count(*) FILTER (
            WHERE p.first_collected_at >= ${startOfTodaySql}
              AND p.first_collected_at < ${startOfTomorrowSql}
          )::int AS imported_today
        FROM publications p
        WHERE NOT p.is_hidden
      ) visible
    `.execute(app.db);

    const row = result.rows[0];
    return {
      totalPublications: row?.total_publications ?? 0,
      totalSources: row?.total_sources ?? 0,
      activeSources: row?.active_sources ?? 0,
      importedToday: row?.imported_today ?? 0,
      generatedAt: new Date().toISOString(),
    };
  }

  async function loadSources(): Promise<PublicSourcesV2> {
    const generatedAt = new Date();
    // publication_source_feed already applies the CONFAZ/DOU membership
    // rule; a card shows the count of its semantic (lower-case) code.
    const counts = await sourceCountsCache.get('counts', loadSourceCounts);
    const result = await sql<{
      code: string;
      name: string;
      jurisdiction_level: string;
      uf: string | null;
      is_active: boolean;
      last_run_status: string | null;
      last_success_at: Date | string | null;
      last_attempt_at: Date | string | null;
    }>`
      SELECT
        s.code,
        s.name,
        s.jurisdiction_level,
        s.uf,
        s.is_active,
        vsm.last_run_status,
        vsm.last_success_at,
        vsm.last_attempt_at
      FROM sources s
      LEFT JOIN v_source_monitoring vsm ON vsm.source_id = s.id
      ORDER BY
        CASE WHEN s.jurisdiction_level = 'FEDERAL' THEN 0 ELSE 1 END,
        s.uf NULLS FIRST,
        s.name
    `.execute(app.db);

    return {
      generatedAt: generatedAt.toISOString(),
      items: result.rows.map((row) => ({
        code: row.code,
        name: row.name,
        jurisdictionLevel: row.jurisdiction_level,
        uf: row.uf,
        isActive: row.is_active,
        status: derivePublicSourceStatus({
          isActive: row.is_active,
          lastRunStatus: row.last_run_status,
          lastSuccessAt: row.last_success_at,
          now: generatedAt,
        }),
        lastRunStatus: row.last_run_status,
        lastSuccessAt: row.last_success_at
          ? new Date(row.last_success_at).toISOString()
          : null,
        lastAttemptAt: row.last_attempt_at
          ? new Date(row.last_attempt_at).toISOString()
          : null,
        importedToday: 0,
        totalPublications: counts.get(row.code.toLowerCase()) ?? 0,
      })),
    };
  }

  async function loadFacets(): Promise<ArchiveFacets> {
    // One indexed probe per UF / source / act type instead of scanning the
    // growing publications table. The small act-type candidate catalog is
    // maintained by migration 030 and stale candidates are filtered here.
    const ufs = await sql<{ uf: string }>`
      SELECT u.uf
      FROM unnest(${BRAZILIAN_UFS}::char(2)[]) AS u(uf)
      CROSS JOIN LATERAL (
        SELECT 1
        FROM publications p
        WHERE p.jurisdiction_level = 'STATE'
          AND p.uf = u.uf
          AND NOT p.is_hidden
        LIMIT 1
      ) hit
      ORDER BY u.uf
    `.execute(app.db);

    // Candidate codes: every source code (case-folded) plus the virtual
    // "confaz", kept when the feed has a visible row for it.
    const sources = await sql<{ code: string; name: string }>`
      SELECT
        c.code,
        CASE WHEN c.code = 'confaz' THEN 'CONFAZ' ELSE c.name END AS name
      FROM (
        SELECT candidate.code, min(candidate.name) AS name
        FROM (
          SELECT lower(s.code) AS code, s.name
          FROM sources s
          UNION ALL
          SELECT 'confaz', 'CONFAZ'
        ) candidate
        GROUP BY candidate.code
      ) c
      CROSS JOIN LATERAL (
        -- Ordered like ix_publication_source_feed_order so the probe is an
        -- index lookup rather than a scan.
        SELECT 1
        FROM publication_source_feed f
        WHERE f.source_code = c.code
          AND NOT f.is_hidden
        ORDER BY f.published_on DESC NULLS LAST, f.first_collected_at DESC
        LIMIT 1
      ) hit
      ORDER BY 2
    `.execute(app.db);

    // Exact collected values only. publication_act_type_catalog is tiny and
    // each candidate is validated through ix_publications_act_type_visible_order,
    // so the facet cost stays independent of the historical corpus size.
    const actTypes = await sql<{ act_type: string }>`
      SELECT c.act_type
      FROM publication_act_type_catalog c
      CROSS JOIN LATERAL (
        SELECT 1
        FROM publications p
        WHERE p.act_type = c.act_type
          AND NOT p.is_hidden
        ORDER BY
          p.published_on DESC NULLS LAST,
          p.first_collected_at DESC,
          p.id
        LIMIT 1
      ) hit
      ORDER BY c.act_type
    `.execute(app.db);

    return {
      ufs: ufs.rows.map((row) => row.uf),
      sources: sources.rows,
      actTypes: actTypes.rows.map((row) => row.act_type),
    };
  }

  /** Counts up to ARCHIVE_COUNT_CAP + 1 matches. */
  async function cappedArchiveCount(plan: ArchivePlan): Promise<number> {
    const limit = ARCHIVE_COUNT_CAP + 1;
    const result = plan.searchIds
      ? await sql<{ count: number }>`
          SELECT count(*)::int AS count
          FROM (
            SELECT 1
            FROM (${plan.searchIds}) m
            JOIN publications p ON p.id = m.publication_id
            ${plan.feedJoin}
            WHERE ${plan.filters}
            LIMIT ${limit}
          ) capped
        `.execute(app.db)
      : await sql<{ count: number }>`
          SELECT count(*)::int AS count
          FROM (
            SELECT 1
            FROM publications p
            ${plan.feedJoin}
            WHERE ${plan.where}
            LIMIT ${limit}
          ) capped
        `.execute(app.db);

    return result.rows[0]?.count ?? 0;
  }

  typed.get(
    '/api/v1/monitoring/runs',
    { preHandler: app.authenticate },
    async (request, reply) => {
      if (!request.auth) {
        return reply.status(401).send({ error: 'unauthorized' });
      }

      const tenantId = tenantIdFromRequest(request);
      if (!tenantId) {
        return reply.status(400).send({ error: 'tenant_required' });
      }
      if (!(await verifyTenantAccess(app, request, tenantId))) {
        return reply.status(403).send({ error: 'tenant_access_denied' });
      }

      const result = await sql<{
        id: string;
        source_code: string;
        source_name: string;
        jurisdiction_level: string;
        uf: string | null;
        status: string;
        trigger_type: string;
        scheduled_for: Date | string;
        started_at: Date | string | null;
        finished_at: Date | string | null;
        duration_ms: number | null;
        attempt_count: number;
        found_items: number;
        imported_documents: number;
      }>`
        SELECT
          cr.id,
          s.code AS source_code,
          s.name AS source_name,
          s.jurisdiction_level,
          s.uf,
          cr.status,
          cr.trigger_type,
          cr.scheduled_for,
          cr.started_at,
          cr.finished_at,
          CASE
            WHEN cr.started_at IS NOT NULL AND cr.finished_at IS NOT NULL
            THEN round(
              extract(epoch FROM (cr.finished_at - cr.started_at)) * 1000
            )::int
            ELSE NULL
          END AS duration_ms,
          (
            SELECT count(*)::int
            FROM collection_attempts ca
            WHERE ca.collection_run_id = cr.id
          ) AS attempt_count,
          (
            SELECT count(*)::int
            FROM collection_items ci
            WHERE ci.collection_run_id = cr.id
          ) AS found_items,
          (
            SELECT count(*)::int
            FROM collection_run_publications crp
            WHERE crp.collection_run_id = cr.id
              AND crp.disposition IN ('NEW_PUBLICATION', 'NEW_VERSION')
          ) AS imported_documents
        FROM collection_runs cr
        JOIN sources s ON s.id = cr.source_id
        WHERE cr.scheduled_for >= now() - interval '24 hours'
        ORDER BY cr.scheduled_for DESC, cr.created_at DESC
        LIMIT 1000
      `.execute(app.db);

      return reply.status(200).send({
        generatedAt: new Date().toISOString(),
        windowHours: 24,
        items: result.rows.map((row) => ({
          id: row.id,
          sourceCode: row.source_code,
          sourceName: row.source_name,
          jurisdictionLevel: row.jurisdiction_level,
          uf: row.uf,
          status: row.status,
          triggerType: row.trigger_type,
          scheduledFor: new Date(row.scheduled_for).toISOString(),
          startedAt: row.started_at
            ? new Date(row.started_at).toISOString()
            : null,
          finishedAt: row.finished_at
            ? new Date(row.finished_at).toISOString()
            : null,
          durationMs: row.duration_ms,
          attemptCount: row.attempt_count,
          foundItems: row.found_items,
          importedDocuments: row.imported_documents,
        })),
      });
    },
  );

  typed.get(
    '/api/v2/archive',
    {
      preHandler: app.authenticate,
      schema: { querystring: archiveQuerySchema },
    },
    async (request, reply) => {
      if (!request.auth) {
        return reply.status(401).send({ error: 'unauthorized' });
      }

      const input = request.query;
      const offset = (input.page - 1) * input.limit;
      const tsquery = input.q ? buildSearchTsquery(input.q) : null;

      const sourceCode = input.source?.toLowerCase() ?? null;

      const emptyPage = {
        page: input.page,
        limit: input.limit,
        totalItems: 0,
        totalPages: 1,
        totalIsCapped: false,
        hasMore: false,
        items: [],
      };

      if (input.q && !tsquery) {
        return reply.status(200).send(emptyPage);
      }

      const plan = buildArchivePlan(input, sourceCode, tsquery);

      // Exact totals come from the cached aggregates when no other filter
      // applies; otherwise count up to the cap ("more than 10,000").
      let totalItems: number;
      let totalIsCapped = false;

      if (
        !input.q &&
        !input.ncm &&
        !input.tag &&
        !input.uf &&
        !input.jurisdiction &&
        !input.actType &&
        !input.publishedOn &&
        !input.publishedFrom &&
        !input.publishedTo
      ) {
        totalItems = sourceCode
          ? ((await sourceCountsCache.get('counts', loadSourceCounts)).get(
              sourceCode,
            ) ?? 0)
          : (await statsCache.get('stats', loadStats)).totalPublications;
      } else {
        // Searches and NCM filters count live: the same count picks the query
        // strategy below and must not be stale while collections and the NCM
        // enrichment add matches.
        const capped = plan.searchIds
          ? await cappedArchiveCount(plan)
          : await archiveCountCache.get(
              JSON.stringify([
                input.uf ?? null,
                input.jurisdiction ?? null,
                sourceCode,
                input.actType ?? null,
                input.publishedOn ?? null,
                input.publishedFrom ?? null,
                input.publishedTo ?? null,
              ]),
              () => cappedArchiveCount(plan),
            );
        totalIsCapped = capped > ARCHIVE_COUNT_CAP;
        totalItems = Math.min(capped, ARCHIVE_COUNT_CAP);
      }

      // Few search matches: fetch them through the text index and sort only
      // those. Many matches (or no search): walk the date-ordered index.
      const pageIds =
        plan.searchIds && !totalIsCapped
          ? sql`
              SELECT matched.id
              FROM (
                SELECT p.id, p.published_on, p.first_collected_at
                FROM (${plan.searchIds}) m
                JOIN publications p ON p.id = m.publication_id
                ${plan.feedJoin}
                WHERE ${plan.filters}
                OFFSET 0
              ) matched
              ORDER BY
                matched.published_on DESC NULLS LAST,
                matched.first_collected_at DESC,
                matched.id
              LIMIT ${input.limit + 1}
              OFFSET ${offset}
            `
          : sql`
              SELECT p.id
              FROM publications p
              ${plan.feedJoin}
              WHERE ${plan.where}
              ORDER BY ${plan.order}
              LIMIT ${input.limit + 1}
              OFFSET ${offset}
            `;

      const rows = await sql<ArchiveRow>`
        SELECT
          p.id,
          p.title,
          p.act_type,
          p.act_number,
          p.agency,
          p.jurisdiction_level,
          p.uf,
          p.published_on,
          p.effective_on,
          cv.relevant_excerpt,
          COALESCE(
            p.primary_official_url,
            first_origin.official_url
          ) AS official_url,
          CASE
            WHEN p.is_confaz THEN 'confaz'
            ELSE first_origin.source_code
          END AS source_code,
          CASE
            WHEN p.is_confaz THEN 'CONFAZ'
            ELSE first_origin.source_name
          END AS source_name
        FROM (${pageIds}) page
        JOIN publications p ON p.id = page.id
        LEFT JOIN publication_versions cv
          ON cv.publication_id = p.id
         AND cv.is_current = true
        LEFT JOIN LATERAL (
          SELECT
            po.official_url,
            s.code AS source_code,
            s.name AS source_name
          FROM publication_origins po
          JOIN sources s ON s.id = po.source_id
          WHERE po.publication_id = p.id
          ORDER BY po.first_seen_at ASC
          LIMIT 1
        ) first_origin ON true
        ORDER BY
          p.published_on DESC NULLS LAST,
          p.first_collected_at DESC,
          p.id
      `.execute(app.db);

      // One extra row tells whether a next page exists, independently of
      // the (possibly cached or capped) total.
      const hasMore = rows.rows.length > input.limit;
      const items = rows.rows.slice(0, input.limit);
      const totalPages = Math.max(
        1,
        Math.ceil(totalItems / input.limit),
      );

      return reply.status(200).send({
        page: input.page,
        limit: input.limit,
        totalItems,
        totalPages,
        totalIsCapped,
        hasMore,
        items: items.map((row) => ({
          id: row.id,
          title: row.title,
          actType: row.act_type,
          actNumber: row.act_number,
          agency: row.agency,
          jurisdictionLevel: row.jurisdiction_level,
          uf: row.uf,
          publishedOn: toDateOnly(row.published_on),
          effectiveOn: toDateOnly(row.effective_on),
          officialUrl: row.official_url,
          sourceCode: row.source_code,
          sourceName: row.source_name,
          excerpt: row.relevant_excerpt,
        })),
      });
    },
  );

  typed.get(
    '/api/v2/archive/facets',
    { preHandler: app.authenticate },
    async (request, reply) => {
      if (!request.auth) {
        return reply.status(401).send({ error: 'unauthorized' });
      }

      return reply
        .status(200)
        .send(await facetsCache.get('facets', loadFacets));
    },
  );

  typed.get('/public/v2/stats', async (_request, reply) => {
    return reply
      .status(200)
      .send(await statsCache.get('stats', loadStats));
  });

  typed.get('/public/v2/sources', async (_request, reply) => {
    return reply
      .status(200)
      .send(await sourcesCache.get('sources', loadSources));
  });
}
