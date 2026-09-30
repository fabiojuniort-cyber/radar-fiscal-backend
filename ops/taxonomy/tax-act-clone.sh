#!/usr/bin/env bash
set -euo pipefail

: "${SOURCE_DATABASE_URL:?SOURCE_DATABASE_URL is required}"
: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL is required}"

echo "TAX_ACT_CLONE_START"

pg_dumpall --database="$SOURCE_DATABASE_URL" --roles-only --no-role-passwords > /tmp/roles.sql
psql "$TARGET_DATABASE_URL" -f /tmp/roles.sql >/tmp/roles.out 2>/tmp/roles.err || true

for role in radar_app radar_worker radar_taxonomy_curator radar_app_runtime radar_worker_runtime; do
  if ! psql "$TARGET_DATABASE_URL" -Atc "SELECT 1 FROM pg_roles WHERE rolname = '${role}'" | grep -qx 1; then
    echo "TAX_ACT_CLONE_MISSING_ROLE=${role}" >&2
    exit 1
  fi
done

pg_dump "$SOURCE_DATABASE_URL" -Fc --no-owner --no-acl -f /tmp/prod.dump
pg_restore --clean --if-exists --no-owner --no-acl -d "$TARGET_DATABASE_URL" /tmp/prod.dump

echo -n "TAX_ACT_CLONE_MIGRATIONS="
psql "$TARGET_DATABASE_URL" -Atc "SELECT string_agg(filename, chr(44) ORDER BY filename) FROM schema_migrations"

echo -n "TAX_ACT_CLONE_RELEASE="
psql "$TARGET_DATABASE_URL" -Atc "SELECT version || chr(58) || status FROM taxonomy_releases WHERE version_major=1 AND version_minor=0 AND version_patch=0"

echo "TAX_ACT_CLONE_DONE"
