import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';

import { env } from '../../config/env.js';

const CACHE_CONTROL_VALUE = 'public, max-age=300';
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

async function enforcePublicCors(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
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
  reply.header('Vary', 'Origin');
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

  app.addHook(
    'onRequest',
    enforcePublicCors,
  );

  app.addHook(
    'onSend',
    async (_request, reply, payload) => {
      reply.header(
        'Cache-Control',
        CACHE_CONTROL_VALUE,
      );
      return payload;
    },
  );

  typed.get(
    '/public/v1/sources',
    async (_request, reply) => {
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

      return reply.status(200).send({
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
      });
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

      return reply.status(200).send({
        items: rows.map((row) => ({
          id: row.id,
          title: row.title,
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
      });
    },
  );

  typed.get(
    '/public/v1/stats',
    async (_request, reply) => {
      const result = await sql<StatsRow>`
        SELECT
          (
            SELECT count(*)::int
            FROM publications
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

      return reply.status(200).send({
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
      });
    },
  );
}
