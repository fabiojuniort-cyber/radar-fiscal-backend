#!/usr/bin/env bash
# DOE-SP rebuild — PREPARATION runner (DOE-SP-31). Runs inside Railway.
#
# Production access is READ ONLY:
#   * only sql/10, 11, 12, 20 (allowlist) and pg_dump touch PROD_DATABASE_URL;
#   * every production session starts with default_transaction_read_only=on
#     and each SQL file asserts transaction_read_only=on at server level;
#   * all of them share one exported snapshot, so preflight, manifest, table
#     counts, dry-run and backup describe the same instant.
# Write steps (25/30/40/50/60) only ever run against a temporary PostgreSQL
# started inside this container (unix socket, no network listener).
#
# Private data (backup, identifiable manifest) stays on the Railway volume
# mounted at DATA_DIR. Logs carry PASS/FAIL, counts and SHA-256 only.
set -Eeuo pipefail

: "${PROD_DATABASE_URL:?PROD_DATABASE_URL is required}"
DATA_DIR="${DATA_DIR:-/data}"
OPS="${OPS_DIR:-/opt/doe-sp}"
SQL="$OPS/sql"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$DATA_DIR/doe-sp-31/$STAMP"
PRIVATE="$WORK/private"
BACKUP="$WORK/backup"
PGTMP="$WORK/pgtmp"
LOCAL_SOCKET=/tmp/doe-sp-pg
LOCAL_PORT=5439
declare -A RESULT=()
AS_POSTGRES="${AS_POSTGRES:-gosu postgres}"

log() { printf '%s\n' "$*"; }
stop_temp() { [ -f "$PGTMP/data/postmaster.pid" ] && $AS_POSTGRES pg_ctl -D "$PGTMP/data" -m immediate stop >/dev/null 2>&1 || true; }
fail() { trap - ERR; log "DOE_SP_31_STEP_FAIL=$1"; RESULT[$1]=FAIL; stop_temp; summary; exit 1; }
pass() { log "DOE_SP_31_STEP_PASS=$1"; RESULT[$1]=PASS; }
summary() {
  local json='{}' k
  for k in "${!RESULT[@]}"; do json=$(jq -c --arg k "$k" --arg v "${RESULT[$k]}" '. + {($k): $v}' <<<"$json"); done
  log "DOE_SP_31_RESULT=$(jq -c --arg stamp "$STAMP" '{stamp: $stamp, steps: .}' <<<"$json")"
}
trap 'fail "unexpected_error_line_$LINENO"' ERR

umask 077
mkdir -p "$PRIVATE" "$BACKUP" "$PGTMP" "$LOCAL_SOCKET"

# ---------------------------------------------------------------- production (read only)
export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=600000 -c lock_timeout=2000"
PROD="$PROD_DATABASE_URL"

prod_sql() { # allowlisted read-only files only
  local file="$1"; shift
  case "$file" in
    10_preflight_readonly.sql|11_private_manifest_readonly.sql|12_table_counts_readonly.sql|20_dry_run_readonly.sql) ;;
    *) fail "prod_sql_not_allowlisted_$file" ;;
  esac
  psql "$PROD" -X -q -t -A -v ON_ERROR_STOP=1 "$@" -f "$SQL/$file"
}

log "DOE_SP_31_START stamp=$STAMP"
[ "$(psql "$PROD" -X -t -A -c 'SHOW default_transaction_read_only')" = "on" ] || fail prod_session_read_only
pass prod_session_read_only

# Snapshot holder: one READ ONLY transaction kept open while everything else
# imports its snapshot.
coproc SNAP { psql "$PROD" -X -q -t -A -v ON_ERROR_STOP=1; }
echo "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();" >&"${SNAP[1]}"
read -r -t 30 SNAPSHOT <&"${SNAP[0]}" || fail snapshot_export
[[ "$SNAPSHOT" =~ ^[0-9A-F-]+$ ]] || fail snapshot_export
pass snapshot_export

prod_sql 10_preflight_readonly.sql -v snapshot="$SNAPSHOT" > "$WORK/preflight.prod.txt" || fail preflight_prod
grep '^DOE_SP_PREFLIGHT=' "$WORK/preflight.prod.txt"
pass preflight_prod

