#!/usr/bin/env bash
# R3: production is read-only; restore target is a new Unix-socket-only
# PostgreSQL cluster in this Railway container. No production URL is ever
# passed to createdb/pg_restore. Private dump and logs stay on the volume.
set -Eeuo pipefail
umask 077
: "${PROD_DATABASE_ADMIN_URL:?required}"
: "${CANDIDATE_SHA:?required}"
: "${RAILWAY_PROJECT_ID:?must run inside Railway}"
[[ "$CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]] || exit 1
MODE="${MODE:-preflight}"
[[ "$MODE" == preflight || "$MODE" == backup-restore ]] || exit 1
# Pre-deploy backups (DOU-CLEAN-02) required the scope ledgers to be absent;
# post-deploy backups (DOU-CLEAN-01 / #80) require them to be present.
EXPECT_SCOPE_TABLES="${EXPECT_SCOPE_TABLES:-absent}"
[[ "$EXPECT_SCOPE_TABLES" == absent || "$EXPECT_SCOPE_TABLES" == present ]] || exit 1
DATA_DIR=/data
mountpoint -q "$DATA_DIR" || { echo 'SCOPE_BACKUP_FAIL=missing_private_volume'; exit 1; }
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK="$DATA_DIR/dou-clean-02/$STAMP-$$"
PGTMP="$WORK/pgtmp"
SOCKET="$WORK/socket"
mkdir -p "$WORK" "$PGTMP" "$SOCKET"
PROD="$PROD_DATABASE_ADMIN_URL"
export PGOPTIONS='-c default_transaction_read_only=on -c lock_timeout=2000 -c statement_timeout=600000'
SNAPSHOT_PID=''
TEMP_STARTED=false
cleanup() {
  if [[ -n "$SNAPSHOT_PID" ]]; then kill "$SNAPSHOT_PID" 2>/dev/null || true; fi
  if [[ "$TEMP_STARTED" == true ]]; then
    gosu postgres pg_ctl -D "$PGTMP/data" -m fast stop >>"$WORK/private.log" 2>&1 || true
  fi
}
trap cleanup EXIT
trap 'echo "SCOPE_BACKUP_FAIL=line_$LINENO" >&2' ERR
prod() { psql "$PROD" -X -qAt -v ON_ERROR_STOP=1 "$@" 2>>"$WORK/private.log"; }
[[ "$(prod -c 'SHOW default_transaction_read_only')" == on ]]
prod -c "SELECT json_build_object('serverMajor', current_setting('server_version_num')::int / 10000, 'databaseBytes', pg_database_size(current_database()), 'scopeAbsent', to_regclass('public.publication_scope_events') IS NULL AND to_regclass('public.publication_scope_state') IS NULL AND to_regclass('public.publication_scope_epoch_state') IS NULL);" > "$WORK/preflight.json"
jq -e --arg expect "$EXPECT_SCOPE_TABLES" '.serverMajor == 18 and .scopeAbsent == ($expect == "absent")' "$WORK/preflight.json" >/dev/null
echo "SCOPE_PREFLIGHT=$(jq -c --arg sha "$CANDIDATE_SHA" --arg timestamp "$STAMP" '. + {candidateSha: $sha, timestamp: $timestamp}' "$WORK/preflight.json")"
if [[ "$MODE" == preflight ]]; then echo 'SCOPE_PREFLIGHT_PASS'; exit 0; fi

# Conservative volume check before starting the logical dump and restore.
AVAILABLE=$(df -B1 --output=avail "$DATA_DIR" | tail -1 | tr -d ' ')
DATABASE_BYTES=$(jq -r .databaseBytes "$WORK/preflight.json")
(( AVAILABLE > DATABASE_BYTES * 3 + 2147483648 ))
echo "SCOPE_VOLUME_AVAILABLE_BYTES=$AVAILABLE"
coproc SNAP { prod; }
SNAPSHOT_PID=$SNAP_PID
SNAP_IN=${SNAP[1]}
SNAP_OUT=${SNAP[0]}
printf '%s\n' 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();' >&"$SNAP_IN"
read -r -t 30 SNAPSHOT <&"$SNAP_OUT"
[[ "$SNAPSHOT" =~ ^[0-9A-F-]+$ ]]

# Capture every public table count and required role name in that same snapshot.
# Role passwords, login attributes and memberships are never exported.
cat > "$WORK/counts.sql" <<'SQL'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET TRANSACTION SNAPSHOT :'snapshot';
SELECT format('SELECT %L || ''='' || count(*)::text FROM %I.%I;', tablename, schemaname, tablename)
FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename \gexec
COMMIT;
SQL
prod -v snapshot="$SNAPSHOT" -f "$WORK/counts.sql" > "$WORK/counts.original.txt"
cat > "$WORK/roles.sql" <<'SQL'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET TRANSACTION SNAPSHOT :'snapshot';
SELECT format('CREATE ROLE %I NOLOGIN;', rolname)
FROM pg_roles WHERE rolname !~ '^pg_' AND rolname <> 'postgres' ORDER BY rolname;
COMMIT;
SQL
prod -v snapshot="$SNAPSHOT" -f "$WORK/roles.sql" > "$WORK/roles.private.sql"
echo 'SCOPE_BACKUP_STAGE=snapshot_counts_and_roles_captured'
DUMP="$WORK/scope-pre-deploy.dump"
pg_dump "$PROD" --snapshot="$SNAPSHOT" --format=custom --compress=6 --no-password --file="$DUMP" 2>>"$WORK/private.log"
pg_restore --list "$DUMP" > "$WORK/dump.private.toc" 2>>"$WORK/private.log"
sha256sum "$DUMP" > "$DUMP.sha256"
echo 'SCOPE_BACKUP_STAGE=dump_and_toc_complete'
printf '%s\n' 'COMMIT;' >&"$SNAP_IN"
exec {SNAP_IN}>&-
wait "$SNAPSHOT_PID"
SNAPSHOT_PID=''
unset PGOPTIONS

# The restore cluster is new, has no TCP listener and no production passwords.
chmod 711 "$DATA_DIR/dou-clean-02" "$WORK"
chown postgres:postgres "$PGTMP" "$SOCKET"
gosu postgres initdb -D "$PGTMP/data" -U postgres --auth=trust --encoding=UTF8 --locale=C.UTF-8 >>"$WORK/private.log" 2>&1
gosu postgres pg_ctl -D "$PGTMP/data" -w -o "-c listen_addresses='' -k $SOCKET -p 5439 -c max_wal_size=2GB" -l "$PGTMP/server.log" start >>"$WORK/private.log" 2>&1
TEMP_STARTED=true
LOCAL_ADMIN="host=$SOCKET port=5439 user=postgres dbname=postgres"
LOCAL_RESTORE="host=$SOCKET port=5439 user=postgres dbname=scope_restore_test"
psql "$LOCAL_ADMIN" -X -q -v ON_ERROR_STOP=1 -f "$WORK/roles.private.sql" >>"$WORK/private.log" 2>&1
createdb --maintenance-db="$LOCAL_ADMIN" --template=template0 scope_restore_test >>"$WORK/private.log" 2>&1
pg_restore --exit-on-error --no-owner --jobs=2 --dbname="$LOCAL_RESTORE" "$DUMP" >>"$WORK/private.log" 2>&1
echo 'SCOPE_BACKUP_STAGE=isolated_restore_complete'
# All public table counts must match, including the four mandatory tables.
sed '/SET TRANSACTION SNAPSHOT/d' "$WORK/counts.sql" > "$WORK/counts.restored.sql"
PGOPTIONS='-c default_transaction_read_only=on' psql "$LOCAL_RESTORE" -X -qAt -v ON_ERROR_STOP=1 -f "$WORK/counts.restored.sql" > "$WORK/counts.restored.txt" 2>>"$WORK/private.log"
cmp -s "$WORK/counts.original.txt" "$WORK/counts.restored.txt"
for table in publications publication_versions publication_origins collection_run_publications; do
  grep -q "^$table=[0-9]*$" "$WORK/counts.original.txt"
done
COUNTS=$(jq -Rn '[inputs | split("=") | {key: .[0], value: (.[1] | tonumber)}] | from_entries' < "$WORK/counts.original.txt")
jq -cn --arg timestamp "$STAMP" --arg sha "$CANDIDATE_SHA" \
  --arg dumpSha256 "$(cut -d' ' -f1 "$DUMP.sha256")" \
  --argjson dumpBytes "$(stat -c %s "$DUMP")" --argjson counts "$COUNTS" \
  '{result:"PASS",timestamp:$timestamp,candidateSha:$sha,dumpSha256:$dumpSha256,dumpBytes:$dumpBytes,allPublicTableCountsEqual:true,counts:$counts,location:"Railway private volume",restoreTarget:"isolated Unix socket cluster"}' > "$WORK/evidence.json"
echo "SCOPE_BACKUP_RESTORE=$(cat "$WORK/evidence.json")"
echo 'SCOPE_BACKUP_RESTORE_PASS'
# Preserve both dump and restored cluster for review; stop PostgreSQL on exit.
