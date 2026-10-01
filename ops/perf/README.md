# Catalog performance kit (PERF-01)

Reproducible volume tests for the catalog endpoints. Scratch databases only:
both scripts refuse to run unless the database name contains `perf`.

```bash
createdb radar_perf
DATABASE_URL=postgresql://.../radar_perf DATABASE_ADMIN_URL=postgresql://.../radar_perf \
  npm run build && npm run db:migrate
psql postgresql://.../radar_perf -v n=5000000 -f ops/perf/seed-catalog-scale.sql
AGGREGATE_CACHE_TTL_MS=0 DATABASE_URL=... DATABASE_ADMIN_URL=... JWT_ACCESS_SECRET=... \
  npx tsx ops/perf/bench-catalog.ts
```

`AGGREGATE_CACHE_TTL_MS=0` measures the cold queries the aggregate cache
hides. To time the proposed schema changes (PERF-02) — these experiments target the
pre-028 schema; on a database migrated with 028 the structures already exist:

```bash
psql postgresql://.../radar_perf -f ops/perf/experiment-build.sql
psql postgresql://.../radar_perf -f ops/perf/experiment-measure.sql
```

Results and the scaling plan: `docs/catalog-scale-plan.md`.
