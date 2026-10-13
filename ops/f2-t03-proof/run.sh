#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# An initial Railway deployment MUST be inert. Only a later explicit OK
# enables this script, with SOURCE_PG_DUMP_URL already filled by the owner.
if [[ "${F2_PROOF_ENABLED:-false}" != "true" ]]; then
  echo 'F2_T03_STATUS=INERT_WAITING_FOR_CREDENTIAL_AND_OWNER_OK'
  exit 0
fi
fail() { echo "F2_T03_STATUS=BLOCK:$1" >&2; exit 1; }
tmp="$(mktemp -d -t f2-t03-proof-XXXXXXXX)"
cleanup() {
  rm -rf -- "$tmp"
  unset SOURCE_PG_DUMP_URL DATABASE_ADMIN_URL AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
}
trap cleanup EXIT

[[ -n "${SOURCE_PG_DUMP_URL:-}" ]] || fail SOURCE_ADMIN_URL_MISSING
[[ -n "${DATABASE_ADMIN_URL:-}" ]] || fail ISOLATED_DB_URL_MISSING
[[ -n "${BACKUP_BUCKET_NAME:-}" && -n "${BACKUP_BUCKET_ENDPOINT:-}" ]] || fail BUCKET_NOT_CONFIGURED
[[ -n "${AWS_ACCESS_KEY_ID:-}" && -n "${AWS_SECRET_ACCESS_KEY:-}" ]] || fail BUCKET_CREDENTIALS_NOT_CONFIGURED
[[ "${NODE_ENV:-}" == "test" ]] || fail NODE_ENV_NOT_TEST
[[ "${F2_IMPORT_SCOPE:-}" == "ISOLATED_POSTGRES18_ONLY" ]] || fail F2_IMPORT_SCOPE_INVALID
node --input-type=module - <<'NODE' || fail DATABASE_URL_ISOLATION_FAILED
try {
  const a = new URL(process.env.SOURCE_PG_DUMP_URL);
  const b = new URL(process.env.DATABASE_ADMIN_URL);
  if (!/^postgres(?:ql)?:$/.test(a.protocol) || !/^postgres(?:ql)?:$/.test(b.protocol) ||
      !a.hostname || !b.hostname || a.hostname === b.hostname ||
      decodeURIComponent(b.pathname) !== '/radar_fiscal_test') process.exit(1);
} catch {
  // Never log a malformed DSN (it may contain the production password).
  process.exit(1);
}
NODE
node -e "if (require('yauzl')?.open === undefined) process.exit(1)" || fail NATIVE_YAUZL_MISSING
[[ "$(pg_dump --version | grep -oE '[0-9]+' | head -1)" -ge 18 ]] || fail PG_CLIENT_TOO_OLD

# Accept uploaded repository-root .b64 files or the original ops paths.
# The decoded XLSX SHA-256 checks below remain mandatory.
segmentB64='Radar_Fiscal_Carga_Segmento_Revisada_v5.1.xlsx.b64'
productB64='Radar_Fiscal_Carga_Produto_Revisada_v5.xlsx.b64'
[[ -s "$segmentB64" ]] || segmentB64="ops/f2-t03-proof/$segmentB64"
[[ -s "$productB64" ]] || productB64="ops/f2-t03-proof/$productB64"
[[ -s "$segmentB64" && -s "$productB64" ]] || fail APPROVED_XLSX_B64_NOT_UPLOADED
base64 -d "$segmentB64" > "$tmp/segmento.xlsx" || fail SEGMENTO_BASE64_CORRUPT
base64 -d "$productB64" > "$tmp/produto.xlsx" || fail PRODUTO_BASE64_CORRUPT
[[ "$(sha256sum "$tmp/segmento.xlsx" | awk '{print $1}')" == "695b0df85339ec60a2b1bc8b88b842ac09a55e71d90c3f7eb2443f1709c6af67" ]] || fail SEGMENTO_SHA256_MISMATCH
[[ "$(sha256sum "$tmp/produto.xlsx" | awk '{print $1}')" == "261da490a5a030e698d43030c6a552cf39cc3f025f0249f71ffff1001b57051a" ]] || fail PRODUTO_SHA256_MISMATCH
echo 'F2_T03_SOURCE_HASHES=PASS'

# IMPORTANT: production admin URL is used EXCLUSIVELY by pg_dump.
# Audits are pg_dump data-only exports in read-only transactions.
echo 'F2_T03_STEP=PRODUCTION_COUNTS_BEFORE'
PGOPTIONS="-c default_transaction_read_only=on" pg_dump \
  --dbname="$SOURCE_PG_DUMP_URL" --format=plain --data-only \
  --no-owner --no-acl --table='public.taxonomy_*' --file="$tmp/before.sql" ||
  fail PRODUCTION_BEFORE_DUMP_FAILED
python3 ops/f2-t03-proof/audit-copy-counts.py "$tmp/before.sql" "$tmp/before.json" ||
  fail PRODUCTION_BEFORE_COUNTS_FAILED
rm -f "$tmp/before.sql"

dumpStart="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "F2_T03_DUMP_START_UTC=$dumpStart"
PGOPTIONS="-c default_transaction_read_only=on" pg_dump \
  --dbname="$SOURCE_PG_DUMP_URL" --format=custom --compress=6 \
  --file="$tmp/official.dump" || fail OFFICIAL_PG_DUMP_FAILED
