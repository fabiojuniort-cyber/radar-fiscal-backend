#!/usr/bin/env bash
set -euo pipefail
# Isolated GitHub CI only. Exercises migration 051's fail-closed DRAFT guard.
ROOT="${GITHUB_WORKSPACE:-$PWD}"
TEST_DB="l11_draft_guard_test"
URL="postgresql://postgres:postgres@localhost:5432/${TEST_DB}"
PGPASSWORD=postgres psql -h localhost -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE ${TEST_DB}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/migrations"
cp "$ROOT"/migrations/0[0-4][0-9]_*.sql "$tmp/migrations/"
rm -f "$tmp/migrations/051_collection_filter_direct_rules_cleanup.sql"
(
 cd "$tmp"
 DATABASE_ADMIN_URL="$URL" DATABASE_URL="$URL" node "$ROOT/dist/infrastructure/database/migrate.js"
) >"$tmp/initial.log" 2>&1 || { cat "$tmp/initial.log"; exit 1; }
PGPASSWORD=postgres psql -h localhost -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO collection_filter_policies(version,status) VALUES (999,'DRAFT');
INSERT INTO collection_filter_type_rules(policy_id,source_code,section,canonical_type,mode)
SELECT id,'dou','DO1','EDITAL','EXCLUDE_ALWAYS'
FROM collection_filter_policies WHERE version=999 AND status='DRAFT';
SQL
cp "$ROOT/migrations/051_collection_filter_direct_rules_cleanup.sql" "$tmp/migrations/"
if (
 cd "$tmp"
 DATABASE_ADMIN_URL="$URL" DATABASE_URL="$URL" node "$ROOT/dist/infrastructure/database/migrate.js"
) >"$tmp/guard.log" 2>&1; then
  echo "FAIL: configured DRAFT unexpectedly allowed migration 051"
  exit 1
fi
grep -q "L11_MIGRATION_BLOCKED_CONFIGURED_DRAFT" "$tmp/guard.log" || { cat "$tmp/guard.log"; exit 1; }
result="$(PGPASSWORD=postgres psql -h localhost -U postgres -d "$TEST_DB" -v ON_ERROR_STOP=1 -Atc "
  SELECT CASE WHEN
    (SELECT count(*) FROM collection_filter_policies WHERE version=999 AND status='DRAFT')=1
    AND (SELECT count(*) FROM collection_filter_type_rules r
      JOIN collection_filter_policies p ON p.id=r.policy_id
      WHERE p.version=999)=1
    AND NOT EXISTS(SELECT 1 FROM schema_migrations WHERE filename='051_collection_filter_direct_rules_cleanup.sql')
    AND to_regclass('public.collection_filter_simulations') IS NOT NULL
  THEN 'PASS' ELSE 'FAIL' END;
")"
test "$result" = PASS
echo "L11_CONFIGURED_DRAFT_GUARD=PASS (migration blocked and all data/schema preserved)"