prod_sql 11_private_manifest_readonly.sql -v snapshot="$SNAPSHOT" > "$PRIVATE/manifest.prod.jsonl" || fail manifest_prod
MANIFEST_SHA=$(sha256sum "$PRIVATE/manifest.prod.jsonl" | cut -d' ' -f1)
log "DOE_SP_PRIVATE_MANIFEST=$(jq -cn --arg sha "$MANIFEST_SHA" --argjson lines "$(wc -l < "$PRIVATE/manifest.prod.jsonl")" '{sha256: $sha, lines: $lines, location: "railway-volume"}')"
pass manifest_prod

prod_sql 12_table_counts_readonly.sql -v snapshot="$SNAPSHOT" | grep '^DOE_SP_TABLE_COUNTS=' > "$WORK/counts.prod.txt" || fail table_counts_prod
log "DOE_SP_TABLE_COUNTS_PROD_SHA256=$(sha256sum "$WORK/counts.prod.txt" | cut -d' ' -f1)"
pass table_counts_prod

prod_sql 20_dry_run_readonly.sql -v snapshot="$SNAPSHOT" > "$WORK/dryrun.prod.txt" || fail dry_run_prod
grep -E '^DOE_SP_(DRY_RUN|REBUILD_ARGS)=' "$WORK/dryrun.prod.txt"
pass dry_run_prod

DUMP="$BACKUP/radar-fiscal-$STAMP.dump"
pg_dump "$PROD" --snapshot="$SNAPSHOT" --format=custom --compress=6 --no-password --file="$DUMP" || fail backup_dump
DUMP_SHA=$(sha256sum "$DUMP" | cut -d' ' -f1)
sha256sum "$DUMP" > "$DUMP.sha256"
log "DOE_SP_BACKUP=$(jq -cn --arg sha "$DUMP_SHA" --argjson bytes "$(stat -c %s "$DUMP")" --arg file "$(basename "$DUMP")" '{file: $file, sha256: $sha, bytes: $bytes, format: "pg_dump custom", location: "railway-volume"}')"
pg_restore --list "$DUMP" > "$WORK/backup.toc" || fail backup_toc
pass backup_dump

echo "COMMIT;" >&"${SNAP[1]}"
exec {SNAP[1]}>&-
wait "$SNAP_PID" || true
unset PGOPTIONS
pass snapshot_released

# ---------------------------------------------------------------- temporary PostgreSQL (local only)
chmod 711 "$DATA_DIR/doe-sp-31" "$WORK"   # traverse only; private/ and backup/ stay 700
chown -R postgres:postgres "$PGTMP" "$LOCAL_SOCKET"
$AS_POSTGRES initdb -D "$PGTMP/data" -U postgres --auth=trust --encoding=UTF8 --locale=C.UTF-8 >/dev/null || fail temp_initdb
$AS_POSTGRES pg_ctl -D "$PGTMP/data" -w -o "-c listen_addresses='' -k $LOCAL_SOCKET -p $LOCAL_PORT -c max_wal_size=2GB" -l "$PGTMP/server.log" start >/dev/null || fail temp_start
LOCAL_ADMIN="host=$LOCAL_SOCKET port=$LOCAL_PORT user=postgres dbname=postgres"
local_db() { printf 'host=%s port=%s user=postgres dbname=%s' "$LOCAL_SOCKET" "$LOCAL_PORT" "$1"; }
pass temp_postgres_started

# Roles referenced by the dump (names only; no passwords leave production).
export PGOPTIONS="-c default_transaction_read_only=on"
psql "$PROD" -X -t -A -v ON_ERROR_STOP=1 -c "SELECT rolname FROM pg_roles WHERE rolname !~ '^pg_' AND rolname <> current_user ORDER BY 1" > "$WORK/roles.txt" || fail roles_list
unset PGOPTIONS
while read -r role; do
  [ -n "$role" ] || continue
  printf '%s\n' "SELECT format('CREATE ROLE %I NOLOGIN', :'role') \\gexec" | psql "$LOCAL_ADMIN" -X -q -v ON_ERROR_STOP=1 -v role="$role" >/dev/null
done < "$WORK/roles.txt"
PROD_OWNER=$(PGOPTIONS="-c default_transaction_read_only=on" psql "$PROD" -X -t -A -c "SELECT current_user")
[ "$PROD_OWNER" = postgres ] || printf '%s\n' "SELECT format('CREATE ROLE %I SUPERUSER NOLOGIN', :'role') \\gexec" | psql "$LOCAL_ADMIN" -X -q -v ON_ERROR_STOP=1 -v role="$PROD_OWNER" >/dev/null
pass temp_roles

