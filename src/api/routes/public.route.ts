import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { aggregateCacheOptions } from '../../infrastructure/cache/aggregate-cache.js';
import { TtlCache } from '../../infrastructure/cache/ttl-cache.js';
import {
  DISPLAY_TITLE_CONTENT_CHARS,
  publicationDisplayTitle,
} from '../../modules/catalog/display-title.js';

const CACHE_CONTROL_VALUE =
  'public, max-age=0, no-cache, must-revalidate';
const SAO_PAULO_TZ = 'America/Sao_Paulo';

const publicationsQuerySchema = z.object({
  uf: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/)
    .transform((value) => value.toUpperCase())
    .optional(),
  jurisdiction: z
    .enum(['FEDERAL', 'STATE'])
    .optional(),
  source: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(20)
    .default(3),
});

export type PublicSourceStatus =
  | 'ONLINE'
  | 'UNSTABLE'
  | 'UNAVAILABLE'
  | 'NOT_CONSULTED';

export function derivePublicSourceStatus(input: {
  isActive: boolean;
  lastRunStatus: string | null;
  lastSuccessAt: Date | string | null;
  now?: Date;
}): PublicSourceStatus {
  if (!input.isActive) {
    return 'NOT_CONSULTED';
  }

  const status = input.lastRunStatus;

  if (!status || status === 'NOT_CONSULTED') {
    return 'NOT_CONSULTED';
  }

  if (
    status === 'SUCCESS' ||
    status === 'SUCCESS_NO_RESULTS'
  ) {
    return 'ONLINE';
  }

  if (status === 'PARTIAL_SUCCESS') {
    return 'UNSTABLE';
  }

  if (
    status === 'SOURCE_UNAVAILABLE' ||
    status === 'FETCH_FAILED' ||
    status === 'PROCESSING_FAILED' ||
    status === 'CANCELLED'
  ) {
    return 'UNAVAILABLE';
  }

  if (
    status === 'RUNNING' ||
    status === 'PENDING'
  ) {
    if (!input.lastSuccessAt) {
      return 'UNAVAILABLE';
    }

    const now = input.now ?? new Date();
    const lastSuccess = new Date(
      input.lastSuccessAt,
    );
    const ageMs =
      now.getTime() - lastSuccess.getTime();
    const maxRecentSuccessMs =
      48 * 60 * 60 * 1000;

    return ageMs >= 0 &&
      ageMs < maxRecentSuccessMs
      ? 'UNSTABLE'
      : 'UNAVAILABLE';
  }

  return 'UNAVAILABLE';
}

function toIsoTimestamp(
  value: Date | string | null,
): string | null {
  if (!value) {
    return null;
  }

  return new Date(value).toISOString();
}

function toDateOnly(
  value: Date | string | null,
): string | null {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return value.slice(0, 10);
  }

  return value.toISOString().slice(0, 10);
}

