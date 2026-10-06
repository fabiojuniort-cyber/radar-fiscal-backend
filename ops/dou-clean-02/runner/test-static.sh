#!/usr/bin/env bash
# Offline checks only. No connection credentials, PostgreSQL, HTTP or Railway.
set -Eeuo pipefail
ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
SCRIPT=$ROOT_DIR/postdeploy-smoke.sh
bash -n "$SCRIPT"
bash -n "$ROOT_DIR/test-recovery-control.sh"
bash -n "$ROOT_DIR/test-pg18-isolated.sh"
for mode in '' disabled unknown rehearsal; do
  set +e
  output=$(env -i PATH=/usr/bin:/bin MODE="$mode" bash "$SCRIPT")
  status=$?
  set -e
  [[ $status != 0 && $output == *DISABLED_EXPLICIT_MODE_REQUIRED* ]]
  [[ $output != *PRIVATE_DURABLE_JOURNAL_READY* && $output != *SMOKE_PASS* ]]
done
set +e
preflight_output=$(env -i PATH=/usr/bin:/bin MODE=preflight bash "$SCRIPT")
preflight_status=$?
set -e
[[ $preflight_status != 0 && $preflight_output != *READ_ONLY_PREFLIGHT_PASS* ]]
rg -q 'READ_ONLY_PREFLIGHT_PASS; NO_SUPPRESS_OR_RESTORE' "$SCRIPT"
rg -q 'PINNED_PUBLIC_CANDIDATE_REQUIRED_FOR_UI' "$SCRIPT"
rg -q 'controlled_publication_sha256' "$ROOT_DIR/sql/candidate.sql"
[[ $(awk '/atomic_journal "\$WORK\/journal-prepared.json"/{print NR}' "$SCRIPT") -lt \
   $(awk '/db suppress.sql/{print NR}' "$SCRIPT") ]]
[[ $(awk '/ARMED=1/{line=NR} /db suppress.sql/{print line}' "$SCRIPT") -lt \
   $(awk '/db suppress.sql/{print NR}' "$SCRIPT") ]]
[[ $(awk '/verify_restored$/{line=NR} /DOU_CLEAN_02_PUBLIC_SCOPE_SMOKE_PASS/{print line}' "$SCRIPT") -lt \
   $(awk '/DOU_CLEAN_02_PUBLIC_SCOPE_SMOKE_PASS/{print NR}' "$SCRIPT") ]]
# Metadata ACL strings legitimately contain DML names; reject actual commands.
# `! cmd` never triggers errexit; negative guards use explicit if.
if rg -n --glob '*.sql' '^[[:space:]]*(DELETE[[:space:]]+FROM|TRUNCATE|DROP|ALTER|GRANT|REVOKE|INSERT[[:space:]]+INTO|UPDATE[[:space:]]+[a-z_])\b' "$ROOT_DIR/sql"; then printf '%s\n' 'OFFLINE_FORBIDDEN_PATTERN_FOUND'; exit 1; fi
rg -q 'psql -X --no-password.*ON_ERROR_STOP=on' "$SCRIPT"
if rg -n 'PGDATABASE=\$PROD|psql .*PROD_DATABASE_ADMIN_URL' "$SCRIPT"; then printf '%s\n' 'OFFLINE_FORBIDDEN_PATTERN_FOUND'; exit 1; fi
rg -q 'connection_from_url "\$PROD_DATABASE_ADMIN_URL" \|\| die' "$SCRIPT"
rg -q 'SET LOCAL ROLE radar_app' "$ROOT_DIR/sql/rls.sql"
rg -q 'publication_version_id=ANY\(:.version_ids.::uuid\[\]\)' "$ROOT_DIR/sql/rls.sql"
rg -q 'operation_id=:.suppress_operation_id.::uuid' "$ROOT_DIR/sql/restore.sql"
rg -q 's.current_event_id=e.id' "$ROOT_DIR/sql/restore.sql"
rg -q '^BEGIN ISOLATION LEVEL READ COMMITTED;' "$ROOT_DIR/sql/recovery-state.sql"
rg -q '^FOR UPDATE$' "$ROOT_DIR/sql/recovery-state.sql"
rg -q '^\\gset$' "$ROOT_DIR/sql/recovery-state.sql"
[[ $(awk '/^FOR UPDATE$/{print NR}' "$ROOT_DIR/sql/recovery-state.sql") -lt \
   $(awk '/^SELECT jsonb_build_object\(/{print NR}' "$ROOT_DIR/sql/recovery-state.sql") ]]
