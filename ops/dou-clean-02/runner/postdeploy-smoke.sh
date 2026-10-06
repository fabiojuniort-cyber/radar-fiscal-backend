#!/usr/bin/env bash
# PREPARED LOCALLY ONLY. Production use requires reviewed exact SHA + R3 approval.
# Never invoke with bash -x. No PostgreSQL URL or private output goes to stdout.
set +x
set -Eeuo pipefail
umask 077
exec 2>/dev/null

readonly BACKEND_SHA=068506811ae4c0a257816c38e899e3a1dccb0fb8
readonly BASE_URL=https://radar-fiscal-backend-production.up.railway.app
readonly ROOT=/data/dou-clean-02-postdeploy-smoke
readonly JOURNAL=$ROOT/journal.json
readonly SQL_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/sql" && pwd -P)"
MODE=${MODE:-disabled}
PHASE=configuration
ARMED=0
FINISHED=0
OUT_SCOPE_START=-1
RECOVERING=0
WORK=

log() { printf '%s\n' "$1"; }
die() { log "$1"; exit 1; }
hash_json() { jq -cS . "$1" | sha256sum | cut -d ' ' -f1; }
uuid() { local value; IFS= read -r value </proc/sys/kernel/random/uuid; printf '%s' "$value"; }
private_file() {
  [[ -f "$1" && ! -L "$1" ]] && [[ $(stat -c '%a:%u' "$1") == "600:$(id -u)" ]]
}
atomic_journal() {
  local tmp
  tmp=$(mktemp "$ROOT/.journal.XXXXXXXX") || return 1
  jq -cS . "$1" >"$tmp" || return 1
  chmod 600 "$tmp" || return 1
  sync -f "$tmp" || return 1
  mv -T -- "$tmp" "$JOURNAL" || return 1
  sync -f "$ROOT" || return 1
}
update_journal() {
  local state=$1
  jq --arg status "$state" --arg at "$(date -u +%FT%TZ)" \
    '.status=$status | .updated_at=$at' "$JOURNAL" >"$WORK/journal-next.json" || return 1
  if [[ $state == suppressed ]]; then
    jq --slurpfile s "$WORK/suppressed-state.json" '.observations.suppressed=$s[0]' \
      "$WORK/journal-next.json" >"$WORK/journal-observation.json" || return 1
    mv -T "$WORK/journal-observation.json" "$WORK/journal-next.json" || return 1
  fi
  atomic_journal "$WORK/journal-next.json"
}
budget_seconds() {
  local cap=$1 remaining
  if (( OUT_SCOPE_START >= 0 && RECOVERING == 0 )); then
    remaining=$((60 - (SECONDS - OUT_SCOPE_START)))
    (( remaining > 0 )) || return 1
    (( cap <= remaining )) || cap=$remaining
  fi
  printf '%s' "$cap"
}

