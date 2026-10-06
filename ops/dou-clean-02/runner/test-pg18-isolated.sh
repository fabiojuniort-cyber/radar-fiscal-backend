#!/usr/bin/env bash
# Opt-in future integration run. Never reads a connection URL or contacts a server.
# Docker is pinned to its local Unix socket; the image must already be installed.
set -Eeuo pipefail
umask 077
ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
readonly FIXTURE_ID=DOU_CLEAN_02_PG18_NETWORK_NONE_FIXTURE_V1
readonly PUB=11111111-1111-4111-8111-111111111111
readonly SUP=22222222-2222-4222-8222-222222222222
readonly RES=33333333-3333-4333-8333-333333333333
readonly TRANSITION='public.apply_publication_scope_transition(uuid,text,uuid,uuid,text,text,text,text,text,text)'
readonly MATERIAL='public.restore_publication_scope_on_material_change(uuid,text)'
fail() { printf 'ISOLATED_PG18_FAIL: %s\n' "$1" >&2; exit 1; }

if [[ ${1:-} == --syntax-only && $# == 1 ]]; then
  bash -n "$ROOT_DIR/test-pg18-isolated.sh"
  [[ -s $ROOT_DIR/tests/fixture.sql && -s $ROOT_DIR/sql/privileges.sql
     && -s $ROOT_DIR/sql/recovery-state.sql ]] || fail 'required SQL missing'
  printf '%s\n' 'ISOLATED_HARNESS_SYNTAX_PASS; POSTGRES_INTEGRATION_NOT_RUN'
  exit 0
fi
[[ $# == 1 && $1 == --run-isolated-fixture ]] ||
  fail 'opt-in required: --run-isolated-fixture (or --syntax-only)'

# Reject connection/configuration inputs even though psql never runs on the host.
# Do not print their values, or consume caller-selected image/container/SQL paths.
while IFS= read -r name; do
  case "$name" in
    PG*|POSTGRES*|DATABASE_*|DB_*|*DATABASE*URL*|*DB*URL*|*DATABASE*HOST*|*DB*HOST*|DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG|DOCKER_TLS*|DOCKER_CERT_PATH)
      fail 'external database or Docker configuration environment is forbidden' ;;
  esac
done < <(compgen -e)
for executable in docker jq timeout rg sed; do command -v "$executable" >/dev/null || fail "missing $executable"; done
[[ -S /var/run/docker.sock ]] || fail 'local Docker Unix socket unavailable'
[[ -s $ROOT_DIR/sql/privileges.sql ]] || fail 'privileges.sql missing'
DOCKER=(docker --host unix:///var/run/docker.sock)
"${DOCKER[@]}" image inspect postgres:18-bookworm >/dev/null 2>&1 || fail 'postgres:18-bookworm must already be local; pulling is prohibited'
TEMP_DIR=$(mktemp -d /tmp/dou-clean-02-pg18.XXXXXXXX)
container=
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n $container ]]; then
    if [[ $("${DOCKER[@]}" inspect --format '{{index .Config.Labels "org.openai.dou-clean-02-fixture"}}' "$container" 2>/dev/null) == "$FIXTURE_ID" ]]; then
      "${DOCKER[@]}" rm --force --volumes "$container" >/dev/null 2>&1 || true
    fi
  fi
  # Keep bounded fixture-only diagnostics for inspection; no credentials inside.
  printf 'Fixture diagnostics: %s\n' "$TEMP_DIR" >&2
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
container=$("${DOCKER[@]}" run --detach --pull=never --network none --read-only \
  --label "org.openai.dou-clean-02-fixture=$FIXTURE_ID" \
  --tmpfs /tmp:rw,nosuid,nodev,size=512m --tmpfs /var/run/postgresql:rw,nosuid,nodev,size=8m \
  --env PGDATA=/tmp/fixture-pgdata --env POSTGRES_DB=fixture_template \
  --env POSTGRES_PASSWORD=isolated-fixture-only \
  --env 'POSTGRES_INITDB_ARGS=--auth-local=trust --auth-host=reject' \
  postgres:18-bookworm postgres -c listen_addresses= -c unix_socket_directories=/var/run/postgresql)
[[ $container =~ ^[a-f0-9]{64}$ ]] || fail 'unexpected container identity'
[[ $("${DOCKER[@]}" inspect --format '{{.HostConfig.NetworkMode}}' "$container") == none ]] || fail 'container is not isolated'
for ((attempt=0; attempt<100; attempt++)); do
  # Do not race the entrypoint's temporary initialization PostgreSQL process.
  if [[ $("${DOCKER[@]}" exec "$container" cat /proc/1/comm 2>/dev/null) == postgres ]] &&
     "${DOCKER[@]}" exec "$container" pg_isready -h /var/run/postgresql -U postgres -d fixture_template >/dev/null 2>&1; then break; fi
  sleep 0.1
done
[[ $("${DOCKER[@]}" exec "$container" cat /proc/1/comm 2>/dev/null) == postgres ]] || fail 'fixture initialization did not complete'
"${DOCKER[@]}" exec "$container" pg_isready -h /var/run/postgresql -U postgres -d fixture_template >/dev/null 2>&1 || fail 'fixture database did not become ready'

psql_fixture() {
  local database=$1 app=${2:-fixture-main} options=${3:--c statement_timeout=12000 -c lock_timeout=8000}
  shift 3
  [[ $database == fixture_* && $database =~ ^[a-z0-9_]+$ ]] || fail 'nonfixture database rejected'
  timeout --signal=TERM --kill-after=2s 18s "${DOCKER[@]}" exec --interactive \
    --env "PGOPTIONS=$options" --env "PGAPPNAME=$app" "$container" \
    psql -X --no-password --host=/var/run/postgresql --username=postgres \
      --dbname="$database" --quiet --tuples-only --no-align --set=ON_ERROR_STOP=on \
      --set="publication_id=$PUB" --set="suppress_operation_id=$SUP" \
      --set="restore_operation_id=$RES" --set=evidence_sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
      --set=manifest_sha256=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
      --set=actor_ref=isolated-fixture --set=baseline_epoch=0 "$@"
}
query() { local database=$1 statement=$2; printf '%s\n' "$statement" | psql_fixture "$database" fixture-main '-c statement_timeout=12000 -c lock_timeout=8000'; }
sql_file() { local database=$1 file=$2; psql_fixture "$database" fixture-main '-c statement_timeout=12000 -c lock_timeout=8000' <"$ROOT_DIR/sql/$file"; }
new_database() {
  local database=$1
  [[ $database =~ ^fixture_[a-z0-9_]+$ ]] || fail 'unsafe fixture name'
  query fixture_admin "CREATE DATABASE $database TEMPLATE fixture_template;" >/dev/null
  [[ $(query "$database" 'SELECT identity FROM public.fixture_identity;') == "$FIXTURE_ID" ]] || fail 'fixture identity mismatch'
}

psql_fixture fixture_template fixture-bootstrap '-c statement_timeout=12000 -c lock_timeout=8000' <"$ROOT_DIR/tests/fixture.sql" >"$TEMP_DIR/bootstrap.out"
query fixture_template 'CREATE DATABASE fixture_admin TEMPLATE template0;' >/dev/null
sql_file fixture_template privileges.sql >"$TEMP_DIR/privileges-safe.out"
printf '%s\n' 'PASS safe privilege baseline'

new_database fixture_nominal
sql_file fixture_nominal suppress.sql >"$TEMP_DIR/nominal-suppress.out"
sql_file fixture_nominal recovery-state.sql >"$TEMP_DIR/nominal-suppressed.json"
jq -e '.barrier_acquired and (.observed_isolation == "read committed") and .canonical_exists and (.in_scope == false) and (.suppress_event.id == .current_event) and (.restore_event == null)' "$TEMP_DIR/nominal-suppressed.json" >/dev/null
sql_file fixture_nominal restore.sql >"$TEMP_DIR/nominal-restore.out"
sql_file fixture_nominal recovery-state.sql >"$TEMP_DIR/nominal-restored.json"
jq -e '.barrier_acquired and (.observed_isolation == "read committed") and .canonical_exists and .in_scope and (.restore_event.id == .current_event)' "$TEMP_DIR/nominal-restored.json" >/dev/null
[[ $(query fixture_nominal 'SELECT count(*) FROM public.publication_scope_events;') == 2 ]] || fail 'nominal event count'
printf '%s\n' 'PASS nominal actual SUPPRESS -> recovery -> RESTORE SQL'

wait_for_activity() {
  local database=$1 application=$2 condition=$3
  for ((probe=0; probe<40; probe++)); do
    if [[ $(query "$database" "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname='$database' AND application_name='$application' AND $condition);") == t ]]; then return 0; fi
    sleep 0.05
  done
  fail "expected backend state not observed: $application"
}
delayed_suppress() {
  local database=$1
  # Execute the actual suppress.sql, only delaying its final COMMIT.
  sed 's/^COMMIT;$/SELECT pg_sleep(5); COMMIT;/' "$ROOT_DIR/sql/suppress.sql" |
    psql_fixture "$database" fixture-delayed-suppress '-c statement_timeout=12000 -c lock_timeout=8000'
}

new_database fixture_race
delayed_suppress fixture_race >"$TEMP_DIR/race-suppress.out" 2>"$TEMP_DIR/race-suppress.err" &
suppress_pid=$!
wait_for_activity fixture_race fixture-delayed-suppress "wait_event='PgSleep'"
psql_fixture fixture_race fixture-recovery '-c statement_timeout=12000 -c lock_timeout=8000' \
  <"$ROOT_DIR/sql/recovery-state.sql" >"$TEMP_DIR/race-recovery.json" 2>"$TEMP_DIR/race-recovery.err" &
recovery_pid=$!
wait_for_activity fixture_race fixture-recovery "wait_event_type='Lock'"
wait "$suppress_pid"
wait "$recovery_pid"
jq -e '.barrier_acquired and (.observed_isolation == "read committed") and .canonical_exists and (.in_scope == false) and (.suppress_event.id == .current_event) and (.restore_event == null)' "$TEMP_DIR/race-recovery.json" >/dev/null
sql_file fixture_race restore.sql >"$TEMP_DIR/race-restore.out"
sql_file fixture_race recovery-state.sql >"$TEMP_DIR/race-restored.json"
jq -e '.in_scope and (.restore_event.id == .current_event)' "$TEMP_DIR/race-restored.json" >/dev/null
printf '%s\n' 'PASS delayed SUPPRESS commit blocks recovery; fresh READ COMMITTED statement observes commit'

new_database fixture_timeout
delayed_suppress fixture_timeout >"$TEMP_DIR/timeout-suppress.out" 2>"$TEMP_DIR/timeout-suppress.err" &
suppress_pid=$!
wait_for_activity fixture_timeout fixture-delayed-suppress "wait_event='PgSleep'"
if psql_fixture fixture_timeout fixture-lock-timeout '-c statement_timeout=3000 -c lock_timeout=150' \
  <"$ROOT_DIR/sql/recovery-state.sql" >"$TEMP_DIR/timeout-recovery.out" 2>"$TEMP_DIR/timeout-recovery.err"; then
  fail 'recovery unexpectedly succeeded through held lock'
fi
rg -q 'lock timeout' "$TEMP_DIR/timeout-recovery.err" || fail 'recovery failed for a reason other than lock timeout'
[[ ! -s $TEMP_DIR/timeout-recovery.out ]] || fail 'timed-out recovery emitted usable stale state'
wait "$suppress_pid"
sql_file fixture_timeout restore.sql >"$TEMP_DIR/timeout-restore.out"
printf '%s\n' 'PASS recovery lock timeout is nonzero and emits no state'

case_no=0
reject_privilege() {
  local label=$1 mutation=$2 database
  case_no=$((case_no+1)); database=fixture_acl_$case_no
  new_database "$database"
  query "$database" "$mutation" >"$TEMP_DIR/acl-$case_no-mutation.out"
  if sql_file "$database" privileges.sql >"$TEMP_DIR/acl-$case_no-check.out" 2>"$TEMP_DIR/acl-$case_no-check.err"; then
    fail "preflight accepted forbidden privilege: $label"
  fi
  rg -q 'division by zero' "$TEMP_DIR/acl-$case_no-check.err" || fail "privilege SQL failed unexpectedly: $label"
  printf 'PASS rejects %s\n' "$label"
  # Bound tmpfs usage; this exact just-created fixture DB contains no user data.
  [[ $database =~ ^fixture_acl_[0-9]+$ ]] || fail 'unsafe fixture cleanup target'
  query fixture_admin "DROP DATABASE $database;" >/dev/null
}
set_bridge='GRANT fixture_escape_role TO fixture_runtime_noinherit WITH INHERIT FALSE, SET TRUE;'
for signature in "$TRANSITION" "$MATERIAL"; do
  # Prove the effective privilege is invisible before SET ROLE, then executable
  # after real PostgreSQL session authorization + SET ROLE, not just ACL parsing.
  if [[ $signature == "$TRANSITION" ]]; then
    call="SELECT * FROM public.apply_publication_scope_transition('$PUB','SUPPRESS','$SUP',NULL,'fixture','fixture','fixture','fixture','fixture','fixture');"
  else call="SELECT public.restore_publication_scope_on_material_change('$PUB','fixture');"; fi
  reject_privilege "NOINHERIT runtime SET ROLE EXECUTE $signature" \
    "GRANT EXECUTE ON FUNCTION $signature TO fixture_escape_role; $set_bridge
     SELECT 1 / CASE WHEN NOT has_function_privilege('fixture_runtime_noinherit','$signature','EXECUTE')
       AND pg_has_role('fixture_runtime_noinherit','fixture_escape_role','SET') THEN 1 ELSE 0 END;
     SET SESSION AUTHORIZATION fixture_runtime_noinherit; SET ROLE fixture_escape_role;
     $call RESET ROLE; RESET SESSION AUTHORIZATION;"
  # Role memberships are cluster-global, unlike grants on cloned fixture objects.
  query fixture_template 'REVOKE fixture_escape_role FROM fixture_runtime_noinherit;' >/dev/null
  reject_privilege "PUBLIC EXECUTE $signature" "GRANT EXECUTE ON FUNCTION $signature TO PUBLIC;"
done

for table in publication_scope_events publication_scope_state publication_scope_epoch_state; do
  for privilege in SELECT INSERT UPDATE DELETE TRUNCATE REFERENCES TRIGGER MAINTAIN; do
    reject_privilege "runtime $privilege on $table" "GRANT $privilege ON TABLE public.$table TO radar_worker;"
  done
  reject_privilege "PUBLIC UPDATE on $table" "GRANT UPDATE ON TABLE public.$table TO PUBLIC;"
  reject_privilege "PUBLIC SELECT on $table" "GRANT SELECT ON TABLE public.$table TO PUBLIC;"
  reject_privilege "reachable ownership of $table" "ALTER TABLE public.$table OWNER TO fixture_escape_role; $set_bridge"
  query fixture_template 'REVOKE fixture_escape_role FROM fixture_runtime_noinherit;' >/dev/null
  column=publication_id
  [[ $table != publication_scope_epoch_state ]] || column=epoch
  reject_privilege "NOINHERIT SET-able helper table UPDATE on $table" \
    "GRANT UPDATE ON TABLE public.$table TO fixture_escape_role; $set_bridge
     SELECT 1 / CASE WHEN NOT has_table_privilege('fixture_runtime_noinherit','public.$table','UPDATE')
       AND pg_has_role('fixture_runtime_noinherit','fixture_escape_role','SET') THEN 1 ELSE 0 END;"
  query fixture_template 'REVOKE fixture_escape_role FROM fixture_runtime_noinherit;' >/dev/null
  reject_privilege "NOINHERIT SET-able helper column UPDATE on $table" \
    "GRANT UPDATE ($column) ON public.$table TO fixture_escape_role; $set_bridge
     SELECT 1 / CASE WHEN NOT has_any_column_privilege('fixture_runtime_noinherit','public.$table','UPDATE')
       AND pg_has_role('fixture_runtime_noinherit','fixture_escape_role','SET') THEN 1 ELSE 0 END;"
  query fixture_template 'REVOKE fixture_escape_role FROM fixture_runtime_noinherit;' >/dev/null
  for privilege in SELECT INSERT UPDATE REFERENCES; do
    reject_privilege "PUBLIC column $privilege on $table" "GRANT $privilege ($column) ON public.$table TO PUBLIC;"
  done
done
for signature in "$TRANSITION" "$MATERIAL"; do
  reject_privilege "reachable function ownership $signature" "ALTER FUNCTION $signature OWNER TO fixture_escape_role; $set_bridge"
  query fixture_template 'REVOKE fixture_escape_role FROM fixture_runtime_noinherit;' >/dev/null
done
for attribute in SUPERUSER BYPASSRLS CREATEROLE CREATEDB REPLICATION; do
  reject_privilege "SET-able helper role attribute $attribute" \
    "ALTER ROLE fixture_escape_role $attribute; $set_bridge
     SELECT 1 / CASE WHEN pg_has_role('fixture_runtime_noinherit','fixture_escape_role','SET') THEN 1 ELSE 0 END;"
  # Attributes and memberships are cluster-global: reset both before next case.
  query fixture_template "ALTER ROLE fixture_escape_role NO$attribute;
    REVOKE fixture_escape_role FROM fixture_runtime_noinherit;" >/dev/null
done
reject_privilege 'reachable public schema ownership' "ALTER SCHEMA public OWNER TO fixture_escape_role; $set_bridge"
query fixture_template 'REVOKE fixture_escape_role FROM fixture_runtime_noinherit;' >/dev/null
reject_privilege 'reachable database ownership' \
  "ALTER DATABASE fixture_acl_$((case_no+1)) OWNER TO fixture_escape_role; $set_bridge"
query fixture_template 'REVOKE fixture_escape_role FROM fixture_runtime_noinherit;' >/dev/null
for column in publication_id publication_version_id detected_at; do
  reject_privilege "private history column $column" "GRANT SELECT($column) ON public.collection_run_publications TO radar_app;"
  reject_privilege "SET-able private history column $column" \
    "GRANT SELECT($column) ON public.collection_run_publications TO fixture_escape_role;
     GRANT fixture_escape_role TO radar_app_runtime WITH INHERIT FALSE, SET TRUE;"
  query fixture_template 'REVOKE fixture_escape_role FROM radar_app_runtime;' >/dev/null
done
CURATOR='public.publication_scope_lock_curator_version(uuid)'
IMPORTED='public.publication_scope_imported_today(uuid)'
for signature in "$CURATOR" "$IMPORTED" public.publication_scope_is_in_scope\(uuid\) \
  public.publication_scope_company_publication_is_in_scope\(uuid\) public.publication_scope_epoch\(\); do
  reject_privilege "PUBLIC narrow helper EXECUTE $signature" "GRANT EXECUTE ON FUNCTION $signature TO PUBLIC;"
done
for role in radar_app radar_worker; do
  reject_privilege "$role curator boundary" "GRANT EXECUTE ON FUNCTION $CURATOR TO $role;"
done
for role in radar_worker radar_taxonomy_curator; do
  reject_privilege "$role imported-today boundary" "GRANT EXECUTE ON FUNCTION $IMPORTED TO $role;"
done
reject_privilege 'missing curator boundary' "REVOKE EXECUTE ON FUNCTION $CURATOR FROM radar_taxonomy_curator;"
reject_privilege 'missing imported-today boundary' "REVOKE EXECUTE ON FUNCTION $IMPORTED FROM radar_app;"
for role in radar_app radar_worker; do
  for signature in public.publication_scope_is_in_scope\(uuid\) \
    public.publication_scope_company_publication_is_in_scope\(uuid\) public.publication_scope_epoch\(\); do
    reject_privilege "missing $role helper $signature" "REVOKE EXECUTE ON FUNCTION $signature FROM $role;"
  done
done
sql_file fixture_template privileges.sql >"$TEMP_DIR/privileges-final-safe.out"
printf '%s\n' 'PG18_ISOLATED_INTEGRATION_PASS'