dumpBytes="$(wc -c < "$tmp/official.dump" | tr -d ' ')"
dumpSha="$(sha256sum "$tmp/official.dump" | awk '{print $1}')"
dumpKey="f2-t03-backup-$dumpSha.dump"
echo "F2_T03_BACKUP_START=$dumpStart SHA256=$dumpSha BYTES=$dumpBytes VALID_HOURS=24"

aws --endpoint-url="$BACKUP_BUCKET_ENDPOINT" s3 cp --no-progress \
  "$tmp/official.dump" "s3://$BACKUP_BUCKET_NAME/$dumpKey" ||
  fail BACKUP_BUCKET_UPLOAD_FAILED
verifiedSha="$(aws --endpoint-url="$BACKUP_BUCKET_ENDPOINT" s3 cp --no-progress \
  "s3://$BACKUP_BUCKET_NAME/$dumpKey" - | sha256sum | awk '{print $1}')" ||
  fail BACKUP_BUCKET_RETRIEVAL_FAILED
[[ "$verifiedSha" == "$dumpSha" ]] || fail BACKUP_BUCKET_HASH_MISMATCH
echo "F2_T03_BACKUP_BUCKET=PASS KEY=$dumpKey"

# Prepare archive owners as passwordless NOLOGIN roles, TEMP DB ONLY.
pg_restore --list "$tmp/official.dump" > "$tmp/archive.list" || fail ARCHIVE_LIST_FAILED
python3 - "$tmp/archive.list" "$tmp/roles.sql" <<'PY' || fail ROLES_PREP_FAILED
import pathlib, re, sys
roles=set()
for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
    if not re.match(r"^[0-9]+;", line): continue
    name=line.rsplit(" ",1)[-1].strip()
    if name in ("-", "postgres") or name.startswith("pg_"): continue
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*",name):
        raise ValueError("Unrecognized owner (manual review required)")
    roles.add(name)
sql=[]
for name in sorted(roles):
    sql.append("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '"+name+
      "') THEN CREATE ROLE \""+name+"\" NOLOGIN; END IF; END $$;")
pathlib.Path(sys.argv[2]).write_text("\n".join(sql)+"\n")
print("F2_T03_RESTORE_GLOBAL_ROLES_NOLOGIN="+str(len(roles)))
PY
psql "$DATABASE_ADMIN_URL" -X -v ON_ERROR_STOP=1 -f "$tmp/roles.sql" >/dev/null ||
  fail TEMP_ROLES_CREATION_FAILED

echo 'F2_T03_STEP=RESTORE_TO_ISOLATED_PG18'
pg_restore --dbname="$DATABASE_ADMIN_URL" --exit-on-error \
  --single-transaction "$tmp/official.dump" || fail TEMP_RESTORE_FAILED
echo 'F2_T03_RESTORE=PASS'

echo 'F2_T03_STEP=OFFICIAL_CLI_WITH_GENUINE_YAUZL'
node ops/taxonomy/f2-xlsx-dry-run.mjs \
  --segmento="$tmp/segmento.xlsx" --produto="$tmp/produto.xlsx" \
  --out="$tmp/dry-run.json" || fail CLI_NATIVE_FAILED
node - "$tmp/dry-run.json" <<'NODE' || fail CLI_GATE_FAILED
const fs=require('node:fs');
const p=JSON.parse(fs.readFileSync(process.argv[2]));
const s=p.summary;
if(p.mode!=='DRY_RUN_ONLY'||p.noDatabaseWrites!==true||s.errors!==0||
  s.warnings!==448||s.segmentRows!==1332||s.productRows!==4225||
  s.cnaeDistinct!==1332||s.productCodesDistinct!==4225||s.actuationCategories!==12)
    process.exit(1);
console.log('F2_T03_NATIVE_CLI=PASS ERRORS=0 WARNINGS=448');
NODE

echo 'F2_T03_STEP=ISOLATED_STAGING_TWO_JOBS_AND_GH_READBACK'
node ops/f2-t03-proof/stage-two-jobs.mjs \
  "$tmp/segmento.xlsx" "$tmp/produto.xlsx" || fail STAGING_READBACK_FAILED

echo 'F2_T03_STEP=PRODUCTION_COUNTS_AFTER'
PGOPTIONS="-c default_transaction_read_only=on" pg_dump \
  --dbname="$SOURCE_PG_DUMP_URL" --format=plain --data-only \
  --no-owner --no-acl --table='public.taxonomy_*' --file="$tmp/after.sql" ||
  fail PRODUCTION_AFTER_DUMP_FAILED
python3 ops/f2-t03-proof/audit-copy-counts.py "$tmp/after.sql" "$tmp/after.json" ||
  fail PRODUCTION_AFTER_COUNTS_FAILED
cmp -s "$tmp/before.json" "$tmp/after.json" || fail PRODUCTION_TABLE_COUNTS_CHANGED
echo 'F2_T03_PRODUCTION_COUNTS=PASS UNCHANGED=true'
echo "F2_T03_FINAL=PASS DUMP_START_UTC=$dumpStart DUMP_SHA256=$dumpSha DUMP_BYTES=$dumpBytes"
echo 'F2_T03_OWNER_ACTION=REMOVE_SECRETS_SET_INERT_START_AND_RESTART_NEVER'