# psql variables come from environment, NOT command-line arguments. All psql
# errors are discarded, not copied to any public or private log. Connection URL
# is supplied only through libpq's PGDATABASE environment parameter.
db() {
  local sql_file=$1 output=$2 access=${3:-read} operation_timeout
  operation_timeout=$(budget_seconds 25) || return 1
  {
    printf '\\getenv publication_id SMOKE_PUBLICATION_ID\n'
    printf '\\getenv controlled_publication_sha256 SMOKE_CANDIDATE_SHA256\n'
    printf '\\getenv version_ids SMOKE_VERSION_IDS\n'
    printf '\\getenv run_ids SMOKE_RUN_IDS\n'
    printf '\\getenv suppress_operation_id SMOKE_SUPPRESS_OPERATION_ID\n'
    printf '\\getenv restore_operation_id SMOKE_RESTORE_OPERATION_ID\n'
    printf '\\getenv evidence_sha256 SMOKE_EVIDENCE_SHA256\n'
    printf '\\getenv manifest_sha256 SMOKE_MANIFEST_SHA256\n'
    printf '\\getenv actor_ref SMOKE_ACTOR_REF\n'
    printf '\\getenv baseline_epoch SMOKE_BASELINE_EPOCH\n'
    printf "SET statement_timeout='15s'; SET lock_timeout='3s'; SET idle_in_transaction_session_timeout='20s';\n"
    printf "SET search_path=pg_catalog,public; SET timezone='UTC'; SET application_name='dou-clean-02-postdeploy-smoke';\n"
    if [[ $access == read ]]; then printf 'SET default_transaction_read_only=on;\n';
    else printf 'SET default_transaction_read_only=off;\n'; fi
    cat -- "$SQL_DIR/$sql_file"
  } | timeout --signal=TERM --kill-after=3s "$operation_timeout" \
    psql -X --no-password --quiet --tuples-only --no-align --set=ON_ERROR_STOP=on \
    >"$output" 2>/dev/null
}
snapshot() { db state.sql "$1" && jq -e 'type=="object" and .canonical_exists==true' "$1" >/dev/null; }
recovery_snapshot() {
  # FOR UPDATE barrier needs a read-write transaction, but performs no DML.
  # Any timeout/error is NOT_CONFIRMED, even if an older file said IN_SCOPE.
  db recovery-state.sql "$1" write && jq -e 'type=="object" and .canonical_exists==true and
    .barrier_acquired==true and .observed_isolation=="read committed"' "$1" >/dev/null
}
security_preflight() {
  local file
  if ! db preflight.sql "$1"; then file=$1;
  elif ! db privileges.sql "$1.acl"; then file=$1.acl;
  else return 0; fi
  # Only fixed source-code gate labels may be printed, never SQL errors/data.
  awk '/^CHECK_(DATABASE_ROLE_AND_FUNCTIONS|MIGRATION_CHECKSUMS|HISTORY_COLUMNS|ROLE_BASELINE|SET_ROLE_ACL_AND_OWNERSHIP|NARROW_FUNCTION_AND_HISTORY_BOUNDARIES)$/ {last=$0}
    END {if(last!="") print "FAILED_" last}' "$file"
  return 1
}
fingerprints() {
  db fingerprints.sql "$1.lines" || return 1
  jq -csS 'add' "$1.lines" >"$1" || return 1
  jq -e '
    ["publications","publication_versions","publication_origins","publication_files",
      "publication_ncm_mentions","publication_ncm_scans","publication_taxonomy_runs",
      "publication_taxonomy_assertions","publication_taxonomy_spans","publication_taxonomy_reviews",
      "publication_taxonomy_scans","publication_taxonomy_curator_tags","collection_run_publications",
      "collection_items","company_publications","publication_matches","taxonomy_unmapped_occurrences",
      "taxonomy_candidate_occurrence_links","linked_taxonomy_candidates","historical_collection_runs",
      "historical_imported_documents"] as $required |
    . as $all | all($required[]; $all[.] != null) and
    all(.[]; (.count|test("^[0-9]+$")) and (.sha256|test("^[a-f0-9]{64}$"))) and
    .publications.count=="1" and .company_publications.count=="0" and .publication_matches.count=="0"
  ' "$1" >/dev/null
}
same_json() { cmp -s <(jq -cS . "$1") <(jq -cS . "$2"); }

