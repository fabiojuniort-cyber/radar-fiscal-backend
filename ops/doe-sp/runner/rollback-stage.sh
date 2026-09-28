#!/usr/bin/env bash
# Stage the pre-rebuild DOE-SP rows from a verified backup restore (SOURCE) into
# schema doe_sp_rollback of TARGET, for sql/60_rollback_import.sql.
# Usage: rollback-stage.sh <source_conninfo> <target_conninfo>
# SOURCE is read inside a READ ONLY transaction. TARGET only gets the staging
# schema; live tables are changed exclusively by 60 in one transaction.
set -euo pipefail

SOURCE="$1"
TARGET="$2"

scope="SELECT DISTINCT po.publication_id FROM publication_origins po JOIN sources s ON s.id = po.source_id WHERE s.code = 'doe-sp' AND s.connector_key = 'doe-sp'"

psql "$TARGET" -v ON_ERROR_STOP=1 -X -q <<'SQL'
DROP SCHEMA IF EXISTS doe_sp_rollback CASCADE;
CREATE SCHEMA doe_sp_rollback;
CREATE TABLE doe_sp_rollback.origins (LIKE public.publication_origins);
CREATE TABLE doe_sp_rollback.versions AS
  SELECT id, publication_id, version_no, content_hash, content_text, relevant_excerpt, source_metadata, is_current, captured_at
  FROM public.publication_versions WITH NO DATA;
CREATE TABLE doe_sp_rollback.files (LIKE public.publication_files);
CREATE TABLE doe_sp_rollback.run_links (collection_run_id uuid NOT NULL, publication_id uuid NOT NULL, publication_version_id uuid);
CREATE TABLE doe_sp_rollback.checkpoints (LIKE public.collection_checkpoints);
SQL

copy() {
  local table="$1" query="$2"
  psql "$SOURCE" -X -q -v ON_ERROR_STOP=1 \
    -c "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY" \
    -c "\\copy ($query) TO STDOUT" \
    -c "COMMIT" \
  | psql "$TARGET" -X -q -v ON_ERROR_STOP=1 -c "\\copy doe_sp_rollback.$table FROM STDIN"
}

copy origins "SELECT po.* FROM publication_origins po JOIN sources s ON s.id = po.source_id WHERE s.code = 'doe-sp' AND s.connector_key = 'doe-sp'"
copy versions "SELECT id, publication_id, version_no, content_hash, content_text, relevant_excerpt, source_metadata, is_current, captured_at FROM publication_versions WHERE publication_id IN ($scope)"
copy files "SELECT pf.* FROM publication_files pf JOIN publication_versions pv ON pv.id = pf.publication_version_id WHERE pv.publication_id IN ($scope)"
copy run_links "SELECT collection_run_id, publication_id, publication_version_id FROM collection_run_publications WHERE publication_id IN ($scope)"
copy checkpoints "SELECT cc.* FROM collection_checkpoints cc JOIN sources s ON s.id = cc.source_id WHERE s.code = 'doe-sp' AND cc.connector_key = 'doe-sp'"

psql "$TARGET" -X -q -t -A -v ON_ERROR_STOP=1 -c "SELECT 'DOE_SP_ROLLBACK_STAGED=' || jsonb_build_object(
  'origins', (SELECT count(*) FROM doe_sp_rollback.origins),
  'versions', (SELECT count(*) FROM doe_sp_rollback.versions),
  'files', (SELECT count(*) FROM doe_sp_rollback.files),
  'runLinks', (SELECT count(*) FROM doe_sp_rollback.run_links),
  'checkpoints', (SELECT count(*) FROM doe_sp_rollback.checkpoints))::text"
