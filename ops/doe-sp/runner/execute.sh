#!/usr/bin/env bash
# DOE-SP rebuild — EXECUTION runner (DOE-SP-38). Runs inside Railway, in the
# same service/volume as prep.sh (tmp-doe-sp-31-runner), started by overriding
# the service start command with /opt/doe-sp/runner/execute.sh.
#
# One deploy = one step. The step and every argument come from service
# variables; nothing is typed by hand against production.
#
#   DOE_SP_STEP         pause | dry_run | rebuild_dry | rebuild_commit |
#                       validate_40 | resume | validate_41 | rollback
#   DOE_SP_EXEC_ID      unique id of this execution (e.g. doe-sp-40-03). A
#                       marker is kept on the volume: the same id never runs
#                       twice, so an accidental redeploy is refused.
#   DOE_SP_NOT_AFTER    ISO-8601 UTC deadline; after it the step is refused.
#   DOE_SP_CONFIRM      write steps only: PAUSE_DOE_SP | REBUILD_DOE_SP |
#                       RESUME_DOE_SP | ROLLBACK_DOE_SP (must match the step).
#   DOE_SP_REBUILD_ARGS rebuild_dry / rebuild_commit / validate_40: the exact
#                       DOE_SP_REBUILD_ARGS line printed by the reviewed dry-run.
#   DOE_SP_ROLLBACK_DUMP_SHA256  rollback only: SHA-256 of the verified dump on
#                       the volume (DOE_SP_BACKUP line of prep.sh).
#
# Guarantees:
#   * unknown/missing step, confirm, id or deadline => refused BEFORE any
#     database connection;
#   * read-only steps run with default_transaction_read_only=on;
#   * rebuild_* re-run 20 in the same execution: all blockers must be 0 and its
#     DOE_SP_REBUILD_ARGS must equal DOE_SP_REBUILD_ARGS exactly; commit then
#     runs 40 immediately;
#   * rollback restores the dump into a temporary PostgreSQL inside this
#     container, stages it with rollback-stage.sh, runs 60 and requires the
#     production manifest (11) to equal the backup's manifest;
#   * logs carry only DOE_SP_* aggregate lines, SHA-256 and counts (C-09).
set -Eeuo pipefail

DATA_DIR="${DATA_DIR:-/data}"
OPS="${OPS_DIR:-/opt/doe-sp}"
SQL="$OPS/sql"
AS_POSTGRES="${AS_POSTGRES-gosu postgres}"
STEP="${DOE_SP_STEP:-}"
EXEC_ID="${DOE_SP_EXEC_ID:-}"
NOT_AFTER="${DOE_SP_NOT_AFTER:-}"
CONFIRM="${DOE_SP_CONFIRM:-}"
MARKERS="$DATA_DIR/doe-sp-exec"
LOCAL_SOCKET=/tmp/doe-sp-exec-pg
LOCAL_PORT=5440
PGTMP=""

log() { printf '%s\n' "$*"; }
result() { log "DOE_SP_EXEC_RESULT=$(jq -cn --arg step "$STEP" --arg id "$EXEC_ID" --arg status "$1" --arg detail "${2:-}" '{step: $step, execId: $id, status: $status, detail: $detail}')"; }
stop_temp() { [ -n "$PGTMP" ] && [ -f "$PGTMP/data/postmaster.pid" ] && $AS_POSTGRES pg_ctl -D "$PGTMP/data" -m immediate stop >/dev/null 2>&1 || true; [ -n "$PGTMP" ] && rm -rf "$PGTMP" || true; }
refuse() { trap - ERR; result REFUSED "$1"; exit 2; }
fail() { trap - ERR; stop_temp; result FAILED "$1"; exit 1; }
trap 'fail "unexpected_error_line_$LINENO"' ERR

