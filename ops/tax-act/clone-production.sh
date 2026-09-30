#!/usr/bin/env bash
set -euo pipefail

: "${SOURCE_DATABASE_URL:?SOURCE_DATABASE_URL required}"
: "${TARGET_ADMIN_URL:?TARGET_ADMIN_URL required}"
: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL required}"

echo "TAX_ACT_CLONE_PREPARE_START"

psql "$TARGET_ADMIN_URL" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'radar_app') THEN
    CREATE ROLE radar_app NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'radar_worker') THEN
    CREATE ROLE radar_worker NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'radar_taxonomy_curator') THEN
    CREATE ROLE radar_taxonomy_curator NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'radar_app_runtime') THEN
    CREATE ROLE radar_app_runtime NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'radar_worker_runtime') THEN
    CREATE ROLE radar_worker_runtime NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

GRANT radar_app TO radar_app_runtime;
GRANT radar_worker TO radar_worker_runtime;
REVOKE radar_worker FROM radar_app_runtime;
REVOKE radar_app FROM radar_worker_runtime;
REVOKE radar_taxonomy_curator FROM radar_app_runtime;
REVOKE radar_taxonomy_curator FROM radar_worker_runtime;
SQL

echo "TAX_ACT_CLONE_DUMP_START"
pg_dump "$SOURCE_DATABASE_URL" -Fc --no-owner -f /tmp/prod.dump

echo "TAX_ACT_CLONE_RESTORE_START"
pg_restore --exit-on-error --clean --if-exists --no-owner -d "$TARGET_DATABASE_URL" /tmp/prod.dump

echo -n "TAX_ACT_CLONE_MIGRATIONS="
psql "$TARGET_DATABASE_URL" -Atc "SELECT string_agg(filename, chr(44) ORDER BY filename) FROM schema_migrations"

echo -n "TAX_ACT_CLONE_RELEASE="
psql "$TARGET_DATABASE_URL" -Atc "SELECT status FROM taxonomy_releases WHERE version_major=1 AND version_minor=0 AND version_patch=0"

echo "TAX_ACT_CLONE_COPY_DONE"
