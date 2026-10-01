# Catalog performance (PERF-01 / PERF-02)

## Problem

Opening the authenticated panel fires ~10 requests at once. Several of them
(`/public/v2/sources`, `/api/v2/archive/facets`, `/public/v2/stats`,
`/api/v2/archive`) scanned the whole `publications` table, evaluating ten
`upper(...) LIKE` hidden-family predicates (and six CONFAZ ones) per row; the
archive sorted the whole table on every page because `ix_publications_date`
(`published_on DESC`, NULLS FIRST) cannot serve `ORDER BY published_on DESC
NULLS LAST`; the source filter probed `publication_origins` for every
publication; and search used `ILIKE` over the full content. A burst saturated
the 10-connection pool and even trivial endpoints waited behind it. Scaling
measurements and decisions: [catalog-scale-plan.md](catalog-scale-plan.md).

## Schema (migration 028_catalog_scale)

- `publications.is_hidden`, `publications.is_confaz`: stored generated flags.
  The migration is the single source of truth for both rules; changing a
  hidden family or a CONFAZ act type requires a new migration.
- `publications.title_vector`: accent-insensitive tsvector of act type,
  number, agency and title (`public.pt_unaccent` = `portuguese` + `unaccent`).
  `publication_versions.search_vector` uses the same configuration (same
  size bounds as migration 014); its GIN index is partial on `is_current`.
- `ix_publications_visible_order`: `(published_on DESC NULLS LAST,
  first_collected_at DESC) WHERE NOT is_hidden`.
- `publication_source_feed(source_code, publication_id, published_on,
  first_collected_at, is_hidden)`: one row per (semantic source code,
  publication), indexed by `(source_code, date)`. `source_code` is
  `lower(sources.code)`, so case variants (`dou`/`DOU`) collapse into one row,
  and the virtual `confaz` code exists even without a `sources` row. Membership
  keeps the previous filter meaning: `confaz` = CONFAZ-typed acts plus acts
  with a confaz origin; `dou` = dou origin and not CONFAZ-typed; other codes =
  any origin from a source with that code (second origins included).
  `publication_source_feed_expected(uuid[])` computes the authoritative rows.
- Maintenance: triggers on `publication_origins` (insert/delete statement
  level; update of `publication_id`/`source_id` row level), `publications`
  (update of `published_on`/`first_collected_at`/`act_type`/`title` row level
  with `WHEN`; delete statement level) and `sources` (case-insensitive code
  change) call `refresh_publication_source_feed(uuid[])` (`SECURITY DEFINER`,
  fixed `search_path`; runtime roles only have `SELECT` on the table).
  Refreshes are serialized per publication with transaction-scoped advisory
  locks taken in id order (batches above 1,000 ids take one exclusive batch
  lock; single refreshes hold it shared), then rebuild from a snapshot taken
  after the lock, so two writers on one publication cannot leave stale rows.
  Updates of `last_seen_at` never invoke the triggers.
- There is intentionally no foreign key to `publications`: the DOE-SP rebuild
  guard blocks on unknown foreign keys, and the delete trigger keeps the
  table clean.

## `GET /api/v2/archive`

Query parameters: `q` (2–200 chars), `scope` (`title` default | `full`),
`uf`, `jurisdiction` (`FEDERAL` | `STATE`), `source`, `page`, `limit` (≤ 50).

- Search (`q`): letters/digits only (tsquery operators are discarded); every
  term must match; the last term matches as a prefix when it contains a letter
  ("Conv" → Convênio) while numbers stay exact ("1216" does not match 12160);
  accents are ignored. `scope=title` searches act type, number, agency and
  title; `scope=full` also searches the full content.
- Strategy: count matches up to 10,001 through the text index (live, never
  cached, because it also picks the strategy); with ≤ 10,000 matches fetch
  them and sort by date; with more, walk the date index and check each row.
