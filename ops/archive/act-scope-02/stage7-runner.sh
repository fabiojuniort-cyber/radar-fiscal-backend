#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
: "${RAILWAY_PROJECT_ID:?Railway required}"
: "${CANDIDATE_SHA:?exact artifact required}"
mountpoint -q /data || exit 1
MODE="${MODE:-prepare}"
[[ "$MODE" == prepare || "$MODE" == rehearse || "$MODE" == roundtrip || "$MODE" == restore ]] || exit 1
RUNNER=/opt/act-scope-02/stage7.cjs
if [[ "$MODE" != rehearse ]]; then
  [[ "${TARGET:-production}" == production ]] || exit 1
  exec node "$RUNNER"
fi
# Rehearsal reuses only the already-restored local PG18 cluster. Production
# credentials are never passed to pg_ctl, psql or the isolated Node client.
[[ "${BACKUP_SHA:-}" == 20acd13cc7eb20d2b7d1d0de8de4dfd3d663965454f95e1f72e90b626189891d ]] || exit 1
shopt -s nullglob
BACKUPS=(/data/act-scope-02/20261007T183123Z-*)
[[ "${#BACKUPS[@]}" == 1 ]] || exit 1
WORK="${BACKUPS[0]}"
jq -e --arg sha "$BACKUP_SHA" '.result=="PASS" and .allPublicTableCountsEqual==true and .dumpSha256==$sha' "$WORK/evidence.json" >/dev/null
[[ -d "$WORK/pgtmp/data" && -d "$WORK/socket" ]] || exit 1
if [[ -d /data/act-scope-02/stage7-rehearsal ]]; then
  mv /data/act-scope-02/stage7-rehearsal "/data/act-scope-02/stage7-rehearsal-archive-$(date -u +%Y%m%dT%H%M%SZ)-$$"
fi
cleanup() { gosu postgres pg_ctl -D "$WORK/pgtmp/data" -m fast stop >>"$WORK/private.log" 2>&1 || true; }
trap cleanup EXIT
gosu postgres pg_ctl -D "$WORK/pgtmp/data" -w -o "-c listen_addresses='' -k $WORK/socket -p 5439" -l "$WORK/pgtmp/server.log" start >>"$WORK/private.log" 2>&1
export TARGET=isolated LOCAL_SOCKET="$WORK/socket"
unset PROD_DATABASE_ADMIN_URL DATABASE_URL DATABASE_ADMIN_URL PGOPTIONS
MODE=prepare node "$RUNNER"
export APPROVED_MANIFEST_SHA="$(jq -r .digest /data/act-scope-02/stage7-rehearsal/manifest.json)"
export APPROVED_COUNT="$(jq -r '.candidates|length' /data/act-scope-02/stage7-rehearsal/manifest.json)"
MODE=roundtrip node "$RUNNER"