restore_into() {
  local db="$1"
  psql "$LOCAL_ADMIN" -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $db" >/dev/null
  pg_restore --exit-on-error --jobs=2 --dbname="$(local_db "$db")" "$DUMP"
}
restore_into restored || fail restore
pass restore

# ---------------------------------------------------------------- restore verification
export PGOPTIONS="-c default_transaction_read_only=on"
RESTORED="$(local_db restored)"
psql "$RESTORED" -X -q -t -A -v ON_ERROR_STOP=1 -f "$SQL/12_table_counts_readonly.sql" | grep '^DOE_SP_TABLE_COUNTS=' > "$WORK/counts.restored.txt" || fail table_counts_restored
cmp -s "$WORK/counts.prod.txt" "$WORK/counts.restored.txt" || fail restore_table_counts_equal
pass restore_table_counts_equal

psql "$RESTORED" -X -q -t -A -v ON_ERROR_STOP=1 -f "$SQL/11_private_manifest_readonly.sql" > "$PRIVATE/manifest.restored.jsonl" || fail manifest_restored
[ "$(sha256sum "$PRIVATE/manifest.restored.jsonl" | cut -d' ' -f1)" = "$MANIFEST_SHA" ] || fail restore_manifest_equal
pass restore_manifest_equal

psql "$RESTORED" -X -q -t -A -v ON_ERROR_STOP=1 -f "$SQL/10_preflight_readonly.sql" > "$WORK/preflight.restored.txt" || fail preflight_restored
strip='sub("^DOE_SP_PREFLIGHT=";"") | fromjson | del(.capturedAt, .serverVersion)'
[ "$(grep '^DOE_SP_PREFLIGHT=' "$WORK/preflight.prod.txt" | jq -R -c "$strip")" = "$(grep '^DOE_SP_PREFLIGHT=' "$WORK/preflight.restored.txt" | jq -R -c "$strip")" ] || fail restore_preflight_equal
pass restore_preflight_equal

# Record access: every manifest publication is readable with its current version text.
ACCESS=$(psql "$RESTORED" -X -q -t -A -v ON_ERROR_STOP=1 -c "BEGIN READ ONLY; SELECT count(*) FILTER (WHERE pv.id IS NOT NULL) || '/' || count(*) FROM publication_origins po JOIN sources s ON s.id = po.source_id AND s.code = 'doe-sp' JOIN publications p ON p.id = po.publication_id LEFT JOIN publication_versions pv ON pv.publication_id = p.id AND pv.is_current; COMMIT;" | grep '/')
log "DOE_SP_RESTORE_RECORD_ACCESS=$ACCESS"
[ "${ACCESS%/*}" = "${ACCESS#*/}" ] || fail restore_record_access
pass restore_record_access
unset PGOPTIONS

# ---------------------------------------------------------------- rehearsal on a second temporary copy
restore_into rehearsal || fail rehearsal_restore
REH="$(local_db rehearsal)"
psql "$REH" -X -q -t -A -v ON_ERROR_STOP=1 -f "$SQL/25_pause_source.sql" | grep -E '^DOE_SP_(PAUSE|PAUSED|ACTIVE)' || fail rehearsal_pause
pass rehearsal_pause

REH_ARGS=$(PGOPTIONS="-c default_transaction_read_only=on" psql "$REH" -X -q -t -A -v ON_ERROR_STOP=1 -f "$SQL/20_dry_run_readonly.sql" | tee "$WORK/dryrun.rehearsal.txt" | sed -n 's/^DOE_SP_REBUILD_ARGS=//p')
[ -n "$REH_ARGS" ] || fail rehearsal_dry_run
grep '^DOE_SP_DRY_RUN=' "$WORK/dryrun.rehearsal.txt" | jq -R -e 'sub("^DOE_SP_DRY_RUN=";"") | fromjson | .blockers | to_entries | all(.value == 0)' >/dev/null || fail rehearsal_blockers_zero
pass rehearsal_blockers_zero

