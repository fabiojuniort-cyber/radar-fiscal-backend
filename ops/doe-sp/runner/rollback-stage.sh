#!/usr/bin/env bash
# Stage the pre-rebuild DOE-SP state from a verified backup restore (SOURCE)
# into schema doe_sp_rollback of TARGET, for sql/60_rollback_import.sql.
# Usage: rollback-stage.sh <source_conninfo> <target_conninfo>
#
# SOURCE is only read (READ ONLY transactions). TARGET only gets the staging
# schema; live tables are changed exclusively by 60, in one transaction.
# Staged: full publications rows of the scope (canonical fields are restored,
# not just versions), origins, versions, files, run links, checkpoints, the
# ids of every DOE-SP run that existed at backup time (anything newer is a
# recapture run and is removed by 60) and translations if the table exists.
set -euo pipefail

SOURCE="$1"
TARGET="$2"

src="SELECT id FROM sources WHERE code = 'doe-sp' AND connector_key = 'doe-sp'"
scope="SELECT DISTINCT po.publication_id FROM publication_origins po WHERE po.source_id = ($src)"

psql "$TARGET" -v ON_ERROR_STOP=1 -X -q <<'SQL'
SET client_min_messages = warning;
DROP SCHEMA IF EXISTS doe_sp_rollback CASCADE;
CREATE SCHEMA doe_sp_rollback;
CREATE TABLE doe_sp_rollback.publications (LIKE public.publications);
CREATE TABLE doe_sp_rollback.origins (LIKE public.publication_origins);
CREATE TABLE doe_sp_rollback.versions AS
  SELECT id, publication_id, version_no, content_hash, content_text, relevant_excerpt, source_metadata, is_current, captured_at
  FROM public.publication_versions WITH NO DATA;
CREATE TABLE doe_sp_rollback.files (LIKE public.publication_files);
CREATE TABLE doe_sp_rollback.run_links (collection_run_id uuid NOT NULL, publication_id uuid NOT NULL, publication_version_id uuid);
CREATE TABLE doe_sp_rollback.runs (id uuid PRIMARY KEY);
CREATE TABLE doe_sp_rollback.checkpoints (LIKE public.collection_checkpoints);
SQL
HAS_TRANSLATIONS=$(psql "$SOURCE" -X -t -A -c "SELECT to_regclass('public.norma_clara_translations') IS NOT NULL")
if [ "$HAS_TRANSLATIONS" = t ]; then
  psql "$TARGET" -v ON_ERROR_STOP=1 -X -q -c "CREATE TABLE doe_sp_rollback.translations (LIKE public.norma_clara_translations)"
fi

copy() {
  local table="$1" query="$2"
  psql "$SOURCE" -X -q -v ON_ERROR_STOP=1 \
    -c "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY" \
    -c "\\copy ($query) TO STDOUT" \
    -c "COMMIT" \
  | psql "$TARGET" -X -q -v ON_ERROR_STOP=1 -c "\\copy doe_sp_rollback.$table FROM STDIN"
}

copy publications "SELECT p.* FROM publications p WHERE p.id IN ($scope)"
copy origins "SELECT po.* FROM publication_origins po WHERE po.source_id = ($src)"
copy versions "SELECT id, publication_id, version_no, content_hash, content_text, relevant_excerpt, source_metadata, is_current, captured_at FROM publication_versions WHERE publication_id IN ($scope)"
copy files "SELECT pf.* FROM publication_files pf JOIN publication_versions pv ON pv.id = pf.publication_version_id WHERE pv.publication_id IN ($scope)"
copy run_links "SELECT collection_run_id, publication_id, publication_version_id FROM collection_run_publications WHERE publication_id IN ($scope)"
copy runs "SELECT id FROM collection_runs WHERE source_id = ($src)"
copy checkpoints "SELECT cc.* FROM collection_checkpoints cc WHERE cc.source_id = ($src) AND cc.connector_key = 'doe-sp'"
if [ "$HAS_TRANSLATIONS" = t ]; then
  copy translations "SELECT t.* FROM norma_clara_translations t JOIN publication_versions pv ON pv.id = t.publication_version_id WHERE pv.publication_id IN ($scope)"
fi

psql "$TARGET" -X -q -t -A -v ON_ERROR_STOP=1 -c "SELECT 'DOE_SP_ROLLBACK_STAGED=' || jsonb_build_object(
  'publications', (SELECT count(*) FROM doe_sp_rollback.publications),
  'origins', (SELECT count(*) FROM doe_sp_rollback.origins),
  'versions', (SELECT count(*) FROM doe_sp_rollback.versions),
  'files', (SELECT count(*) FROM doe_sp_rollback.files),
  'runLinks', (SELECT count(*) FROM doe_sp_rollback.run_links),
  'runs', (SELECT count(*) FROM doe_sp_rollback.runs),
  'checkpoints', (SELECT count(*) FROM doe_sp_rollback.checkpoints),
  'translations', CASE WHEN to_regclass('doe_sp_rollback.translations') IS NULL THEN 0 ELSE (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM doe_sp_rollback.translations', false, true, '')))[1]::text::bigint END)::text"