rg -q 'db recovery-state.sql "\$1" write' "$SCRIPT"
rg -q '\.barrier_acquired==true.*observed_isolation|\.barrier_acquired==true and' "$SCRIPT"
rg -q 'pg_has_role\(runtime.oid,candidate.oid,.SET.\)' "$ROOT_DIR/sql/privileges.sql"
rg -q 'rolcreaterole.*rolcreatedb.*rolreplication' "$ROOT_DIR/sql/privileges.sql"
rg -q 'has_any_column_privilege' "$ROOT_DIR/sql/privileges.sql"
rg -q 'acl.grantee=0' "$ROOT_DIR/sql/privileges.sql"
rg -q 'pg_has_role\(a.oid,l.relowner,.USAGE.\)' "$ROOT_DIR/sql/privileges.sql"
[[ $(rg -c '^  security_preflight ' "$SCRIPT") == 3 ]]
rg -q 'if ! db preflight.sql "\$1"' "$SCRIPT"
rg -q 'elif ! db privileges.sql "\$1.acl"' "$SCRIPT"
rg -q 'trap on_exit EXIT' "$SCRIPT"
# A foreground sleep would defer the restore trap for the whole UI window.
rg -q '^    sleep "\$wait_seconds" 9>&- &$' "$SCRIPT"
rg -q '^    wait "\$!"$' "$SCRIPT"
if rg -n '^[[:space:]]*sleep "\$wait_seconds"$' "$SCRIPT"; then printf '%s\n' 'OFFLINE_FORBIDDEN_PATTERN_FOUND'; exit 1; fi
rg -q '^    PHASE=read_only_preflight_connection$' "$SCRIPT"
rg -q "log 'BASELINE_HTTP_COHERENT=true'" "$SCRIPT"
rg -q '^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;$' "$ROOT_DIR/sql/state-diagnose.sql"
rg -q '^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;$' "$ROOT_DIR/sql/candidate-blockers.sql"
# jq 1.6 (bookworm) exits 0 for `jq -e` on empty input: image and runtime guard.
rg -q '^FROM postgres:18-trixie$' "$ROOT_DIR/Dockerfile"
rg -q "if printf '' \| jq -e \. >/dev/null; then die 'UNSAFE_JQ_EMPTY_INPUT_SEMANTICS'; fi" "$SCRIPT"
rg -q "jq -se '" "$SCRIPT"
rg -q 'sync -f "\$tmp"' "$SCRIPT"
rg -q 'chmod 600 "\$tmp"' "$SCRIPT"
rg -q -- '--retry 0' "$SCRIPT"
if rg -n -- '--insecure|--location|--verbose|set -x|PGPASSWORD|JWT_SECRET' "$SCRIPT"; then printf '%s\n' 'OFFLINE_FORBIDDEN_PATTERN_FOUND'; exit 1; fi
rg -q 'env -i PATH=.*bash ops/dou-clean-02/runner/test-static.sh' "$ROOT_DIR/../../../.github/workflows/ci.yml"
rg -q -- '--network none' "$ROOT_DIR/test-pg18-isolated.sh"
rg -q -- '--pull=never' "$ROOT_DIR/test-pg18-isolated.sh"
if rg -n 'radar-fiscal-backend-production|up\.railway\.app|curl|postdeploy-smoke\.sh' "$ROOT_DIR/test-pg18-isolated.sh"; then printf '%s\n' 'OFFLINE_FORBIDDEN_PATTERN_FOUND'; exit 1; fi
env -i PATH="$PATH" bash "$ROOT_DIR/test-recovery-control.sh"
env -i PATH="$PATH" bash "$ROOT_DIR/test-pg18-isolated.sh" --syntax-only
# Rehearsal rejects credential/configuration variables BEFORE Docker discovery.
for key in DATABASE_ADMIN_URL PROD_DATABASE_ADMIN_URL PGHOST DOCKER_HOST; do
  set +e
  rejected=$(env -i PATH="$PATH" "$key=OFFLINE_REJECTION_SENTINEL" \
    bash "$ROOT_DIR/test-pg18-isolated.sh" --run-isolated-fixture 2>&1)
  status=$?
  set -e
  [[ $status != 0 && $rejected == *'external database or Docker configuration environment is forbidden'* ]]
  [[ $rejected != *OFFLINE_REJECTION_SENTINEL* ]]
done
printf '%s\n' 'OFFLINE_STATIC_CHECKS_PASS; POSTGRES_INTEGRATION_NOT_RUN'
