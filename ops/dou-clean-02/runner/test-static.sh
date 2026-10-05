#!/usr/bin/env bash
# Offline checks only. No connection credentials, PostgreSQL, HTTP or Railway.
set -Eeuo pipefail
ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
SCRIPT=$ROOT_DIR/postdeploy-smoke.sh
bash -n "$SCRIPT"
for mode in '' disabled unknown; do
  set +e
  output=$(env -i PATH=/usr/bin:/bin MODE="$mode" bash "$SCRIPT")
  status=$?
  set -e
  [[ $status != 0 && $output == *DISABLED_EXPLICIT_MODE_REQUIRED* ]]
  [[ $output != *PRIVATE_DURABLE_JOURNAL_READY* && $output != *SMOKE_PASS* ]]
done
[[ $(awk '/atomic_journal "\$WORK\/journal-prepared.json"/{print NR}' "$SCRIPT") -lt \
   $(awk '/db suppress.sql/{print NR}' "$SCRIPT") ]]
[[ $(awk '/ARMED=1/{line=NR} /db suppress.sql/{print line}' "$SCRIPT") -lt \
   $(awk '/db suppress.sql/{print NR}' "$SCRIPT") ]]
[[ $(awk '/verify_restored$/{line=NR} /DOU_CLEAN_02_PUBLIC_SCOPE_SMOKE_PASS/{print line}' "$SCRIPT") -lt \
   $(awk '/DOU_CLEAN_02_PUBLIC_SCOPE_SMOKE_PASS/{print NR}' "$SCRIPT") ]]
! rg -n --glob '*.sql' '\b(DELETE|TRUNCATE|DROP|ALTER|GRANT|REVOKE|INSERT|UPDATE)\b' "$ROOT_DIR/sql" | \
  rg -v 'FOR UPDATE|--'
rg -q 'psql -X --no-password.*ON_ERROR_STOP=on' "$SCRIPT"
rg -q 'SET LOCAL ROLE radar_app' "$ROOT_DIR/sql/rls.sql"
rg -q 'publication_version_id=ANY\(:.version_ids.::uuid\[\]\)' "$ROOT_DIR/sql/rls.sql"
rg -q 'operation_id=:.suppress_operation_id.::uuid' "$ROOT_DIR/sql/restore.sql"
rg -q 's.current_event_id=e.id' "$ROOT_DIR/sql/restore.sql"
rg -q 'trap on_exit EXIT' "$SCRIPT"
rg -q 'sync -f "\$tmp"' "$SCRIPT"
rg -q 'chmod 600 "\$tmp"' "$SCRIPT"
rg -q -- '--retry 0' "$SCRIPT"
! rg -n -- '--insecure|--location|--verbose|set -x|PGPASSWORD|JWT_SECRET' "$SCRIPT"
printf '%s\n' 'OFFLINE_STATIC_CHECKS_PASS; POSTGRES_INTEGRATION_NOT_RUN'