- Totals: exact from the cached aggregates when only `source` (or nothing) is
  filtered; otherwise counted up to 10,000 (non-search counts cached).
  Response fields: `totalItems`, `totalPages`, `totalIsCapped` (true = "more
  than `totalItems`"), `hasMore`. `hasMore` comes from fetching `limit + 1`
  rows, so a stale total never blocks navigation.
- Ordering is `published_on DESC NULLS LAST, first_collected_at DESC, id`:
  the id tie-breaker makes pagination stable (an incremental sort on top of
  the date indexes; measured cost < 1 ms).

## Aggregates and cache

`/public/v2/stats` (visible total via the partial index), `/public/v2/sources`
(feed counts per source), `/api/v2/archive/facets` (one indexed probe per UF
and per source), archive totals and `/public/v1/{sources,stats,publications}`
are served through an in-process cache (`src/infrastructure/cache/`):
global, tenant-independent payloads only. Fresh for `AGGREGATE_CACHE_TTL_MS`
(default 3 600 000 = 1 h, max 6 h; `0` disables); afterwards the previous value
is served for up to another TTL while one background reload runs, so a payload
is at most ~2 TTLs old. Concurrent misses share one query; failed loads are
not cached; `generatedAt` reflects when the payload was computed. The cache
lives in process memory: a restart/deploy starts empty. Product decision
(01/10/2026): catalog totals are not real-time, 1 h is acceptable.

## Measurements (local PostgreSQL 16, synthetic data)

300k publications, PERF-01 (before → after, cold):

| Request | Before | After (cold) | Cached |
| --- | ---: | ---: | ---: |
| `/public/v2/sources` | 9.9–14.7 s | 2.3–2.6 s | ~2 ms |
| `/api/v2/archive/facets` | 6.0 s | 1.3 s | ~2 ms |
| `/api/v2/archive` page 1 / 40 | 1.2–1.4 s | 5–45 ms | 5 ms |
| Dashboard burst (9 requests) | ~14 s | — | 17–38 ms |

5M publications, PERF-01 → PERF-02 (cache off, then cached):

| Request | PERF-01 | PERF-02 cold | PERF-02 cached |
| --- | ---: | ---: | ---: |
| `/public/v2/sources` | 37 s | 0.26 s | 1 ms |
| `/api/v2/archive/facets` | 48 s | 8 ms | 3 ms |
| `/public/v2/stats` | 0.9 s | 0.8 s | 1 ms |
| Archive by source (DOU/SPED) | 7 s – 2 min | 0.25 s | 8–17 ms |
| Archive by UF, page 40 | 0.9 s | 0.1 s | — |
| Search "conv" (title) | 27 s (ILIKE) | 0.16 s | — |
| Search "portaria 4242" (title) | — | 0.05 s | — |
| Search rare term, `scope=full` | — | 0.5 s | — |
| Search very common term, `scope=full` | — | 3–4 s | — |

Equivalence (300k): for every source, the set of publications returned by the
previous filter and by `publication_source_feed` is identical, and
`is_hidden`/`is_confaz` match the previous predicates on every row. Archive
pages differ only in the order of rows tied on date and collection time.
Intentional differences: totals above 10,000 are capped for filtered views,
search ignores accents and matches words (prefix on the last one) instead of
substrings.

Trigger cost (300k publications, local):

| Operation | Without triggers | With triggers |
| --- | ---: | ---: |
| 50k origins in one `INSERT` | 1.8 s | 7.8 s |
| 5k single-row origin `INSERT`s (worker pattern) | 0.26 s | 2.9 s (+~0.5 ms each) |
| 50k origin `UPDATE last_seen_at` | 2.0–2.3 s | 2.2 s (not invoked) |
| 50k publication `UPDATE last_seen_at` | 4.7 s | 4.4 s (not invoked) |

For the historical load, prefer multi-row inserts (one refresh per
statement) or load with the feed triggers disabled and rebuild the feed with
the backfill statement afterwards, then run `ops/catalog/028-validate.sql`.

## Runbook — applying migration 028 (R3)

Migration 028 rewrites `publications` and `publication_versions`, builds GIN
and ordered indexes and backfills the feed, holding locks on those tables
(5M publications: ~12.5 min locally; production is far smaller today but must
be measured on a restored copy). The runner wraps it in one transaction and
rolls back on error; after commit there is no down migration — recovery is a
forward fix or a restore.

Preconditions (all required before authorization):

1. Governance: R3 Issue + LOCK; frozen SHA with review approval.
2. Preflight with the production migration role: `CREATE EXTENSION IF NOT
   EXISTS unaccent` allowed (`SELECT * FROM pg_available_extensions WHERE
   name = 'unaccent'` and role privileges).
3. Backup taken and a full restore rehearsed on scratch; on the restored copy
   run the migration, `npm run db:prepare` and `ops/catalog/028-validate.sql`,
   timing it (this is the window estimate) and confirming that
   `pg_dump`/`pg_restore` of the migrated copy restores `pt_unaccent` before
   the generated columns, plus indexes, triggers and feed.
4. Capacity: free disk/WAL for two table rewrites, the GIN indexes, the
   ordered index and the feed (≈ size of `publications` + `publication_versions`
   + 20%).
5. Window: pause scheduler, workers and any backfill; check for long
   transactions/locks on the rewritten tables (`pg_stat_activity`,
   `pg_locks`). Abort criterion: if `lock_timeout`/expected window is
   exceeded before commit, cancel (the transaction rolls back).
6. Apply: `npm run db:migrate`.
7. Validate: `npm run db:prepare`; `psql -f ops/catalog/028-validate.sql`
   (every mismatch/missing/stale = 0, plans use the new indexes); API smoke
   for search with/without accent, `scope=full`, source filter, totals and
   facets; DOE-SP rebuild dry-run (`ops/doe-sp/sql/20_dry_run_readonly.sql`)
   reports `unknown_foreign_keys = 0`.
8. Resume workers/scheduler; only then deploy the frontend (PR 25).
