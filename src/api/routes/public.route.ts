import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import {
  type RawBuilder,
  sql,
} from 'kysely';
import {
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';

import { env } from '../../config/env.js';

type PublicSourceStatus =
  | 'ONLINE'
  | 'UNSTABLE'
  | 'UNAVAILABLE'
  | 'NOT_CONSULTED';

interface PublicRoutesOptions {
  allowedOrigins?: readonly string[];
}

interface PublicSourceRow {
  code: string;
  name: string;
  jurisdiction_level: 'FEDERAL' | 'STATE';
  uf: string | null;
  is_active: boolean;
  last_run_status: string | null;
  last_success_at: Date | string | null;
  last_attempt_at: Date | string | null;
  imported_today: number | string;
  total_publications: number | string;
}

interface PublicPublicationRow {
  id: string;
  title: string;
  act_type: string | null;
  act_number: string | null;
  agency: string | null;
  uf: string | null;
  published_on: Date | string | null;
  effective_on: Date | string | null;
  official_url: string | null;
}

interface PublicStatsRow {
  total_publications: number | string;
  total_sources: number | string;
  active_sources: number | string;
  imported_today: number | string;
}

const PUBLIC_CACHE_CONTROL =
  'public, max-age=300';

const PUBLIC_API_PREFIX = '/public/v1';

const publicationsQuerySchema = z.object({
  uf: z
    .string()
    .trim()
    .length(2)
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
    .transform((value) => value.toLowerCase())
    .optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(20)
    .default(3),
});

function toIso(
  value: Date | string | null,
): string | null {
  if (!value) {
    return null;
  }

  const date =
    value instanceof Date
      ? value
      : new Date(value);

  return Number.isNaN(date.getTime())
    ? null
    : date.toISOString();
}

function toDateOnly(
  value: Date | string | null,
): string | null {
  if (!value) {
    return null;
  }

  if (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return value;
  }

  const date =
    value instanceof Date
      ? value
      : new Date(value);

  return Number.isNaN(date.getTime())
    ? null
    : date.toISOString().slice(0, 10);
}

function toNumber(
  value: number | string,
): number {
  return typeof value === 'number'
    ? value
    : Number(value);
}

export function parsePublicApiAllowedOrigins(
  raw: string,
): string[] {
  return [
    ...new Set(
      raw
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

export function classifyPublicSourceStatus(
  input: {
    isActive: boolean;
    lastRunStatus: string | null;
    lastSuccessAt: Date | string | null;
  },
  now = new Date(),
): PublicSourceStatus {
  if (
    !input.isActive ||
    input.lastRunStatus === null ||
    input.lastRunStatus ===
      'NOT_CONSULTED'
  ) {
    return 'NOT_CONSULTED';
  }

  if (
    input.lastRunStatus === 'SUCCESS' ||
    input.lastRunStatus ===
      'SUCCESS_NO_RESULTS'
  ) {
    return 'ONLINE';
  }

  if (
    input.lastRunStatus ===
    'PARTIAL_SUCCESS'
  ) {
    return 'UNSTABLE';
  }

  if (
    input.lastRunStatus === 'RUNNING' ||
    input.lastRunStatus === 'PENDING'
  ) {
    const lastSuccessAt =
      input.lastSuccessAt
        ? new Date(input.lastSuccessAt)
        : null;
    const recentCutoff =
      now.getTime() -
      48 * 60 * 60 * 1000;

    if (
      lastSuccessAt &&
      !Number.isNaN(
        lastSuccessAt.getTime(),
      ) &&
      lastSuccessAt.getTime() >=
        recentCutoff
    ) {
      return 'UNSTABLE';
    }

    return 'UNAVAILABLE';
  }

  if (
    input.lastRunStatus ===
      'SOURCE_UNAVAILABLE' ||
    input.lastRunStatus ===
      'FETCH_FAILED' ||
    input.lastRunStatus ===
      'PROCESSING_FAILED'
  ) {
    return 'UNAVAILABLE';
  }

  /*
   * Fail closed for operational states not
   * explicitly listed in the public contract,
   * such as CANCELLED or future statuses.
   */
  return 'UNAVAILABLE';
}

function addCorsHeaders(
  reply: FastifyReply,
  origin: string,
): void {
  reply.header(
    'Access-Control-Allow-Origin',
    origin,
  );
  reply.header('Vary', 'Origin');
  reply.header(
    'Access-Control-Allow-Methods',
    'GET, OPTIONS',
  );
  reply.header(
    'Access-Control-Allow-Headers',
    'Content-Type',
  );
  reply.header(
    'Access-Control-Max-Age',
    '300',
  );
}

function buildOfficialUrlExpression(
  sourceCode?: string,
): RawBuilder<string | null> {
  if (sourceCode) {
    return sql<string | null>`
      coalesce(
        (
          select po.official_url
          from publication_origins po
          join sources os
            on os.id = po.source_id
          where po.publication_id = p.id
            and os.code = ${sourceCode}
          order by po.first_seen_at asc
          limit 1
        ),
        p.primary_official_url
      )
    `;
  }

  return sql<string | null>`
    coalesce(
      p.primary_official_url,
      (
        select po.official_url
        from publication_origins po
        where po.publication_id = p.id
        order by po.first_seen_at asc
        limit 1
      )
    )
  `;
}

export async function publicRoutes(
  app: FastifyInstance,
  options: PublicRoutesOptions = {},
): Promise<void> {
  const typed =
    app.withTypeProvider<ZodTypeProvider>();

  const allowedOrigins = new Set(
    options.allowedOrigins ??
      parsePublicApiAllowedOrigins(
        env.PUBLIC_API_ALLOWED_ORIGINS,
      ),
  );

  app.addHook(
    'onRequest',
    async (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => {
      const origin =
        request.headers.origin;

      if (!origin) {
        return;
      }

      if (!allowedOrigins.has(origin)) {
        await reply
          .status(403)
          .send({
            error: 'origin_not_allowed',
          });
        return;
      }

      addCorsHeaders(reply, origin);
    },
  );

  app.addHook(
    'onSend',
    async (
      request,
      reply,
      payload,
    ) => {
      if (request.method === 'GET') {
        reply.header(
          'Cache-Control',
          PUBLIC_CACHE_CONTROL,
        );
      }

      return payload;
    },
  );

  app.options(
    `${PUBLIC_API_PREFIX}/*`,
    async (_request, reply) =>
      reply.status(204).send(),
  );

  typed.get(
    `${PUBLIC_API_PREFIX}/sources`,
    async (_request, reply) => {
      const result =
        await sql<PublicSourceRow>`
          with day_bounds as (
            select
              (
                date_trunc(
                  'day',
                  now() at time zone
                    'America/Sao_Paulo'
                )
                at time zone
                  'America/Sao_Paulo'
              ) as start_at,
              (
                (
                  date_trunc(
                    'day',
                    now() at time zone
                      'America/Sao_Paulo'
                  )
                  + interval '1 day'
                )
                at time zone
                  'America/Sao_Paulo'
              ) as end_at
          )
          select
            s.code,
            s.name,
            s.jurisdiction_level,
            s.uf,
            s.is_active,
            vm.last_run_status,
            vm.last_success_at,
            vm.last_attempt_at,
            (
              select count(*)::int
              from collection_runs cr
              join
                collection_run_publications crp
                on
                  crp.collection_run_id =
                  cr.id
              cross join day_bounds db
              where cr.source_id = s.id
                and crp.detected_at >=
                  db.start_at
                and crp.detected_at <
                  db.end_at
                and crp.disposition in (
                  'NEW_PUBLICATION',
                  'NEW_VERSION'
                )
            ) as imported_today,
            (
              select
                count(
                  distinct po.publication_id
                )::int
              from publication_origins po
              where po.source_id = s.id
            ) as total_publications
          from sources s
          left join v_source_monitoring vm
            on vm.source_id = s.id
          order by
            case
              when
                s.jurisdiction_level =
                'FEDERAL'
              then 0
              else 1
            end,
            s.uf nulls first,
            s.name
        `.execute(app.db);

      const generatedAt =
        new Date().toISOString();

      return reply.status(200).send({
        generatedAt,
        items: result.rows.map(
          (row) => ({
            code: row.code,
            name: row.name,
            jurisdictionLevel:
              row.jurisdiction_level,
            uf: row.uf,
            isActive: row.is_active,
            status:
              classifyPublicSourceStatus(
                {
                  isActive:
                    row.is_active,
                  lastRunStatus:
                    row.last_run_status,
                  lastSuccessAt:
                    row.last_success_at,
                },
              ),
            lastRunStatus:
              row.last_run_status,
            lastSuccessAt: toIso(
              row.last_success_at,
            ),
            lastAttemptAt: toIso(
              row.last_attempt_at,
            ),
            importedToday: toNumber(
              row.imported_today,
            ),
            totalPublications:
              toNumber(
                row.total_publications,
              ),
          }),
        ),
      });
    },
  );

  typed.get(
    `${PUBLIC_API_PREFIX}/publications`,
    {
      schema: {
        querystring:
          publicationsQuerySchema,
      },
    },
    async (request, reply) => {
      const query = request.query;
      const conditions: Array<
        RawBuilder<unknown>
      > = [];

      if (query.uf) {
        conditions.push(
          sql`p.uf = ${query.uf}`,
        );
      }

      if (query.jurisdiction) {
        conditions.push(
          sql`
            p.jurisdiction_level =
              ${query.jurisdiction}
          `,
        );
      }

      if (query.source) {
        conditions.push(
          sql`
            exists (
              select 1
              from publication_origins po
              join sources os
                on os.id = po.source_id
              where
                po.publication_id = p.id
                and os.code =
                  ${query.source}
            )
          `,
        );
      }

      const whereClause =
        conditions.length > 0
          ? sql`
              where
                ${sql.join(
                  conditions,
                  sql` and `,
                )}
            `
          : sql``;

      const officialUrl =
        buildOfficialUrlExpression(
          query.source,
        );

      const result =
        await sql<PublicPublicationRow>`
          select
            p.id,
            p.title,
            p.act_type,
            p.act_number,
            p.agency,
            p.uf,
            p.published_on,
            p.effective_on,
            ${officialUrl}
              as official_url
          from publications p
          ${whereClause}
          order by
            p.published_on desc
              nulls last,
            p.first_collected_at desc
          limit ${query.limit}
        `.execute(app.db);

      return reply.status(200).send({
        items: result.rows.map(
          (row) => ({
            id: row.id,
            title: row.title,
            actType: row.act_type,
            actNumber: row.act_number,
            agency: row.agency,
            uf: row.uf,
            publishedOn:
              toDateOnly(
                row.published_on,
              ),
            effectiveOn:
              toDateOnly(
                row.effective_on,
              ),
            officialUrl:
              row.official_url,
          }),
        ),
      });
    },
  );

  typed.get(
    `${PUBLIC_API_PREFIX}/stats`,
    async (_request, reply) => {
      const result =
        await sql<PublicStatsRow>`
          with day_bounds as (
            select
              (
                date_trunc(
                  'day',
                  now() at time zone
                    'America/Sao_Paulo'
                )
                at time zone
                  'America/Sao_Paulo'
              ) as start_at,
              (
                (
                  date_trunc(
                    'day',
                    now() at time zone
                      'America/Sao_Paulo'
                  )
                  + interval '1 day'
                )
                at time zone
                  'America/Sao_Paulo'
              ) as end_at
          ),
          source_imports as (
            select
              s.id,
              (
                select count(*)::int
                from collection_runs cr
                join
                  collection_run_publications
                    crp
                  on
                    crp.collection_run_id =
                    cr.id
                cross join day_bounds db
                where
                  cr.source_id = s.id
                  and crp.detected_at >=
                    db.start_at
                  and crp.detected_at <
                    db.end_at
                  and crp.disposition in (
                    'NEW_PUBLICATION',
                    'NEW_VERSION'
                  )
              ) as imported_today
            from sources s
          )
          select
            (
              select count(*)::int
              from publications
            ) as total_publications,
            (
              select count(*)::int
              from sources
            ) as total_sources,
            (
              select count(*)::int
              from sources
              where is_active = true
            ) as active_sources,
            (
              select
                coalesce(
                  sum(imported_today),
                  0
                )::int
              from source_imports
            ) as imported_today
        `.execute(app.db);

      const row = result.rows[0];

      return reply.status(200).send({
        totalPublications:
          toNumber(
            row?.total_publications ??
              0,
          ),
        totalSources:
          toNumber(
            row?.total_sources ?? 0,
          ),
        activeSources:
          toNumber(
            row?.active_sources ?? 0,
          ),
        importedToday:
          toNumber(
            row?.imported_today ?? 0,
          ),
        generatedAt:
          new Date().toISOString(),
      });
    },
  );
}
