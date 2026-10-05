import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';

import { env } from '../../config/env.js';
import type { TtlCacheOptions } from './ttl-cache.js';

/**
 * Shared settings for caches of global catalog aggregates. A value is fresh
 * for AGGREGATE_CACHE_TTL_MS (default 1 h) and, once expired, is still served
 * for up to another AGGREGATE_CACHE_TTL_MS while one background reload
 * refreshes it. Catalog totals are not real-time data.
 *
 * Publication scope is different: SUPPRESS/RESTORE is an explicit visibility
 * boundary. Every aggregate cache key is therefore versioned by the monotonic
 * database scope epoch so a committed transition immediately bypasses both
 * fresh and stale entries in every route that uses these shared options.
 */
export function aggregateCacheOptions(
  app: FastifyInstance,
): TtlCacheOptions {
  const ttlMs = env.AGGREGATE_CACHE_TTL_MS;

  return {
    ttlMs,
    staleMs: ttlMs,
    keyVersion: async () => {
      const result = await sql<{ epoch: string }>`
        SELECT public.publication_scope_epoch()::text AS epoch
      `.execute(app.db);
      return result.rows[0]?.epoch ?? '0';
    },
    onBackgroundError: (error, key) => {
      app.log.warn(
        { err: error, cacheKey: key },
        'Aggregate cache background refresh failed',
      );
    },
  };
}
