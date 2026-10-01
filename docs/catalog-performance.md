# Catalog performance (PERF-01)

## Problem

Opening the authenticated panel fires ~10 requests at once. Several of them
(`/public/v2/sources`, `/api/v2/archive/facets`, `/public/v2/stats`,
`/api/v2/archive`) scanned the whole `publications` table, evaluating ten
`upper(...) LIKE` hidden-family predicates per row, and the archive sorted the
whole table on every page because `ix_publications_date` (`published_on DESC`,
NULLS FIRST) cannot serve `ORDER BY published_on DESC NULLS LAST`. A burst
saturated the 10-connection pool and even trivial endpoints (`/api/v1/account`)
waited behind it.

## Changes

1. **Partial index** `ix_publications_visible_order` (migration 028) on
   `(published_on DESC NULLS LAST, first_collected_at DESC)` restricted to
   visible publications. Its predicate must stay equivalent to
   `visiblePublicationSql`; `test/catalog.visible-index.integration.test.ts`
   fails if they drift.
2. **Query rewrites** with identical results:
   - archive: count without the `publication_versions` join unless `q` is set;
     paginate first, resolve excerpt/origin only for returned rows;
   - facets: first origin per publication in one pass (`DISTINCT ON`) instead
     of two correlated subqueries per publication;
   - `/public/v2/stats`: one scan with `FILTER`, sargable "today" range;
   - `/public/v2/sources`: every source count from one pass over visible
     publications instead of one scan per source.
3. **In-process aggregate cache** (`src/infrastructure/cache/ttl-cache.ts`):
   global, tenant-independent payloads only. Fresh for
   `AGGREGATE_CACHE_TTL_MS` (default 60 000; `0` disables); afterwards the
   previous value is served for up to 5x that while one background reload
   runs. Concurrent misses share one query. Failed loads are not cached.
   `generatedAt` reflects when the payload was computed.

## Local measurement (300k publications, PostgreSQL 16)

| Request | Before | After (cold) | After (cached) |
| --- | ---: | ---: | ---: |
| `/public/v2/sources` | 9.9–14.7 s | 2.3–2.6 s | ~2 ms |
| `/api/v2/archive/facets` | 6.0 s | 1.3 s | ~2 ms |
| `/api/v2/archive` page 1 / 40 | 1.2–1.4 s | 5–45 ms | 5 ms |
| `/public/v2/stats` | 1.0 s | 50–120 ms | ~2 ms |
| Dashboard burst (9 requests) | ~14 s | — | 17–38 ms |

Old and new code returned byte-identical payloads for 35 endpoint/filter/page
combinations on the same dataset.

## Not done here (follow-ups)

- Cold `/public/v2/sources` and facets still scan all visible publications.
  Before the historical DOU load, replace them with pre-aggregated counts or
  stored visibility/CONFAZ flags (table rewrite → R3 migration).
- `pg_stat_statements` / `log_min_duration_statement` in production and
  `DB_POOL_MAX` sizing are infrastructure changes outside this PR.
