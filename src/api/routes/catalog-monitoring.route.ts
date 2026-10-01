import type {
  FastifyInstance,
  FastifyRequest,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';

import { aggregateCacheOptions } from '../../infrastructure/cache/aggregate-cache.js';
import { TtlCache } from '../../infrastructure/cache/ttl-cache.js';
import {
  TenantAccessDeniedError,
  withTenantContext,
} from '../../infrastructure/database/tenant-context.js';
import { derivePublicSourceStatus } from './public.route.js';

const SAO_PAULO_TZ = 'America/Sao_Paulo';

const archiveQuerySchema = z.object({
  q: z.string().trim().min(2).max(200).optional(),
  uf: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/)
    .transform((value) => value.toUpperCase())
    .optional(),
  jurisdiction: z.enum(['FEDERAL', 'STATE']).optional(),
  source: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});

function tenantIdFromRequest(
  request: FastifyRequest,
): string | null {
  const raw = request.headers['x-tenant-id'];
  if (typeof raw !== 'string') return null;
  return z.string().uuid().safeParse(raw).success ? raw : null;
}

const excludedPublicationFamilySql = sql<boolean>`
  (
    upper(coalesce(p.act_type, '')) LIKE '%AVISO DE LICITAÇÃO%'
    OR upper(coalesce(p.title, '')) LIKE '%AVISO DE LICITAÇÃO%'
    OR upper(coalesce(p.act_type, '')) LIKE '%COMUNICADO DGFIN%'
    OR upper(coalesce(p.title, '')) LIKE '%COMUNICADO DGFIN%'
    OR upper(coalesce(p.act_type, '')) LIKE '%PORTARIA DO COORDENADOR GERAL%'
    OR upper(coalesce(p.title, '')) LIKE '%PORTARIA DO COORDENADOR GERAL%'
    OR upper(coalesce(p.act_type, '')) LIKE '%COMISSÃO DE ANÁLISE DE PROJETOS%'
    OR upper(coalesce(p.title, '')) LIKE '%COMISSÃO DE ANÁLISE DE PROJETOS%'
    OR upper(coalesce(p.act_type, '')) LIKE '%COMISSAO DE ANALISE DE PROJETOS%'
    OR upper(coalesce(p.title, '')) LIKE '%COMISSAO DE ANALISE DE PROJETOS%'
  )
`;

// Keep in sync with the partial index ix_publications_visible_order
// (migrations/028_publication_visible_order_index.sql): PostgreSQL only uses
// it when this predicate matches the index predicate.
export const visiblePublicationSql = sql<boolean>`
  NOT (${excludedPublicationFamilySql})
`;

const startOfTodaySql = sql<Date>`
  (date_trunc('day', now() AT TIME ZONE ${SAO_PAULO_TZ}) AT TIME ZONE ${SAO_PAULO_TZ})
`;

const startOfTomorrowSql = sql<Date>`
  ((date_trunc('day', now() AT TIME ZONE ${SAO_PAULO_TZ}) + interval '1 day') AT TIME ZONE ${SAO_PAULO_TZ})
`;

const confazPublicationSql = sql<boolean>`
  (
    upper(coalesce(p.act_type, '')) LIKE '%CONVÊNIO ICMS%'
    OR upper(coalesce(p.act_type, '')) LIKE '%CONVENIO ICMS%'
    OR upper(coalesce(p.act_type, '')) LIKE '%AJUSTE SINIEF%'
    OR upper(coalesce(p.act_type, '')) LIKE '%PROTOCOLO ICMS%'
    OR upper(coalesce(p.act_type, '')) LIKE '%ATO COTEPE%'
    OR upper(coalesce(p.act_type, '')) LIKE '%CONFAZ%'
  )
`;

