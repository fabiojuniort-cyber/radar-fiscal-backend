#!/usr/bin/env bash
# ANAT-ADMIN-01 integration readiness (issue #116): applies the REAL migration chain of origin/main (verified copies from git,
# never edited) to a FRESH local disposable database, then the rehearsal admin SQL (test/support), then a functional smoke.
# Disposable only: refuses unless the target is exactly postgresql://postgres:postgres@localhost:5432/anat04_ci and no
# DATABASE_URL/DATABASE_ADMIN_URL is set. It DROPS and recreates anat04_ci. Never point it at a shared database.
set -euo pipefail
URL="${ANAT04_CI_DATABASE_URL:-}"
[[ "$URL" == "postgresql://postgres:postgres@localhost:5432/anat04_ci" ]] || { echo "ANAT04_DISPOSABLE_CI_ONLY"; exit 2; }
[[ -z "${DATABASE_URL:-}" && -z "${DATABASE_ADMIN_URL:-}" ]] || { echo "generic database URLs must be absent"; exit 2; }
export PGPASSWORD=postgres
REF="${1:-origin/main}"; WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
git fetch -q origin main
echo "main: $(git rev-parse "$REF")"
for f in $(git ls-tree --name-only "$REF" migrations/); do git show "$REF:$f" > "$WORK/$(basename "$f")"; done
psql -q -h localhost -U postgres -d postgres -c "DROP DATABASE IF EXISTS anat04_ci" -c "CREATE DATABASE anat04_ci"
n=0; for f in $(ls "$WORK" | sort); do psql -q -v ON_ERROR_STOP=1 -h localhost -U postgres -d anat04_ci -1 -f "$WORK/$f" >/dev/null; n=$((n+1)); done
echo "real migrations applied: $n (last: $(ls "$WORK" | sort | tail -1))"
psql -q -h localhost -U postgres -d anat04_ci -tAc "SELECT 'anatomy tables on main: ' || count(*) FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'anatomy_%'"
{ echo "BEGIN; SET LOCAL anatomy.ci_disposable='true';"; cat test/support/anatomy-ci-schema.sql test/support/anatomy-admin-audit-policy.sql test/support/anatomy-admin-ci-schema.sql; echo "COMMIT;"; } \
  | psql -q -v ON_ERROR_STOP=1 -h localhost -U postgres -d anat04_ci >/dev/null
echo "rehearsal admin SQL applied on top of the real chain"
psql -v ON_ERROR_STOP=1 -h localhost -U postgres -d anat04_ci -tA <<'SQL'
INSERT INTO app_users (id, email, name) VALUES ('aaaaaaaa-0000-4000-8000-000000000001','a@example.test','A'),('aaaaaaaa-0000-4000-8000-000000000003','n@example.test','N');
INSERT INTO platform_user_roles (user_id, role, granted_by) VALUES ('aaaaaaaa-0000-4000-8000-000000000001','PLATFORM_ADMIN','aaaaaaaa-0000-4000-8000-0000000000ff');
BEGIN; SET LOCAL ROLE radar_app; SELECT set_config('app.user_id','aaaaaaaa-0000-4000-8000-000000000001',true) \g /dev/null
SELECT 'draft saved: ' || (SELECT revision FROM anat_save_draft(NULL,NULL,'[{"profileVersion":"ANAT-PROFILE/1","scope":{"level":"default"},"fields":{}}]'::jsonb,'[{"id":"ex-a"}]'::jsonb,gen_random_uuid()));
SELECT 'frozen: ' || (SELECT created FROM anat_freeze((SELECT id FROM anatomy_rule_drafts LIMIT 1),1,repeat('e',64),gen_random_uuid()));
COMMIT;
SELECT 'audit rows: ' || string_agg(action, ',' ORDER BY occurred_at) FROM audit_log WHERE entity_type='anatomy_rules';
BEGIN; SET LOCAL ROLE radar_app; SELECT set_config('app.user_id','aaaaaaaa-0000-4000-8000-000000000003',true) \g /dev/null
SELECT 'non-admin sees ANAT audit rows: ' || count(*) FROM audit_log WHERE entity_type='anatomy_rules';
ROLLBACK;
SELECT 'old event projection unchanged: ' || (audit_project('COMPANY_CREATED','company','{"company_id":"aaaaaaaa-0000-4000-8000-000000000001","is_active":true,"x":"free"}') = '{"is_active":true,"company_id":"aaaaaaaa-0000-4000-8000-000000000001"}'::jsonb);
SELECT 'radar_app CREATE on public: ' || has_schema_privilege('radar_app','public','CREATE');
SELECT 'publication_anatomies effective_profile_hash/family columns: ' || count(*) FROM information_schema.columns WHERE table_name='publication_anatomies' AND column_name IN ('effective_profile_hash','family');
SQL
