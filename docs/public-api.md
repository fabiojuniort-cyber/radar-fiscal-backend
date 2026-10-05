# Public read-only API — API-01

Decision: D-050 (26/09/2026).  
Tracking: tribusca-control Issue #11.

## Scope

The public API exposes only global metadata that is already public by nature:
official sources, source operational health, and official-publication metadata.

It does **not** expose:

- tenant/company/user data;
- authentication/session data;
- monitoring-profile or matching data;
- publication `content_text`;
- internal worker/scheduler metadata beyond the public status fields defined below.

Prefix: `/public/v1`.

All routes are GET-only and require no authentication.

## GET /public/v1/sources

Response:

```json
{
  "generatedAt": "2026-09-26T18:00:00.000Z",
  "items": [
    {
      "code": "doe-sp",
      "name": "Diário Oficial do Estado de São Paulo",
      "jurisdictionLevel": "STATE",
      "uf": "SP",
      "isActive": true,
      "status": "ONLINE",
      "lastRunStatus": "SUCCESS",
      "lastSuccessAt": "2026-09-26T17:55:00.000Z",
      "lastAttemptAt": "2026-09-26T17:55:00.000Z",
      "importedToday": 3,
      "totalPublications": 517
    }
  ]
}
```

The numeric values above are illustrative contract examples, not production claims.

### Status mapping

- `ONLINE`: latest run = `SUCCESS` or `SUCCESS_NO_RESULTS`.
- `UNSTABLE`: latest run = `PARTIAL_SUCCESS`; or `RUNNING`/`PENDING` with a successful run less than 48 hours ago.
- `UNAVAILABLE`: latest run = `SOURCE_UNAVAILABLE`, `FETCH_FAILED`, `PROCESSING_FAILED` or `CANCELLED`; or `RUNNING`/`PENDING` without a successful run in the previous 48 hours.
- `NOT_CONSULTED`: no run, latest run = `NOT_CONSULTED`, or source is inactive.

A jurisdiction/source absent from `sources` is omitted. The frontend may represent it as “Em implantação”.

### Counts

- `importedToday`: count of `collection_run_publications` rows with disposition `NEW_PUBLICATION` or `NEW_VERSION` whose `detected_at` falls on the current calendar day in `America/Sao_Paulo`.
- `totalPublications`: distinct publications connected to the source through `publication_origins`.

The route reads `sources`, `v_source_monitoring`, `collection_runs`, `collection_run_publications` and `publication_origins`.

## GET /public/v1/publications

Supported query parameters:

- `uf=SP`;
- `jurisdiction=FEDERAL|STATE`;
- `source=<source code>`;
- `limit=1..20` (default 3).

Filters may be combined.

Ordering:

1. `published_on DESC NULLS LAST`;
2. `first_collected_at DESC`.

Response:

```json
{
  "items": [
    {
      "id": "00000000-0000-0000-0000-000000000000",
      "title": "Título oficial",
      "actType": "PORTARIA",
      "actNumber": "99/2026",
      "agency": "SEFAZ-SP",
      "uf": "SP",
      "publishedOn": "2026-09-26",
      "effectiveOn": "2026-09-27",
      "officialUrl": "https://fonte-oficial.example/ato"
    }
  ]
}
```

No `content_text`, excerpt, tenant or customer field is returned.

`officialUrl` prefers `publications.primary_official_url`; when it is null, the oldest official URL from `publication_origins` is used.

The route does not read `publication_versions`.

## GET /public/v1/stats

Response:

```json
{
  "totalPublications": 0,
  "totalSources": 0,
  "activeSources": 0,
  "importedToday": 0,
  "generatedAt": "2026-09-26T18:00:00.000Z"
}
```

`importedToday` follows the same São Paulo calendar-day/disposition rule as `/sources`.

## CORS

Browser CORS uses:

```text
PUBLIC_API_ALLOWED_ORIGINS=https://<railway-prototype-host>,https://<final-site-host>
```

Rules:

- exact comma-separated origin allowlist;
- every public response varies by `Origin`, including requests without it; existing `Vary` values are retained so shared caches distinguish browser-origin variants;
- allowed browser origins receive `Access-Control-Allow-Origin` with the exact request origin;
- no `Access-Control-Allow-Credentials`;
- preflight advertises only `GET`;
- unknown browser origins receive HTTP 403;
- requests without an `Origin` header remain possible because this is a public API; CORS is a browser boundary, not server-to-server authentication.

The actual prototype/final origins are deployment configuration and must be confirmed before deploy. They are not invented in source control.

## Cache

Successful GET responses send:

```text
Cache-Control: public, max-age=0, no-cache, must-revalidate
```

Public clients and intermediaries must revalidate successful GET responses. This prevents a response containing a publication that has just transitioned to `OUT_OF_SCOPE` from remaining usable for the former five-minute client/CDN TTL.

Since PERF-01, the server also keeps an in-process copy of the global
aggregates (`/public/v1/sources`, `/public/v1/stats`, `/public/v1/publications`,
`/public/v2/stats`, `/public/v2/sources` and the authenticated
`/api/v2/archive/facets` and archive totals). Publication-scope transitions
advance a monotonic cache epoch used to version the affected server-side cache
keys, so `SUPPRESS`/`RESTORE` invalidates those cached representations without
requiring a process restart. See [catalog-performance.md](catalog-performance.md).

## Rate limit

The backend does not currently include a rate-limit plugin. Per-IP rate limiting (target example: 60 requests/minute) remains a documented follow-up before high-volume public exposure.

## Database and indexes

API-01 introduces no migration.

The implementation uses existing structures/indexes:

- `ix_publications_scope_date`;
- `ix_collection_runs_source_history`;
- publication-origin indexes;
- `v_source_monitoring`.

It does not scan `publication_versions`.

The application runtime role already has SELECT grants on the global source/publication/collection tables and `v_source_monitoring` in migration 009.

## Production-schema verification limitation

During API-01 implementation, the Railway connector could inspect service configuration but could not execute read-only PostgreSQL metadata SQL. Therefore the implementation revalidated migrations and generated Kysely types, but does **not** claim a fresh direct SQL read of the production schema.

Merge and deploy are separate gates. After an authorized deploy, validate the three public endpoints against the deployed database before marking the API productive.
