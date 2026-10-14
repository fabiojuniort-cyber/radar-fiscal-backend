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

[[ -z "${SOURCE_PG_DUMP_URL:-}" ]] || fail PRODUCTION_CREDENTIAL_FORBIDDEN
[[ -z "${DATABASE_URL:-}" ]] || fail UNEXPECTED_DATABASE_URL
[[ -n "${DATABASE_ADMIN_URL:-}" ]] || fail ISOLATED_DB_URL_MISSING
[[ -n "${BACKUP_BUCKET_NAME:-}" && -n "${BACKUP_BUCKET_ENDPOINT:-}" ]] || fail BUCKET_NOT_CONFIGURED
[[ -n "${AWS_ACCESS_KEY_ID:-}" && -n "${AWS_SECRET_ACCESS_KEY:-}" ]] || fail BUCKET_CREDENTIALS_NOT_CONFIGURED
[[ "${NODE_ENV:-}" == "test" ]] || fail NODE_ENV_NOT_TEST
[[ "${F2_IMPORT_SCOPE:-}" == "ISOLATED_POSTGRES18_ONLY" ]] || fail F2_IMPORT_SCOPE_INVALID
node --input-type=module - <<'NODE' || fail DATABASE_URL_ISOLATION_FAILED
try {
 const b=new URL(process.env.DATABASE_ADMIN_URL);
 if(!/^postgres(?:ql)?:$/.test(b.protocol) || b.hostname!=='postgres.railway.internal' ||
 decodeURIComponent(b.pathname)!=='/radar_fiscal_test') process.exit(1);
 console.log('F2_T03_NO_PRODUCTION_CREDENTIAL=PASS');
 console.log('F2_T03_VARIABLE_INVENTORY='+JSON.stringify(Object.keys(process.env).sort().map(name=>({name,value:process.env[name]?'[MASKED]':'[EMPTY]'}))));
} catch { process.exit(1); }
NODE
node ops/f2-t03-proof/prepare-restore-roles.test.mjs || fail ROLE_PARSER_FIXTURES_FAILED
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

# R2: only the previously verified private bucket dump; no production connection.
dumpStart='2026-10-14T00:42:39Z'
dumpSha='69d8cfe2ae01f81a8684b6ba844df8d32b7b3bc85fdbe04df841b849f8fa95b3'
dumpKey="f2-t03-backup-$dumpSha.dump"
[[ "$(date -u +%s)" -lt "$(( $(date -u -d "$dumpStart" +%s) + 86400 ))" ]] || fail DUMP_EXPIRED
aws --endpoint-url="$BACKUP_BUCKET_ENDPOINT" s3 cp --no-progress \
 "s3://$BACKUP_BUCKET_NAME/$dumpKey" "$tmp/official.dump" || fail BACKUP_BUCKET_RETRIEVAL_FAILED
[[ "$(sha256sum "$tmp/official.dump" | awk '{print $1}')" == "$dumpSha" ]] || fail BACKUP_BUCKET_HASH_MISMATCH
dumpBytes="$(wc -c < "$tmp/official.dump" | tr -d ' ')"
[[ "$dumpBytes" == "229111370" ]] || fail BACKUP_SIZE_MISMATCH
echo "F2_T03_BACKUP_REUSED=PASS START=$dumpStart SHA256=$dumpSha BYTES=$dumpBytes"
pg_restore --list "$tmp/official.dump" > "$tmp/archive.list" || fail ARCHIVE_LIST_FAILED
pg_restore --schema-only --file="$tmp/archive-schema.sql" "$tmp/official.dump" || fail ARCHIVE_SCHEMA_FAILED
node ops/f2-t03-proof/prepare-restore-roles.mjs "$tmp/archive-schema.sql" "$tmp/roles.sql" || fail ROLES_PREP_FAILED
# Verify TEMP database identity before any SQL mutation.
[[ "$(psql "$DATABASE_ADMIN_URL" -X -At -v ON_ERROR_STOP=1 -c 'SELECT current_database()')" == "radar_fiscal_test" ]] || fail TEMP_DATABASE_IDENTITY_FAILED
psql "$DATABASE_ADMIN_URL" -X -v ON_ERROR_STOP=1 -f "$tmp/roles.sql" >/dev/null || fail TEMP_ROLES_CREATION_FAILED
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

echo 'F2_T03_PRODUCTION_COUNTS=REPLACED_BY_NO_PRODUCTION_CREDENTIAL_GATE'
echo "F2_T03_FINAL=PASS DUMP_START_UTC=$dumpStart DUMP_SHA256=$dumpSha DUMP_BYTES=$dumpBytes"
echo 'F2_T03_OWNER_ACTION=REMOVE_SECRETS_SET_INERT_START_AND_RESTART_NEVER'
