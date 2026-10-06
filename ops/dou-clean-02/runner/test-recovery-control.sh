#!/usr/bin/env bash
# Offline shell-control tests. PostgreSQL, HTTP, Docker and production are mocked.
set -Eeuo pipefail
SCRIPT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/postdeploy-smoke.sh
WORK=$(mktemp -d)
JOURNAL=$WORK/journal.json
cleanup() {
  rm -f -- "$WORK/recovery-before.json" "$WORK/recovery-after.json" "$JOURNAL" "$WORK/security" "$WORK/security.acl"
  rmdir -- "$WORK"
}
trap cleanup EXIT
# Extract exact function bodies, not a separately maintained implementation.
source <(awk '/^recovery_snapshot\(\) \{/{active=1} active{print} active && /^}/{exit}' "$SCRIPT")
source <(awk '/^recover\(\) \{/{active=1} active{print} active && /^}/{exit}' "$SCRIPT")
printf '%s\n' '{"manifest":{"database_fingerprint":"isolated-fixture"}}' >"$JOURNAL"
IN_SCOPE='{"canonical_exists":true,"barrier_acquired":true,"observed_isolation":"read committed","database_fingerprint":"isolated-fixture","in_scope":true,"current_event":null,"suppress_event":null,"restore_event":null}'
SUPPRESSED='{"canonical_exists":true,"barrier_acquired":true,"observed_isolation":"read committed","database_fingerprint":"isolated-fixture","in_scope":false,"current_event":"own-suppress","suppress_event":{"id":"own-suppress"},"restore_event":null}'
RESTORED='{"canonical_exists":true,"barrier_acquired":true,"observed_isolation":"read committed","database_fingerprint":"isolated-fixture","in_scope":true,"current_event":"own-restore","suppress_event":{"id":"own-suppress"},"restore_event":{"id":"own-restore"}}'
STATE=$IN_SCOPE
AFTER_RESTORE=$RESTORED
READ_RC=0
RESTORE_RC=0
RESTORE_CALLS=0
load_journal() { return 0; }
db() {
  case $1 in
    recovery-state.sql)
      # A row-lock barrier must NOT be requested through read-only db access.
      [[ ${3:-read} == write ]] || return 90
      printf '%s\n' "$STATE" >"$2"
      return "$READ_RC"
      ;;
    restore.sql)
      RESTORE_CALLS=$((RESTORE_CALLS+1))
      STATE=$AFTER_RESTORE
      return "$RESTORE_RC"
      ;;
    *) return 99 ;;
  esac
}
must_fail_without_write() {
  RESTORE_CALLS=0
  if recover; then printf '%s\n' 'OFFLINE_RECOVERY_EXPECTED_FAILURE_MISSING'; exit 1; fi
  [[ $RESTORE_CALLS == 0 ]]
}
# Already committed IN_SCOPE after a successful barrier is a safe no-op.
recover
[[ $RESTORE_CALLS == 0 ]]
# Even an IN_SCOPE JSON on disk cannot turn timeout/error into confirmation.
READ_RC=1
must_fail_without_write
READ_RC=0
STATE=$(printf '%s' "$IN_SCOPE" | jq '.barrier_acquired=false')
must_fail_without_write
STATE=$(printf '%s' "$IN_SCOPE" | jq '.observed_isolation="repeatable read"')
must_fail_without_write
STATE=$(printf '%s' "$IN_SCOPE" | jq '.database_fingerprint="different-fixture"')
must_fail_without_write
# A restore may commit and lose its acknowledgement. Fresh read-back decides.
STATE=$SUPPRESSED
AFTER_RESTORE=$RESTORED
RESTORE_RC=1
recover
[[ $RESTORE_CALLS == 1 ]]
# Failure without a committed restore remains NOT_CONFIRMED.
STATE=$SUPPRESSED
AFTER_RESTORE=$SUPPRESSED
RESTORE_CALLS=0
if recover; then printf '%s\n' 'OFFLINE_RECOVERY_FALSE_CONFIRMATION'; exit 1; fi
[[ $RESTORE_CALLS == 1 ]]
# Never compensate a different current scope operation.
STATE=$(printf '%s' "$SUPPRESSED" | jq '.current_event="other-operation"')
must_fail_without_write
printf '%s\n' 'OFFLINE_RECOVERY_CONTROL_PASS; DATABASE_CONCURRENCY_NOT_RUN'
source <(awk '/^security_preflight\(\) \{/{active=1} active{print} active && /^}/{exit}' "$SCRIPT")
db() {
  printf '%s\n' 'CHECK_ROLE_BASELINE' 'SENSITIVE_DIAGNOSTIC_SENTINEL' 'CHECK_SET_ROLE_ACL_AND_OWNERSHIP' >"$2"
  [[ $1 == preflight.sql ]]
}
set +e
diagnostic=$(security_preflight "$WORK/security")
diagnostic_rc=$?
set -e
[[ $diagnostic_rc != 0 && $diagnostic == FAILED_CHECK_SET_ROLE_ACL_AND_OWNERSHIP ]]
printf '%s\n' 'OFFLINE_SECURITY_DIAGNOSTIC_REDACTION_PASS'