function sourceFilterSql(sourceCode: string) {
  if (sourceCode.toLowerCase() === 'confaz') {
    return sql<boolean>`
      (
        ${confazPublicationSql}
        OR EXISTS (
          SELECT 1
          FROM publication_origins po_filter
          JOIN sources s_filter ON s_filter.id = po_filter.source_id
          WHERE po_filter.publication_id = p.id
            AND lower(s_filter.code) = 'confaz'
        )
      )
    `;
  }

  if (sourceCode.toLowerCase() === 'dou') {
    return sql<boolean>`
      NOT (${confazPublicationSql})
      AND EXISTS (
        SELECT 1
        FROM publication_origins po_filter
        JOIN sources s_filter ON s_filter.id = po_filter.source_id
        WHERE po_filter.publication_id = p.id
          AND lower(s_filter.code) = 'dou'
      )
    `;
  }

  return sql<boolean>`
    EXISTS (
      SELECT 1
      FROM publication_origins po_filter
      JOIN sources s_filter ON s_filter.id = po_filter.source_id
      WHERE po_filter.publication_id = p.id
        AND lower(s_filter.code) = ${sourceCode.toLowerCase()}
    )
  `;
}

function archiveWhere(input: z.infer<typeof archiveQuerySchema>) {
  const conditions = [visiblePublicationSql];

  if (input.uf) {
    conditions.push(sql<boolean>`p.uf = ${input.uf}`);
  }
  if (input.jurisdiction) {
    conditions.push(
      sql<boolean>`p.jurisdiction_level = ${input.jurisdiction}`,
    );
  }
  if (input.source) {
    conditions.push(sourceFilterSql(input.source));
  }
  if (input.q) {
    const pattern = `%${input.q}%`;
    conditions.push(sql<boolean>`
      (
        p.title ILIKE ${pattern}
        OR coalesce(p.act_type, '') ILIKE ${pattern}
        OR coalesce(p.act_number, '') ILIKE ${pattern}
        OR coalesce(p.agency, '') ILIKE ${pattern}
        OR coalesce(pv.relevant_excerpt, '') ILIKE ${pattern}
        OR coalesce(pv.content_text, '') ILIKE ${pattern}
      )
    `);
  }

  return sql.join(conditions, sql` AND `);
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
  // collection run lands, so a short TTL removes them from the hot path.
  const cacheOptions = aggregateCacheOptions(app);
  const archiveCountCache = new TtlCache<number>({
    ...cacheOptions,
    maxEntries: 500,
  });
  const facetsCache = new TtlCache<ArchiveFacets>(cacheOptions);
  const statsCache = new TtlCache<PublicStatsV2>(cacheOptions);
  const sourcesCache = new TtlCache<PublicSourcesV2>(cacheOptions);

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

      const where = archiveWhere(request.query);
      const offset =
        (request.query.page - 1) * request.query.limit;

      // The current version is only needed by the text search predicate.
      const versionJoin = request.query.q
        ? sql`
          LEFT JOIN publication_versions pv
            ON pv.publication_id = p.id
           AND pv.is_current = true
        `
        : sql``;

      const countKey = JSON.stringify([
        request.query.q ?? null,
        request.query.uf ?? null,
        request.query.jurisdiction ?? null,
        request.query.source?.toLowerCase() ?? null,
      ]);

      const totalItems = await archiveCountCache.get(
        countKey,
        async () => {
          const countResult = await sql<{ count: string }>`
            SELECT count(*)::text AS count
            FROM publications p
            ${versionJoin}
            WHERE ${where}
          `.execute(app.db);

          return Number(countResult.rows[0]?.count ?? 0);
        },
      );
      const totalPages = Math.max(
        1,
        Math.ceil(totalItems / request.query.limit),
      );

      // Paginate first, then resolve version/origin details only for the
      // rows actually returned.
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
            WHEN ${confazPublicationSql} THEN 'confaz'
            ELSE first_origin.source_code
          END AS source_code,
          CASE
            WHEN ${confazPublicationSql} THEN 'CONFAZ'
            ELSE first_origin.source_name
          END AS source_name
        FROM (
          SELECT p.*
          FROM publications p
          ${versionJoin}
          WHERE ${where}
          ORDER BY
            p.published_on DESC NULLS LAST,
            p.first_collected_at DESC
          LIMIT ${request.query.limit}
          OFFSET ${offset}
        ) p
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
          p.first_collected_at DESC
      `.execute(app.db);

      return reply.status(200).send({
        page: request.query.page,
        limit: request.query.limit,
        totalItems,
        totalPages,
        hasMore: request.query.page < totalPages,
        items: rows.rows.map((row) => ({
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

      const facets = await facetsCache.get('facets', async () => {
        const ufs = await sql<{ uf: string }>`
          SELECT DISTINCT p.uf
          FROM publications p
          WHERE ${visiblePublicationSql}
            AND p.uf IS NOT NULL
          ORDER BY p.uf
        `.execute(app.db);

        // Same result as resolving each visible publication's first origin,
        // but with a single pass over publication_origins instead of two
        // correlated subqueries per publication.
        const sources = await sql<{ code: string; name: string }>`
          SELECT DISTINCT source_code AS code, source_name AS name
          FROM (
            SELECT
              CASE
                WHEN ${confazPublicationSql} THEN 'confaz'
                ELSE s.code
              END AS source_code,
              CASE
                WHEN ${confazPublicationSql} THEN 'CONFAZ'
                ELSE s.name
              END AS source_name
            FROM publications p
            LEFT JOIN (
              SELECT DISTINCT ON (po.publication_id)
                po.publication_id,
                po.source_id
              FROM publication_origins po
              ORDER BY po.publication_id, po.first_seen_at ASC
            ) first_origin ON first_origin.publication_id = p.id
            LEFT JOIN sources s ON s.id = first_origin.source_id
            WHERE ${visiblePublicationSql}
          ) visible_sources
          WHERE source_code IS NOT NULL
          ORDER BY source_name
        `.execute(app.db);

        return {
          ufs: ufs.rows.map((row) => row.uf),
          sources: sources.rows,
        };
      });

      return reply.status(200).send(facets);
    },
  );

  typed.get('/public/v2/stats', async (_request, reply) => {
    const stats = await statsCache.get('stats', async () => {
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
          WHERE ${visiblePublicationSql}
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
    });

    return reply.status(200).send(stats);
  });

  typed.get('/public/v2/sources', async (_request, reply) => {
    const payload = await sourcesCache.get('sources', async () => {
      const generatedAt = new Date();
      // One pass over the visible publications computes every source count:
      // - confaz: CONFAZ-typed acts plus other acts with a confaz origin;
      // - dou: acts with a dou origin that are not CONFAZ-typed;
      // - others: acts with an origin from that source.
      const result = await sql<{
        code: string;
        name: string;
        jurisdiction_level: string;
        uf: string | null;
        is_active: boolean;
        last_run_status: string | null;
        last_success_at: Date | string | null;
        last_attempt_at: Date | string | null;
        total_publications: number;
      }>`
        WITH visible AS MATERIALIZED (
          SELECT
            p.id,
            ${confazPublicationSql} AS is_confaz
          FROM publications p
          WHERE ${visiblePublicationSql}
        ),
        origin_counts AS (
          SELECT
            po.source_id,
            count(DISTINCT po.publication_id)::int AS all_visible,
            count(DISTINCT po.publication_id) FILTER (
              WHERE NOT v.is_confaz
            )::int AS non_confaz_visible
          FROM publication_origins po
          JOIN visible v ON v.id = po.publication_id
          GROUP BY po.source_id
        ),
        confaz_typed AS (
          SELECT count(*)::int AS total
          FROM visible
          WHERE is_confaz
        )
        SELECT
          s.code,
          s.name,
          s.jurisdiction_level,
          s.uf,
          s.is_active,
          vsm.last_run_status,
          vsm.last_success_at,
          vsm.last_attempt_at,
          CASE
            WHEN lower(s.code) = 'confaz'
              THEN ct.total + coalesce(oc.non_confaz_visible, 0)
            WHEN lower(s.code) = 'dou'
              THEN coalesce(oc.non_confaz_visible, 0)
            ELSE coalesce(oc.all_visible, 0)
          END AS total_publications
        FROM sources s
        LEFT JOIN v_source_monitoring vsm ON vsm.source_id = s.id
        LEFT JOIN origin_counts oc ON oc.source_id = s.id
        CROSS JOIN confaz_typed ct
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
          totalPublications: row.total_publications,
        })),
      };
    });

    return reply.status(200).send(payload);
  });
}
