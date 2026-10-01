import type { FastifyInstance } from 'fastify';

import { env } from '../../config/env.js';
import type { TtlCacheOptions } from './ttl-cache.js';

/**
 * Shared settings for caches of global catalog aggregates. A value is fresh
 * for AGGREGATE_CACHE_TTL_MS (default 1 h) and, once expired, is still served
 * for up to another AGGREGATE_CACHE_TTL_MS while one background reload
 * refreshes it. Catalog totals are not real-time data.
 */
export function aggregateCacheOptions(
  app: FastifyInstance,
): TtlCacheOptions {
  const ttlMs = env.AGGREGATE_CACHE_TTL_MS;

  return {
    ttlMs,
    staleMs: ttlMs,
    onBackgroundError: (error, key) => {
      app.log.warn(
        { err: error, cacheKey: key },
        'Aggregate cache background refresh failed',
      );
    },
  };
}