# 30 without confirm: must execute every step and roll back, leaving data identical.
# shellcheck disable=SC2086
psql "$REH" -X -q -t -A -v ON_ERROR_STOP=1 $REH_ARGS -f "$SQL/30_rebuild_destructive.sql" | grep -E '^DOE_SP_REBUILD' || fail rehearsal_30_dry
PGOPTIONS="-c default_transaction_read_only=on" psql "$REH" -X -q -t -A -v ON_ERROR_STOP=1 -f "$SQL/11_private_manifest_readonly.sql" | sha256sum | cut -d' ' -f1 > "$WORK/reh.after-dry.sha"
[ "$(cat "$WORK/reh.after-dry.sha")" = "$MANIFEST_SHA" ] || fail rehearsal_30_dry_left_data_intact
pass rehearsal_30_dry_left_data_intact

# 30 with a wrong expected count must abort before changing anything.
# shellcheck disable=SC2086
if psql "$REH" -X -q -t -A -v ON_ERROR_STOP=1 $REH_ARGS -v expected_versions_deleted=-1 -v confirm=REBUILD_DOE_SP -f "$SQL/30_rebuild_destructive.sql" >/dev/null 2>&1; then
  fail rehearsal_30_mismatch_aborts
fi
pass rehearsal_30_mismatch_aborts

# 30 committed.
# shellcheck disable=SC2086
psql "$REH" -X -q -t -A -v ON_ERROR_STOP=1 $REH_ARGS -v confirm=REBUILD_DOE_SP -f "$SQL/30_rebuild_destructive.sql" | tee "$WORK/rebuild.rehearsal.txt" | grep -E '^DOE_SP_REBUILD' || fail rehearsal_30_commit
grep -q '^DOE_SP_REBUILD_COMMITTED' "$WORK/rebuild.rehearsal.txt" || fail rehearsal_30_commit
pass rehearsal_30_commit

KEPT=$(sed -n 's/.*-v expected_publications_kept=\([0-9]*\).*/\1/p' <<<"$REH_ARGS")
PGOPTIONS="-c default_transaction_read_only=on" psql "$REH" -X -q -t -A -v ON_ERROR_STOP=1 -v expected_publications_kept="$KEPT" -f "$SQL/40_post_rebuild_validation.sql" | grep '^DOE_SP_POST_REBUILD=' || fail rehearsal_40
pass rehearsal_40_post_rebuild

# Rollback after COMMIT: stage from the pristine restore, import, compare manifest.
"$OPS/runner/rollback-stage.sh" "$RESTORED" "$REH" || fail rehearsal_rollback_stage
psql "$REH" -X -q -t -A -v ON_ERROR_STOP=1 -f "$SQL/60_rollback_import.sql" | grep -E '^DOE_SP_ROLLBACK' || fail rehearsal_60_rollback
PGOPTIONS="-c default_transaction_read_only=on" psql "$REH" -X -q -t -A -v ON_ERROR_STOP=1 -f "$SQL/11_private_manifest_readonly.sql" | sha256sum | cut -d' ' -f1 > "$WORK/reh.after-rollback.sha"
[ "$(cat "$WORK/reh.after-rollback.sha")" = "$MANIFEST_SHA" ] || fail rehearsal_rollback_manifest_equal
pass rehearsal_rollback_manifest_equal

psql "$REH" -X -q -t -A -v ON_ERROR_STOP=1 -f "$SQL/50_resume_source.sql" | grep -q DOE_SP_RESUMED || fail rehearsal_resume
PGOPTIONS="-c default_transaction_read_only=on" psql "$REH" -X -q -t -A -v ON_ERROR_STOP=1 -f "$SQL/12_table_counts_readonly.sql" | grep '^DOE_SP_TABLE_COUNTS=' > "$WORK/counts.rehearsal-final.txt"
cmp -s "$WORK/counts.prod.txt" "$WORK/counts.rehearsal-final.txt" || fail rehearsal_final_counts_equal
pass rehearsal_final_counts_equal

# ---------------------------------------------------------------- cleanup (backup + manifest stay)
$AS_POSTGRES pg_ctl -D "$PGTMP/data" -m fast stop >/dev/null
rm -rf "$PGTMP"
pass temp_postgres_removed
log "DOE_SP_31_FILES=$(cd "$WORK" && find . -type f -printf '%P %s\n' | sort | jq -R -s -c 'split("\n") | map(select(length > 0))')"
trap - ERR
summary
log "DOE_SP_31_DONE"