# ---------------------------------------------------------------- validation (no database access yet)
case "$STEP" in
  pause) NEED_CONFIRM=PAUSE_DOE_SP ;;
  rebuild_commit) NEED_CONFIRM=REBUILD_DOE_SP ;;
  resume) NEED_CONFIRM=RESUME_DOE_SP ;;
  rollback) NEED_CONFIRM=ROLLBACK_DOE_SP ;;
  dry_run|rebuild_dry|validate_40|validate_41) NEED_CONFIRM="" ;;
  *) refuse "unknown_step" ;;
esac
[[ "$EXEC_ID" =~ ^[a-z0-9][a-z0-9-]{2,63}$ ]] || refuse "invalid_exec_id"
[[ "$NOT_AFTER" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2})?Z$ ]] || refuse "invalid_not_after"
DEADLINE=$(date -u -d "$NOT_AFTER" +%s 2>/dev/null) || refuse "invalid_not_after"
[ "$(date -u +%s)" -le "$DEADLINE" ] || refuse "deadline_passed"
[ "$CONFIRM" = "$NEED_CONFIRM" ] || refuse "confirm_mismatch"
[ -n "${PROD_DATABASE_URL:-}" ] || refuse "missing_prod_database_url"

ARGS_RE='^-v expected_publications_kept=[0-9]+ -v expected_versions_deleted=[0-9]+ -v expected_files_deleted=[0-9]+ -v expected_origins_deleted=[0-9]+ -v expected_run_links_version_cleared=[0-9]+ -v expected_checkpoints_deleted=[0-9]+ -v expected_translations_deleted=[0-9]+$'
case "$STEP" in
  rebuild_dry|rebuild_commit|validate_40)
    [[ "${DOE_SP_REBUILD_ARGS:-}" =~ $ARGS_RE ]] || refuse "invalid_rebuild_args" ;;