load_candidate() {
  SMOKE_PUBLICATION_ID=$(jq -er '.publication_id' "$1") || return 1
  SMOKE_VERSION_IDS=$(jq -er '"{"+(.version_ids|join(","))+"}"' "$1") || return 1
  SMOKE_RUN_IDS=$(jq -er '"{"+(.run_ids|join(","))+"}"' "$1") || return 1
  SOURCE_CODE=$(jq -er '.source_code' "$1") || return 1
  LIST_URL="$BASE_URL/public/v1/publications?source=$(printf '%s' "$SOURCE_CODE" | jq -sRr @uri)&limit=20"
  export SMOKE_PUBLICATION_ID SMOKE_VERSION_IDS SMOKE_RUN_IDS
}
validate_candidate() {
  jq -e '
    def uuid: type=="string" and test("^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$");
    (.publication_id|uuid) and (.source_code|type=="string" and length>=1 and length<=100) and
    (.version_ids|type=="array" and length>0 and all(.[];uuid)) and
    (.run_ids|type=="array" and all(.[];uuid))
  ' "$1" >/dev/null
}
load_journal() {
  private_file "$JOURNAL" || return 1
  jq -e --arg backend "$BACKEND_SHA" '
    def uuid: type=="string" and test("^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$");
    .schema==1 and .manifest.backend_sha==$backend and
    .manifest.allow_compensating_restore==true and
    (.manifest.suppress_operation_id|uuid) and (.manifest.restore_operation_id|uuid) and
    .manifest.suppress_operation_id!=.manifest.restore_operation_id and
    (.manifest.database_fingerprint|test("^[a-f0-9]{64}$")) and
    .manifest.actor_ref=="DOU_CLEAN_02_POSTDEPLOY_SMOKE_RUNNER" and
    (.manifest_sha256|test("^[a-f0-9]{64}$")) and (.evidence_sha256|test("^[a-f0-9]{64}$")) and
    (.baseline.state.epoch|test("^[0-9]{1,15}$"))
  ' "$JOURNAL" >/dev/null || return 1
  jq '.manifest' "$JOURNAL" >"$WORK/manifest-check.json" || return 1
  jq '.baseline' "$JOURNAL" >"$WORK/evidence-check.json" || return 1
  [[ $(hash_json "$WORK/manifest-check.json") == $(jq -r '.manifest_sha256' "$JOURNAL") ]] || return 1
  [[ $(hash_json "$WORK/evidence-check.json") == $(jq -r '.evidence_sha256' "$JOURNAL") ]] || return 1
  jq '.manifest.candidate' "$JOURNAL" >"$WORK/candidate.json" || return 1
  validate_candidate "$WORK/candidate.json" || return 1
  load_candidate "$WORK/candidate.json" || return 1
  SMOKE_SUPPRESS_OPERATION_ID=$(jq -er '.manifest.suppress_operation_id' "$JOURNAL") || return 1
  SMOKE_RESTORE_OPERATION_ID=$(jq -er '.manifest.restore_operation_id' "$JOURNAL") || return 1
  SMOKE_EVIDENCE_SHA256=$(jq -er '.evidence_sha256' "$JOURNAL") || return 1
  SMOKE_MANIFEST_SHA256=$(jq -er '.manifest_sha256' "$JOURNAL") || return 1
  SMOKE_BASELINE_EPOCH=$(jq -er '.baseline.state.epoch' "$JOURNAL") || return 1
  export SMOKE_SUPPRESS_OPERATION_ID SMOKE_RESTORE_OPERATION_ID SMOKE_EVIDENCE_SHA256 SMOKE_MANIFEST_SHA256 SMOKE_BASELINE_EPOCH
}

