import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';

const newsQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

interface NewsRow {
  id: string;
  source_code: string;
  source_name: string;
  agency: string | null;
  title: string;
  summary: string | null;
  category: string | null;
  published_at: Date | string | null;
  updated_at_source: Date | string | null;
  official_url: string;
  tags: string[];
  source_metadata: Record<string, unknown> | null;
  total_count: number;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function imageUrl(metadata: Record<string, unknown> | null): string | null {
  const value = metadata?.imageUrl;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

export async function newsRoutes(app: FastifyInstance): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/api/v1/news',
    {
      preHandler: app.authenticate,
      schema: {
        querystring: newsQuerySchema,
      },
    },
    async (request, reply) => {
      if (!request.auth) {
        return reply.status(401).send({ error: 'unauthorized' });
      }

      const page = request.query.page;
      const limit = request.query.limit;
      const offset = (page - 1) * limit;
      const q = request.query.q?.trim() || undefined;
      const search = q ? `%${q}%` : undefined;

      const predicate = search
        ? sql<boolean>`(
            latest.title ILIKE ${search}
            OR COALESCE(latest.summary, '') ILIKE ${search}
            OR COALESCE(latest.category, '') ILIKE ${search}
            OR array_to_string(latest.tags, ' ') ILIKE ${search}
          )`
        : sql<boolean>`TRUE`;

      const result = await sql<NewsRow>`
        WITH latest AS (
          SELECT DISTINCT ON (ni.id)
            ni.id,
            s.code AS source_code,
            s.name AS source_name,
            COALESCE(ni.agency, s.agency) AS agency,
            niv.title,
            niv.summary,
            niv.category,
            niv.published_at,
            niv.updated_at_source,
            niv.official_url,
            niv.tags,
            niv.source_metadata,
            niv.collected_at
          FROM news_items ni
          INNER JOIN sources s
            ON s.id = ni.source_id
          INNER JOIN news_item_versions niv
            ON niv.news_item_id = ni.id
          ORDER BY ni.id, niv.version_no DESC
        )
        SELECT
          latest.id,
          latest.source_code,
          latest.source_name,
          latest.agency,
          latest.title,
          latest.summary,
          latest.category,
          latest.published_at,
          latest.updated_at_source,
          latest.official_url,
          latest.tags,
          latest.source_metadata,
          COUNT(*) OVER()::int AS total_count
        FROM latest
        WHERE ${predicate}
        ORDER BY
          COALESCE(latest.published_at, latest.collected_at) DESC,
          latest.collected_at DESC,
          latest.id DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `.execute(app.db);

      const rows = result.rows;
      const totalItems = rows[0]?.total_count ?? 0;
      const totalPages = Math.max(1, Math.ceil(totalItems / limit));

      return reply.status(200).send({
        items: rows.map((row) => ({
          id: row.id,
          sourceCode: row.source_code,
          sourceName: row.source_name,
          agency: row.agency,
          title: row.title,
          summary: row.summary,
          category: row.category,
          publishedAt: iso(row.published_at),
          updatedAt: iso(row.updated_at_source),
          officialUrl: row.official_url,
          imageUrl: imageUrl(row.source_metadata),
          tags: row.tags,
        })),
        page,
        limit,
        totalItems,
        totalPages,
      });
    },
  );
}