function allowedOrigins(): Set<string> {
  return new Set(
    env.PUBLIC_API_ALLOWED_ORIGINS
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

async function publicationScopeEpoch(
  app: FastifyInstance,
): Promise<string> {
  const result = await sql<{ epoch: string }>`
    SELECT public.publication_scope_epoch()::text AS epoch
  `.execute(app.db);

  return result.rows[0]?.epoch ?? '0';
}

export function withOriginVary(
  current: string | number | string[] | undefined,
): string {
  const raw = Array.isArray(current)
    ? current.join(', ')
    : String(current ?? '');
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (
    values.some(
      (value) =>
        value === '*' ||
        value.toLowerCase() === 'origin',
    )
  ) {
    return values.join(', ');
  }

  return [...values, 'Origin'].join(', ');
}

async function enforcePublicCors(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  reply.header(
    'Vary',
    withOriginVary(reply.getHeader('Vary')),
  );

  const origin = request.headers.origin;

  if (!origin) {
    return;
  }

  const allowed = allowedOrigins();

  if (!allowed.has(origin)) {
    await reply.status(403).send({
      error: 'origin_not_allowed',
    });
    return;
  }

  reply.header(
    'Access-Control-Allow-Origin',
    origin,
  );
}

interface SourceRow {
  code: string;
  name: string;
  jurisdiction_level: string;
  uf: string | null;
  is_active: boolean;
  last_run_status: string | null;
  last_success_at: Date | string | null;
  last_attempt_at: Date | string | null;
  imported_today: number;
  total_publications: number;
}

interface StatsRow {
  total_publications: number;
  total_sources: number;
  active_sources: number;
  imported_today: number;
}

export async function publicRoutes(
  app: FastifyInstance,
): Promise<void> {
  const typed =
    app.withTypeProvider<ZodTypeProvider>();

  // Public payloads are cached server-side, but scope transitions advance a
  // database epoch that becomes part of every cache key. HTTP consumers must
  // revalidate so a suppressed act is not retained for the previous 300 s.
  const cacheOptions = aggregateCacheOptions(app);
  const sourcesCache = new TtlCache<object>(cacheOptions);
  const publicationsCache = new TtlCache<object>({
    ...cacheOptions,
    maxEntries: 200,
  });
  const statsCache = new TtlCache<object>(cacheOptions);

  app.addHook(
    'onRequest',
    enforcePublicCors,
  );

  app.addHook(
    'onSend',
    async (request, reply, payload) => {
      if (
        request.method === 'GET' &&
        reply.statusCode >= 200 &&
        reply.statusCode < 300
      ) {
        reply.header(
          'Cache-Control',
          CACHE_CONTROL_VALUE,
        );
      }

      return payload;
    },
  );

  typed.options(
    '/public/v1/*',
    async (_request, reply) => {
      reply.header(
        'Access-Control-Allow-Methods',
        'GET',
      );
      reply.header(
        'Access-Control-Max-Age',
        '300',
      );

      return reply.status(204).send();
    },
  );

  typed.get(
    '/public/v1/sources',
    async (_request, reply) => {
      const scopeEpoch = await publicationScopeEpoch(app);
      reply.header('X-Publication-Scope-Epoch', scopeEpoch);

      const payload = await sourcesCache.get(
        `sources:${scopeEpoch}`,
        async () => {
          const generatedAt = new Date();

          const result = await sql<SourceRow>`
            SELECT
              s.code,
              s.name,
              s.jurisdiction_level,
              s.uf,
              s.is_active,
              vsm.last_run_status,
              vsm.last_success_at,
              vsm.last_attempt_at,
              (
                SELECT count(*)::int
                FROM collection_runs cr
                JOIN collection_run_publications crp
                  ON crp.collection_run_id = cr.id
                WHERE cr.source_id = s.id
                  AND public.publication_scope_is_in_scope(
                    crp.publication_id
                  )
                  AND crp.disposition IN (
                    'NEW_PUBLICATION',
                    'NEW_VERSION'
                  )
                  AND (
                    crp.detected_at
                    AT TIME ZONE ${SAO_PAULO_TZ}
                  )::date = (
                    now()
                    AT TIME ZONE ${SAO_PAULO_TZ}
                  )::date
              ) AS imported_today,
              (
                SELECT count(DISTINCT po.publication_id)::int
                FROM publication_origins po
                WHERE po.source_id = s.id
                  AND public.publication_scope_is_in_scope(
                    po.publication_id
                  )
              ) AS total_publications
            FROM sources s
            LEFT JOIN v_source_monitoring vsm
              ON vsm.source_id = s.id
            ORDER BY
              CASE
                WHEN s.jurisdiction_level = 'FEDERAL'
                  THEN 0
                ELSE 1
              END,
              s.uf NULLS FIRST,
              s.name
          `.execute(app.db);

          return {
            generatedAt:
              generatedAt.toISOString(),
            items: result.rows.map((row) => ({
              code: row.code,
              name: row.name,
              jurisdictionLevel:
                row.jurisdiction_level,
              uf: row.uf,
              isActive: row.is_active,
              status: derivePublicSourceStatus({
                isActive: row.is_active,
                lastRunStatus:
                  row.last_run_status,
                lastSuccessAt:
                  row.last_success_at,
                now: generatedAt,
              }),
              lastRunStatus:
                row.last_run_status,
              lastSuccessAt: toIsoTimestamp(
                row.last_success_at,
              ),
              lastAttemptAt: toIsoTimestamp(
                row.last_attempt_at,
              ),
              importedToday:
                row.imported_today,
              totalPublications:
                row.total_publications,
            })),
          };
        },
      );

      return reply.status(200).send(payload);
    },
  );

  typed.get(
    '/public/v1/publications',
    {
      schema: {
        querystring:
          publicationsQuerySchema,
      },
    },
    async (request, reply) => {
      const scopeEpoch = await publicationScopeEpoch(app);
      reply.header('X-Publication-Scope-Epoch', scopeEpoch);

      const cacheKey = JSON.stringify([
        scopeEpoch,
        request.query.uf ?? null,
        request.query.jurisdiction ?? null,
        request.query.source ?? null,
        request.query.limit,
      ]);

      const payload = await publicationsCache.get(cacheKey, async () => {
        let query = app.db
          .selectFrom('publications as p')
          .select([
            'p.id',
            'p.title',
            'p.act_type',
            'p.act_number',
            'p.agency',
            'p.uf',
            'p.published_on',
            'p.effective_on',
            'p.first_collected_at',
          ])
          .select(
            sql<string | null>`
              COALESCE(
                p.primary_official_url,
                (
                  SELECT po.official_url
                  FROM publication_origins po
                  WHERE po.publication_id = p.id
                  ORDER BY po.first_seen_at ASC
                  LIMIT 1
                )
              )
            `.as('official_url'),
          )
          .select(
            sql<string | null>`
              (
                SELECT left(pv.content_text, ${DISPLAY_TITLE_CONTENT_CHARS})
                FROM publication_versions pv
                WHERE pv.publication_id = p.id
                  AND pv.is_current = true
                LIMIT 1
              )
            `.as('content_head'),
          )
          .where(
            sql<boolean>`public.publication_scope_is_in_scope(p.id)`,
          );

        if (request.query.uf) {
          query = query.where(
            'p.uf',
            '=',
            request.query.uf,
          );
        }

        if (request.query.jurisdiction) {
          query = query.where(
            'p.jurisdiction_level',
            '=',
            request.query.jurisdiction,
          );
        }

        if (request.query.source) {
          const sourceCode =
            request.query.source;

          query = query.where(({ exists, selectFrom }) =>
            exists(
              selectFrom(
                'publication_origins as po_filter',
              )
                .innerJoin(
                  'sources as s_filter',
                  's_filter.id',
                  'po_filter.source_id',
                )
                .select('po_filter.id')
                .whereRef(
                  'po_filter.publication_id',
                  '=',
                  'p.id',
                )
                .where(
                  's_filter.code',
                  '=',
                  sourceCode,
                ),
            ),
          );
        }

        const rows = await query
          .orderBy(
            sql`p.published_on DESC NULLS LAST`,
          )
          .orderBy(
            'p.first_collected_at',
            'desc',
          )
          .limit(request.query.limit)
          .execute();

        return {
          items: rows.map((row) => ({
            id: row.id,
            title: publicationDisplayTitle(row.title, row.content_head),
            actType: row.act_type,
            actNumber: row.act_number,
            agency: row.agency,
            uf: row.uf,
            publishedOn: toDateOnly(
              row.published_on,
            ),
            effectiveOn: toDateOnly(
              row.effective_on,
            ),
            officialUrl: row.official_url,
          })),
        };
      });

      return reply.status(200).send(payload);
    },
  );

  typed.get(
    '/public/v1/stats',
    async (_request, reply) => {
      const scopeEpoch = await publicationScopeEpoch(app);
      reply.header('X-Publication-Scope-Epoch', scopeEpoch);

      const payload = await statsCache.get(
        `stats:${scopeEpoch}`,
        async () => {
          const result = await sql<StatsRow>`
            SELECT
              (
                SELECT count(*)::int
                FROM publications p
                WHERE public.publication_scope_is_in_scope(p.id)
              ) AS total_publications,
              (
                SELECT count(*)::int
                FROM sources
              ) AS total_sources,
              (
                SELECT count(*)::int
                FROM sources
                WHERE is_active = true
              ) AS active_sources,
              (
                SELECT COALESCE(
                  sum(source_imports),
                  0
                )::int
                FROM (
                  SELECT (
                    SELECT count(*)::int
                    FROM collection_runs cr
                    JOIN collection_run_publications crp
                      ON crp.collection_run_id = cr.id
                    WHERE cr.source_id = s.id
                      AND public.publication_scope_is_in_scope(
                        crp.publication_id
                      )
                      AND crp.disposition IN (
                        'NEW_PUBLICATION',
                        'NEW_VERSION'
                      )
                      AND (
                        crp.detected_at
                        AT TIME ZONE ${SAO_PAULO_TZ}
                      )::date = (
                        now()
                        AT TIME ZONE ${SAO_PAULO_TZ}
                      )::date
                  ) AS source_imports
                  FROM sources s
                ) per_source
              ) AS imported_today
          `.execute(app.db);

          const row = result.rows[0];

          return {
            totalPublications:
              row?.total_publications ?? 0,
            totalSources:
              row?.total_sources ?? 0,
            activeSources:
              row?.active_sources ?? 0,
            importedToday:
              row?.imported_today ?? 0,
            generatedAt:
              new Date().toISOString(),
          };
        },
      );

      return reply.status(200).send(payload);
    },
  );
}
