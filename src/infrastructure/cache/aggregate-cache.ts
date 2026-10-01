import type { FastifyInstance } from 'fastify';

import { env } from '../../config/env.js';
import type { TtlCacheOptions } from './ttl-cache.js';

/**
 * Shared settings for caches of global catalog aggregates. A value is fresh
 * for AGGREGATE_CACHE_TTL_MS and may be served for up to 5x that long while
 * one background reload refreshes it.
 */
export function aggregateCacheOptions(
  app: FastifyInstance,
): TtlCacheOptions {
  const ttlMs = env.AGGREGATE_CACHE_TTL_MS;

  return {
    ttlMs,
    staleMs: ttlMs * 5,
    onBackgroundError: (error, key) => {
      app.log.warn(
        { err: error, cacheKey: key },
        'Aggregate cache background refresh failed',
      );
    },
  };
}