esac
if [ "$STEP" = rollback ]; then
  [[ "${DOE_SP_ROLLBACK_DUMP_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] || refuse "invalid_dump_sha256"
fi

umask 077
mkdir -p "$MARKERS"
MARKER="$MARKERS/$EXEC_ID"
[ ! -e "$MARKER" ] || refuse "exec_id_already_used"
jq -cn --arg step "$STEP" --arg at "$(date -u +%FT%TZ)" '{step: $step, startedAt: $at}' > "$MARKER"

PROD="$PROD_DATABASE_URL"
ro() { PGOPTIONS="-c default_transaction_read_only=on" psql "$PROD" -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }
rw() { psql "$PROD" -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }
kept_from_args() { sed -n 's/.*-v expected_publications_kept=\([0-9]*\).*/\1/p' <<<"$1"; }

log "DOE_SP_EXEC_START=$(jq -cn --arg step "$STEP" --arg id "$EXEC_ID" --arg notAfter "$NOT_AFTER" '{step: $step, execId: $id, notAfter: $notAfter}')"
log "DOE_SP_EXEC_SQL_SHA256=$(cd "$SQL" && sha256sum 13_other_sources_fingerprint_readonly.sql 20_dry_run_readonly.sql 25_pause_source.sql 30_rebuild_destructive.sql 40_post_rebuild_validation.sql 41_post_recapture_validation.sql 50_resume_source.sql 60_rollback_import.sql | jq -R -s -c 'split("\n") | map(select(length > 0) | split("  ") | {(.[1]): .[0]}) | add')"

# Re-runs the reviewed dry-run and checks it against the expected arguments.
fresh_dry_run() {
  local out args
  out=$(ro -f "$SQL/20_dry_run_readonly.sql") || fail "dry_run_failed"
  grep -E '^DOE_SP_(DRY_RUN|REBUILD_ARGS)=' <<<"$out"
  args=$(sed -n 's/^DOE_SP_REBUILD_ARGS=//p' <<<"$out")
  grep '^DOE_SP_DRY_RUN=' <<<"$out" | sed 's/^DOE_SP_DRY_RUN=//' | jq -e '.blockers | to_entries | all(.value == 0)' >/dev/null || fail "blockers_not_zero"
  [ "$args" = "$DOE_SP_REBUILD_ARGS" ] || fail "rebuild_args_differ_from_fresh_dry_run"
}

case "$STEP" in
  dry_run)
    ro -f "$SQL/20_dry_run_readonly.sql" | grep -E '^DOE_SP_(DRY_RUN|REBUILD_ARGS)=' || fail "dry_run_failed"
    result PASS ;;

  pause)
    rw -f "$SQL/25_pause_source.sql" | grep -E '^DOE_SP_(PAUSE_BEFORE|PAUSED|ACTIVE_RUNS)' || fail "pause_failed"
    result PASS ;;

  rebuild_dry)
    fresh_dry_run
    # shellcheck disable=SC2086
    out=$(rw $DOE_SP_REBUILD_ARGS -f "$SQL/30_rebuild_destructive.sql") || fail "rebuild_dry_failed"
    grep -E '^DOE_SP_REBUILD' <<<"$out"
    grep -q '^DOE_SP_REBUILD_ROLLED_BACK' <<<"$out" || fail "rebuild_dry_not_rolled_back"
    result PASS ;;

  rebuild_commit)
    fresh_dry_run
    # shellcheck disable=SC2086
    out=$(rw $DOE_SP_REBUILD_ARGS -v confirm=REBUILD_DOE_SP -f "$SQL/30_rebuild_destructive.sql") || fail "rebuild_commit_failed"
    grep -E '^DOE_SP_REBUILD' <<<"$out"
    grep -q '^DOE_SP_REBUILD_COMMITTED' <<<"$out" || fail "rebuild_not_committed"
    ro -v expected_publications_kept="$(kept_from_args "$DOE_SP_REBUILD_ARGS")" -f "$SQL/40_post_rebuild_validation.sql" | grep '^DOE_SP_POST_REBUILD=' || fail "post_rebuild_validation_failed"
    result PASS ;;

  validate_40)
    ro -v expected_publications_kept="$(kept_from_args "$DOE_SP_REBUILD_ARGS")" -f "$SQL/40_post_rebuild_validation.sql" | grep '^DOE_SP_POST_REBUILD=' || fail "post_rebuild_validation_failed"
    result PASS ;;

  resume)
    rw -f "$SQL/50_resume_source.sql" | grep -E '^DOE_SP_RESUMED' || fail "resume_failed"
    result PASS ;;

  validate_41)
    out=$(ro -f "$SQL/41_post_recapture_validation.sql") || fail "post_recapture_validation_failed"
    line=$(grep '^DOE_SP_POST_RECAPTURE=' <<<"$out") || fail "post_recapture_validation_failed"
    log "$line"
    # RUNBOOK §6 step 11: the recapture is closed only when every criterion holds.
    unmet=$(sed 's/^DOE_SP_POST_RECAPTURE=//' <<<"$line" | jq -c '[
      (if .checkpoint.pendingRanges == [] then empty else "pendingRanges" end),
      (if .publicationsWithoutVersionOrOrigin == 0 then empty else "publicationsWithoutVersionOrOrigin" end),
      (if .redundantPdfInVersion == 0 then empty else "redundantPdfInVersion" end),
      (if .crossOriginFiles == 0 then empty else "crossOriginFiles" end),
      (if .historicalVersions == 0 then empty else "historicalVersions" end)]') || fail "post_recapture_validation_failed"
    if [ "$unmet" != "[]" ]; then
      log "DOE_SP_POST_RECAPTURE_UNMET=$unmet"
      fail "post_recapture_criteria_not_met"
    fi
    result PASS ;;

  rollback)
    DUMP=""
    while IFS= read -r -d '' candidate; do
      if [ "$(sha256sum "$candidate" | cut -d' ' -f1)" = "$DOE_SP_ROLLBACK_DUMP_SHA256" ]; then DUMP="$candidate"; break; fi
    done < <(find "$DATA_DIR" -path "$MARKERS" -prune -o -type f -name '*.dump' -print0)
    [ -n "$DUMP" ] || fail "dump_not_found_on_volume"
    log "DOE_SP_EXEC_ROLLBACK_DUMP=$(jq -cn --arg file "$(basename "$DUMP")" --arg sha "$DOE_SP_ROLLBACK_DUMP_SHA256" --argjson bytes "$(stat -c %s "$DUMP")" '{file: $file, sha256: $sha, bytes: $bytes}')"

    # Temporary PostgreSQL inside this container (unix socket only).
    PGTMP=$(mktemp -d "$DATA_DIR/doe-sp-exec-pgtmp.XXXXXX")
    mkdir -p "$LOCAL_SOCKET"
    if [ "$(id -u)" = 0 ]; then chmod 711 "$PGTMP"; chown -R postgres:postgres "$PGTMP" "$LOCAL_SOCKET"; fi
    $AS_POSTGRES initdb -D "$PGTMP/data" -U postgres --auth=trust --encoding=UTF8 --locale=C.UTF-8 >/dev/null || fail "temp_initdb"
    $AS_POSTGRES pg_ctl -D "$PGTMP/data" -w -o "-c listen_addresses='' -k $LOCAL_SOCKET -p $LOCAL_PORT" -l "$PGTMP/server.log" start >/dev/null || fail "temp_start"
    LOCAL_ADMIN="host=$LOCAL_SOCKET port=$LOCAL_PORT user=postgres dbname=postgres"
    RESTORED="host=$LOCAL_SOCKET port=$LOCAL_PORT user=postgres dbname=restored"
    ro -c "SELECT rolname FROM pg_roles WHERE rolname !~ '^pg_' AND rolname <> current_user ORDER BY 1" | while read -r role; do
      [ -n "$role" ] || continue
      printf '%s\n' "SELECT format('CREATE ROLE %I NOLOGIN', :'role') \\gexec" | psql "$LOCAL_ADMIN" -X -q -v ON_ERROR_STOP=1 -v role="$role" >/dev/null
    done
    PROD_OWNER=$(ro -c "SELECT current_user")
    [ "$PROD_OWNER" = postgres ] || printf '%s\n' "SELECT format('CREATE ROLE %I SUPERUSER NOLOGIN', :'role') \\gexec" | psql "$LOCAL_ADMIN" -X -q -v ON_ERROR_STOP=1 -v role="$PROD_OWNER" >/dev/null
    psql "$LOCAL_ADMIN" -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE restored" >/dev/null
    pg_restore --exit-on-error --jobs=2 --dbname="$RESTORED" "$DUMP" || fail "restore_failed"
    BACKUP_MANIFEST=$(PGOPTIONS="-c default_transaction_read_only=on" psql "$RESTORED" -X -q -t -A -v ON_ERROR_STOP=1 -f "$SQL/11_private_manifest_readonly.sql" | sha256sum | cut -d' ' -f1)
    log "DOE_SP_EXEC_BACKUP_MANIFEST_SHA256=$BACKUP_MANIFEST"

    "$OPS/runner/rollback-stage.sh" "$RESTORED" "$PROD" | grep '^DOE_SP_ROLLBACK_STAGED=' || fail "rollback_stage_failed"
    rw -f "$SQL/60_rollback_import.sql" | grep -E '^DOE_SP_ROLLBACK' || fail "rollback_import_failed"
    AFTER_MANIFEST=$(ro -f "$SQL/11_private_manifest_readonly.sql" | sha256sum | cut -d' ' -f1)
    log "DOE_SP_EXEC_PROD_MANIFEST_SHA256=$AFTER_MANIFEST"
    [ "$AFTER_MANIFEST" = "$BACKUP_MANIFEST" ] || fail "rollback_manifest_differs_from_backup"
    stop_temp
    result PASS "manifest_equals_backup" ;;
esac
trap - ERR
