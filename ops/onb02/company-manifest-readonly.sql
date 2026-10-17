-- ONB-02-R3 — PRIVATE COMPANY GRAPH MANIFEST (READ ONLY).
-- REQUIRES: psql -X -v ON_ERROR_STOP=1 -v company_id='<UUID>' -f <this-file>
-- Operator must keep output in restricted evidence store; no raw names/CNPJs.
-- This file can inspect PRD read-only after approval, or restored PG clone.
\if :{?company_id}
\else
\echo 'BLOCK: supply explicit company_id. No query executed.'
\quit 4
\endif

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT CASE WHEN :'company_id' ~
  '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'
  THEN 'VALID_INPUT' ELSE 'INVALID_INPUT' END AS uuid_input_status;

-- Counts of every known company-owned relation. No raw PII in results.
WITH target AS (
 SELECT id,tenant_id,head_office_cnpj,legal_name,trade_name
 FROM companies WHERE id=:'company_id'::uuid
), units AS (
 SELECT id FROM establishments WHERE company_id=:'company_id'::uuid
), products AS (
 SELECT id FROM company_product_profiles WHERE company_id=:'company_id'::uuid
), pubs AS (
 SELECT id,publication_id FROM company_publications WHERE company_id=:'company_id'::uuid
), monitoring AS (
 SELECT id FROM monitoring_profiles WHERE company_id=:'company_id'::uuid
)
SELECT
 (SELECT count(*) FROM target) AS companies,
 (SELECT count(*) FROM units) AS establishments,
 (SELECT count(*) FROM establishment_cnaes ec JOIN units u ON u.id=ec.establishment_id) AS establishment_cnaes,
 (SELECT count(*) FROM company_cnaes cc WHERE cc.company_id=:'company_id'::uuid) AS company_cnaes,
 (SELECT count(*) FROM company_tax_profiles p WHERE p.company_id=:'company_id'::uuid) AS tax_versions,
 (SELECT count(*) FROM products) AS product_profiles,
 (SELECT count(*) FROM company_product_ncms n JOIN products p ON p.id=n.company_product_profile_id) AS product_ncms,
 (SELECT count(*) FROM company_cnae_ncms n WHERE n.company_id=:'company_id'::uuid) AS cnae_ncms,
 (SELECT count(*) FROM monitoring) AS monitoring_profiles,
 (SELECT count(*) FROM pubs) AS company_publications,
 (SELECT count(*) FROM publication_matches pm
    WHERE pm.company_publication_id IN (SELECT id FROM pubs)
       OR pm.monitoring_profile_id IN (SELECT id FROM monitoring)) AS publication_matches,
 (SELECT count(*) FROM publication_matches pm
    JOIN company_publications cp ON cp.id=pm.company_publication_id
    JOIN monitoring_profiles mp ON mp.id=pm.monitoring_profile_id
    WHERE (cp.company_id=:'company_id'::uuid OR mp.company_id=:'company_id'::uuid)
      AND cp.company_id<>mp.company_id) AS cross_company_matches,
 (SELECT count(*) FROM tenant_onboarding_profiles tp JOIN target t ON t.tenant_id=tp.tenant_id
    WHERE tp.cnpj=t.head_office_cnpj) AS explicitly_linked_legacy_onboarding,
 (SELECT count(*) FROM tenant_onboarding_profiles tp JOIN target t ON t.tenant_id=tp.tenant_id
    WHERE tp.cnpj IS NULL AND tp.company_name IS NOT NULL
      AND (tp.company_name=t.legal_name OR tp.company_name=t.trade_name)) AS ambiguous_legacy_names,
 (SELECT count(*) FROM audit_log a
    WHERE a.entity_type IN ('company','establishment') AND a.entity_id=:'company_id') AS historical_id_based_audits;

-- Global/publication preservation: rows in publications and versions are not
-- company-owned. This digest must be evaluated on the restore before and
-- after the dry-run using a private list of referenced publication IDs; the
-- collection links disappear after deletion, so retain the before-list in a
-- separate restricted artifact (not GitHub or screenshots).
SELECT count(*) AS global_publications_total,
       md5(coalesce(string_agg(md5(to_jsonb(p)::text),''
             ORDER BY p.id),'EMPTY')) AS publications_digest
FROM publications p;

SELECT count(*) AS global_versions_total,
       md5(coalesce(string_agg(md5(to_jsonb(v)::text),''
             ORDER BY v.publication_id,v.id),'EMPTY')) AS versions_digest
FROM publication_versions v;

SELECT count(*) AS global_cnaes_total,
       md5(coalesce(string_agg(md5(to_jsonb(c)::text),''
             ORDER BY c.code),'EMPTY')) AS cnaes_digest
FROM cnaes c;

-- Unrelated companies and their private dependencies must be byte-identical
-- before/after a company purge in the isolated restore. Never expose rows.
SELECT 'other_companies' AS relation,
       count(*)::bigint AS rows,
       md5(coalesce(string_agg(md5(to_jsonb(c)::text),'' ORDER BY c.id),'EMPTY')) AS fingerprint
FROM companies c WHERE c.id <> :'company_id'::uuid
UNION ALL
SELECT 'other_establishments',count(*)::bigint,
       md5(coalesce(string_agg(md5(to_jsonb(e)::text),'' ORDER BY e.id),'EMPTY'))
FROM establishments e WHERE e.company_id <> :'company_id'::uuid
UNION ALL
SELECT 'other_tax_profiles',count(*)::bigint,
       md5(coalesce(string_agg(md5(to_jsonb(p)::text),'' ORDER BY p.id),'EMPTY'))
FROM company_tax_profiles p WHERE p.company_id <> :'company_id'::uuid
UNION ALL
SELECT 'other_products',count(*)::bigint,
       md5(coalesce(string_agg(md5(to_jsonb(p)::text),'' ORDER BY p.id),'EMPTY'))
FROM company_product_profiles p WHERE p.company_id <> :'company_id'::uuid
UNION ALL
SELECT 'other_monitoring_profiles',count(*)::bigint,
       md5(coalesce(string_agg(md5(to_jsonb(mp)::text),'' ORDER BY mp.id),'EMPTY'))
FROM monitoring_profiles mp WHERE mp.company_id <> :'company_id'::uuid
UNION ALL
SELECT 'other_company_publications',count(*)::bigint,
       md5(coalesce(string_agg(md5(to_jsonb(cp)::text),'' ORDER BY cp.id),'EMPTY'))
FROM company_publications cp WHERE cp.company_id <> :'company_id'::uuid
UNION ALL
SELECT 'other_matches',count(*)::bigint,
       md5(coalesce(string_agg(md5(to_jsonb(pm)::text),'' ORDER BY pm.id),'EMPTY'))
FROM publication_matches pm JOIN company_publications cp
  ON cp.id=pm.company_publication_id WHERE cp.company_id <> :'company_id'::uuid;

ROLLBACK;