# Recovery does NOT depend on a stored response event_id. The transaction may
# have committed just before a lost connection or SIGKILL. Resolve operation_id.
# This function checks every failure explicitly because EXIT invokes it in `if`.
recover() {
  RECOVERING=1
  load_journal || return 1
  recovery_snapshot "$WORK/recovery-before.json" || return 1
  [[ $(jq -r '.database_fingerprint' "$WORK/recovery-before.json") == \
    $(jq -r '.manifest.database_fingerprint' "$JOURNAL") ]] || return 1
  if jq -e '.in_scope==true' "$WORK/recovery-before.json" >/dev/null; then
    # Only a fresh READ COMMITTED observation AFTER the row-lock barrier can
    # confirm already restored / SUPPRESS never committed. Never infer this from
    # a pre-lock snapshot while an unacknowledged transition may still commit.
    return 0
  fi
  jq -e '.suppress_event!=null and .current_event==.suppress_event.id' "$WORK/recovery-before.json" >/dev/null || return 1
  # A failed command can still mean COMMIT acknowledgement was lost. Always read back.
  db restore.sql "$WORK/recovery-command.private" write || true
  recovery_snapshot "$WORK/recovery-after.json" || return 1
  jq -e '.in_scope==true and .restore_event!=null and .current_event==.restore_event.id' \
    "$WORK/recovery-after.json" >/dev/null || return 1
  return 0
}
on_exit() {
  local rc=$?
  trap - EXIT INT TERM HUP
  if (( ARMED == 1 && FINISHED == 0 )); then
    if recover; then
      log 'RECOVERY_IN_SCOPE_CONFIRMED; SMOKE_NOT_PASSED'
    else
      log 'CRITICAL_RESTORE_NOT_CONFIRMED; KEEP_PRIVATE_VOLUME; RUN_MODE_RESTORE_ONLY'
    fi
  fi
  if (( rc != 0 )); then log "FAIL_PHASE_${PHASE}"; fi
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

http_get() {
  local url=$1 prefix=$2 expected_epoch=$3 v1=$4 code epoch cache vary request_timeout
  request_timeout=$(budget_seconds 12) || return 1
  code=$(curl -q --silent --show-error --proto '=https' --tlsv1.2 --max-redirs 0 \
    --connect-timeout 5 --max-time "$request_timeout" --retry 0 --max-filesize 1048576 \
    --dump-header "$prefix.headers" --output "$prefix.json" --write-out '%{http_code}' "$url") || return 1
  [[ $code == 200 ]] || return 1
  jq -e 'type=="object"' "$prefix.json" >/dev/null || return 1
  if [[ $v1 == yes ]]; then
    epoch=$(awk 'tolower($1)=="x-publication-scope-epoch:" {gsub("\r", ""); print $2}' "$prefix.headers")
    [[ $epoch == "$expected_epoch" ]] || return 1
    cache=$(awk 'tolower($1)=="cache-control:" {$1="";gsub("\r", ""); print tolower($0)}' "$prefix.headers")
    [[ $cache == *public* && $cache == *max-age=0* && $cache == *no-cache* && $cache == *must-revalidate* ]] || return 1
    vary=$(awk 'tolower($1)=="vary:" {$1="";gsub("\r", ""); print tolower($0)}' "$prefix.headers")
    [[ $vary == *origin* ]] || return 1
  fi
}
api_phase() {
  local phase=$1 want_present=$2 expected_epoch=$3
  snapshot "$WORK/$phase-api-before.json" || return 1
  [[ $(jq -r '.epoch' "$WORK/$phase-api-before.json") == "$expected_epoch" ]] || return 1
  # No cache-buster, no request Cache-Control, no retry, no cookies or auth.
  # The FIRST response after committed transition must already be correct.
  http_get "$LIST_URL" "$WORK/$phase-list" "$expected_epoch" yes || return 1
  http_get "$BASE_URL/public/v1/stats" "$WORK/$phase-v1" "$expected_epoch" yes || return 1
  http_get "$BASE_URL/public/v2/stats" "$WORK/$phase-v2" "$expected_epoch" no || return 1
  snapshot "$WORK/$phase-api-after.json" || return 1
  same_json "$WORK/$phase-api-before.json" "$WORK/$phase-api-after.json" || return 1
  jq -e --arg id "$SMOKE_PUBLICATION_ID" --argjson present "$want_present" \
    '(.items|type=="array") and (([.items[]|select(.id==$id)]|length)==(if $present then 1 else 0 end))' \
    "$WORK/$phase-list.json" >/dev/null || return 1
  for version in v1 v2; do
    jq -e --arg version "$version" --slurpfile state "$WORK/$phase-api-after.json" '
      {totalPublications,totalSources,activeSources,importedToday}==$state[0][$version]
    ' "$WORK/$phase-$version.json" >/dev/null || return 1
  done
}

verify_restored() {
  snapshot "$WORK/final-state.json" || return 1
  jq -e --slurpfile j "$JOURNAL" '
    .canonical_exists and .in_scope and .out_of_scope_total=="0" and .feed_matches_expected and
    .database_fingerprint==$j[0].manifest.database_fingerprint and
    .feed_count==$j[0].baseline.state.feed_count and .feed_sha256==$j[0].baseline.state.feed_sha256 and
    (if .suppress_event==null then .epoch==$j[0].baseline.state.epoch and .restore_event==null
     else .restore_event!=null and .current_event==.restore_event.id and
       .candidate_events=="2" and (.epoch|tonumber)==(($j[0].baseline.state.epoch|tonumber)+2) end) and
    (if $j[0].observations.suppressed.suppress_event!=null then
       .suppress_event==$j[0].observations.suppressed.suppress_event else true end)
  ' "$WORK/final-state.json" >/dev/null || return 1
  fingerprints "$WORK/final-fingerprints.json" || return 1
  same_json "$WORK/final-fingerprints.json" <(jq '.baseline.fingerprints' "$JOURNAL") || return 1
  db rls.sql "$WORK/final-rls.json" || return 1
  same_json "$WORK/final-rls.json" <(jq '.baseline.rls' "$JOURNAL") || return 1
  security_preflight "$WORK/final-privileges.private" || return 1
  api_phase final true "$(jq -r '.epoch' "$WORK/final-state.json")" || return 1
  same_json "$WORK/final-state.json" "$WORK/final-api-after.json" || return 1
  fingerprints "$WORK/final-fingerprints-recheck.json" || return 1
  same_json "$WORK/final-fingerprints.json" "$WORK/final-fingerprints-recheck.json" || return 1
  # For a smoke (not a delayed recovery), unchanged global stats except scope are mandatory.
  if [[ $MODE == smoke ]]; then
    jq -e --slurpfile j "$JOURNAL" '.v1==$j[0].baseline.state.v1 and .v2==$j[0].baseline.state.v2' \
      "$WORK/final-state.json" >/dev/null || return 1
    jq -e --slurpfile s "$WORK/suppressed-state.json" '.suppress_event==$s[0].suppress_event' \
      "$WORK/final-state.json" >/dev/null || return 1
  fi
}

main() {
  [[ $MODE == smoke || $MODE == restore-only || $MODE == preflight ]] || die 'DISABLED_EXPLICIT_MODE_REQUIRED'
  for command in psql jq curl flock sha256sum cut stat id date sync mktemp realpath mountpoint awk cmp timeout; do
    command -v "$command" >/dev/null || die 'REQUIRED_DEPENDENCY_MISSING'
  done
  [[ ${RAILWAY_VOLUME_MOUNT_PATH:-} == /data && -n ${RAILWAY_SERVICE_ID:-} && -n ${RAILWAY_ENVIRONMENT_ID:-} ]] || die 'PRIVATE_RAILWAY_RUNNER_REQUIRED'
  [[ ! -L /data && $(realpath /data) == /data ]] && mountpoint -q /data || die 'PRIVATE_VOLUME_REQUIRED'
  [[ ${PROD_DATABASE_ADMIN_URL:-} == postgres://* || ${PROD_DATABASE_ADMIN_URL:-} == postgresql://* ]] || die 'ADMIN_CONNECTION_REQUIRED'
  if [[ ! -e $ROOT ]]; then mkdir -m 700 -- "$ROOT"; fi
  [[ -d $ROOT && ! -L $ROOT && $(stat -c '%a:%u' "$ROOT") == "700:$(id -u)" ]] || die 'PRIVATE_DIRECTORY_REQUIRED'
  [[ ! -L $ROOT/runner.lock ]] || die 'UNSAFE_LOCK_FILE'
  exec 9>"$ROOT/runner.lock"
  chmod 600 "$ROOT/runner.lock"
  flock -n 9 || die 'RUNNER_ALREADY_ACTIVE'
  WORK=$(mktemp -d "$ROOT/evidence.XXXXXXXX")
  chmod 700 "$WORK"
  export PGDATABASE=$PROD_DATABASE_ADMIN_URL PGCONNECT_TIMEOUT=7 PGAPPNAME=dou-clean-02-postdeploy-smoke
  export PGPASSFILE=/dev/null PGOPTIONS='-c statement_timeout=15000 -c lock_timeout=3000'
  unset PROD_DATABASE_ADMIN_URL PGSERVICE PGSERVICEFILE
  export SMOKE_PUBLICATION_ID='' SMOKE_VERSION_IDS='{}' SMOKE_RUN_IDS='{}'
  export SMOKE_SUPPRESS_OPERATION_ID='' SMOKE_RESTORE_OPERATION_ID=''
  export SMOKE_EVIDENCE_SHA256='' SMOKE_MANIFEST_SHA256='' SMOKE_BASELINE_EPOCH='0'
  export SMOKE_ACTOR_REF=DOU_CLEAN_02_POSTDEPLOY_SMOKE_RUNNER
  export SMOKE_CANDIDATE_SHA256=${SMOKE_CANDIDATE_SHA256:-}
  [[ $MODE == restore-only || -z $SMOKE_CANDIDATE_SHA256 || $SMOKE_CANDIDATE_SHA256 =~ ^[a-f0-9]{64}$ ]] || die 'INVALID_PUBLIC_CANDIDATE_HASH'

  if [[ $MODE == preflight ]]; then
    PHASE=read_only_preflight
    security_preflight "$WORK/preflight.private"
    db candidate.sql "$WORK/candidate.json"
    validate_candidate "$WORK/candidate.json" || die 'NO_ELIGIBLE_CONTROLLED_PUBLIC_CANDIDATE'
    load_candidate "$WORK/candidate.json"
    snapshot "$WORK/preflight-state.json"
    # Only aggregates and a hash of an already-public publication ID leave Railway.
    jq -c '{out_of_scope_total,epoch,v1,v2}' "$WORK/preflight-state.json"
    log "PUBLIC_CANDIDATE_ID_SHA256=$(printf '%s' "$SMOKE_PUBLICATION_ID" | sha256sum | cut -d ' ' -f1)"
    FINISHED=1
    log 'READ_ONLY_PREFLIGHT_PASS; NO_SUPPRESS_OR_RESTORE'
    return
  fi

  if [[ $MODE == restore-only ]]; then
    PHASE=restore_only
    [[ ${CONFIRM_DOU_CLEAN_02:-} == RESTORE_JOURNALED_TARGET ]] || die 'RESTORE_CONFIRMATION_REQUIRED'
    load_journal
    ARMED=1
    recover || die 'RESTORE_NOT_CONFIRMED'
    # Restore is attempted before broad schema/API gates to minimize recovery delay.
    verify_restored || die 'IN_SCOPE_RECOVERY_POSTCHECK_NOT_PROVEN'
    update_journal recovery_verified
    FINISHED=1
    log 'RESTORE_ONLY_VERIFIED; NOT_A_NEW_SMOKE_PASS'
    return
  fi

  [[ ${CONFIRM_DOU_CLEAN_02:-} == SUPPRESS_ONE_AND_RESTORE && ${CONTROLLED_SELECTION_APPROVED:-} == true ]] || die 'EXPLICIT_SMOKE_AUTHORIZATION_REQUIRED'
  [[ ${UI_OBSERVATION_WINDOW:-disabled} == disabled || ${UI_OBSERVATION_WINDOW:-disabled} == enabled ]] || die 'INVALID_UI_OBSERVATION_MODE'
  [[ ${UI_OBSERVATION_WINDOW:-disabled} != enabled || -n $SMOKE_CANDIDATE_SHA256 ]] || die 'PINNED_PUBLIC_CANDIDATE_REQUIRED_FOR_UI'
  [[ ${R3_APPROVAL_SHA256:-} =~ ^[a-f0-9]{64}$ ]] || die 'R3_APPROVAL_HASH_REQUIRED'
  [[ ${BACKEND_DEPLOYED_SHA:-} == "$BACKEND_SHA" && ${WORKER_DEPLOYED_SHA:-} == "$BACKEND_SHA" && ${SCHEDULER_DEPLOYED_SHA:-} == "$BACKEND_SHA" ]] || die 'RUNTIME_SHA_ATTESTATIONS_REQUIRED'
  [[ ${RUNNER_SHA:-} =~ ^[a-f0-9]{40}$ && ${RAILWAY_GIT_COMMIT_SHA:-} == "$RUNNER_SHA" ]] || die 'REVIEWED_RUNNER_SHA_REQUIRED'
  [[ ${BACKUP_RESTORE_VERIFIED:-} == true && ${R3_LOCK_VERIFIED:-} == true && ${NO_HISTORICAL_BATCH_VERIFIED:-} == true && ${WORKER_NCM_DISABLED_VERIFIED:-} == true ]] || die 'R3_GATE_ATTESTATIONS_REQUIRED'
  [[ ! -e $JOURNAL && ! -L $JOURNAL ]] || die 'EXISTING_JOURNAL_USE_RESTORE_ONLY_OR_REVIEW_RETENTION'
  PHASE=preflight
  security_preflight "$WORK/preflight.private"
  PHASE=candidate
  db candidate.sql "$WORK/candidate.json"
  validate_candidate "$WORK/candidate.json" || die 'NO_ELIGIBLE_CONTROLLED_PUBLIC_CANDIDATE'
  load_candidate "$WORK/candidate.json"
  SMOKE_SUPPRESS_OPERATION_ID=$(uuid)
  SMOKE_RESTORE_OPERATION_ID=$(uuid)
  export SMOKE_SUPPRESS_OPERATION_ID SMOKE_RESTORE_OPERATION_ID
  PHASE=baseline
  snapshot "$WORK/baseline-state.json"
  jq -e '.in_scope and .candidate_events=="0" and .out_of_scope_total=="0" and .feed_matches_expected and (.feed_count|tonumber)>0 and (.epoch|test("^[0-9]{1,15}$"))' "$WORK/baseline-state.json" >/dev/null
  SMOKE_BASELINE_EPOCH=$(jq -r '.epoch' "$WORK/baseline-state.json")
  export SMOKE_BASELINE_EPOCH
  fingerprints "$WORK/baseline-fingerprints.json"
  db rls.sql "$WORK/baseline-rls.json"
  # Exact role visibility must match the admin baseline, not merely be nonzero.
  jq -e --slurpfile f "$WORK/baseline-fingerprints.json" '
    .publications==$f[0].publications.count and .versions==$f[0].publication_versions.count and
    .origins==$f[0].publication_origins.count and .files==$f[0].publication_files.count and
    (.files|tonumber)>0 and ($f[0].collection_run_publications.count|tonumber)>0
  ' "$WORK/baseline-rls.json" >/dev/null
  api_phase baseline true "$SMOKE_BASELINE_EPOCH"
  same_json "$WORK/baseline-state.json" "$WORK/baseline-api-after.json"
  fingerprints "$WORK/baseline-fingerprints-recheck.json"
  same_json "$WORK/baseline-fingerprints.json" "$WORK/baseline-fingerprints-recheck.json"

  PHASE=journal
  jq -n --slurpfile candidate "$WORK/candidate.json" --slurpfile state "$WORK/baseline-state.json" \
    --arg backend "$BACKEND_SHA" --arg runner "$RUNNER_SHA" --arg approval "$R3_APPROVAL_SHA256" \
    --arg suppress "$SMOKE_SUPPRESS_OPERATION_ID" --arg restore "$SMOKE_RESTORE_OPERATION_ID" \
    --arg actor "$SMOKE_ACTOR_REF" --arg at "$(date -u +%FT%TZ)" \
    '{candidate:$candidate[0],database_fingerprint:$state[0].database_fingerprint,backend_sha:$backend,
      runner_sha:$runner,r3_approval_sha256:$approval,suppress_operation_id:$suppress,restore_operation_id:$restore,
      actor_ref:$actor,created_at:$at,allow_compensating_restore:true}' >"$WORK/manifest.json"
  jq -n --slurpfile state "$WORK/baseline-state.json" --slurpfile f "$WORK/baseline-fingerprints.json" \
    --slurpfile rls "$WORK/baseline-rls.json" '{state:$state[0],fingerprints:$f[0],rls:$rls[0]}' >"$WORK/evidence.json"
  SMOKE_MANIFEST_SHA256=$(hash_json "$WORK/manifest.json")
  SMOKE_EVIDENCE_SHA256=$(hash_json "$WORK/evidence.json")
  export SMOKE_MANIFEST_SHA256 SMOKE_EVIDENCE_SHA256
  jq -n --slurpfile manifest "$WORK/manifest.json" --slurpfile baseline "$WORK/evidence.json" \
    --arg m "$SMOKE_MANIFEST_SHA256" --arg e "$SMOKE_EVIDENCE_SHA256" \
    '{schema:1,status:"prepared",manifest:$manifest[0],baseline:$baseline[0],manifest_sha256:$m,evidence_sha256:$e}' >"$WORK/journal-prepared.json"
  atomic_journal "$WORK/journal-prepared.json"
  load_journal
  ARMED=1
  log 'PRIVATE_DURABLE_JOURNAL_READY'

  PHASE=suppress
  OUT_SCOPE_START=$SECONDS
  db suppress.sql "$WORK/suppress.private" write
  snapshot "$WORK/suppressed-state.json"
  jq -e --slurpfile j "$JOURNAL" '
    .in_scope==false and .feed_count=="0" and .feed_matches_expected and .out_of_scope_total=="1" and .candidate_events=="1" and
    .suppress_event!=null and .restore_event==null and .current_event==.suppress_event.id and
    (.epoch|tonumber)==(($j[0].baseline.state.epoch|tonumber)+1) and
    .v1.totalPublications==($j[0].baseline.state.v1.totalPublications-1) and
    .v2.totalPublications==($j[0].baseline.state.v2.totalPublications-1)
  ' "$WORK/suppressed-state.json" >/dev/null
  update_journal suppressed
  PHASE=idempotence
  db idempotence.sql "$WORK/idempotence.json" write
  jq -e --slurpfile s "$WORK/suppressed-state.json" '.applied==false and .resulting_scope=="OUT_OF_SCOPE" and .event_id==$s[0].suppress_event.id' "$WORK/idempotence.json" >/dev/null
  snapshot "$WORK/idempotence-state.json"
  same_json "$WORK/suppressed-state.json" "$WORK/idempotence-state.json"
  PHASE=suppressed_api
  api_phase suppressed false "$(jq -r '.epoch' "$WORK/suppressed-state.json")"
  same_json "$WORK/suppressed-state.json" "$WORK/suppressed-api-after.json"
  PHASE=suppressed_preservation
  fingerprints "$WORK/suppressed-fingerprints.json"
  same_json "$WORK/suppressed-fingerprints.json" <(jq '.baseline.fingerprints' "$JOURNAL")
  db rls.sql "$WORK/suppressed-rls.json"
  jq -e --slurpfile j "$JOURNAL" '.publications=="0" and .versions=="0" and .origins=="0" and .files=="0" and .history_sha256==$j[0].baseline.rls.history_sha256' "$WORK/suppressed-rls.json" >/dev/null
  security_preflight "$WORK/suppressed-privileges.private"
  if [[ ${UI_OBSERVATION_WINDOW:-disabled} == enabled ]]; then
    local available wait_seconds
    available=$(budget_seconds 45) || die 'NO_UI_OBSERVATION_BUDGET'
    wait_seconds=$((available - 5))
    (( wait_seconds > 0 )) || die 'NO_UI_OBSERVATION_BUDGET'
    log "UI_OBSERVATION_WINDOW_OPEN; AUTO_RESTORE_IN_${wait_seconds}_SECONDS"
    sleep "$wait_seconds"
  fi
  (( SECONDS - OUT_SCOPE_START <= 60 )) || die 'SUPPRESSION_WINDOW_EXCEEDED'
  PHASE=restore
  recover || die 'RESTORE_NOT_CONFIRMED'
  PHASE=restore_verification
  verify_restored
  update_journal smoke_verified
  jq -cn --slurpfile j "$JOURNAL" --slurpfile f "$WORK/final-fingerprints.json" \
    --slurpfile s "$WORK/final-state.json" \
    '{evidence_sha256:$j[0].evidence_sha256,manifest_sha256:$j[0].manifest_sha256,
      epochs:{before:$j[0].baseline.state.epoch,suppressed:$j[0].observations.suppressed.epoch,restored:$s[0].epoch},
      final_in_scope:$s[0].in_scope,feed_count:$s[0].feed_count,fingerprints:$f[0]}' >"$WORK/sanitized-summary.json"
  FINISHED=1
  cat "$WORK/sanitized-summary.json"
  log 'DOU_CLEAN_02_PUBLIC_SCOPE_SMOKE_PASS; FINAL_IN_SCOPE_CONFIRMED'
  log 'AUTHENTICATED_ARCHIVE_DETAIL_FACETS_NAVIGATION_NOT_PROVEN; WORKER_INFLIGHT_RACE_NOT_PROVEN'
}
main "$@"
