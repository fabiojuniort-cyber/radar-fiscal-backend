#!/usr/bin/env bash
# Semantic, disposable PostgreSQL 18 fixture. No Railway or production access.
set -euo pipefail
export PGPASSWORD=postgres
PSQL=(psql -X -v ON_ERROR_STOP=1 -h localhost -U postgres -d radar_fiscal_test)
mkdir -p "${RUNNER_TEMP:-/tmp}"
OUT="${RUNNER_TEMP:-/tmp}/onb02-r3-preflight-semantic.out"
MANIFEST="${RUNNER_TEMP:-/tmp}/onb02-r3-manifest-semantic.out"
NOTICES="${RUNNER_TEMP:-/tmp}/onb02-r3-manifest-notices.out"
FIXTURE="${RUNNER_TEMP:-/tmp}/onb02-r3-semantic-ids.out"

# Seed a target, a same-tenant company, another tenant, branch and audit.
# All table mutations here occur exclusively on GitHub's throwaway DB.
"${PSQL[@]}" -A -t > "$FIXTURE" <<'SQL'
INSERT INTO tenants(name,slug)
VALUES('ONB02 CI OWN','onb02-semantic-owner') RETURNING id AS tenant_id \gset
INSERT INTO tenants(name,slug)
VALUES('ONB02 CI FOREIGN','onb02-semantic-foreign') RETURNING id AS foreign_tenant_id \gset
INSERT INTO companies(tenant_id,legal_name,head_office_cnpj)
VALUES (:'tenant_id'::uuid,'ONB02 CI Target','11222333000181')
RETURNING id AS company_id \gset
INSERT INTO companies(tenant_id,legal_name,head_office_cnpj)
VALUES (:'tenant_id'::uuid,'ONB02 CI Sibling','11222333000182')
RETURNING id AS sibling_company_id \gset
INSERT INTO companies(tenant_id,legal_name,head_office_cnpj)
VALUES (:'foreign_tenant_id'::uuid,'ONB02 CI Foreign','11222333000181')
RETURNING id AS foreign_company_id \gset
INSERT INTO establishments(company_id,cnpj,name,establishment_type_code,is_head_office,uf)
VALUES (:'company_id'::uuid,'11222333000181','ONB02 CI Matrix','HEAD_OFFICE',true,'GO')
RETURNING id AS establishment_id \gset
INSERT INTO establishments(company_id,cnpj,name,establishment_type_code,is_head_office,uf)
VALUES (:'company_id'::uuid,'11222333000262','ONB02 CI Branch','OFFICE',false,'GO')
RETURNING id AS branch_id \gset
INSERT INTO audit_log(tenant_id,actor_type,action,entity_type,entity_id,before_data)
VALUES(:'tenant_id'::uuid,'USER','ONB02_CI_AUDIT','establishment',:'branch_id',
  jsonb_build_object('company_id',:'company_id','branch_id',:'branch_id'));
INSERT INTO cnaes(code,description) VALUES('9900001','ONB02 synthetic') ON CONFLICT DO NOTHING;
INSERT INTO company_cnaes(company_id,cnae_code)
VALUES (:'sibling_company_id'::uuid,'9900001');
INSERT INTO establishment_cnaes(establishment_id,cnae_code)
VALUES (:'branch_id'::uuid,'9900001');
CREATE VIEW public.onb02_ci_dep_direct_view AS SELECT id FROM public.companies;
CREATE VIEW public.onb02_ci_dep_transitive AS SELECT id FROM public.onb02_ci_dep_direct_view;
CREATE MATERIALIZED VIEW public.onb02_ci_dep_matview
AS SELECT id FROM public.companies WITH NO DATA;
\echo ONB02_TARGET_ID= :company_id
\echo ONB02_BRANCH_ID= :branch_id
SQL

target_id="$(awk '/^ONB02_TARGET_ID=/{print $2}' "$FIXTURE")"
branch_id="$(awk '/^ONB02_BRANCH_ID=/{print $2}' "$FIXTURE")"
test -n "$target_id"
test -n "$branch_id"

"${PSQL[@]}" -A -f ops/onb02/preflight-readonly.sql > "$OUT"
"${PSQL[@]}" -A -v "company_id=$target_id" \
  -v "original_establishment_ids=$branch_id" \
  -f ops/onb02/company-manifest-readonly.sql > "$MANIFEST" 2> "$NOTICES"

# Fail on semantically missing direct, indirect and materialized dependencies.
grep -q 'onb02_ci_dep_direct_view' "$OUT"
grep -q 'onb02_ci_dep_transitive' "$OUT"
grep -q 'onb02_ci_dep_matview' "$OUT"
grep -q 'ONB02_GLOBAL relation=' "$NOTICES"

# Confirm actual data values, never just the SQL's header.
node - "$MANIFEST" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const rows = fs.readFileSync(process.argv[2],'utf8').split(/\r?\n/);
const first = rows.findIndex(s=>s.startsWith('companies|establishments|'));
assert.ok(first>=0,'manifest must contain per-company measurements');
const names=rows[first].split('|'), values=rows[first+1].split('|');
const val=name=>Number(values[names.indexOf(name)]);
assert.equal(val('companies'),1,'target company fixture');
assert.equal(val('establishments'),2,'target matrix+branch');
assert.equal(val('historical_id_based_audits_company_or_branches'),1,'filial audit detection');
assert.equal(val('historical_payload_id_references'),1,'audit JSONB references detection');
assert.ok(rows.some(s=>/^other_company_cnaes\|1\|[a-f0-9]{32}$/.test(s)),
 'unrelated company_cnaes fingerprint must be materialized');
assert.ok(rows.some(s=>/^other_establishment_cnaes\|0\|[a-f0-9]{32}$/.test(s)),
 'target branch company_cnaes must not count as other company');
assert.ok(rows.some(s=>/^other_companies\|2\|[a-f0-9]{32}$/.test(s)),
 'both unrelated companies must be counted');
console.log('ONB02_R3_SEMANTIC_SQL_PASS');
NODE

# Teardown on a synthetic disposable DB only.
"${PSQL[@]}" -q <<'SQL'
DROP VIEW public.onb02_ci_dep_transitive;
DROP VIEW public.onb02_ci_dep_direct_view;
DROP MATERIALIZED VIEW public.onb02_ci_dep_matview;
DELETE FROM audit_log WHERE action='ONB02_CI_AUDIT';
DELETE FROM tenants WHERE slug IN ('onb02-semantic-owner','onb02-semantic-foreign');
DELETE FROM cnaes WHERE code='9900001';
SQL
